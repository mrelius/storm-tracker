# Storm Tracker — Operator Notes

Internal reference for system administration, testing, and planning.

---

## Test System Status

### Automated Tests
- **Test count:** 432 tests across 25 test files
- **Last run result:** All passing (0 failures)
- **Test location:** `tests/` directory
- **How to run:** `venv/bin/python -m pytest tests/ -v`
- **Coverage areas:** Schema validation, radar providers (RainViewer, IEM, NEXRAD CC), alert ingestion/sorting, detection models, pipeline cooldown, geometry, alert engine lifecycle, alert service, WebSocket manager, client context, adapter, confidence, detectors, ETA, pipeline, client detection, threat scoring, smoothing, tracker, impact, intelligence

### Manual Verification
The following were verified during the final phase:
- App loads cleanly on LXC 119
- Health endpoint returns status=ok, db=ok, cache=ok
- NWS alerts fetch and render (typically 200–300 active alerts in database)
- Storm alert detection cycle runs every 60 seconds
- Feedback submission and review work end-to-end
- Header minimize/restore functions correctly
- No runtime errors in systemd journal
- Service survives restart with data persistence

---

## Simulator Removal Status

### What Was Removed
- **Simulation dropdown** (scenario selector) — removed from `templates/index.html`
- **Reset simulation button** — removed from `templates/index.html`
- **Simulation banner** ("SIMULATION MODE — NOT LIVE DATA") — removed from `templates/index.html`
- **Test Alert button** — removed from empty state in `storm-alert-panel.js`
- **Simulation control wiring** — removed from `storm-alert-panel.js` init function
- **Validation Mode button (VAL)** — removed from `templates/index.html` (debug tool)

### What Was Kept (Gated)
- **Backend simulation code** — `services/detection/simulator.py` remains in the codebase
- **Simulation API endpoints** — `/api/debug/simulate`, `/api/debug/simulate/reset`, `/api/debug/features` remain in `main.py`
- **Gate:** All simulation endpoints check `settings.debug_mode` and return `{"error": "Simulation disabled. Set DEBUG_MODE=true."}` when debug mode is off

### How to Re-Enable for Development
Set `DEBUG_MODE=true` in the `.env` file on LXC 119 and restart the service:
```bash
ssh root@10.206.8.119
echo "DEBUG_MODE=true" >> /opt/storm-tracker/.env
systemctl restart storm-tracker
```

Then access simulation via API:
```bash
curl "http://10.206.8.119:8119/api/debug/simulate?scenario=direct_hit&lat=39.5&lon=-84.5"
curl "http://10.206.8.119:8119/api/debug/simulate/reset"
curl "http://10.206.8.119:8119/api/debug/features"
```

Available scenarios: `direct_hit`, `near_miss`, `multi_storm`, `escalation` (instant), `slow_mover`, `weakening_storm`, `priority_flip`, `tracked_storm` (timed).

### Debug Overlay
The D-key debug overlay on alert cards is still available in production. It shows internal scores and states but is hidden by default and has no visual indicator. This is intentional — it's useful for live debugging without affecting normal UX.

---

## Feedback Box / Wishlist

### Storage
- **Database:** SQLite (`data/storm_tracker.db`), table `feedback`
- **Fields:** id, created_at, message, category, page_context, user_agent, status, notes
- **Retention:** Unlimited (no auto-purge). Manually review and dismiss as needed.

### Submission Flow
1. User clicks FB button in header
2. Modal opens with category dropdown (Idea/Bug/Improvement/Confusing/Other) and text area
3. User types message and clicks Send
4. Backend validates (non-empty, max 2000 chars, HTML-escaped), rate limits (10s per IP)
5. Stored in SQLite with timestamp, category, page context, and user agent
6. Confirmation shown, modal closes after 1.5s

### Review Flow
1. Navigate to `http://10.206.8.119:8119/feedback`
2. Filter by status (New/Reviewed/Planned/Done/Dismissed) and/or category
3. Read feedback items (newest first)
4. Update status inline via dropdown
5. Add planning notes in the notes field (saved on change)

### API Endpoints
```
POST /api/feedback              — submit (public)
GET  /api/feedback              — list (filterable: ?status=new&category=bug&limit=50&offset=0)
PATCH /api/feedback/{id}        — update status/notes
```

### Security Note
The review page at `/feedback` and the PATCH endpoint are not behind authentication. This is acceptable for internal/home-lab deployment behind a firewall. If the app were made publicly accessible, these endpoints would need authentication.

---

## GitHub Upload Status

### Repository
- **URL:** https://github.com/mrelius/storm-tracker
- **Branch:** main
- **Latest commit:** Production cleanup + header minimize fix + service worker cache bust

### What's Committed
All source code, templates, static assets, tests, deploy script, README, and documentation.

### What's NOT Committed (via .gitignore)
- `venv/` — Python virtual environment
- `__pycache__/`, `*.pyc`, `*.pyo` — compiled Python
- `data/storm_tracker.db*` — runtime database
- `data/cc_tiles/` — generated CC radar tiles
- `.env` — environment configuration with secrets
- `.pytest_cache/` — test artifacts
- `*.log` — log files

### How to Push Updates
```bash
cd /home/melius/119_storm-tracker
git add <files>
git commit -m "Description of changes"
git push origin main
```

### Deploy Process
```bash
cd /home/melius/119_storm-tracker
./deploy.sh
```
This rsyncs code to LXC 119 (`/opt/storm-tracker/`), installs dependencies, restarts the service, and verifies health.

---

## Remaining Planned But Unreleased Items

These were identified during development but are NOT implemented:

| Item | Status | Notes |
|------|--------|-------|
| Per-storm card consolidation | Deferred | Multiple detection types (rotation + strong_storm) from the same storm show as separate cards. Could consolidate into one card per storm. Identified in Phase 31 validation. |
| SPC outlook overlays | Not started | Day 1–3 severe weather risk areas from Storm Prediction Center |
| Lightning data (Blitzortung) | Not started | Real-time lightning strike overlay |
| Home Assistant integration | Not started | Push tornado warnings to HA for home automation triggers |
| Multi-radar SRV/CC composite | Not started | Merge data from multiple NEXRAD sites |
| SRV shear zone detection | Not started | Automatic rotation detection from velocity data |
| HTTPS / SSL | Not configured | Currently HTTP only on the internal network. Would need SSL for browser geolocation and notifications to work on external access. |
| Authentication for admin views | Not implemented | Feedback review page and PATCH endpoint have no auth. Acceptable behind firewall. |
| Notification delivery channels | Partial | Currently browser-only. Notification engine is delivery-agnostic — payloads ready for Telegram, push services, etc. No delivery integration built yet. |
| Quiet hours configuration UI | Not built | Quiet hours exist in backend config but can only be set via environment variables, not via UI. |

---

## Service Reference

### LXC 119 — Storm Tracker
- **IP:** 10.206.8.119, **Port:** 8119
- **Services:** `storm-tracker.service` (FastAPI), `redis-server.service` (cache)
- **Code:** `/opt/storm-tracker/`
- **Logs:** `journalctl -u storm-tracker -f`

### LXC 121 — CC Radar Pipeline
- **IP:** 10.206.8.121, **Port:** 8121
- **Services:** `cc-api.service` (tile server), `cc-pipeline.service` (NEXRAD processor)
- **Code:** `/opt/cc-radar/`
- **Logs:** `journalctl -u cc-pipeline -f`

### Health Checks
```bash
curl -sf http://10.206.8.119:8119/api/health | python3 -m json.tool
curl -sf http://10.206.8.121:8121/api/status | python3 -m json.tool
```
