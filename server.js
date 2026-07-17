/**
 * Migraine, Sleep & Memory Survey — collector server
 * ----------------------------------------------------
 * Serves the survey (public/index.html) and implements the small JSON API
 * the front-end already expects (see the `apiUrl(...)` calls in the HTML):
 *
 *   POST   /api/responses            save one finished submission
 *   GET    /api/responses            list all saved submissions (admin panel)
 *   DELETE /api/responses/:id        remove one submission by participant_id (or date fallback)
 *   POST   /api/starts               anonymous "someone opened the survey" ping
 *   POST   /api/dropout              anonymous "someone left before finishing" ping
 *   GET    /api/stats                { starts, completions, dropouts } funnel numbers
 *   GET    /api/next-id              { id: "participant7" } — next sequential participant id
 *   POST   /api/admin-auth           { password } -> { ok: true|false }
 *
 * Storage: flat JSON files under ./data (no external database needed).
 * Writes are serialized through a tiny in-process queue so two people
 * finishing the survey at the same instant can't corrupt the file.
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

// ── Config ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RESPONSES_FILE = path.join(DATA_DIR, 'responses.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const DROPOUTS_FILE = path.join(DATA_DIR, 'dropouts.json');
// Set a real password via the ADMIN_PASSWORD env var in production.
// This default only exists so the app runs out of the box; change it.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

// ── Tiny persistence layer (JSON file + write queue) ────────────────────
async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const [file, initial] of [
    [RESPONSES_FILE, []],
    [DROPOUTS_FILE, []],
    [META_FILE, { starts: 0 }],
  ]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify(initial, null, 2));
    }
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// Serializes read-modify-write operations per file so concurrent requests
// never clobber each other. `mutator` receives the current array/object
// and returns the new value to persist.
const queues = new Map();
function withFileLock(file, fallback, mutator) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev
    .catch(() => {}) // don't let one failure jam the queue forever
    .then(async () => {
      const current = await readJson(file, fallback);
      const result = await mutator(current);
      await writeJson(file, result.value);
      return result.returned;
    });
  queues.set(file, next);
  return next;
}

// ── App setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
// navigator.sendBeacon() sends the dropout ping as a Blob; some browsers
// label that "text/plain" instead of "application/json", so also parse
// JSON bodies that arrive under that content-type.
app.use(express.text({ type: 'text/plain', limit: '2mb' }));

function parseMaybeJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

// ── Routes: responses ───────────────────────────────────────────────────
function participantIdOf(row) {
  return row && (row.participant_id || row.pid || row.demo?.pid) || null;
}

app.post('/api/responses', async (req, res) => {
  const row = parseMaybeJsonBody(req);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return res.status(400).json({ ok: false, error: 'Body must be a JSON object.' });
  }
  if (!row.date) row.date = new Date().toISOString();
  if (!row.__savedAt) row.__savedAt = Date.now();

  await withFileLock(RESPONSES_FILE, [], async (rows) => {
    rows.push(row);
    return { value: rows, returned: null };
  });

  res.status(201).json({ ok: true });
});

app.get('/api/responses', async (_req, res) => {
  const rows = await readJson(RESPONSES_FILE, []);
  res.json(rows);
});

app.delete('/api/responses/:id', async (req, res) => {
  const identity = decodeURIComponent(req.params.id || '');
  if (!identity) return res.status(400).json({ ok: false, error: 'Missing id.' });

  const removed = await withFileLock(RESPONSES_FILE, [], async (rows) => {
    const keep = [];
    let removedCount = 0;
    for (const row of rows) {
      const pid = participantIdOf(row);
      const matches = (pid && pid === identity) || row.date === identity;
      if (matches) removedCount++;
      else keep.push(row);
    }
    return { value: keep, returned: removedCount };
  });

  res.json({ ok: true, removed });
});

// ── Routes: funnel tracking (starts / dropouts / stats) ────────────────
app.post('/api/starts', async (_req, res) => {
  await withFileLock(META_FILE, { starts: 0 }, async (meta) => {
    const m = meta && typeof meta === 'object' ? meta : {};
    m.starts = (m.starts || 0) + 1;
    return { value: m, returned: null };
  });
  res.status(201).json({ ok: true });
});

app.post('/api/dropout', async (req, res) => {
  const body = parseMaybeJsonBody(req);
  const entry = {
    step: body.step ?? null,
    reason: body.reason ?? null,
    durSec: body.durSec ?? null,
    ts: Date.now(),
  };
  await withFileLock(DROPOUTS_FILE, [], async (list) => {
    const l = Array.isArray(list) ? list : [];
    l.push(entry);
    return { value: l, returned: null };
  });
  // sendBeacon ignores the response, but respond cleanly for the fetch fallback.
  res.status(201).json({ ok: true });
});

app.get('/api/stats', async (_req, res) => {
  const [meta, dropouts, responses] = await Promise.all([
    readJson(META_FILE, { starts: 0 }),
    readJson(DROPOUTS_FILE, []),
    readJson(RESPONSES_FILE, []),
  ]);
  res.json({
    starts: meta.starts || 0,
    completions: responses.length,
    dropouts: dropouts.length,
  });
});

// ── Routes: sequential participant id ───────────────────────────────────
app.get('/api/next-id', async (_req, res) => {
  const rows = await readJson(RESPONSES_FILE, []);
  res.json({ id: 'participant' + (rows.length + 1) });
});

// ── Routes: admin auth ───────────────────────────────────────────────────
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/admin-auth', (req, res) => {
  const { password } = req.body || {};
  const ok = typeof password === 'string' && timingSafeEqual(password, ADMIN_PASSWORD);
  res.json({ ok });
});

// ── Static files (the survey itself) ────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: any unmatched non-API route serves the survey (single page app).
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

// ── Start ────────────────────────────────────────────────────────────────
ensureDataFiles()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Survey collector running: http://localhost:${PORT}`);
      console.log(`Data directory: ${DATA_DIR}`);
      if (ADMIN_PASSWORD === 'change-me') {
        console.warn('⚠️  Using the default admin password. Set ADMIN_PASSWORD before going live.');
      }
    });
  })
  .catch((err) => {
    console.error('Failed to initialize data directory:', err);
    process.exit(1);
  });
