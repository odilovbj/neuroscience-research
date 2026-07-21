const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, "full.html");
const DATA_FILE = path.join(ROOT, "survey-responses.json");
const COUNTER_FILE = path.join(ROOT, "participant-counter.json");
const STARTS_FILE = path.join(ROOT, "survey-starts.json");
const DROPOUTS_FILE = path.join(ROOT, "survey-dropouts.json");
const TARGET_FILE = path.join(ROOT, "sample-target.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "qwerty#3825";
const BACKUP_DIR = path.join(ROOT, "backups");
const MAX_BACKUPS = 25;

// ── GitHub-backed persistence ──────────────────────────────────────────────
// Render's free tier (and any plan without an attached Persistent Disk) wipes
// the local filesystem on every restart, redeploy, or spin-down. To survive
// that, every write to a tracked JSON file is also pushed to a GitHub repo,
// and on boot we try to restore from GitHub before falling back to empty.
// Set these three env vars in Render's dashboard to enable it:
//   GITHUB_TOKEN  - a personal access token with 'repo' (or fine-grained
//                   Contents read/write) scope on the target repo
//   GITHUB_REPO   - "yourusername/your-repo-name"
//   GITHUB_BRANCH - optional, defaults to "main"
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_REPO || "";
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED = !!(GH_TOKEN && GH_REPO);
const GH_SHA_CACHE = {}; // relPath -> last known blob sha, avoids an extra GET before every PUT

function ghHeaders() {
  return {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "survey-app-sync"
  };
}

async function githubGetFile(relPath) {
  if (!GH_ENABLED) return null;
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${relPath}?ref=${encodeURIComponent(GH_BRANCH)}`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) { console.error(`GitHub GET ${relPath} failed:`, res.status); return null; }
    const json = await res.json();
    GH_SHA_CACHE[relPath] = json.sha;
    return Buffer.from(json.content, "base64").toString("utf8");
  } catch (err) {
    console.error(`GitHub GET ${relPath} error:`, err.message);
    return null;
  }
}

async function githubPutFile(relPath, content) {
  if (!GH_ENABLED) return false;
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${relPath}`;
    const body = {
      message: `sync ${relPath} (${new Date().toISOString()})`,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: GH_BRANCH
    };
    if (GH_SHA_CACHE[relPath]) body.sha = GH_SHA_CACHE[relPath];
    const res = await fetch(url, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) {
      // sha mismatch (someone/something else updated the file) \u2014 refetch and retry once
      const fresh = await fetch(url + `?ref=${encodeURIComponent(GH_BRANCH)}`, { headers: ghHeaders() });
      if (fresh.ok) {
        const j = await fresh.json();
        GH_SHA_CACHE[relPath] = j.sha;
        body.sha = j.sha;
        const retry = await fetch(url, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
        if (retry.ok) { GH_SHA_CACHE[relPath] = (await retry.json()).content.sha; return true; }
      }
      return false;
    }
    if (!res.ok) { console.error(`GitHub PUT ${relPath} failed:`, res.status, await res.text()); return false; }
    const j = await res.json();
    GH_SHA_CACHE[relPath] = j.content.sha;
    return true;
  } catch (err) {
    console.error(`GitHub PUT ${relPath} error:`, err.message);
    return false;
  }
}

async function restoreFromGitHubIfMissing(localFile, relPath) {
  if (!GH_ENABLED) return;
  try {
    if (fs.existsSync(localFile)) return; // local copy already present, nothing to restore
    const remote = await githubGetFile(relPath);
    if (remote !== null) {
      fs.writeFileSync(localFile, remote);
      console.log(`Restored ${relPath} from GitHub (${remote.length} bytes)`);
    }
  } catch (err) {
    console.error(`Restore ${relPath} from GitHub failed:`, err.message);
  }
}

async function restoreAllFromGitHub() {
  if (!GH_ENABLED) {
    console.log("GitHub sync disabled (set GITHUB_TOKEN + GITHUB_REPO env vars to enable). Data will NOT survive a Render restart on the free tier.");
    return;
  }
  console.log(`GitHub sync enabled -> ${GH_REPO}@${GH_BRANCH}`);
  await restoreFromGitHubIfMissing(DATA_FILE, "survey-responses.json");
  await restoreFromGitHubIfMissing(COUNTER_FILE, "participant-counter.json");
  await restoreFromGitHubIfMissing(STARTS_FILE, "survey-starts.json");
  await restoreFromGitHubIfMissing(DROPOUTS_FILE, "survey-dropouts.json");
  await restoreFromGitHubIfMissing(TARGET_FILE, "sample-target.json");
}

const apiHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers, ...apiHeaders });
  res.end(body);
}

