# Storm Tracker v2.0.0 — Severe Weather Decision Support System

**Release: 2026-03-20** | **GitHub: https://github.com/mrelius/storm-tracker**

Real-time severe weather tracking focused on tornado awareness, warning clarity, and fast situational decision-making. Map-first dark command center UI with multi-product radar overlays, NWS alert visualization, and radar validation tooling.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER — Leaflet.js dark theme                                │
│  ├── REF: RainViewer composite tiles (13-frame animation)       │
│  ├── SRV: IEM per-site velocity tiles (NEXRAD, single frame)   │
│  ├── CC:  LXC 121 site-based RHOHV tiles (Py-ART, aligned)    │
│  ├── NWS alert polygons + county fill (2170 FIPS counties)     │
│  ├── Zone polygons (fetched from NWS zones API)                │
│  ├── Validation mode (click-to-inspect, crosshair, export)     │
│  └── Service worker (offline alert cache)                       │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│  LXC 119 — storm-tracker (10.206.8.119:8119)                   │
│  FastAPI + SQLite (WAL) + Redis 7.0                             │
│  ├── NWS alert ingest (60s poll) + zone polygon fetch           │
│  ├── Radar provider abstraction (3 providers registered)        │
│  ├── Redis caching (30s alerts, 60s radar, 1hr zones)           │
│  ├── GZip middleware (86-89% compression)                       │
│  └── Request timing + cache hit/miss observability              │
│  NO heavy scientific dependencies                               │
└──────────────┬──────────────────────────────────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────────────────────────────────┐
│  LXC 121 — cc-radar (10.206.8.121:8121)                        │
│  Py-ART 2.2 + GDAL 3.8 + rasterio                              │
│  ├── Downloads NEXRAD Level-II from S3 (unidata bucket)         │
│  ├── Extracts RHOHV via Py-ART, grids polar → cartesian        │
│  ├── Generates z4-z8 tiles via GDAL (5-min daemon cycle)        │
│  ├── Serves tiles + raw grid sampling endpoint                  │
│  └── Site synced with SRV via /api/set-site                     │
└─────────────────────────────────────────────────────────────────┘
```

### Data Sources

| Product | Source | Provider | Type |
|---|---|---|---|
| Reflectivity | RainViewer API | `rainviewer` | CONUS composite, 13 animation frames |
| SRV (Storm Relative Velocity) | Iowa Environmental Mesonet | `iem` | Per-NEXRAD-site (N0S tiles) |
| CC (Correlation Coefficient) | NEXRAD Level-II via Py-ART | `nexrad_cc` | Per-site, scan-aligned with SRV |
| Alerts | NWS API (`api.weather.gov`) | — | 60s poll, SAME→FIPS + zone polygons |
| County boundaries | US Census Bureau | — | Pre-bundled GeoJSON (2170 counties) |

### External Communication

| From | To | Protocol | Purpose |
|---|---|---|---|
| Browser | LXC 119 | HTTP :8119 | App UI + API |
| Browser | RainViewer CDN | HTTPS | REF radar tiles |
| Browser | IEM | HTTPS | SRV velocity tiles |
| Browser | LXC 121 | HTTP :8121 | CC tiles + validation sampling |
| LXC 119 | NWS API | HTTPS | Alert ingestion |
| LXC 119 | NWS Zones API | HTTPS | Zone polygon fetch |
| LXC 119 | LXC 121 | HTTP :8121 | CC status + site sync |
| LXC 121 | AWS S3 (unidata) | HTTPS | NEXRAD Level-II download |

---

## 2. Service Inventory

### LXC 119 — storm-tracker

| Attribute | Value |
|---|---|
| IP | 10.206.8.119 |
| Port | 8119 |
| OS | Ubuntu 24.04 LTS |
| Python | 3.12.3 |
| Cores / RAM / Disk | 2 / 1 GB / 8 GB |
| Autostart | Yes |
| Network | vmbr1, NO VLAN tag, firewall=1, DNS 8.8.8.8 |

| Service | Unit | Purpose |
|---|---|---|
| `storm-tracker.service` | FastAPI (uvicorn) | App + API server |
| `redis-server.service` | Redis 7.0.15 | Alert/radar/zone cache (64MB LRU) |

### LXC 121 — cc-radar

| Attribute | Value |
|---|---|
| IP | 10.206.8.121 |
| Port | 8121 |
| OS | Ubuntu 24.04 LTS |
| Python | 3.12.3 + Py-ART 2.2 + GDAL 3.8 |
| Cores / RAM / Disk | 2 / 2 GB / 10 GB |
| Autostart | Yes |
| Network | vmbr1, NO VLAN tag, firewall=1, DNS 8.8.8.8 |

| Service | Unit | Purpose |
|---|---|---|
| `cc-api.service` | FastAPI (uvicorn) | Tile serving + status + sampling |
| `cc-pipeline.service` | Python daemon | GRIB2→tiles every 5 min |

### API Endpoints

**LXC 119 (storm-tracker)**
```
GET  /                                    UI
GET  /api/health                          Health + cache stats
GET  /api/alerts?sort=&order=&category=&marine=&warnings_only=&lat=&lon=
GET  /api/alerts/{id}                     Alert detail
GET  /api/alerts/counties                 FIPS → event map (county coloring)
GET  /api/radar/products                  Product availability
GET  /api/radar/frames/{product_id}       Animation frames / tile URLs
POST /api/radar/validate-layers?mode=     Layer combination check
GET  /api/radar/nexrad/nearest?lat=&lon=  Nearest NEXRAD sites
POST /api/radar/nexrad/select?site_id=    Switch radar site (syncs SRV + CC)
GET  /api/location/default                Default location
GET  /api/location/resolve?lat=&lon=      Location resolver
```

**LXC 121 (cc-radar)**
```
GET  /api/status                          CC pipeline health + metadata
POST /api/set-site?site_id=               Switch NEXRAD site
GET  /api/radar/sample?lat=&lon=          Raw CC value at point (validation)
GET  /tiles/{site}/latest/{z}/{x}/{y}.png CC tiles
```

---

## 3. Validation Mode

### Purpose
Objective radar accuracy verification. Allows precise comparison between SRV and CC without relying on visual alignment alone.

### Activation
Click **VAL** button in top-right bar. Default OFF — zero overhead when disabled.

### Features

**Click-to-Inspect**: Click any map point to see:
- Coordinates (lat/lon)
- REF value (~dBZ, approximate from rendered tile color)
- SRV value (~kt, approximate from rendered tile color)
- CC value (exact RHOHV from raw grid via LXC 121 `/api/radar/sample`)

**Crosshair Cursor**: Replaces pointer when validation active. REF and SRV values update on mouse hover (throttled 100ms). CC sampled only on click (backend call).

**Timestamp Overlay**: Shows each active layer's data timestamp. Highlights if layers are >2 min apart.

**Alignment Indicator**:
- "OK (same site + scan)" — SRV + CC from same NEXRAD site
- "Partial" — only one of SRV/CC active

**Layer Health**: Shows OK / active status for each radar layer.

**Copy/Export**: Click "Copy to clipboard" to export all validation fields as structured text — coordinates, radar site, all values, timestamps, alignment, health.

### Accuracy

| Product | Method | Accuracy |
|---|---|---|
| REF | Canvas pixel → color table reverse map | ~±3 dBZ |
| SRV | Canvas pixel → color table reverse map | ~±5 kt |
| CC | Backend raw grid sampling (LXC 121) | Exact (4 decimal places, clamped 0–1) |

### Limitations
- REF/SRV canvas sampling may fail for cross-origin tiles (CORS). Returns null gracefully.
- CC sampling requires LXC 121 reachable. Shows "error" if unavailable.
- Displayed CC clamped to 0.0000–1.0000 (raw RHOHV can slightly exceed 1.0 due to processing artifacts).

---

## 4. Operator Runbook

### Daily Operations

**Health check:**
```bash
curl -sf http://10.206.8.119:8119/api/health | python3 -m json.tool
curl -sf http://10.206.8.121:8121/api/status | python3 -m json.tool
```

**Expected health:**
```
LXC 119: status=ok, db=ok, cache=ok, alert_count=50-300
LXC 121: status=ok, available=true, age_seconds<600
```

**Logs:**
```bash
# LXC 119 — app + ingest
ssh root@10.206.8.119 "journalctl -u storm-tracker -f"

