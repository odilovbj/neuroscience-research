# Migraine, Sleep & Memory — Adolescent Research Survey

A trilingual (Uzbek / Russian / English) web-based survey studying whether
**sleep quality mediates the relationship between adolescent migraine and
working memory**. Self-hosted, no external database — response data is
stored as JSON, backed up automatically, and synced to this GitHub repo so
it survives host restarts.

**Live site:** https://neuroscienceresearch.onrender.com

---

## What this measures

| Instrument | What it captures |
|---|---|
| **ID-Migraine™** (Lipton et al., 2003) | 3-item migraine screener |
| **PSQI** (Buysse et al., 1989) | Pittsburgh Sleep Quality Index — 7-component sleep quality score |
| **2-back task** | Working memory, scored with signal detection theory (d′, criterion c) |

Full variable-by-variable documentation (ranges, scoring notes, missing-data
policy) is in the **Codebook** tab of every XLSX export from the admin panel.

---

## Project structure

```
full.html               → the entire client app (survey + admin panel), single file
server.js                → Node.js collector server (no external dependencies)
package.json              → tells Render how to run it (npm start → node server.js)
survey-responses.json     → response data (auto-created, DO NOT edit by hand)
participant-counter.json  → sequential ID counter (auto-created)
survey-starts.json        → funnel tracking: how many people started (auto-created)
survey-dropouts.json      → funnel tracking: where people abandoned (auto-created)
sample-target.json        → shared sample-size target shown in admin panel (auto-created)
backups/                  → rolling local backups, last 25, auto-pruned (auto-created)
```

The four `.json` data files and `backups/` are created automatically on
first run — you never create or edit them directly.

---

## Running it locally

```bash
npm install
npm start
```

Visit `http://localhost:8787`. Admin panel: click "● Data" (bottom right),
password is set via `ADMIN_PASSWORD` env var (defaults to `qwerty#3825` if
unset — **change this if you deploy publicly**).

---

## Deploying on Render

1. **Build Command:** `npm install`
2. **Start Command:** `node server.js` (or `npm start`)
3. Set environment variables (see below)
4. Deploy — check the Logs tab for `Survey collector running`

### ⚠️ The most important thing to know about Render's free tier

Render's free web services have **no persistent disk** — every restart,
redeploy, or inactivity spin-down wipes the local filesystem clean. Without
the GitHub sync below, **your collected data will be silently deleted** the
next time the service restarts. This is not optional if you're using the
free tier for real data collection.

### Environment variables

| Variable | Required? | What it does |
|---|---|---|
| `GITHUB_TOKEN` | Strongly recommended | Personal access token, used to back up every write to GitHub |
| `GITHUB_REPO` | Required if using GITHUB_TOKEN | `yourusername/your-repo-name` |
| `GITHUB_BRANCH` | Optional | Defaults to `main` |
| `ADMIN_PASSWORD` | Optional | Overrides the default admin panel password |
| `PORT` | Set automatically by Render | Don't set this manually |

### Setting up the GitHub token (do this — don't skip it)

**Use a classic token, not fine-grained.** Fine-grained tokens have a
permissions model that's easy to misconfigure (this cost real debugging time
— see Troubleshooting below). Classic tokens with `repo` scope just work.

1. GitHub → Settings → Developer settings → **Personal access tokens → Tokens (classic)**
2. Generate new token (classic) → check the **`repo`** scope box → generate
3. Copy the token (`ghp_...`) → paste as `GITHUB_TOKEN` in Render's Environment tab
4. Set `GITHUB_REPO` to this repo's `owner/name`
5. Save → Render auto-redeploys

### How to confirm it's actually working (don't just trust the logs)

Visit `/api/health` on your deployed URL. Look for:

```json
"githubSync": { "configured": true, "writeVerified": true, ... }
```

`writeVerified: true` means the server actually tested writing to GitHub at
boot and confirmed it works — not just that the env vars are set. This is
the single most reliable way to check. If it says `false`, check the Render
logs right after boot for a line starting with `GitHub sync: ❌` — it names
the exact HTTP error and how to fix it.

---

## API reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Full status snapshot — uptime, GitHub sync status, counts |
| `/api/responses` | GET | All response data |
| `/api/responses` | POST | Save a response |
| `/api/responses/:id` | DELETE | Delete one response |
| `/api/next-id` | GET | Get the next sequential participant ID |
| `/api/stats` | GET | Funnel stats: starts, completions, dropouts |
| `/api/target` | GET / POST | Shared sample-size target |
| `/api/admin-auth` | POST | Verify admin password |
| `/api/admin-reset` | POST | Wipe all data (requires password) |
| `/api/dropout` | POST | Log a mid-survey abandonment (used automatically by the client) |
| `/api/starts` | POST | Log a survey start (used automatically by the client) |

---

## Admin panel features

Accessible via the "● Data" button (bottom right of the site):

- **Summary table** of all responses with data-quality flags (attention
  check, fast-completion, anticipatory responses, straight-lining, time
  inconsistency — combined into one `qc_exclude_recommended` column)
- **Charts** — PSQI vs. d′ scatter, migraine-group comparison bar chart
- **Funnel stats** — started / completed / dropped out, with completion rate
- **Sample-size tracker** — set a target, track progress, shared across
  every device (stored server-side, not per-browser)
- **Exports** — CSV, JSON, XLSX (with full codebook tab), or a bundled ZIP
- **Test Connection** — pings the server and reports pass/fail plainly
- **Reset Everything** — wipes all data (local + GitHub), with a forced
  backup download and double confirmation first. Irreversible.
- **Researcher preview mode** — visit `?preview=1` to take the survey
  yourself without it counting as a real response or triggering the
  one-time-participation lock

---

## Troubleshooting

**"GitHub sync enabled" in the logs, but nothing shows up in the repo.**
This exact thing happened during development — "enabled" only meant the env
vars were *set*, not that the token could actually *write*. Check
`/api/health` for `writeVerified: true`. If `false`, the token's permission
is wrong — see "Setting up the GitHub token" above, and use a classic token
if you're still on fine-grained.

**Data isn't showing up on a different device than where it was submitted.**
Almost always one of: (a) you tested with `?preview=1` in the URL, which
intentionally never saves anything, or (b) you're opening the admin panel on
a local copy of the HTML file instead of the live deployed URL. Confirm
you're on the actual Render URL, not `file://something`.

**A redeploy seems to have lost data.** Check `/api/health` — if
`githubSync.writeVerified` was `false` at the time, the redeploy wiped
whatever hadn't made it to GitHub. Once `writeVerified: true` is confirmed,
this stops being a risk going forward.

**Admin panel says "Wrong password."** Password is set via `ADMIN_PASSWORD`
env var in Render, defaulting to `qwerty#3825` if unset. Check what's
actually configured in your Environment tab.

---

## A note on data ethics

This survey collects data from minors (ages 12–18) on a health-related
topic. Consent is required before starting, a second assent confirmation
appears before the cognitive task, participation is fully anonymous, and a
one-time-per-device lock prevents duplicate participation. If you fork this
for a different study, review and adapt the consent language — don't just
reuse it verbatim for a different population or purpose.
