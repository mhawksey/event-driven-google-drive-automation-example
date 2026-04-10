const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');

const firestore = new Firestore();
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.PROJECT_ID;
const TOPIC_NAME = process.env.TOPIC_NAME || 'drive-events-topic';
const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

/**
 * Cloud Run function that handles the Google Workspace Add-on and OAuth flow.
 *
 * @param {Object} req Request sent from Google Workspace or Browser
 * @param {Object} res Response to send back
 */
exports.addonHandler = async (req, res) => {
  const redirectUri = `https://${req.get('host')}${req.baseUrl || req.path}`;
  const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri);

  // --- GET Requests (OAuth 2.0 Web Flow from user browser) ---
  if (req.method === 'GET') {
    if (req.query.code) {
      if (!req.query.state) return res.status(400).send('OAuth Error: Missing state parameter.');
      
      // Verify CSRF token
      const stateDoc = await firestore.collection('oauth-states').doc(req.query.state).get();
      if (!stateDoc.exists) {
        return res.status(400).send('OAuth Error: Invalid or expired state parameter (possible CSRF attempt).');
      }
      
      // Clean up the used state token
      await firestore.collection('oauth-states').doc(req.query.state).delete();

      try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        // We must have an id_token to know whose refresh token this is
        if (!tokens.id_token || !tokens.refresh_token) {
          return res.status(400).send('OAuth Error: Missing offline refresh_token or id_token. Did you revoke access first?');
        }

        const ticket = await oauth2Client.verifyIdToken({
          idToken: tokens.id_token,
          audience: CLIENT_ID,
        });
        const userId = ticket.getPayload().sub;
        console.log(`OAuth Callback: Received tokens and verified user ID: ${userId}`);

        // Save the refresh token in Firestore
        await firestore.collection('oauth-tokens').doc(userId).set({
          refresh_token: tokens.refresh_token,
          updatedAt: new Date().toISOString()
        });
        console.log(`Successfully saved refresh token to Firestore for user: ${userId}`);

        return res.status(200).send(`
          <html>
            <body>
              <h2>Authorization Successful!</h2>
              <p>You have successfully linked your account for background processing.</p>
              <p>You can close this tab and return to the Workspace Add-on.</p>
            </body>
          </html>
        `);
      } catch (e) {
        console.error('OAuth Callback Error:', e);
        return res.status(500).send('Failed to process authorization code.');
      }
    } else {
      console.log('Initiating OAuth 2.0 flow, generating auth URL.');
      
      const stateToken = crypto.randomBytes(32).toString('hex');
      await firestore.collection('oauth-states').doc(stateToken).set({
        createdAt: new Date().toISOString()
      });

      // Initiate OAuth flow
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Force consent prompt to guarantee we get a refresh_token
        state: stateToken,
        scope: [
          'email',
          'profile',
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/spreadsheets'
        ]
      });
      return res.redirect(authUrl);
    }
  }

  // --- POST Requests (Workspace Add-on JSON Invocation) ---
  if (req.method === 'POST') {
    try {
      const event = req.body;
      console.log('Received POST request from Workspace Add-on.');

      // 1. Authenticate Add-on User
      const userToken = event.authorizationEventObject && event.authorizationEventObject.userOAuthToken;
      const idToken = event.authorizationEventObject && event.authorizationEventObject.userIdToken;

      if (!userToken || !idToken) {
        return res.json(createAlertCard('Error: Missing authorization tokens from Workspace.'));
      }
      
      let userId;
      try {
        // Use the ID token provided in the event instead of making a network request to the userinfo endpoint
        const payloadBase64 = idToken.split('.')[1];
        const decodedPayload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
        const tokenAudience = decodedPayload.aud;

        const ticket = await oauth2Client.verifyIdToken({
          idToken: idToken,
          audience: tokenAudience, // Ensure the audience matches the token's issued client ID
        });
        userId = ticket.getPayload().sub;
      } catch (err) {
        console.error('Failed to verify ID token details:', err);
        return res.json(createAlertCard(`Error: Could not retrieve user profile details. ${err.message}`));
      }

      // 2. Check if we have an offline refresh token for this user
      const tokenDoc = await firestore.collection('oauth-tokens').doc(userId).get();
      if (!tokenDoc.exists) {
        // User needs to authorize offline access
        return res.json(buildAuthCard(redirectUri));
      }

      // 3. Normal Add-on Routing
      if (event.commonEventObject && event.commonEventObject.parameters && event.commonEventObject.parameters.action === 'configure_subscription') {
        return res.json(await handleConfigureSubscription(event, userId));
      } else if (event.drive && event.drive.activeCursorItem) {
        return res.json(buildDriveContextualCard(event, redirectUri));
      } else {
        return res.json(buildHomePageCard());
      }

    } catch (e) {
      console.error('Add-on Handler Error:', e);
      const isAction = req.body && req.body.commonEventObject && req.body.commonEventObject.parameters && req.body.commonEventObject.parameters.action;
      const errorCard = createAlertCard(`Internal Error: ${e.message}`);
      return res.json(isAction ? { renderActions: errorCard } : errorCard);
    }
  }

  return res.status(405).send('Method Not Allowed');
};

