const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const config = require("./config");

const router = express.Router();
const oauthClient = new OAuth2Client(
  config.oauthClientId,
  config.oauthClientSecret,
  config.oauthRedirectUri
);

function isAllowed(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (config.allowedEmails.includes(lower)) return true;
  if (config.allowedDomain) {
    const domain = lower.split("@")[1];
    if (domain === config.allowedDomain) return true;
  }
  return false;
}

router.get("/auth/login", (req, res) => {
  const url = oauthClient.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
  });
  res.redirect(url);
});

router.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing OAuth code.");

  try {
    const { tokens } = await oauthClient.getToken(code);
    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.oauthClientId,
    });
    const payload = ticket.getPayload();

    if (!payload.email_verified || !isAllowed(payload.email)) {
      return res
        .status(403)
        .send(`Signed in as ${payload.email}, which isn't on the allow list for this dashboard.`);
    }

    req.session.user = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };
    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback failed:", err);
    res.status(500).send("Sign-in failed. Check server logs.");
  }
});

router.get("/auth/logout", (req, res) => {
  req.session = null;
  res.redirect("/login.html");
});

router.get("/api/me", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "not_signed_in" });
  res.json(req.session.user);
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "not_signed_in" });
  }
  return res.redirect("/login.html");
}

module.exports = { router, requireAuth };