# LXC 121 — CC pipeline
ssh root@10.206.8.121 "journalctl -u cc-pipeline -f"

# LXC 121 — CC tile server
ssh root@10.206.8.121 "journalctl -u cc-api -f"
```

**Normal log patterns:**
```
NWS ingest: 317/458 stored, 170 purged (fetch=314ms store=3895ms total=4237ms) cache invalidated
Zone polygons: 262/262 fetched
GET /api/alerts → 200 (10.1ms)
Pipeline complete: 42 tiles in 18.6s
```

### Restart Services

```bash
# LXC 119
ssh root@10.206.8.119 "systemctl restart storm-tracker"

# LXC 121
ssh root@10.206.8.121 "systemctl restart cc-pipeline cc-api"

# Redis (LXC 119 — cache only, safe to flush)
ssh root@10.206.8.119 "redis-cli FLUSHDB"
```

### Deploy Code Changes

```bash
# LXC 119 — AUTHORITATIVE DEPLOY (bump + deploy + verify)
cd /home/melius/119_storm-tracker
scripts/bump_build.sh        # increment build, update all version refs
scripts/deploy_ui.sh         # sync, restart, verify over HTTP

# LXC 121 — from /home/melius/121_cc-radar/
rsync -avz -e "ssh -i ~/.ssh/id_proxmox" \
    /home/melius/121_cc-radar/ root@10.206.8.121:/opt/cc-radar/