/**
 * Builds the Authorization Card requiring user to link their account
 */
function buildAuthCard(redirectUri) {
  return {
    action: {
      navigations: [
        {
          pushCard: {
            header: {
              title: 'Authorization Required'
            },
            sections: [
              {
                widgets: [
                  {
                    textParagraph: {
                      text: 'To securely append rows to your Google Sheet in the background, you must authorize this application.'
                    }
                  },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: 'Authorize App',
                          onClick: {
                            openLink: {
                              url: redirectUri
                            }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        }
      ]
    }
  };
}

// ... unchanged logic for UI cards
function buildHomePageCard() {
  return {
    action: {
      navigations: [{
        pushCard: {
          header: { title: 'Drive to Sheets Notifier' },
          sections: [{
            widgets: [{
              textParagraph: { text: 'Select a Folder in Google Drive to configure notifications.' }
            }]
          }]
        }
      }]
    }
  };
}

function buildDriveContextualCard(event, actionUrl) {
  const item = event.drive.activeCursorItem || (event.drive.selectedItems && event.drive.selectedItems[0]);
  if (!item || item.mimeType !== 'application/vnd.google-apps.folder') {
    return {
      action: {
        navigations: [{
          pushCard: {
            header: { title: 'Invalid Selection' },
            sections: [{ widgets: [{ textParagraph: { text: 'Please select a Folder (not a file) to configure notifications.' } }] }]
          }
        }]
      }
    };
  }

  const folderId = item.id;
  const folderTitle = item.title;

  return {
    action: {
      navigations: [{
        pushCard: {
          header: { title: `Configure Notifier: ${folderTitle}` },
          sections: [{
            widgets: [
              { textParagraph: { text: 'When a new file is added, append a row to this Sheet:' } },
              { textInput: { name: 'sheetsUrl', label: 'Google Sheets URL', type: 'SINGLE_LINE' } },
              {
                buttonList: {
                  buttons: [{
                    text: 'Subscribe',
                    onClick: {
                      action: {
                        function: actionUrl, // MUST be a fully qualified URL for Alternate Runtimes
                        parameters: [
                          { key: 'action', value: 'configure_subscription' },
                          { key: 'folderId', value: folderId }
                        ]
                      }
                    }
                  }]
                }
              }
            ]
          }]
        }
      }]
    }
  };
}

async function handleConfigureSubscription(event, userId) {
  console.log(`handleConfigureSubscription: Started for user ID: ${userId}`);
  const formInputs = event.commonEventObject.formInputs;
  const sheetsUrlInput = formInputs && formInputs['sheetsUrl'] && formInputs['sheetsUrl'].stringInputs && formInputs['sheetsUrl'].stringInputs.value[0];

  if (!sheetsUrlInput) return { renderActions: createAlertCard('Error: Please provide a valid Google Sheets URL.') };

  const folderId = event.commonEventObject.parameters.folderId;
  const userToken = event.authorizationEventObject.userOAuthToken;

  if (!folderId || !userToken) return { renderActions: createAlertCard('Error: Missing folder context or user token.') };

  const match = sheetsUrlInput.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return { renderActions: createAlertCard('Error: Could not extract Spreadsheet ID.') };
  const spreadsheetId = match[1];

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: userToken });

  try {

    const payload = {
      targetResource: `//drive.googleapis.com/files/${folderId}`,
      eventTypes: ['google.workspace.drive.file.v3.created'],
      notificationEndpoint: { pubsubTopic: `projects/${PROJECT_ID}/topics/${TOPIC_NAME}` },
      payloadOptions: { includeResource: false },
      driveOptions: { includeDescendants: true }
    };
    console.log(`Sending Create Subscription request to Workspace Events API for folder: ${folderId}`);

    // Since Workspace Events v1beta may not be published in the googleapis discovery docs yet,
    // we make an authenticated request directly using the OAuth client to the REST endpoint.
    const response = await auth.request({
      method: 'POST',
      url: 'https://workspaceevents.googleapis.com/v1beta/subscriptions',
      data: payload
    });

    let subscriptionName = response.data.response ? response.data.response.name : response.data.name;
    if (!subscriptionName) throw new Error('Failed to parse subscription name.');
    console.log(`Successfully created Workspace Events subscription: ${subscriptionName}`);

    await firestore.collection('drive-event-subscriptions').doc(encodeURIComponent(subscriptionName)).set({
      subscriptionName: subscriptionName,
      folderId: folderId,
      spreadsheetId: spreadsheetId,
      spreadsheetUrl: sheetsUrlInput,
      userId: userId, // SAVE STABLE USER ID HERE
      createdAt: new Date().toISOString()
    });
    console.log(`Successfully saved subscription mapping to Firestore for ${subscriptionName}`);

    return { renderActions: createAlertCard('Success! Subscription created and linked to your Google Sheet.') };
  } catch (error) {
    const isConflict = error.code === 409 || (error.response && error.response.status === 409) || error.message.includes('already exists');
    if (isConflict) {
      console.log('Subscription already exists, attempting to recover the mapping from Workspace Events API...');
      try {
        const filterStr = `event_types:"google.workspace.drive.file.v3.created" AND target_resource="//drive.googleapis.com/files/${folderId}"`;
        const listResponse = await auth.request({
          method: 'GET',
          url: `https://workspaceevents.googleapis.com/v1beta/subscriptions?filter=${encodeURIComponent(filterStr)}`
        });
        
        const subs = listResponse.data.subscriptions || [];
        const targetResource = `//drive.googleapis.com/files/${folderId}`;
        const existingSub = subs.find(s => s.targetResource === targetResource);
        
        if (!existingSub) throw new Error('Subscription purportedly exists but was not found in recovery lookup.');
        
        const subscriptionName = existingSub.name;
        console.log(`Successfully recovered existing subscription: ${subscriptionName}`);
        
        await firestore.collection('drive-event-subscriptions').doc(encodeURIComponent(subscriptionName)).set({
          subscriptionName: subscriptionName,
          folderId: folderId,
          spreadsheetId: spreadsheetId,
          spreadsheetUrl: sheetsUrlInput,
          userId: userId,
          createdAt: new Date().toISOString()
        });
        return { renderActions: createAlertCard('Success! Existing subscription recovered and re-linked to your Google Sheet.') };
      } catch (recoveryError) {
        console.error('Error recovering subscription:', recoveryError);
        return { renderActions: createAlertCard(`Error recovering subscription: ${recoveryError.message}`) };
      }
    }

    console.error('Error creating subscription:', error);
    return { renderActions: createAlertCard(`Error creating subscription: ${error.message}`) };
  }
}

function createAlertCard(message) {
  return {
    action: {
      navigations: [{
        pushCard: { sections: [{ widgets: [{ textParagraph: { text: message } }] }] }
      }]
    }
  };
}
