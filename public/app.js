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
      <tr class="clickable" data-build-id="${b.id}">
        <td class="mono">${b.id.slice(0, 8)}</td>
        <td class="mono">${b.branch || "—"}</td>
        <td class="mono">${b.sha || "—"}</td>
        <td>${fmtRelative(b.createTime)}</td>
        <td class="mono">${fmtDuration(b.startTime, b.finishTime)}</td>
        <td><span class="pill ${b.status}">${statusLabel(b.status)}</span></td>
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
        <td class="mono">${a.path.split("/").pop()}</td>
        <td class="mono">${a.branch || "—"}</td>
        <td class="mono">${a.sha || "—"}</td>
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

$("#log-close").addEventListener("click", () => ($("#log-modal").hidden = true));
$("#log-modal").addEventListener("click", (e) => {
  if (e.target === $("#log-modal")) $("#log-modal").hidden = true;
});

$("#run-build").addEventListener("click", async () => {
  const branch = $("#branch-select").value;
  const btn = $("#run-build");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    await api("/api/builds/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
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
