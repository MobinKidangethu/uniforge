// Commit history + diffs for the app repo, read by shelling out to `git`
// against a local bare clone — Cloud Source Repositories has no REST API
// for log/diff, it's just a git remote. Auth reuses the same Application
// Default Credentials as gcp.js: a cloud-platform access token doubles as
// a git HTTP Bearer token against source.developers.google.com.
//
// Branches are fetched lazily, one at a time, only when actually viewed —
// this repo has 20+ branches (per-ticket mtpc/* branches, production/
// codepush/* and production/scope/* release-tracking branches) and pulling
// all of them upfront would be slow and mostly wasted. Listing branch
// *names* uses `ls-remote`, which is cheap (ref names only, no commit data
// transferred).

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const config = require("./config");
const { auth } = require("./googleAuth");

const execFileP = promisify(execFile);

const REPO_DIR = path.join(__dirname, ".data", "repo-mirror");
const REMOTE_URL = `https://source.developers.google.com/p/${config.projectId}/r/${config.repoName}`;

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const MAX_PATCH_BYTES = 300 * 1024;

async function bearerToken() {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function git(args, { gitDir = true } = {}) {
  const token = await bearerToken();
  const baseArgs = gitDir ? ["--git-dir", REPO_DIR] : [];
  const { stdout } = await execFileP(
    "git",
    [...baseArgs, "-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args],
    { maxBuffer: 1024 * 1024 * 32 }
  );
  return stdout;
}

let repoReady = null;
function ensureRepo() {
  if (!repoReady) {
    repoReady = (async () => {
      if (!fs.existsSync(REPO_DIR)) {
        fs.mkdirSync(path.dirname(REPO_DIR), { recursive: true });
        await execFileP("git", ["init", "--bare", REPO_DIR]);
        await execFileP("git", ["--git-dir", REPO_DIR, "remote", "add", "origin", REMOTE_URL]);
        // Partial clone: fetches below only pull commit/tree metadata, not
        // file content (blobs) — this repo's history carries large binary
        // assets (bundles, images, the signing keystore) across years of
        // commits, which made a full fetch take minutes. `git show`/`git
        // diff` transparently lazy-fetch just the blobs a given commit
        // actually needs, the first time that commit's diff is opened.
        await execFileP("git", ["--git-dir", REPO_DIR, "config", "remote.origin.promisor", "true"]);
        await execFileP("git", [
          "--git-dir",
          REPO_DIR,
          "config",
          "remote.origin.partialclonefilter",
          "blob:none",
        ]);
      }
    })().catch((err) => {
      repoReady = null;
      throw err;
    });
  }
  return repoReady;
}

async function listBranches() {
  const out = await git(["ls-remote", "--heads", REMOTE_URL], { gitDir: false });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return { name: ref.replace(/^refs\/heads\//, ""), sha };
    });
}

async function ensureBranch(branch) {
  if (!BRANCH_RE.test(branch)) {
    const err = new Error("Invalid branch name.");
    err.status = 400;
    throw err;
  }
  await ensureRepo();
  // Always re-fetch rather than caching "already fetched" — branches are
  // live and this needs to reflect new pushes. Thanks to the blob:none
  // filter (see ensureRepo), even a first fetch of a branch's full commit
  // history is small — it's metadata only, no file content.
  await git(["fetch", "--no-tags", "--filter=blob:none", "origin", `+${branch}:${branch}`]);
}

async function listCommits({ branch = config.repoBranch, skip = 0, limit = 30 } = {}) {
  await ensureBranch(branch);
  const format = ["%H", "%h", "%an", "%ae", "%ad", "%s"].join(FIELD_SEP) + RECORD_SEP;
  const out = await git([
    "log",
    `refs/heads/${branch}`,
    `--skip=${Number(skip) || 0}`,
    `--max-count=${Number(limit) || 30}`,
    "--date=iso-strict",
    `--pretty=format:${format}`,
  ]);
  return out
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, shortSha, author, email, date, subject] = record.split(FIELD_SEP);
      return { sha, shortSha, author, email, date, subject };
    });
}

function fileStatus(fileDiff) {
  if (/^new file mode/m.test(fileDiff)) return "added";
  if (/^deleted file mode/m.test(fileDiff)) return "deleted";
  if (/^rename from/m.test(fileDiff)) return "renamed";
  return "modified";
}

function filePath(fileDiff) {
  const m = fileDiff.match(/^diff --git a\/(.+) b\/(.+)$/m);
  return m ? m[2] : "unknown";
}

// A commit's objects are only present locally once some branch containing
// it has been fetched via ensureBranch — `git show` on an unfetched sha
// fails cleanly (mapped to 404 below), it never reaches out to the remote.
async function getCommitDiff(sha) {
  if (!SHA_RE.test(sha)) {
    const err = new Error("Invalid commit sha.");
    err.status = 404;
    throw err;
  }
  await ensureRepo();
  const format = ["%H", "%an", "%ad", "%s"].join(FIELD_SEP) + RECORD_SEP;
  let out;
  try {
    out = await git(["show", sha, `--format=${format}`, "--patch"]);
  } catch (e) {
    const err = new Error("Commit not found.");
    err.status = 404;
    throw err;
  }

  const sepIndex = out.indexOf(RECORD_SEP);
  const [commitSha, author, date, subject] = out.slice(0, sepIndex).split(FIELD_SEP);
  const patchText = out.slice(sepIndex + 1);

  if (Buffer.byteLength(patchText, "utf8") > MAX_PATCH_BYTES) {
    return { sha: commitSha, author, date, subject, truncated: true, files: [] };
  }

  const chunks = patchText.split(/(?=^diff --git )/m).filter((c) => c.trim());
  const files = chunks.map((chunk) => ({
    path: filePath(chunk),
    status: fileStatus(chunk),
    patch: chunk,
  }));

  return { sha: commitSha, author, date, subject, truncated: false, files };
}

module.exports = { listBranches, listCommits, getCommitDiff };
