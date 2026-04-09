terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

variable "project_id" {
  description = "The ID of the project in which to provision resources"
  type        = string
}

variable "region" {
  description = "The region in which to provision resources"
  type        = string
  default     = "us-central1"
}

variable "oauth_client_id" {
  description = "The Google Web Application OAuth Client ID"
  type        = string
}

variable "oauth_client_secret" {
  description = "The Google Web Application OAuth Client Secret"
  type        = string
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# Fetch project details to get the project number for service accounts
data "google_project" "project" {
  project_id = var.project_id
}

# 1. Enable Required APIs
locals {
  services = [
    "cloudresourcemanager.googleapis.com", 
    "cloudfunctions.googleapis.com",       
    "eventarc.googleapis.com",             
    "cloudbuild.googleapis.com",           
    "run.googleapis.com",                  
    "artifactregistry.googleapis.com",     
    "firestore.googleapis.com",            
    "pubsub.googleapis.com",               
    "drive.googleapis.com",                
    "workspaceevents.googleapis.com",      
    "sheets.googleapis.com",               
    "gsuiteaddons.googleapis.com"          
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.key
  disable_on_destroy = false
}

resource "time_sleep" "wait_for_apis" {
  create_duration = "45s"
  depends_on      = [google_project_service.apis]
}

# 2. Firestore Database
resource "google_firestore_database" "database" {
  project     = var.project_id
  name        = "(default)"
  location_id = "nam5" 
  type        = "FIRESTORE_NATIVE"
  
  depends_on = [time_sleep.wait_for_apis]

  lifecycle {
    ignore_changes = [name]
  }
}

# 3. Pub/Sub Topic & Permissions
resource "google_pubsub_topic" "drive_events" {
  name       = "drive-addon-events-topic"
  depends_on = [time_sleep.wait_for_apis]
}

resource "google_pubsub_topic_iam_member" "drive_publisher" {
  topic  = google_pubsub_topic.drive_events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:drive-api-event-push@system.gserviceaccount.com"
}

# 4. Cloud Functions Infrastructure & Service Agent Permissions

# Explicitly grant Artifact Registry Reader to the Cloud Functions Service Agent
resource "google_project_iam_member" "gcf_ar_reader" {
  project    = var.project_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${data.google_project.project.number}@gcf-admin-robot.iam.gserviceaccount.com"
  depends_on = [time_sleep.wait_for_apis]
}

resource "google_storage_bucket" "function_bucket" {
  name     = "${var.project_id}-gcf-source"
  location = var.region
  uniform_bucket_level_access = true
  depends_on = [time_sleep.wait_for_apis]
}

# 5. Add-on Handler Function
data "archive_file" "addon_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../addon-handler"
  output_path = "${path.module}/addons-source.zip"
  excludes    = ["node_modules", "package-lock.json"]
}

resource "google_storage_bucket_object" "addon_archive" {
  name   = "addon-source-${data.archive_file.addon_zip.output_md5}.zip"
  bucket = google_storage_bucket.function_bucket.name
  source = data.archive_file.addon_zip.output_path
}

resource "google_cloudfunctions2_function" "addon_handler" {
  name        = "addon-handler"
  location    = var.region
  
  # Ensure the IAM binding is created before attempting to create the function
  depends_on  = [google_firestore_database.database, google_project_iam_member.gcf_ar_reader]

  build_config {
    runtime     = "nodejs20"
    entry_point = "addonHandler"
    source {
      storage_source {
        bucket = google_storage_bucket.function_bucket.name
        object = google_storage_bucket_object.addon_archive.name
      }
    }
  }

  service_config {
    max_instance_count = 5
    available_memory   = "256M"
    environment_variables = {
      GOOGLE_CLOUD_PROJECT = var.project_id
      TOPIC_NAME           = google_pubsub_topic.drive_events.name
      OAUTH_CLIENT_ID      = var.oauth_client_id
      OAUTH_CLIENT_SECRET  = var.oauth_client_secret
    }
  }
}

resource "google_cloud_run_service_iam_member" "addon_invoker" {
  location = google_cloudfunctions2_function.addon_handler.location
  service  = google_cloudfunctions2_function.addon_handler.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# 6. Event Processor Function
data "archive_file" "event_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../event-processor"
  output_path = "${path.module}/event-source.zip"
  excludes    = ["node_modules", "package-lock.json"]
}

resource "google_storage_bucket_object" "event_archive" {
  name   = "event-source-${data.archive_file.event_zip.output_md5}.zip"
  bucket = google_storage_bucket.function_bucket.name
  source = data.archive_file.event_zip.output_path
}

resource "google_cloudfunctions2_function" "event_processor" {
  name        = "event-processor"
  location    = var.region
  
  # Ensure the IAM binding is created before attempting to create the function
  depends_on  = [google_firestore_database.database, google_project_iam_member.gcf_ar_reader]

  build_config {
    runtime     = "nodejs20"
    entry_point = "processEvent"
    source {
      storage_source {
        bucket = google_storage_bucket.function_bucket.name
        object = google_storage_bucket_object.event_archive.name
      }
    }
  }

  service_config {
    max_instance_count = 5
    available_memory   = "256M"
    environment_variables = {
      GOOGLE_CLOUD_PROJECT = var.project_id
      VERIFY_TOKEN         = "false" 
      OAUTH_CLIENT_ID      = var.oauth_client_id
      OAUTH_CLIENT_SECRET  = var.oauth_client_secret
    }
  }
}

resource "google_service_account" "pubsub_invoker" {
  account_id   = "drive-pubsub-invoker"
  display_name = "Pub/Sub to Cloud Run Invoker"
}

resource "google_cloud_run_service_iam_member" "event_invoker" {
  location = google_cloudfunctions2_function.event_processor.location
  service  = google_cloudfunctions2_function.event_processor.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_invoker.email}"
}

# 7. Pub/Sub Push Subscription & Dead Letter Queue
resource "google_pubsub_topic" "drive_events_dlq" {
  name       = "drive-addon-events-dlq"
  depends_on = [time_sleep.wait_for_apis]
}

resource "google_project_service_identity" "pubsub_sa" {
  provider   = google-beta
  project    = var.project_id
  service    = "pubsub.googleapis.com"
  depends_on = [time_sleep.wait_for_apis]
}

# Grant the Pub/Sub Service account permission to create OIDC tokens
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.pubsub_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.pubsub_sa.email}"
}

# Grant the Pub/Sub Service account publisher role to the DLQ topic
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  topic  = google_pubsub_topic.drive_events_dlq.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_project_service_identity.pubsub_sa.email}"
}

# Grant the Pub/Sub Service account subscriber role on the project (needed for DLQ routing)
resource "google_project_iam_member" "pubsub_subscriber" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${google_project_service_identity.pubsub_sa.email}"
}

resource "google_pubsub_subscription" "drive_subscription" {
  name  = "drive-addon-events-sub"
  topic = google_pubsub_topic.drive_events.name

  depends_on = [
    google_pubsub_topic_iam_member.dlq_publisher,
    google_project_iam_member.pubsub_subscriber
  ]

  push_config {
    push_endpoint = google_cloudfunctions2_function.event_processor.service_config[0].uri
    oidc_token {
      service_account_email = google_service_account.pubsub_invoker.email
      audience              = google_cloudfunctions2_function.event_processor.service_config[0].uri
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.drive_events_dlq.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

output "addon_handler_url" {
  description = "The HTTP URL of the Add-on Handler function. Paste this into your deployment.json and set it as your OAuth Redirect URI."
  value       = google_cloudfunctions2_function.addon_handler.service_config[0].uri
}