ssh root@10.206.8.121 "systemctl restart cc-pipeline cc-api"
```

---

## UI DEPLOYMENT RULES (MANDATORY)

**These rules are non-negotiable. Violation = incomplete work.**

### Authoritative Model

| Path | Role |
|---|---|
| `/home/melius/119_storm-tracker` | Edit source (worktree) — NOT runtime |
| `/opt/storm-tracker` (LXC 119) | Runtime source of truth — what the server serves |
| `http://10.206.8.119:8119` | Verification endpoint — only HTTP response counts |

### Rule: Editing worktree is NOT deployment

Changing files under `/home/melius/119_storm-tracker` does NOT update the running server. The server on LXC 119 serves from `/opt/storm-tracker`. Files must be synced and the service restarted.

### Rule: Success requires HTTP verification

Any frontend/UI-affecting change is **incomplete** until ALL of the following are true:
1. `scripts/deploy_ui.sh` passes (sync + restart + health)
2. `scripts/verify_ui_deploy.sh` passes (HTTP response matches build)
3. Served HTML confirms expected `build_version`, `build_marker`, `__ST_BUILD__`
4. All `?v=` asset tags match the current build number
5. No stale prior-version tags remain

**Required failure wording if verification fails:**
> "UI change not complete — deployment verification failed."

### Rule: UI changes trigger mandatory deploy

Any change touching these paths requires deployment:
- `templates/`
- `static/js/`
- `static/css/`
- `static/sw.js`
- `.build-info.json`
- Any file affecting rendered frontend behavior

Detection: `scripts/is_ui_change.sh`

### Deploy Commands

```bash
# Step 1: Bump build version (updates all references atomically)
scripts/bump_build.sh

# Step 2: Deploy + verify (single command, fails on mismatch)
scripts/deploy_ui.sh

# Step 3 (standalone verification):
scripts/verify_ui_deploy.sh

# Check if deploy is needed:
scripts/is_ui_change.sh
```

