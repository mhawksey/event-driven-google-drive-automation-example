# Google Drive to Google Sheets Notification Add-on Tutorial

This repository contains a demo Google Workspace Add-on built using Google Cloud HTTP Endpoints (Node.js) and the Workspace Events API.

This demo uses a modern **OAuth 2.0 Web Flow** architecture. It captures an offline `refresh_token` from the user, allowing a backend Cloud Function (triggered by Pub/Sub) to safely read newly added files from Drive and append them to a target Google Sheet securely on the user's behalf. 

## Repository Structure
- `/addon-handler/`: The Cloud Function that serves the Add-on UI cards, handles the OAuth Web callback, stores tokens in Firestore, and creates the Event Subscription.
- `/event-processor/`: The Cloud Function that receives Push Webhooks from Pub/Sub, executes OAuth flow via `refresh_token`, and securely appends a row to the Sheets file.
- `/terraform/`: Infrastructure-as-code configuration to deploy all required APIs, IAM bindings, Firestore DB, and Cloud Functions.
- `deployment.json`: The manifest file used to configure the Add-on.

---

## 🛠 Deployment Guide

### Prerequisites
1. **Google Cloud Project**: You must have a GCP project with billing enabled.
2. **Developer Preview**: Enroll in the [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview) to use Drive Events.
3. **Terraform**: Installed on your local machine.
4. **Google Cloud CLI (`gcloud`)**: Authenticated via `gcloud auth login` and `gcloud auth application-default login`.

---

### Step 1: Create OAuth Credentials
Because Terraform cannot fully automate the creation of OAuth Consent Screens and Client IDs for personal consumer accounts, you must set these up manually in the Cloud Console:

1. Open your GCP Project and go to **APIs & Services > OAuth consent screen**.
2. Configure your Consent Screen. Ensure you add these Scopes:
   - `.../auth/drive.readonly`
   - `.../auth/spreadsheets`
   - `.../auth/userinfo.email`
3. Go to **APIs & Services > Credentials**.
4. Click **Create Credentials > OAuth client ID**.
5. Select **Web application**.
6. Set the Name to "Drive Events Add-on".
7. Click **Create**. Copy the **Client ID** and **Client Secret**.

---

### Step 2: Deploy Infrastructure with Terraform
Navigate to the `terraform/` directory. You will be prompted to enter your the `project_id` and the `oauth_client_id` + secret you just created.

```bash
cd terraform
terraform init
terraform apply \
  -var="project_id=YOUR_PROJECT_ID" \
  -var="oauth_client_id=YOUR_CLIENT_ID" \
  -var="oauth_client_secret=YOUR_CLIENT_SECRET"
```
*Note: Terraform will deploy the Firestore DB, Pub/Sub Topics, and both Cloud Functions. This takes ~3-5 minutes.*

Once finished, Terraform will output `addon_handler_url`. 

1. Go to your GCP and open **APIs & Services > Credentials**.
2. Open your Client and in the **Authorized redirect URIs** add the `addon_handler_url` from the Terraform output. **Important** add a trailing '/'.

---

### Step 3: Configure the Workspace Add-on

1. Open the `deployment.json` file in the root directory.
2. Replace `URL_PLACEHOLDER_ADDON_HANDLER` with your actual `addon_handler_url` from the Terraform output.
3. Open the Google Cloud Console and navigate to **APIs & Services > Google Workspace Marketplace SDK**.
4. Enable the SDK if you haven't, then create a new HTTP Deployment.
5. Paste the updated contents of your `deployment.json` file and click **Save**.
6. Click **Install** under the HTTP Deployment tab to install the Add-on on your account.

---

### Step 4: Test the Flow
1. Open Google Drive in your browser.
2. Click the Add-on icon in the right side panel to open the Notifier.
3. The Add-on will instruct you to **"Authorize App"**.
4. Click the button. A new browser tab will open the Google OAuth Consent screen. 
5. Grant the permissions. You'll see an "Authorization Successful!" page letting you know you can safely close the tab.
6. Go back to Drive, click the **Back** arrow or reload the Add-on. 
7. Select any Folder in Drive. The Add-on will now show the subscription configuration form!
8. Paste the URL of any Google Sheet you own and click **Subscribe**.
9. Upload a new file into the selected Drive folder.
10. Check your Google Sheet. You should see a new row populated natively as you!

---

## 🔒 Alternative: Domain-Wide Delegation (Enterprise)
The robust OAuth strategy implemented in this demo ensures safety and scalability for consumer Apps and distributed Add-ons. 
However, **if you are deploying an internal Add-on exclusively for users within your own Google Workspace Domain**, you might prefer Domain-Wide Delegation (DWD):
- DWD allows a backend Service Account to impersonate any user in your organization perfectly transparently without requiring consent screens or storing refresh tokens.
- To use DWD, the Google Workspace Super Admin simply authorizes the Service Account's Client ID with the specific API scopes sitewide in the Workspace Admin Console.

## 🧹 Cleanup / Teardown
```bash
cd terraform
terraform destroy \
  -var="project_id=YOUR_PROJECT_ID" \
  -var="oauth_client_id=YOUR_CLIENT_ID" \
  -var="oauth_client_secret=YOUR_CLIENT_SECRET"
```


---

## 🚀 Moving to Production

This Add-on is designed as a demonstration of the Workspace Events API, Google Cloud infrastructure, and OAuth web flows. If you are planning to take this solution to a production environment, please consider the following enhancements:

### 1. Subscription Renewal
Workspace Events API subscriptions have an expiration time. This demo creates a subscription but does not manage its lifecycle. In a production app, you should:
- Save the subscription `expireTime` or TTL in Firestore.
- Implement a scheduled job (e.g., using Cloud Scheduler) to periodically trigger a Cloud Function that reads active subscriptions from Firestore and calls the [`subscriptions.patch` endpoint](https://developers.google.com/workspace/events/reference/rest/v1/subscriptions/patch) to extend the `ttl` before it expires. Because we set `includeResource: false` when creating the subscription, it can last up to 7 days, but can be programmatically renewed

### 2. Broadening Event Types
This demo exclusively uses the `google.workspace.drive.file.v3.created` event type to monitor when new files are added. 
Depending on your use case, you can expand this to include other events supported by the API, such as deletions, updates, or permission changes. Check out the [Drive Events documentation](https://developers.google.com/workspace/events/guides/events-drive) for the full list of supported event types.

### 3. Monitoring the Dead Letter Queue (DLQ)
This project automatically provisions a [Dead Letter Topic](https://cloud.google.com/pubsub/docs/dead-letter-topics) (`drive-addon-events-dlq`) via Terraform. If the `event-processor` fails processing (e.g., due to API rate limits, invalid tokens, or temporary outages), the message is retried 5 times and then routed to the DLQ. 
- **Production Tip**: Ensure you configure active alerting (like Cloud Monitoring alerts) on this DLQ topic so you are notified when unprocessable events accumulate. These messages can then be inspected and replayed manually without data loss.

### 4. Robust Error Handling & Cleanup
The current `event-processor` relies on standard Pub/Sub retries. In a mature setup, you should also handle token revocations (e.g., if a user revokes the Add-on access) gracefully and ensure you actively clean up orphaned subscriptions and states in Firestore to prevent database bloat over time.

