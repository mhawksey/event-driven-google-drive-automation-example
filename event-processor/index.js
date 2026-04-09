const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');
const { OAuth2Client } = require('google-auth-library');

const firestore = new Firestore();
const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

exports.processEvent = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {

    const pubsubMessage = req.body.message;
    if (!pubsubMessage || !pubsubMessage.data) return res.status(400).send('Invalid message');

    const decodedData = Buffer.from(pubsubMessage.data, 'base64').toString('utf8');
    const event = JSON.parse(decodedData);
    
    // Log the entire payload and attributes for exact tracing
    console.log('Received Message Attributes:', JSON.stringify(pubsubMessage.attributes || {}));
    console.log('Received Event Data:', JSON.stringify(event));

    const fileId = event.file ? event.file.id : null;
    if (!fileId && !event.name) {
      console.log('No file ID or resource name found, skipping event.');
      return res.status(200).send('No file ID');
    }

    // Extract the exact Subscription Resource Name to look up our user mapping
    // It can be in the data body (sync events) or the CloudEvent Subject attribute
    let subscriptionId = event.subscription || event.name;
    if (pubsubMessage.attributes) {
      // CloudEvents 'ce-subject' or raw 'subscription' attribute
      if (pubsubMessage.attributes.subscription) subscriptionId = pubsubMessage.attributes.subscription;
      if (pubsubMessage.attributes['ce-subject']) subscriptionId = pubsubMessage.attributes['ce-subject'];
    }

    if (!subscriptionId) {
      console.log('Warning: No subscription ID found in payload or attributes. This usually means the event format is unexpected.');
    } else {
      console.log(`Extracted subscription ID: ${subscriptionId}`);
    }

    console.log(`Looking up mapped subscription in Firestore...`);
    let mappedSubscription = null;
    
    if (subscriptionId) {
      const doc = await firestore.collection('drive-event-subscriptions').doc(encodeURIComponent(subscriptionId)).get();
      if (doc.exists) mappedSubscription = doc.data();
    }
    
    // DEMO FALLBACK: If we still couldn't resolve the subscription, fall back to grabbing the latest one.
    if (!mappedSubscription) {
      const snapshot = await firestore.collection('drive-event-subscriptions').get();
      if (snapshot.size > 0) {
        console.log(`Falling back to latest mapped subscription for demo purposes.`);
        mappedSubscription = snapshot.docs[0].data();
      }
    }

    if (!mappedSubscription) {
      console.log(`No active subscription mapping found. Dropping event.`);
      return res.status(200).send('No mapped subscription found');
    }

    console.log(`Found mapped subscription for Spreadsheet ${mappedSubscription.spreadsheetId} and User ${mappedSubscription.userId}`);

    const spreadsheetId = mappedSubscription.spreadsheetId;
    const userId = mappedSubscription.userId;

    if (!userId) {
      console.error('Subscription mapping is missing userId. Cannot perform OAuth flow.');
      return res.status(200).send('Missing User ID');
    }

    // 2. Lookup the offline Refresh Token for this User
    console.log(`Looking up OAuth refresh token for user ${userId}`);
    const tokenDoc = await firestore.collection('oauth-tokens').doc(userId).get();
    if (!tokenDoc.exists) {
      console.error(`Missing OAuth token for user ${userId}`);
      return res.status(200).send('Missing token');
    }
    console.log(`Successfully retrieved refresh token for user ${userId}`);
    
    const refreshToken = tokenDoc.data().refresh_token;

    // 3. Authenticate AS THE USER using their refresh token
    const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // 4. Fetch rich file metadata from Drive (acting as the user!)
    let fileMeta;
    console.log(`Fetching file metadata for file ${fileId} using Drive API`);
    try {
      const fileRes = await drive.files.get({
        fileId: fileId,
        fields: 'id, name, mimeType, webViewLink, parents'
      });
      fileMeta = fileRes.data;
    } catch (e) {
       if (e.code === 404 || e.code === 403) {
         console.warn(`File ${fileId} not accessible by user ${userId}. Dropping event.`);
         return res.status(200).send('File inaccessible');
       }
       throw e;
    }

    // Append a row to the matching Google Sheet (acting as the user!)
    console.log(`Appending row to Google Sheet ${spreadsheetId}`);
    const rowData = [
      new Date().toISOString(),
      fileMeta.name,
      fileMeta.id,
      fileMeta.mimeType,
      fileMeta.webViewLink
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: 'A:E', // Simple dynamic append to the first active sheet
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowData] }
    });

    console.log(`Successfully appended row to Spreadheet ${spreadsheetId} on behalf of ${userId}`);
    return res.status(200).send('Success');

  } catch (error) {
    console.error('Error processing event:', error);
    res.status(500).send('Internal Server Error');
  }
};
