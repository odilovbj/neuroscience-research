const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8787;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "survey-responses.json");

// MIME types
const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// ===== HELPERS =====

function send(res, status, data, type = "text/plain") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(data);
}

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return "id_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

// ===== STATIC FILES =====

function serveStatic(req, res) {
  let filePath =
    req.url === "/"
      ? path.join(ROOT, "full.html")
      : path.join(ROOT, req.url);

  // prevent path traversal
  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      return send(res, 404, "Not Found");
    }

    const ext = path.extname(filePath);
    const type = MIME_TYPES[ext] || "application/octet-stream";

    send(res, 200, content, type);
  });
}

// ===== SERVER =====

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return send(res, 200, "");
  }

  // ===== API =====

  // GET responses
  if (url.pathname === "/api/responses" && req.method === "GET") {
    return send(res, 200, JSON.stringify(readData()), "application/json");
  }

  // POST response
  if (url.pathname === "/api/responses" && req.method === "POST") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      // protect from large payloads
      if (body.length > 1e6) req.destroy();
    });

    req.on("end", () => {
      try {
        const incoming = JSON.parse(body);

        const data = readData();

        const newEntry = {
          id: generateId(),
          createdAt: new Date().toISOString(),
          ...incoming
        };

        data.push(newEntry);
        writeData(data);

        return send(
          res,
          200,
          JSON.stringify({ success: true }),
          "application/json"
        );
      } catch {
        return send(
          res,
          400,
          JSON.stringify({ success: false, error: "Invalid JSON" }),
          "application/json"
        );
      }
    });

    return;
  }

  // GET stats
  if (url.pathname === "/api/stats" && req.method === "GET") {
    const data = readData();

    return send(
      res,
      200,
      JSON.stringify({
        totalResponses: data.length
      }),
      "application/json"
    );
  }

  // ===== STATIC =====
  serveStatic(req, res);
});

// ===== START =====

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
