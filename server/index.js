const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const config = require("./config");
const { router: authRouter, requireAuth } = require("./auth");
const gcp = require("./gcp");
const repo = require("./repo");

const app = express();
app.use(express.json());
app.use(
  cookieSession({
    name: "uniforge_session",
    keys: [config.sessionSecret],
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
    sameSite: "lax",
    httpOnly: true,
  })
);

app.use(authRouter);

// login.html and the OAuth routes above must stay reachable when signed out.
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));
app.get("/login.html", (req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "login.html"))
);

app.use(requireAuth);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.get("/api/builds", async (req, res) => {
  try {
    res.json(await gcp.listBuilds());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "cloud_build_list_failed", message: err.message });
  }
});

app.get("/api/builds/:id", async (req, res) => {
  try {
    res.json(await gcp.getBuild(req.params.id));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "cloud_build_get_failed", message: err.message });
  }
});

app.get("/api/builds/:id/logs", async (req, res) => {
  try {
    res.json(await gcp.getBuildLogTail(req.params.id));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "logs_fetch_failed", message: err.message });
  }
});

app.post("/api/builds/trigger", async (req, res) => {
  try {
    const branch = req.body?.branch || "testing";
    res.json(await gcp.runTrigger(branch));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "trigger_run_failed", message: err.message });
  }
});

app.get("/api/apks", async (req, res) => {
  try {
    res.json(await gcp.listApks());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "apk_list_failed", message: err.message });
  }
});

app.get("/api/apks/download", async (req, res) => {
  try {
    const objectPath = req.query.path;
    if (!objectPath) return res.status(400).json({ error: "missing_path" });
    const url = await gcp.signedApkUrl(objectPath);
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "signed_url_failed", message: err.message });
  }
});

app.get("/api/repo/branches", async (req, res) => {
  try {
    res.json(await repo.listBranches());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "branch_list_failed", message: err.message });
  }
});

app.get("/api/repo/commits", async (req, res) => {
  try {
    res.json(
      await repo.listCommits({ branch: req.query.branch, skip: req.query.skip, limit: req.query.limit })
    );
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: "invalid_branch", message: err.message });
    }
    console.error(err);
    res.status(502).json({ error: "commit_list_failed", message: err.message });
  }
});

app.get("/api/repo/commits/:sha", async (req, res) => {
  try {
    res.json(await repo.getCommitDiff(req.params.sha));
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: "commit_not_found", message: err.message });
    }
    console.error(err);
    res.status(502).json({ error: "commit_diff_failed", message: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`UniForge dashboard listening on http://localhost:${config.port}`);
  console.log(`Project: ${config.projectId} · Bucket: gs://${config.apkBucket}`);
});
