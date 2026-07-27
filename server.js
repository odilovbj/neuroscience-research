// ============================================================================
// Migraine, Sleep & Memory Survey — Collector Server
// ============================================================================
// Serves full.html and collects survey responses to a local JSON file.
// On Render's free tier (and any host without a persistent disk), local files
// are wiped on every restart/redeploy/spin-down — so every write here is also
// pushed to a GitHub repo, and pulled back down on boot. See the GITHUB CONFIG
// section below for the three env vars that turn this on.
// ============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

// ── CORE CONFIG ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, "full.html");
const DATA_FILE = path.join(ROOT, "survey-responses.json");
const COUNTER_FILE = path.join(ROOT, "participant-counter.json");
const STARTS_FILE = path.join(ROOT, "survey-starts.json");
const DROPOUTS_FILE = path.join(ROOT, "survey-dropouts.json");
const TARGET_FILE = path.join(ROOT, "sample-target.json");
const BACKUP_DIR = path.join(ROOT, "backups");
const MAX_BACKUPS = 25;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "qwerty#3825";

// ── GITHUB-BACKED PERSISTENCE ────────────────────────────────────────────────
// Set these three in Render's Environment tab to enable it:
//   GITHUB_TOKEN  - classic PAT with 'repo' scope (simplest, most reliable),
//                   or a fine-grained token with Contents: Read and write
//                   on the target repo specifically
//   GITHUB_REPO   - "yourusername/your-repo-name"
//   GITHUB_BRANCH - optional, defaults to "main"
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_REPO || "";
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED = !!(GH_TOKEN && GH_REPO);
const GH_SHA_CACHE = {}; // relPath -> last known blob sha, avoids an extra GET before every PUT
let GH_WRITE_VERIFIED = null; // null = not tested yet, true/false after boot self-test

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
    if (!res.ok) {
      console.error(`GitHub GET ${relPath} failed: ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    const json = await res.json();
    GH_SHA_CACHE[relPath] = json.sha;
    return Buffer.from(json.content, "base64").toString("utf8");
  } catch (err) {
    console.error(`GitHub GET ${relPath} error:`, err.message);
    return null;
  }
}

async function githubPutFile(relPath, content) {
  if (!GH_ENABLED) return { ok: false, reason: "sync disabled" };
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${relPath}`;
    const body = {
      message: `sync ${relPath} (${new Date().toISOString()})`,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: GH_BRANCH
    };
    if (GH_SHA_CACHE[relPath]) body.sha = GH_SHA_CACHE[relPath];
    let res = await fetch(url, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });

    if (res.status === 409 || res.status === 422) {
      const fresh = await fetch(url + `?ref=${encodeURIComponent(GH_BRANCH)}`, { headers: ghHeaders() });
      if (fresh.ok) {
        const j = await fresh.json();
        GH_SHA_CACHE[relPath] = j.sha;
        body.sha = j.sha;
        res = await fetch(url, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`GitHub PUT ${relPath} failed: ${res.status} ${errText}`);
      return { ok: false, reason: `HTTP ${res.status}`, detail: errText };
    }
    const j = await res.json();
    GH_SHA_CACHE[relPath] = j.content.sha;
    return { ok: true };
  } catch (err) {
    console.error(`GitHub PUT ${relPath} error:`, err.message);
    return { ok: false, reason: err.message };
  }
}

async function restoreFromGitHubIfMissing(localFile, relPath) {
  if (!GH_ENABLED) return;
  try {
    if (fs.existsSync(localFile)) return;
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
    console.log("GitHub sync: DISABLED (set GITHUB_TOKEN + GITHUB_REPO env vars to enable). Data will NOT survive a restart on a host without a persistent disk.");
    return;
  }
  console.log(`GitHub sync: configured -> ${GH_REPO}@${GH_BRANCH} (verifying write access next...)`);
  await restoreFromGitHubIfMissing(DATA_FILE, "survey-responses.json");
  await restoreFromGitHubIfMissing(COUNTER_FILE, "participant-counter.json");
  await restoreFromGitHubIfMissing(STARTS_FILE, "survey-starts.json");
  await restoreFromGitHubIfMissing(DROPOUTS_FILE, "survey-dropouts.json");
  await restoreFromGitHubIfMissing(TARGET_FILE, "sample-target.json");
}

async function verifyGithubWriteAccess() {
  if (!GH_ENABLED) { GH_WRITE_VERIFIED = false; return; }
  // Read-only check: ask GitHub what permissions this token actually has on the
  // repo, via a plain GET. This used to write a small test file to confirm write
  // access — but that created a real commit on every single boot, which Render
  // treats as a new push and tries to redeploy, burning pipeline minutes in a
  // loop. A GET request creates no commit and can never trigger a deploy.
  try {
    const url = `https://api.github.com/repos/${GH_REPO}`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) {
      GH_WRITE_VERIFIED = false;
      console.log(`GitHub sync: \u274c CANNOT REACH REPO \u2014 HTTP ${res.status}. Check GITHUB_REPO is spelled correctly and the token has access to it.`);
      return;
    }
    const info = await res.json();
    const canPush = !!(info.permissions && info.permissions.push);
    GH_WRITE_VERIFIED = canPush;
    if (canPush) {
      console.log("GitHub sync: \u2705 WRITE ACCESS VERIFIED (read-only check, no commit made) \u2014 your token can actually save data. You're good.");
    } else {
      console.log("GitHub sync: \u274c WRITE ACCESS FAILED \u2014 token can read this repo but does not have push/write permission.");
      console.log("  Fix: use a classic token (Settings > Developer settings > Tokens (classic)) with the 'repo' scope,");
      console.log("  or check that your fine-grained token has Contents: Read and write on this exact repo.");
    }
  } catch (err) {
    GH_WRITE_VERIFIED = false;
    console.log("GitHub sync: \u274c COULD NOT VERIFY \u2014 network error:", err.message);
  }
}

