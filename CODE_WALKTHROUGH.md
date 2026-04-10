# Code Walkthrough

This document provides a detailed breakdown of the two main Node.js Cloud Functions that power the Drive Events Add-on: `addon-handler` and `event-processor`.

---

## 1. Add-on Handler (`/addon-handler/index.js`)

This Cloud Function acts as the "frontend" API for your Workspace Add-on. It handles both generating the UI that appears in the Google Drive sidebar and managing the OAuth 2.0 Web Flow required to capture offline user tokens.

### The OAuth 2.0 Web Flow (GET Requests)
Unlike standard Workspace Apps Scripts which automatically handle authorization silently, we implement a full Web Flow callback because we require secure offline access via a `refresh_token`.

When receiving a `GET` request without a `code` parameter, it generates an authorization URL with `access_type: 'offline'` and redirects the user browser:
```javascript
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // Force consent prompt to guarantee we get a refresh_token
  state: stateToken,
  scope: [ ... ]
});
```

When the user accepts and is redirected back with an authorization `code`, the handler exchanges this code for a standard `refresh_token` and an `id_token`. The `id_token` is used to firmly identify the user (`userId = ticket.getPayload().sub`) so the `refresh_token` can be securely saved in Firestore mapping exactly to that user ID.

### Rendering the Add-on UI (POST Requests)
When the user clicks around the Add-on in Google Drive, Workspace executes HTTP `POST` requests sending an event object describing the user's context.

The script examines this context out of `req.body`:
- **Authentication Check**: Dynamically decodes `event.authorizationEventObject.userIdToken` (an offline verifiable JWT) to match its precise audience, and then evaluates it using `oauth2Client.verifyIdToken()` to cryptographically extract the user's ID securely with zero network latency. It also extracts `event.authorizationEventObject.userOAuthToken` for later API operations.
- **Card Routing**: 
  - If we are responding to an explicit user interaction (e.g., clicking a button), we target the route using the action parameter (like `configure_subscription`).
  - If the user selects a Drive folder (`event.drive.activeCursorItem`), we route them to the `buildDriveContextualCard` returning JSON representing the Workspace Card Framework schema mapping configuring the folder.
  - If nothing is selected, we prompt the user to select a folder (`buildHomePageCard`).

### Creating the Event Subscription
When the user clicks "Subscribe", `handleConfigureSubscription` is executed. Because creating a subscription maps a user to an underlying Push Topic, we must execute the Subscription request using the standard `access_token` provided by the Add-on event payload itself.

```javascript
const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: userToken });

const payload = {
  targetResource: `//drive.googleapis.com/files/${folderId}`,
  eventTypes: ['google.workspace.drive.file.v3.created'],
  notificationEndpoint: { pubsubTopic: `projects/${PROJECT_ID}/topics/${TOPIC_NAME}` },
  payloadOptions: { includeResource: false },
};
const response = await auth.request({
  method: 'POST',
  url: 'https://workspaceevents.googleapis.com/v1beta/subscriptions',
  data: payload
});
```
We immediately save a database mapping linking `Subscription ID -> Folder ID -> Spreadsheet URL -> User ID`. This bridging lookup is critical for offline event processing.

***Self-Healing Recovery:*** *If Workspace rejects the POST request with a 409 Conflict because a subscription already exists for this folder, the Add-on automatically falls back. It executes a `subscriptions.list` query containing a strict URL-encoded `filter` string to pull down the active matching subscription, and seamlessly recovers the lost mapping into Firestore without failing!*


---

## 2. Event Processor (`/event-processor/index.js`)

This Cloud Function runs completely in the background. It is triggered by Google Cloud Pub/Sub whenever a Push Webhook arrives from the Workspace Events engine.

### Demultiplexing the Event
Workspace Events API webhooks contain lightweight pointers to the Drive modification (which file changed and what triggered it), but naturally *do not* contain user identity payloads or authorization tokens.

**Handling Lifecycle Events vs Data Events**
Before executing business logic, the processor checks the `ce-type` attribute. Google Workspace emits lifecycle events alongside standard data events. Most notably, it will fire a `google.workspace.events.subscription.v1.expirationReminder` event when a subscription is nearing its expiration time. The demo gracefully drops these expiration reminders to simplify the code, but in a production environment, you could listen for this specific event type and dynamically renew the subscription.

For standard data events, the raw Pub/Sub message contains base64 encoded event bodies alongside `attributes`. The script successfully unpacks the event and searches for the explicit internal `subscriptionId`:
```javascript
let subscriptionId = event.subscription || event.name;
if (pubsubMessage.attributes) {
  subscriptionId = pubsubMessage.attributes.subscription || pubsubMessage.attributes['ce-subject'];
}
```

### Looking Up Configuration & Re-Authenticating
The script maps the extracted `subscriptionId` to the Firestore mapping created earlier by the Add-on Handler. 
```javascript
const mappedSubscription = await firestore.collection('drive-event-subscriptions').doc(subscriptionId).get();
const { spreadsheetId, userId } = mappedSubscription.data();
```

Now knowing exactly who created the subscription (`userId`) and where they want Data sent (`spreadsheetId`), the script fetches that specific user's `refresh_token` out of the database and sets up asynchronous API clients *acting perfectly as the user*:
```javascript
const refreshToken = tokenDoc.data().refresh_token;

// Authenticate AS THE USER
const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: refreshToken });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
```

### Extracting Context & Executing Action
Because the Workspace Event is very lightweight (`includeResource: false`), the processor only initially receives the `fileId`.

It immediately invokes `drive.files.get` on behalf of the user to fetch rich runtime metadata (name, mimeType, webViewLink, etc).
```javascript
const fileRes = await drive.files.get({ fileId: fileId, fields: 'id, name, mimeType, webViewLink' });
```

Finally, it takes this extracted file metadata and executes a standard `spreadsheets.values.append` to synchronously write a new row to the bottom of the configured Google Sheet!

***Handling Revoked Tokens***: 
*If an API call triggers an `invalid_grant` error (usually meaning the user revoked permissions or the offline token naturally expired), the process catches this exception gracefully. It immediately deletes the expired token from Firestore and drops the event (returning anHTTP 200). This prevents Pub/Sub from endlessly retrying the failure into the DLQ, and allows the Add-on Handler to cleanly prompt the user to re-authorize the next time they open the sidebar.*