### Build Identity

Single source of truth: `.build-info.json`

```json
{
  "build_number": 220,
  "build_version": "v220",
  "build_marker": "v220-2026-03-25T14-00-00Z",
  "built_at": "2026-03-25T14:00:00Z"
}
```

Visible in three places:
1. Served HTML (`<span id="build-version">`, `__ST_BUILD_INFO__`, `BUILD_MARKER` comment)
2. `GET /api/debug/build` endpoint
3. `.last_deploy.json` on deploy target

### Deploy Stamp

Written to `/opt/storm-tracker/.last_deploy.json` after each successful deploy. Contains build identity + timestamp. Queryable via `/api/debug/build`.

---

### Switch Radar Site

```bash
# Switches BOTH SRV (IEM) and CC (LXC 121) to the same site
curl -X POST "http://10.206.8.119:8119/api/radar/nexrad/select?site_id=LOT"
```

### Database Recovery

```bash
# SQLite is ephemeral — safe to delete and let rebuild
ssh root@10.206.8.119 "rm /opt/storm-tracker/data/storm_tracker.db*"
ssh root@10.206.8.119 "systemctl restart storm-tracker"
# Counties reseed automatically. Alerts repopulate in 60s.
```

### CC Pipeline Recovery

```bash
# If CC shows stale/unavailable:
ssh root@10.206.8.121 "journalctl -u cc-pipeline --since '10 minutes ago'"

# Force regenerate:
ssh root@10.206.8.121 "cd /opt/cc-radar && rm -rf tiles/ILN/2* && venv/bin/python3 cc_site_pipeline.py --site ILN"

# If Py-ART read fails ("unknown compression"):
# Only V06 files are supported. MDM variants are filtered automatically.
```

### Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| No alerts | `curl /api/health` → nws_last_poll | Check DNS (`cat /etc/resolv.conf` — must be 8.8.8.8 first) |
| Alerts stale >5min | Staleness banner in UI | Restart storm-tracker, check NWS API status |
| CC unavailable | `curl http://10.206.8.121:8121/api/status` | Restart cc-pipeline. Check Level-II bucket access. |
| SRV error tiles | Check radar site availability | Try different site: `/api/radar/nexrad/select?site_id=LOT` |
| Redis down | `redis-cli ping` | `systemctl restart redis-server`. App works without cache. |
| Disk full | `df -h /` on each LXC | CC tiles: `rm -rf /opt/cc-radar/tiles/*/2*` (keeps only latest) |
| LXC unreachable | Proxmox: `pct status {ID}` | Check vmbr1 bridge. **Never use tag=8** (double-tagging). |

---

## 5. Known Limitations

| Limitation | Impact | Notes |
|---|---|---|
| SRV is single-frame (no animation) | Cannot track rotation evolution | IEM serves latest scan only |
| SRV timestamp unknown | UI shows "latest scan" | IEM doesn't provide scan time in tile response |
| CC tiles sparse in clear weather | Few colored tiles when no precip | Correct behavior — CC only exists where radar returns are present |
| REF auto-pauses when SRV active | User must press play to override | By design — prevents temporal mismatch |
| 3 marine alerts still invisible | Offshore zones without fetchable geometry | Open-ocean marine zones only |
| Canvas pixel sampling may CORS-fail | REF values show null for RainViewer tiles | Use CC exact values for validation instead |
| CC pipeline ~19s processing time | New data available 19s after scan uploaded to S3 | Within 5-min cycle budget |
| Single NEXRAD site for SRV+CC | Only one radar's coverage visible at a time | Auto-selects nearest. Manual switch via API. |

---

## 6. Deferred / Future Enhancements

