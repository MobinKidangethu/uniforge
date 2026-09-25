# UniForge dashboard

A real, working web app over the pipeline from `uniforge-cicd`: it calls the
Cloud Build API, Cloud Logging API, and Cloud Storage directly — no sample
data. Sign-in is Google OAuth, gated to an email/domain allow list.

- **Recent builds** — live status, branch, commit, duration, polling every
  10s. Click a row to see its real log tail (Cloud Logging).
- **Run build now** — actually fires the Cloud Build trigger for the branch
  you pick, the same as a real push would.
- **Built APKs** — lists what's actually in the GCS bucket, grouped by
  branch/commit, with a real signed download URL (15-minute expiry, minted
  on click — nothing is left public).

## 1. Prerequisites

- Node.js 18+
- The `uniforge-cicd` pipeline already set up (bucket, trigger) — this app reads
  its output. If you haven't run that yet, see its README first.
- `gcloud auth application-default login` run locally, with a user/account
  that has at least:
  - `roles/cloudbuild.builds.viewer` (and `roles/cloudbuild.builds.editor`
    if you want the "Run build now" button)
  - `roles/logging.viewer`
  - `roles/storage.objectViewer` on the APK bucket

## 2. Google Sign-In client

Create an OAuth 2.0 Client ID (Web application) at
console.cloud.google.com/apis/credentials:

- Authorized redirect URI: `http://localhost:8080/auth/callback`

Copy the client ID and secret into `.env` (step 4).

## 3. Install

```bash
npm install
```

## 4. Configure

```bash
cp .env.example .env
```

Fill in:

- `GCP_PROJECT_ID`, `GCP_APK_BUCKET` — match what you used in `uniforge-cicd`.
- `CLOUD_BUILD_TRIGGER_ID` — `gcloud builds triggers list --format='value(id,name)'`
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — from step 2.
- `ALLOWED_EMAILS` and/or `ALLOWED_DOMAIN` — who on your team can sign in.
- `SESSION_SECRET` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 5. Run

```bash
npm start
```

Open `http://localhost:8080`, sign in with an allow-listed Google account.

## Moving this to Cloud Run later

The app is already structured for it — Application Default Credentials
work the same way from a Cloud Run service account, so no code changes are
needed, only:

1. `gcloud run deploy uniforge-dashboard --source . --region us-central1 --no-allow-unauthenticated`
2. Update the OAuth client's redirect URI to the Cloud Run URL's
   `/auth/callback`, and `GOOGLE_OAUTH_REDIRECT_URI` in the deployed env.
3. Grant the Cloud Run service account the IAM roles listed in step 1, plus
   the deploy step's own `roles/run.invoker` for whoever should reach it —
   or front it with Identity-Aware Proxy for one-click Google-account
   restriction instead of managing `ALLOWED_EMAILS` by hand.

## Notes

- The signed download URL is generated fresh per click and expires in 15
  minutes — nobody can bookmark a permanent public link to an APK.
- `/api/builds/:id/logs` reads from Cloud Logging's build sink, so it only
  has entries after Cloud Build has actually written them; a build that
  just started may show an empty log for a few seconds.
