const $ = (sel) => document.querySelector(sel);

function fmtDuration(startTime, finishTime) {
  if (!startTime) return "—";
  const end = finishTime ? new Date(finishTime) : new Date();
  const ms = end - new Date(startTime);
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function fmtSize(bytes) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function statusLabel(status) {
  return { SUCCESS: "Succeeded", FAILURE: "Failed", TIMEOUT: "Timed out", WORKING: "Running", QUEUED: "Queued", CANCELLED: "Cancelled" }[status] || status;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showError(msg) {
  const el = $("#global-error");
  el.textContent = msg;
  el.hidden = false;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("not signed in");
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || body.error || `Request failed: ${path}`);
  return body;
}

async function loadMe() {
  try {
    const me = await api("/api/me");
    $("#who-email").textContent = me.email;
    if (me.picture) {
      $("#who-pic").src = me.picture;
      $("#who-pic").hidden = false;
    }
  } catch {
    /* handled by redirect in api() */
  }
}

async function loadBuilds() {
  const tbody = $("#builds-body");
  try {
    const builds = await api("/api/builds");
    if (!builds.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">No builds yet — push a commit, or use "Run build now".</td></tr>`;
      return;
    }
    tbody.innerHTML = builds
      .map(
        (b) => `
      <tr class="clickable" data-build-id="${esc(b.id)}">
        <td class="mono">${esc(b.id.slice(0, 8))}</td>
        <td class="mono">${esc(b.branch) || "—"}</td>
        <td class="mono">${esc(b.sha) || "—"}</td>
        <td>${fmtRelative(b.createTime)}</td>
        <td class="mono">${fmtDuration(b.startTime, b.finishTime)}</td>
        <td><span class="pill ${esc(b.status)}">${esc(statusLabel(b.status))}</span></td>
      </tr>`
      )
      .join("");
    tbody.querySelectorAll("tr[data-build-id]").forEach((row) => {
      row.addEventListener("click", () => openLog(row.dataset.buildId));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Couldn't load builds: ${err.message}</td></tr>`;
  }
}

async function loadApks() {
  const tbody = $("#apks-body");
  try {
    const apks = await api("/api/apks");
    if (!apks.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">No APKs published yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = apks
      .map(
        (a) => `
      <tr>
        <td class="mono">${esc(a.path.split("/").pop())}</td>
        <td class="mono">${esc(a.branch) || "—"}</td>
        <td class="mono">${esc(a.sha) || "—"}</td>
        <td>${fmtSize(a.size)}</td>
        <td>${fmtRelative(a.updated)}</td>
        <td><button class="download" data-path="${encodeURIComponent(a.path)}">Download</button></td>
      </tr>`
      )
      .join("");
    tbody.querySelectorAll("button.download").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "…";
        try {
          const { url } = await api(`/api/apks/download?path=${btn.dataset.path}`);
          window.location.href = url;
        } catch (err) {
          showError(`Couldn't get a download link: ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = "Download";
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Couldn't load APKs: ${err.message}</td></tr>`;
  }
}

async function openLog(buildId) {
  $("#log-modal").hidden = false;
  $("#log-title").textContent = `Build ${buildId}`;
  $("#log-body").textContent = "Loading log…";
  try {
    const entries = await api(`/api/builds/${buildId}/logs`);
    $("#log-body").textContent = entries.length
      ? entries.map((e) => e.text).join("\n")
      : "No log entries yet.";
  } catch (err) {
    $("#log-body").textContent = `Couldn't load log: ${err.message}`;
  }
}

let commitsLoaded = false;
let commitSkip = 0;
let currentBranch = null;
const COMMIT_PAGE_SIZE = 30;

async function loadBranches() {
  const select = $("#branch-select");
  try {
    const branches = await api("/api/repo/branches");
    const preferred = branches.find((b) => b.name === "testing") || branches[0];
    select.innerHTML = branches
      .map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`)
      .join("");
    if (preferred) select.value = preferred.name;
    currentBranch = select.value;
  } catch (err) {
    select.innerHTML = `<option>—</option>`;
    showError(`Couldn't load branches: ${err.message}`);
  }
}

$("#branch-select").addEventListener("change", () => {
  currentBranch = $("#branch-select").value;
  $("#commit-diff").innerHTML = `<div class="empty">Select a commit to view its changes.</div>`;
  loadCommits();
});

function diffLineClass(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

function renderDiffFile(file) {
  const bodyLines = file.patch
    .split("\n")
    .filter((l) => !l.startsWith("diff --git") && !l.startsWith("index "));
  const lines = bodyLines
    .map((l) => `<div class="diff-line ${diffLineClass(l)}">${esc(l) || "&nbsp;"}</div>`)
    .join("");
  return `
    <div class="diff-file">
      <div class="diff-file-header">${esc(file.path)} <span class="mono">(${esc(file.status)})</span></div>
      <div class="diff-lines">${lines}</div>
    </div>`;
}

async function loadCommitDiff(sha) {
  const panel = $("#commit-diff");
  panel.innerHTML = `<div class="empty">Loading diff…</div>`;
  document.querySelectorAll("#commit-list li.commit-row").forEach((li) => {
    li.classList.toggle("active", li.dataset.sha === sha);
  });
  try {
    const commit = await api(`/api/repo/commits/${sha}`);
    if (commit.truncated) {
      panel.innerHTML = `<div class="empty">This commit's diff is too large to display here.</div>`;
      return;
    }
    const header = `
      <div class="commit-diff-header">
        <div class="subject">${esc(commit.subject)}</div>
        <div class="meta mono">${esc(commit.sha.slice(0, 10))} · ${esc(commit.author)} · ${fmtRelative(commit.date)}</div>
      </div>`;
    const files = commit.files.length
      ? commit.files.map(renderDiffFile).join("")
      : `<div class="empty">No file changes.</div>`;
    panel.innerHTML = header + files;
  } catch (err) {
    panel.innerHTML = `<div class="empty">Couldn't load diff: ${esc(err.message)}</div>`;
  }
}

async function loadCommits(reset = true) {
  const list = $("#commit-list");
  const loadMoreBtn = $("#load-more-commits");
  if (reset) {
    commitSkip = 0;
    list.innerHTML = `<li class="empty">Loading commits…</li>`;
  }
  try {
    const branch = encodeURIComponent(currentBranch || "");
    const commits = await api(`/api/repo/commits?branch=${branch}&skip=${commitSkip}&limit=${COMMIT_PAGE_SIZE}`);
    if (reset) list.innerHTML = "";
    if (!commits.length && reset) {
      list.innerHTML = `<li class="empty">No commits found.</li>`;
    } else {
      list.insertAdjacentHTML(
        "beforeend",
        commits
          .map(
            (c) => `
        <li class="commit-row" data-sha="${esc(c.sha)}">
          <div class="commit-subject">${esc(c.subject)}</div>
          <div class="commit-meta mono">${esc(c.shortSha)} · ${esc(c.author)} · ${fmtRelative(c.date)}</div>
        </li>`
          )
          .join("")
      );
    }
    list.querySelectorAll("li.commit-row").forEach((li) => {
      li.onclick = () => loadCommitDiff(li.dataset.sha);
    });
    commitSkip += commits.length;
    loadMoreBtn.hidden = commits.length < COMMIT_PAGE_SIZE;
  } catch (err) {
    if (reset) list.innerHTML = `<li class="empty">Couldn't load commits: ${esc(err.message)}</li>`;
  }
}

$("#load-more-commits").addEventListener("click", () => loadCommits(false));

function switchView(view) {
  $("#view-builds").hidden = view !== "builds";
  $("#view-repo").hidden = view !== "repo";
  $("#nav-builds").classList.toggle("active", view === "builds");
  $("#nav-repo").classList.toggle("active", view === "repo");
  if (view === "repo" && !commitsLoaded) {
    commitsLoaded = true;
    loadBranches().then(loadCommits);
  }
}

$("#nav-builds").addEventListener("click", () => switchView("builds"));
$("#nav-repo").addEventListener("click", () => switchView("repo"));

$("#log-close").addEventListener("click", () => ($("#log-modal").hidden = true));
$("#log-modal").addEventListener("click", (e) => {
  if (e.target === $("#log-modal")) $("#log-modal").hidden = true;
});

$("#run-build").addEventListener("click", async () => {
  const btn = $("#run-build");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    await api("/api/builds/trigger", { method: "POST" });
    await loadBuilds();
  } catch (err) {
    showError(`Couldn't start a build: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run build now";
  }
});

function refresh() {
  loadBuilds();
  loadApks();
}

loadMe();
refresh();
setInterval(refresh, 10000); // poll every 10s for live status