| Enhancement | Effort | Priority |
|---|---|---|
| SRV shear zone detection | High | Deferred until SRV usability confirmed |
| Multi-radar SRV/CC composite | High | Would merge multiple NEXRAD sites |
| SRV opacity slider | Small | Fixed 0.55/0.65 acceptable for now |
| WebSocket real-time alert push | Medium | Would eliminate 30s polling lag |
| Alert sound on Tornado Warning | Medium | Critical awareness feature |
| SPC outlook overlays | Medium | Day 1-3 severe weather risk |
| Lightning data (Blitzortung) | Medium | Real-time lightning overlay |
| HA integration | Small | Push tornado warnings to Home Assistant |
| Advanced mode UI toggle | Small | Currently enforced in code only |
| CC color legend (separate from SRV) | Small | CC uses different color scale than SRV |
| Collapsed strip: long area name on narrow viewport | Small | Truncation works but could benefit from responsive wrapping or tooltip on hover |

---

## 7. Release History

| Tag | Date | Commits | Summary |
|---|---|---|---|
| v1.0.0 | 2026-03-20 | `c270028` | Phase 1-3: backend, frontend, deploy, radar, alerts, performance, trust signals, zone polygons, polish |
| v2.0.0 | 2026-03-20 | `a96ebcd` | MRMS CC pipeline, site-based CC via LXC 121, CC toggle, validation mode, SRV bug fix |
| v3.0.0 | 2026-03-21 | — | Auto Track audio follow, premium animations, CC spam fix, SRV zoom cap, collapsed tracked-alert strip, switch sound |

### v3.0.0 Changelog

**Auto Track Audio Follow** (`audio-follow.js`)
- Event-driven audio routing: NOAA for tornado warnings, scanner for severe thunderstorm
- 4 independent timers: stability (9s), debounce (2s), cooldown (5s), grace (12s)
- Ownership model: manual always wins, tornado overrides immediately
- Stream availability probes with degraded-source detection
- UI strip with source/status/countdown progress bar
- Full debug section in Shift+Alt+D panel
- Session persistence of enabled state

**Premium Animation Layer**
- Camera easing: 3 profiles — tornado (700ms), normal (1000ms), reframe (1200ms)
- Tracked card: scale + glow transition, TRACKING label slide-in
- Path arrow: SVG stroke draw-in (800ms) + predicted position shimmer
- Badge: acquisition pulse (blue/purple by mode)
- Radar: 300ms opacity crossfade on product/site changes
- Countdown: shrinking progress bar (amber pending, orange grace)
- `prefers-reduced-motion` global gate respects accessibility

**Collapsed Tracked-Alert Strip**
- Horizontal strip at top-right replaces forced-open panel behavior during Auto Track
- Shows event type, TRACKING label, area name, time remaining, severity color
- Updates live on target change; click reopens full panel
- Panel stays collapsed if user collapsed it — AT no longer forces it open

**Auto Track Switch Sound** (`at-switch-sound.js`)
- Two-tone rising chirp on real tracked-target changes
- First acquisition always silent — no false sound on startup or restore
- 8-second cooldown prevents rapid sound during tracker churn
- Tornado replacing severe thunderstorm bypasses cooldown (priority jump ≥ 30)
- User toggle (SW button), persisted across reloads
- Debug section: current/previous target, cooldown, suppressed reason

**Bug Fixes**
- CC overlay spam: `enableInterrogationLayers` now sequential — site switch completes before layer enable
- CC/SRV enable gate: synchronous `ccEnableFailed`/`srvEnableFailed` flags prevent async re-entry
- `enableCC()`/`enableSRV()` now return `false` when `loadOverlay` fails internally
- SRV invisible on zoom: Auto Track camera capped at zoom 10 (IEM tile limit)
- Cache busting: meta tags + `?v=` param on all static assets + build version indicator

### v2.0.0 Metrics

| Metric | Value |
|---|---|
| Alert visibility | 98% |
| Redis cache hit ratio | 99%+ |
| API response (cached) | 4-13ms |
| GZip compression | 86-89% |
| NWS ingest cycle | 4.2s |
| CC pipeline cycle | ~19s |
| Tests | 71 passing |
| App files (LXC 119) | 43 |
| Pipeline files (LXC 121) | 4 |
| Total lines of code | ~6,400 |
| LXCs | 2 (119 + 121) |
| Systemd services | 4 |

