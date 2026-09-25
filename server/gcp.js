// Thin wrappers around the real GCP APIs this dashboard reads from:
//   - Cloud Build API   -> build list / detail / manual trigger run
//   - Cloud Logging API -> tail of a build's log
//   - Cloud Storage     -> built APKs + short-lived signed download URLs
//
// Auth: Application Default Credentials. Locally that's whatever
// `gcloud auth application-default login` set up; on Cloud Run it's the
// service's attached service account. No keys are stored by this app.

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const { Storage } = require("@google-cloud/storage");
const { Logging } = require("@google-cloud/logging");
const config = require("./config");

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
const auth = new GoogleAuth({ scopes: SCOPES });

const storage = new Storage({ projectId: config.projectId });
const logging = new Logging({ projectId: config.projectId });

let cloudbuildClient = null;
async function cloudbuild() {
  if (cloudbuildClient) return cloudbuildClient;
  const authClient = await auth.getClient();
  cloudbuildClient = google.cloudbuild({ version: "v1", auth: authClient });
  return cloudbuildClient;
}

function shortSha(build) {
  return (
    build.substitutions?.SHORT_SHA ||
    build.sourceProvenance?.resolvedRepoSource?.commitSha?.slice(0, 7) ||
    null
  );
}

function branchName(build) {
  return (
    build.substitutions?.BRANCH_NAME ||
    build.source?.repoSource?.branchName ||
    null
  );
}

function summarize(build) {
  return {
    id: build.id,
    status: build.status, // QUEUED, WORKING, SUCCESS, FAILURE, TIMEOUT, CANCELLED, ...
    branch: branchName(build),
    sha: shortSha(build),
    createTime: build.createTime,
    startTime: build.startTime,
    finishTime: build.finishTime,
    logUrl: build.logUrl,
    triggerId: build.buildTriggerId || null,
    steps: (build.steps || []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      timing: s.timing || null,
    })),
  };
}

async function listBuilds(limit = 30) {
  const cb = await cloudbuild();
  const filter = config.triggerId ? `trigger_id="${config.triggerId}"` : undefined;
  const res = await cb.projects.builds.list({
    projectId: config.projectId,
    pageSize: limit,
    filter,
  });
  return (res.data.builds || []).map(summarize);
}

async function getBuild(buildId) {
  const cb = await cloudbuild();
  const res = await cb.projects.builds.get({ projectId: config.projectId, id: buildId });
  return summarize(res.data);
}

// Manually fires the configured trigger against a branch, same as a real
// push would — this is what the dashboard's "Run build now" button calls.
async function runTrigger(branch = "main") {
  if (!config.triggerId) {
    throw new Error("CLOUD_BUILD_TRIGGER_ID is not set — can't run a trigger manually.");
  }
  const cb = await cloudbuild();
  const res = await cb.projects.triggers.run({
    projectId: config.projectId,
    triggerId: config.triggerId,
    requestBody: { branchName: branch },
  });
  // Long-running operation; metadata.build carries the new build's id/status.
  return res.data?.metadata?.build ? summarize(res.data.metadata.build) : res.data;
}

async function getBuildLogTail(buildId, limit = 200) {
  const filter = [
    'resource.type="build"',
    `resource.labels.build_id="${buildId}"`,
  ].join(" AND ");

  const [entries] = await logging.getEntries({
    filter,
    orderBy: "timestamp desc",
    pageSize: limit,
  });

  return entries
    .map((e) => ({
      timestamp: e.metadata.timestamp,
      text:
        typeof e.data === "string"
          ? e.data
          : e.data?.textPayload || JSON.stringify(e.data),
    }))
    .reverse();
}

// Built APKs live at gs://BUCKET/[<any prefix>/]<branch>/<short-sha>/app-release.apk
// (matching infra/cloudbuild.yaml's artifacts.objects.location — the
// prefix itself, e.g. "apk/", doesn't matter here: branch and commit are
// read off the last three path segments, whatever sits in front of them).
async function listApks(limit = 50) {
  const [files] = await storage.bucket(config.apkBucket).getFiles({
    matchGlob: "**/*.apk",
  });

  files.sort((a, b) => new Date(b.metadata.updated) - new Date(a.metadata.updated));

  return files.slice(0, limit).map((f) => {
    const parts = f.name.split("/"); // [...prefix/]<branch>/<sha>/app-release.apk
    const n = parts.length;
    return {
      path: f.name,
      branch: n >= 3 ? parts[n - 3] : null,
      sha: n >= 3 ? parts[n - 2] : null,
      size: Number(f.metadata.size),
      updated: f.metadata.updated,
    };
  });
}

async function signedApkUrl(objectPath) {
  // Guard against path traversal / escaping the bucket namespace.
  if (objectPath.includes("..") || objectPath.startsWith("/")) {
    throw new Error("Invalid object path.");
  }
  const [url] = await storage
    .bucket(config.apkBucket)
    .file(objectPath)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });
  return url;
}

module.exports = { listBuilds, getBuild, runTrigger, getBuildLogTail, listApks, signedApkUrl };
