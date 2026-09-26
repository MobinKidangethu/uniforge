// Shared Application Default Credentials client, used by both gcp.js
// (Cloud Build/Logging/Storage APIs) and repo.js (git over HTTPS against
// Cloud Source Repositories — the same cloud-platform scope's access token
// doubles as a git Bearer token there).
const { GoogleAuth } = require("google-auth-library");

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
const auth = new GoogleAuth({ scopes: SCOPES });

module.exports = { auth };