---

## 8. Interpretation Layer — Stable Contract (v122+)

Established 2026-03-23. Do not refactor interpretation-source ownership unless a new requirement explicitly changes semantics.

### Invariants

1. **`context-pulse.js`** is the sole owner of in-frame primary ranking. It sets `pulse.primaryInViewEventId` and `pulse.inViewCount` in shared state.
2. **`getPrimaryContextEvent()`** is the sole strict-context selector. Resolution: pulse active → resolve by ID from canonical store; autotrack enabled → resolve by ID; else → null. No cross-context fallback.
3. **Type A surfaces** (ETA, confidence, narrative) are strict — render only from selector result. Null = hide immediately.
4. **Type B banner** is a passive ambient awareness surface. Falls back to `alerts[0]` when selector returns null. Tracks `bannerSourceMode` ("context" | "passive" | "none") internally.
5. **Derived debug state** (`getDebugState()`) is non-persistent — computed on read only. Exposed in Shift+Alt+D panel under INTERPRETATION section.
6. **Transition logs** (`context_source_change`, `banner_source_change`) emit only on actual source mode/ID changes, never per-render.
7. **ClarityLayer never computes in-frame primary.** `_findInFramePrimary()` was removed in v121. Only `context-pulse.js` may rank viewport polygons.

### State Shape

```
state.pulse: {
    primaryInViewEventId: null,   // alert ID — set by context-pulse.js only
    inViewCount: 0                // polygon count during pulse
}
```

Cleared in all pulse exit/interruption paths: `_removeCard()`, `returnFromPulse()`, `cancelPulse()`, `stop()`, and when autotrack goes off in `state.js`.

### Surface Classification

| Surface | Type | Source | Empty behavior |
|---|---|---|---|
| Banner | B (passive) | selector → `alerts[0]` fallback | "No active threats in your area" |
| ETA | A (strict) | selector only | Hidden |
| Confidence | A (strict) | selector only | Hidden |
| Narrative | A (strict) | selector only | Hidden, no stale text |

### v4.0.0 Changelog (builds 117–122)

**Interpretation Layer** (`clarity-layer.js`)
- Status banner: structured `[TYPE] — [DISTANCE] — [DIRECTION] — motion` format
- Motion vector extraction from NWS description text via regex
- Bearing calculation + 8-point cardinal direction
- ETA engine: distance-only + motion-based time ETA, 100mi hide threshold
- Confidence indicator: HIGH/MEDIUM/LOW from priority score, 5s debounce
- Narrative generator: direction, hazard details, motion, shelter urgency
- `[IN VIEW]` / `[TRACKING]` prefix on narrative based on context source
- Unified selector `getPrimaryContextEvent()` — all surfaces consume one call
- Banner source mode metadata: context/passive/none with transition logging
- Debug surface in Shift+Alt+D panel: contextMode, contextEventId, bannerMode, bannerEventId

**Pulse/Narrative Integration** (`context-pulse.js`, `state.js`)
- `pulse.primaryInViewEventId` + `pulse.inViewCount` in shared state
- Cleared in all 5 exit paths + autotrack-off in state.js
- Fixed latent bug: `_hidePulseCard` → `_removeCard` (undefined function)

**UI**
- `#clarity-strip` container: banner + ETA + confidence (top center)
- `#clarity-narrative` container below alert panel (right side, bottom)
- Version indicator moved to header inline after title
- Ticker scroll bar removed (display:none)

**Observability**
- `context_source_change` log: context, event_id, prev_context, prev_event_id
- `banner_source_change` log: mode, event_id, prev_mode, prev_event_id
- Both bounded to actual transitions only

**Performance**
- Banner throttle: 1/sec
- ETA interval: 12s
- Narrative: immediate on source change, 1s drift throttle
- Confidence debounce: 5s