// ── LOCAL BACKUPS ────────────────────────────────────────────────────────────
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

// ── RESPONSE DATA ────────────────────────────────────────────────────────────
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

function writeRows(rows) {
  backupBeforeWrite();
  const content = JSON.stringify(rows, null, 2);
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, DATA_FILE);
  githubPutFile("survey-responses.json", content).catch(() => {});
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

function deleteRow(identity) {
  const rows = readRows();
  const next = rows.filter(item => {
    const pid = String(item.pid || item.participant_id || "");
    const date = String(item.date || "");
    return pid !== identity && date !== identity;
  });
  const removed = rows.length - next.length;
  if (removed > 0) writeRows(next);
  return removed;
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

// ── FUNNEL TRACKING (starts / dropouts) ──────────────────────────────────────
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

// ── SAMPLE-SIZE TARGET ───────────────────────────────────────────────────────
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

// ── ADMIN RESET (wipes everything, locally AND on GitHub) ───────────────────
function resetAllData() {
  writeRows([]);
  const counterContent = JSON.stringify({ next: 1 }, null, 2);
  fs.writeFileSync(COUNTER_FILE, counterContent);
  githubPutFile("participant-counter.json", counterContent).catch(() => {});
  fs.writeFileSync(STARTS_FILE, "[]");
  githubPutFile("survey-starts.json", "[]").catch(() => {});
  fs.writeFileSync(DROPOUTS_FILE, "[]");
  githubPutFile("survey-dropouts.json", "[]").catch(() => {});
  console.log("ADMIN RESET: all response/counter/starts/dropouts data wiped");
}

// ── MISC HELPERS ─────────────────────────────────────────────────────────────
function networkUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${PORT}`);
    }
  }
  return urls;
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  });
  res.end(body);
}

const startedAt = Date.now();

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch (err) {
    return send(res, 400, "Bad request");
  }

  if (req.method === "OPTIONS") {
    return send(res, 204, "");
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    return send(res, 200, JSON.stringify({
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      githubSync: {
        configured: GH_ENABLED,
        writeVerified: GH_WRITE_VERIFIED,
        repo: GH_ENABLED ? `${GH_REPO}@${GH_BRANCH}` : null
      },
      counts: {
        responses: readRows().length,
        starts: readStarts().length,
        dropouts: readDropouts().length
      },
      sampleTarget: readTarget()
    }, null, 2), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/responses" && req.method === "GET") {
    return send(res, 200, JSON.stringify(readRows()), { "Content-Type": "application/json; charset=utf-8" });
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

  if (url.pathname.startsWith("/api/responses/") && req.method === "DELETE") {
    const identity = decodeURIComponent(url.pathname.slice("/api/responses/".length));
    const removed = deleteRow(identity);
    return send(res, 200, JSON.stringify({ ok: true, removed }), { "Content-Type": "application/json; charset=utf-8" });
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
      resetAllData();
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
      return send(res, 200, JSON.stringify({ ok: false }), { "Content-Type": "application/json; charset=utf-8" });
    }
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    return send(res, 200, JSON.stringify({
      starts: readStarts().length,
      completions: readRows().length,
      dropouts: readDropouts().length
    }), { "Content-Type": "application/json; charset=utf-8" });
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

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/full.html")) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Could not load full.html: " + err.message);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

// ── BOOT SEQUENCE ─────────────────────────────────────────────────────────────
(async () => {
  await restoreAllFromGitHub();
  await verifyGithubWriteAccess();

  server.listen(PORT, "0.0.0.0", () => {
    console.log("═══════════════════════════════════════════════════");
    console.log("Survey collector running");
    console.log(`Local:   http://localhost:${PORT}`);
    for (const url of networkUrls()) console.log(`Network: ${url}`);
    console.log(`Health check: /api/health`);
    if (GH_ENABLED && GH_WRITE_VERIFIED) {
      console.log("Data persistence: \u2705 local disk + GitHub (verified working)");
    } else if (GH_ENABLED && !GH_WRITE_VERIFIED) {
      console.log("Data persistence: \u26a0\ufe0f  local disk ONLY \u2014 GitHub sync is configured but NOT working, see errors above");
    } else {
      console.log("Data persistence: \u26a0\ufe0f  local disk ONLY \u2014 will NOT survive a restart on a host without a persistent disk");
    }
    console.log("═══════════════════════════════════════════════════");
  });
})();
