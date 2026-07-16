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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "qwerty#3825";
const BACKUP_DIR = path.join(ROOT, "backups");
const MAX_BACKUPS = 25;

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
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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
  try {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify({ next: n + 1 }, null, 2));
  } catch (err) {
    console.error("Could not persist participant counter:", err.message);
  }
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
  try {
    fs.writeFileSync(STARTS_FILE, JSON.stringify(starts, null, 2));
  } catch (err) {
    console.error("Could not record survey start:", err.message);
  }
  return starts.length;
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

  if (url.pathname === "/api/starts" && req.method === "POST") {
    const total = appendStart();
    return send(res, 200, JSON.stringify({ ok: true, total }), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    const starts = readStarts().length;
    const completions = readRows().length;
    return send(res, 200, JSON.stringify({ starts, completions }), { "Content-Type": "application/json; charset=utf-8" });
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("Survey collector running");
  console.log(`Local:   http://localhost:${PORT}`);
  for (const url of networkUrls()) console.log(`Network: ${url}`);
  console.log("Responses will be saved to survey-responses.json");
});
