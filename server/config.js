require("dotenv").config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

module.exports = {
  projectId: required("GCP_PROJECT_ID"),
  apkBucket: required("GCP_APK_BUCKET"),
  triggerId: process.env.CLOUD_BUILD_TRIGGER_ID || null,

  repoName: process.env.GCP_SOURCE_REPO || "MTPC-rewamp",
  repoBranch: process.env.GCP_SOURCE_REPO_BRANCH || "testing",

  oauthClientId: required("GOOGLE_OAUTH_CLIENT_ID"),
  oauthClientSecret: required("GOOGLE_OAUTH_CLIENT_SECRET"),
  oauthRedirectUri: required("GOOGLE_OAUTH_REDIRECT_URI"),

  allowedEmails: (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  allowedDomain: (process.env.ALLOWED_DOMAIN || "").trim().toLowerCase() || null,

  sessionSecret: required("SESSION_SECRET"),
  port: Number(process.env.PORT || 8080),
};