function readRows() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Could not read survey-responses.json:", err.message);
    return [];
  }
}

function backupBeforeWrite() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(BACKUP_DIR, `survey-responses-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("survey-responses-") && f.endsWith(".json"))
      .sort();
    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch (err) { /* ignore */ }
    }
  } catch (err) {
    console.error("Backup failed (continuing anyway):", err.message);
  }
}

function writeRows(rows) {
  backupBeforeWrite();
  const content = JSON.stringify(rows, null, 2);
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, DATA_FILE);
  githubPutFile("survey-responses.json", content).catch(() => {});
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function nextParticipantId() {
  let n = 1;
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const c = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
      n = Number(c.next) || 1;
    } else {
      n = readRows().length + 1;
    }
  } catch (err) {
    n = readRows().length + 1;
  }
  const content = JSON.stringify({ next: n + 1 }, null, 2);
  try {
    fs.writeFileSync(COUNTER_FILE, content);
  } catch (err) {
    console.error("Could not persist participant counter:", err.message);
  }
  githubPutFile("participant-counter.json", content).catch(() => {});
  return "participant" + n;
}

function deleteRow(identity) {
  const rows = readRows();
  const id = String(identity);
  const next = rows.filter(item => {
    const pid = String(item.pid || item.participant_id || "");
    const date = String(item.date || "");
    return pid !== id && date !== id;
  });
  const removed = rows.length - next.length;
  if (removed > 0) writeRows(next);
  return removed;
}

function upsertRow(row) {
  const rows = readRows();
  const pid = String(row.pid || row.participant_id || `p${Date.now()}${Math.random().toString(36).slice(2, 8)}`);
  const normalized = { ...row, pid };
  const index = rows.findIndex(item => String(item.pid || item.participant_id) === pid);
  if (index >= 0) rows[index] = normalized;
  else rows.push(normalized);
  writeRows(rows);
  return { row: normalized, count: rows.length };
}

function readStarts() {
  try {
    if (!fs.existsSync(STARTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(STARTS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function appendStart() {
  const starts = readStarts();
  starts.push({ date: new Date().toISOString() });
  const content = JSON.stringify(starts, null, 2);
  try {
    fs.writeFileSync(STARTS_FILE, content);
  } catch (err) {
    console.error("Could not record survey start:", err.message);
  }
  githubPutFile("survey-starts.json", content).catch(() => {});
  return starts.length;
}

function readDropouts() {
  try {
    if (!fs.existsSync(DROPOUTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(DROPOUTS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function appendDropout(entry) {
  const dropouts = readDropouts();
  dropouts.push({ date: new Date().toISOString(), step: entry.step ?? null, reason: entry.reason ?? null, durSec: entry.durSec ?? null });
  const content = JSON.stringify(dropouts, null, 2);
  try {
    fs.writeFileSync(DROPOUTS_FILE, content);
  } catch (err) {
    console.error("Could not record dropout:", err.message);
  }
  githubPutFile("survey-dropouts.json", content).catch(() => {});
  return dropouts.length;
}

function readTarget() {
  try {
    if (!fs.existsSync(TARGET_FILE)) return 60;
    const parsed = JSON.parse(fs.readFileSync(TARGET_FILE, "utf8"));
    return Number(parsed.target) > 0 ? Number(parsed.target) : 60;
  } catch (err) {
    return 60;
  }
}

function writeTarget(n) {
  const content = JSON.stringify({ target: n }, null, 2);
  try {
    fs.writeFileSync(TARGET_FILE, content);
  } catch (err) {
    console.error("Could not save sample target:", err.message);
  }
  githubPutFile("sample-target.json", content).catch(() => {});
}

function networkUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${PORT}`);
    }
  }
  return urls;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/api/health") {
    return send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/responses" && req.method === "GET") {
    return send(res, 200, JSON.stringify(readRows()), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/next-id" && req.method === "GET") {
    return send(res, 200, JSON.stringify({ id: nextParticipantId() }), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/admin-auth" && req.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const ok = typeof body.password === "string" && body.password === ADMIN_PASSWORD;
      return send(res, 200, JSON.stringify({ ok }), { "Content-Type": "application/json; charset=utf-8" });
    } catch (err) {
      return send(res, 400, JSON.stringify({ ok: false, error: err.message }), { "Content-Type": "application/json; charset=utf-8" });
    }
  }

  if (url.pathname === "/api/admin-reset" && req.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      if (typeof body.password !== "string" || body.password !== ADMIN_PASSWORD) {
        return send(res, 401, JSON.stringify({ ok: false, error: "wrong password" }), { "Content-Type": "application/json; charset=utf-8" });
      }
      // Wipe every tracked file, locally AND on GitHub, so a restart/redeploy can't silently restore old data.
      writeRows([]); // also creates a local rolling backup of what existed before, via backupBeforeWrite()
      const counterContent = JSON.stringify({ next: 1 }, null, 2);
      fs.writeFileSync(COUNTER_FILE, counterContent);
      githubPutFile("participant-counter.json", counterContent).catch(() => {});
      fs.writeFileSync(STARTS_FILE, "[]");
      githubPutFile("survey-starts.json", "[]").catch(() => {});
      fs.writeFileSync(DROPOUTS_FILE, "[]");
      githubPutFile("survey-dropouts.json", "[]").catch(() => {});
      console.log("ADMIN RESET: all response/counter/starts/dropouts data wiped");
      return send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json; charset=utf-8" });
    } catch (err) {
      return send(res, 500, JSON.stringify({ ok: false, error: err.message }), { "Content-Type": "application/json; charset=utf-8" });
    }
  }

  if (url.pathname === "/api/starts" && req.method === "POST") {
    const total = appendStart();
    return send(res, 200, JSON.stringify({ ok: true, total }), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/dropout" && req.method === "POST") {
    try {
      const raw = await readRequestBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const total = appendDropout(body);
      return send(res, 200, JSON.stringify({ ok: true, total }), { "Content-Type": "application/json; charset=utf-8" });
    } catch (err) {
      return send(res, 200, JSON.stringify({ ok: false }), { "Content-Type": "application/json; charset=utf-8" }); // never error out on a best-effort beacon
    }
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    const starts = readStarts().length;
    const completions = readRows().length;
    const dropouts = readDropouts().length;
    return send(res, 200, JSON.stringify({ starts, completions, dropouts }), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/target" && req.method === "GET") {
    return send(res, 200, JSON.stringify({ target: readTarget() }), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/target" && req.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const n = Number(body.target);
      if (!n || n < 1) return send(res, 400, JSON.stringify({ ok: false, error: "invalid target" }), { "Content-Type": "application/json; charset=utf-8" });
      writeTarget(n);
      return send(res, 200, JSON.stringify({ ok: true, target: n }), { "Content-Type": "application/json; charset=utf-8" });
    } catch (err) {
      return send(res, 400, JSON.stringify({ ok: false, error: err.message }), { "Content-Type": "application/json; charset=utf-8" });
    }
  }

  if (url.pathname.startsWith("/api/responses/") && req.method === "DELETE") {
    const pid = decodeURIComponent(url.pathname.slice("/api/responses/".length));
    if (!pid) {
      return send(res, 400, JSON.stringify({ ok: false, error: "Missing participant id" }), { "Content-Type": "application/json; charset=utf-8" });
    }
    const removed = deleteRow(pid);
    return send(res, 200, JSON.stringify({ ok: true, removed }), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/responses" && req.method === "POST") {
    try {
      const row = JSON.parse(await readRequestBody(req));
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return send(res, 400, JSON.stringify({ ok: false, error: "Expected a response object" }), { "Content-Type": "application/json; charset=utf-8" });
      }
      const saved = upsertRow(row);
      return send(res, 200, JSON.stringify({ ok: true, count: saved.count, pid: saved.row.pid }), { "Content-Type": "application/json; charset=utf-8" });
    } catch (err) {
      return send(res, 400, JSON.stringify({ ok: false, error: err.message }), { "Content-Type": "application/json; charset=utf-8" });
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/full.html")) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Could not read full.html");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

(async () => {
  await restoreAllFromGitHub();
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Survey collector running");
    console.log(`Local:   http://localhost:${PORT}`);
    for (const url of networkUrls()) console.log(`Network: ${url}`);
    console.log("Responses will be saved to survey-responses.json" + (GH_ENABLED ? " and synced to GitHub" : " (LOCAL ONLY \u2014 will not survive a restart on Render's free tier)"));
  });
})();
