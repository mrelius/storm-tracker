# Storm Tracker — Severe Weather Decision Support System

## Release: v1.0.0 — 2026-03-20

Real-time severe weather tracking web app focused on tornado awareness, warning clarity, and fast situational decision-making. Map-first design with radar overlays and NWS alert visualization.

---

## 1. Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                        BROWSER                               │
│  Leaflet.js map (dark theme)                                │
│  ├── CartoDB Dark Matter basemap                            │
│  ├── County GeoJSON overlay (2170 FIPS-keyed polygons)      │
│  ├── NWS alert polygons (county fill + warning polygons)    │
│  ├── RainViewer reflectivity tiles (13-frame animation)     │
│  ├── IEM SRV velocity tiles (single frame per NEXRAD site)  │
│  └── Service worker (offline alert cache)                   │
│                                                              │
│  7 JS modules: state, location, map, radar-manager,         │
│                alert-renderer, alert-panel, app              │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP (gzip)
┌──────────────────────▼──────────────────────────────────────┐
│                   FastAPI (uvicorn)                          │
│  Port 8119 │ LXC 119 │ 10.206.8.119                        │
│                                                              │
│  Routers: alerts, radar, location, health                   │
│  Middleware: GZip (>500B), RequestTiming (API logging)       │
│                                                              │
│  Services:                                                   │
│  ├── nws_ingest.py — 60s poll loop → store + purge + zone   │
│  ├── alert_processor.py — FIPS extract, priority, zone poly │
│  └── radar/ — provider abstraction                          │
│       ├── RainViewerProvider (reflectivity, CONUS composite) │
│       └── IEMRadarProvider (SRV, per-NEXRAD-site tiles)     │
└──────┬─────────────┬────────────────────────────────────────┘
       │             │
┌──────▼──────┐ ┌────▼─────┐
│   SQLite    │ │  Redis   │
│  WAL mode   │ │  7.0.15  │
│  3 tables   │ │  64MB    │
│  3.3 MB     │ │  LRU     │
└─────────────┘ └──────────┘
```

### Data Flow

```
NWS API ──(60s poll)──► alert_processor ──► SQLite (alerts + alert_counties)
                            │                    │
                            ├── zone polygon ◄───┤ (if no county match)
                            │   fetch (async)    │
                            │   NWS zones API    │
                            ▼                    │
                        Redis cache ◄────────────┘
                        (30s TTL alerts)
                        (60s TTL radar products)
                        (1hr TTL zone geometries)
                        (5min TTL NWS raw fallback)
```

### External Dependencies

| Service | Purpose | Auth | Failure Mode |
|---|---|---|---|
| NWS API (`api.weather.gov`) | Alerts, zone geometries | User-Agent header | Redis serves stale data |
| RainViewer API | Reflectivity radar tiles | None | "Radar unavailable" + retry |
| IEM (`mesonet.agron.iastate.edu`) | SRV velocity tiles | None | "SRV unavailable for [site]" |
| CartoDB | Dark basemap tiles | None | Blank map background |
| Census Bureau GeoJSON | County boundaries (pre-bundled) | N/A | Bundled in `/data/` |

---

## 2. Deployment / Service Inventory

### LXC 119 — storm-tracker

| Attribute | Value |
|---|---|
| Proxmox Host | 10.206.20.11 (Primary) |
| LXC ID | 119 |
| Hostname | storm-tracker |
| IP | 10.206.8.119 |
| Port | 8119 |
| OS | Ubuntu 24.04 LTS |
| Python | 3.12.3 |
| Cores | 2 |
| RAM | 1 GB |
| Swap | 512 MB |
| Disk | 8 GB (20% used) |
| Autostart | Yes |
| Network | vmbr1, NO VLAN tag, firewall=1 |
| DNS | 8.8.8.8 (primary), 10.206.8.1 (secondary) |

### Systemd Services

| Service | Description | Enabled | Restart |
|---|---|---|---|
| `storm-tracker.service` | FastAPI app (uvicorn) | Yes | always (5s delay) |
| `redis-server.service` | Redis 7.0.15 | Yes | auto |

### File Layout on LXC

```
/opt/storm-tracker/
├── main.py                    # FastAPI entry + lifespan + middleware
├── config.py                  # Settings, layer rules, memory budget, marine keywords
├── db.py                      # SQLite schema, county seeding, centroid calc
├── cache.py                   # Redis wrapper with hit/miss stats
├── models.py                  # Pydantic: AlertOut, RadarLayerInfo, HealthOut, etc.
├── .env                       # Runtime config (NWS agent, Redis URL, DB path)
├── .env.example               # Template
├── requirements.txt           # Pinned dependencies
├── deploy.sh                  # Rsync deploy script
├── storm-tracker.service      # Systemd unit file
│
├── routers/
│   ├── alerts.py              # /api/alerts (sort, filter, marine, cache)
│   ├── radar.py               # /api/radar (products, frames, validate, nexrad)
│   ├── location.py            # /api/location (default, resolve)
│   └── health.py              # /api/health (db, cache, stats)
│
├── services/
│   ├── alert_processor.py     # SAME→FIPS, priority, zone polygon fetch (batched)
│   ├── nws_ingest.py          # 60s poll loop, cache invalidation, zone fetch trigger
│   └── radar/
│       ├── base.py            # RadarProvider ABC
│       ├── registry.py        # Provider registry
│       ├── rainviewer.py      # Reflectivity (CONUS composite, 13 animation frames)
│       ├── iem.py             # SRV (per-NEXRAD-site, single frame, honest timestamp)
│       └── nexrad_sites.py    # 43 Midwest NEXRAD sites, nearest-by-location
│
├── static/
│   ├── css/app.css            # Dark command center theme
│   ├── js/
│   │   ├── state.js           # AppState, layer rules, event colors
│   │   ├── location.js        # GPS → saved → manual → default fallback
│   │   ├── map.js             # Leaflet init, county layer, focusOnAlert
│   │   ├── radar-manager.js   # Preload animation, SRV overlay, legend, range circle
│   │   ├── alert-renderer.js  # County fill + polygon overlay
│   │   ├── alert-panel.js     # Side panel, sorting, countdown, marine filter
│   │   └── app.js             # Controller, freshness polling, staleness, offline
│   └── sw.js                  # Service worker (cache-first static, network-first API)
│
├── templates/
│   └── index.html             # Single-page app shell
│
├── data/
│   ├── counties_midwest.geojson  # 2170 counties, 1.4 MB
│   └── storm_tracker.db          # SQLite database (auto-created)
│
├── tests/                     # 59 tests (pytest)
│   ├── test_schema.py         # 8 tests — tables, columns, FK, cascade, WAL
│   ├── test_alerts.py         # 12 tests — ingest, SAME/FIPS, expiry, county map
│   ├── test_sorting.py        # 5 tests — severity, distance, issued, expiration
│   ├── test_radar_provider.py # 8 tests — ABC, registry, RainViewer
│   ├── test_iem_provider.py   # 14 tests — NEXRAD lookup, IEM contract, site switch
│   └── test_layer_rules.py    # 12 tests — max layers, SRV+CC, mode gating
│
└── venv/                      # Python virtual environment
```

### Pinned Dependencies

```
fastapi==0.135.1
uvicorn==0.42.0
aiosqlite==0.22.1
redis==7.3.0
httpx==0.28.1
pydantic==2.12.5
pydantic-settings==2.13.1
jinja2==3.1.6
pytest==9.0.2
pytest-asyncio==1.3.0
```

### Management Folder

```
/home/melius/119_storm-tracker/   # Source of truth (management host)
```

Deploy via: `./deploy.sh` (rsync to LXC, restart service)

---

## 3. Operational Runbook

### Starting / Stopping

```bash
# On LXC 119:
systemctl start storm-tracker
systemctl stop storm-tracker
systemctl restart storm-tracker

# Check status:
systemctl status storm-tracker
curl -sf http://10.206.8.119:8119/api/health | python3 -m json.tool
```

### Viewing Logs

```bash
# Live tail:
journalctl -u storm-tracker -f

# Last hour:
journalctl -u storm-tracker --since "1 hour ago"

# Ingest cycles only:
journalctl -u storm-tracker | grep "NWS ingest:"

# API timing:
journalctl -u storm-tracker | grep "→"

# Errors only:
journalctl -u storm-tracker -p err
```

### Expected Log Patterns

```
# Normal ingest cycle (~4s):
NWS ingest: 317/458 stored, 170 purged (fetch=314ms store=3895ms total=4237ms) cache invalidated

# Zone polygon fetch (after ingest):
Zone polygons: 262/262 fetched

# API request timing:
GET /api/alerts → 200 (10.1ms)
GET /api/alerts/counties → 200 (1.7ms)
```

### Health Check Interpretation

```json
{
    "status": "ok",
    "db": "ok",              // SQLite accessible
    "cache": "ok",           // Redis connected
    "nws_last_poll": "...",  // ISO timestamp of last NWS fetch
    "alert_count": 140,      // Alerts in DB (active + expired)
    "cache_stats": {
        "hits": 1314,        // Redis cache hits
        "misses": 19,        // Cache misses (DB queries)
        "sets": 24,          // Cache writes
        "errors": 0          // Redis errors
    }
}
```

| Field | Normal | Warning | Action |
|---|---|---|---|
| `cache` | "ok" | "unavailable" | Check `systemctl status redis-server` |
| `nws_last_poll` | <2 min ago | >5 min ago | Check internet, NWS API status |
| `cache_stats.errors` | 0 | >0 | Check Redis logs |
| `alert_count` | 50-300 | 0 | NWS API may be down |

### Redis Operations

```bash
# On LXC 119:
redis-cli ping                    # PONG = healthy
redis-cli DBSIZE                  # Key count
redis-cli KEYS '*'                # All keys
redis-cli INFO memory             # Memory usage
redis-cli FLUSHDB                 # Clear all cache (safe — repopulates)
```

### Database Operations

```bash
# On LXC 119:
sqlite3 /opt/storm-tracker/data/storm_tracker.db

# Useful queries:
SELECT COUNT(*) FROM counties;                           -- should be 2170
SELECT COUNT(*) FROM alerts;                             -- active alert count
SELECT COUNT(*) FROM alerts WHERE polygon IS NOT NULL;   -- alerts with map visibility
SELECT event, COUNT(*) FROM alerts GROUP BY event ORDER BY COUNT(*) DESC;
```

### Deploying Code Changes

```bash
# From management host (/home/melius/119_storm-tracker/):
./deploy.sh

# Manual:
rsync -avz --exclude='venv/' --exclude='__pycache__/' --exclude='data/storm_tracker.db*' \
    -e "ssh -i ~/.ssh/id_proxmox" \
    /home/melius/119_storm-tracker/ root@10.206.8.119:/opt/storm-tracker/
ssh -i ~/.ssh/id_proxmox root@10.206.8.119 "systemctl restart storm-tracker"
```

### Network Note

LXC 119 uses `vmbr1` bridge (VLAN 8). **Do NOT add `tag=8`** — the bridge is already VLAN-specific. DNS must have `8.8.8.8` as primary nameserver (FortiGate DNS at `10.206.8.1` times out on external lookups).

---

## 4. Rollback and Recovery

### Code Rollback

```bash
# 1. Backup current (on LXC):
ssh root@10.206.8.119 "cp -r /opt/storm-tracker /opt/storm-tracker.bak.$(date +%Y%m%d%H%M%S)"

# 2. Deploy previous version from management host:
rsync -avz --delete --exclude='venv/' --exclude='data/storm_tracker.db*' \
    /path/to/previous/version/ root@10.206.8.119:/opt/storm-tracker/

# 3. Restart:
ssh root@10.206.8.119 "systemctl restart storm-tracker"
```

### Database Recovery

```bash
# Backup:
ssh root@10.206.8.119 "cp /opt/storm-tracker/data/storm_tracker.db /opt/storm-tracker/data/storm_tracker.db.bak"

# Restore:
ssh root@10.206.8.119 "cp /opt/storm-tracker/data/storm_tracker.db.bak /opt/storm-tracker/data/storm_tracker.db"
ssh root@10.206.8.119 "systemctl restart storm-tracker"

# Nuclear recovery (delete and let it rebuild):
ssh root@10.206.8.119 "rm /opt/storm-tracker/data/storm_tracker.db*"
ssh root@10.206.8.119 "systemctl restart storm-tracker"
# Counties re-seed automatically. Alerts repopulate on next NWS poll (60s).
```

### Redis Recovery

```bash
# Redis is ephemeral cache only. Safe to flush:
ssh root@10.206.8.119 "redis-cli FLUSHDB"
# Cache repopulates on next API requests + ingest cycle.

# If Redis won't start:
ssh root@10.206.8.119 "systemctl restart redis-server"
# App runs without Redis (cache.py degrades gracefully).
```

### Full LXC Recovery

```bash
# From Proxmox Primary:
ssh claude@10.206.20.11

# Recreate LXC:
sudo pct create 119 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
    --hostname storm-tracker --storage local-lvm --rootfs local-lvm:8 \
    --memory 1024 --swap 512 --cores 2 \
    --net0 name=eth0,bridge=vmbr1,firewall=1,ip=10.206.8.119/24,gw=10.206.8.1 \
    --nameserver 8.8.8.8 --onboot 1 --start 1 --unprivileged 1 --features nesting=1

# Then from management host:
# Set root password, install packages, deploy code (see deploy.sh)
```

---

## 5. Known Limitations

| Limitation | Impact | Workaround |
|---|---|---|
| **CC (Correlation Coefficient) unavailable** | Cannot overlay dual-pol CC data | No free tile source exists. Requires MRMS GRIB2 server-side pipeline. |
| **SRV is single-frame** (no animation) | Cannot track rotation evolution | IEM serves only latest scan. Temporal context requires manual refresh. |
| **SRV timestamp unknown** | UI shows "latest scan" not exact time | IEM doesn't provide scan timestamp. Honest about it. |
| **SRV per-site only** (not composite) | Covers ~230km radius of one radar | Auto-selects nearest NEXRAD. User must zoom to coverage area. |
| **REF auto-pauses when SRV active** | Can't animate REF + view SRV simultaneously | By design — prevents temporal mismatch. User can override via play button. |
| **Zone polygon fetch depends on NWS API** | Zone-based alerts invisible if NWS zone API down | Cached in Redis (1hr). Non-blocking — doesn't affect ingest. |
| **DNS on LXC 119** | FortiGate DNS times out for external queries | Fixed: 8.8.8.8 as primary. May revert on LXC restart if resolv.conf not persisted. |
| **Marine alerts hidden by default** | Users must toggle to see marine advisories | "Marine" toggle in filter controls. |
| **3 marine alerts still invisible** | Offshore zones have no fetchable geometry | Affects only open-ocean marine zones. Acceptable. |

---

## 6. Deferred Future Enhancements

### Near-Term (Phase 4 candidates)

| Enhancement | Effort | Value |
|---|---|---|
| SRV opacity slider | Small | User-adjustable overlay density |
| Advanced mode toggle in UI | Small | Enables SRV+CC combo (when CC available) |
| Alert sound/notification on new Tornado Warning | Medium | Critical for real-time awareness |
| WebSocket push for real-time alert updates | Medium | Eliminates 30s polling lag |
| Persist DNS config on LXC restart | Small | Prevents DNS regression |

### Medium-Term

| Enhancement | Effort | Value |
|---|---|---|
| CC via MRMS GRIB2 pipeline | High | Server-side GRIB2→tile rendering for RhoHV |
| SRV shear zone detection | High | Automated couplet/rotation identification |
| Multi-radar SRV composite | High | Merge multiple NEXRAD sites for regional SRV |
| Historical alert playback | Medium | Review past severe weather events |
| User accounts + saved locations | Medium | Persistent preferences |

### Long-Term

| Enhancement | Effort | Value |
|---|---|---|
| SPC outlook overlays | Medium | Day 1-3 severe weather risk areas |
| Lightning data (Blitzortung) | Medium | Real-time lightning overlay |
| HA integration | Small | Push tornado warnings to Home Assistant |
| Mobile app (PWA) | Medium | Already has service worker foundation |
| ProbSevere overlay | High | NWS probabilistic severe weather data |

---

## 7. Validation Summary

### Test Suite

59 tests across 6 files, all passing:

| File | Tests | Coverage |
|---|---|---|
| `test_schema.py` | 8 | Tables, columns, FK, cascade, indexes, WAL |
| `test_alerts.py` | 12 | SAME/FIPS extract, ingest, expiry, upsert, county map |
| `test_sorting.py` | 5 | Severity, distance, issued, expiration (asc/desc) |
| `test_radar_provider.py` | 8 | ABC enforcement, registry, RainViewer, unsupported products |
| `test_iem_provider.py` | 14 | NEXRAD lookup, IEM contract, site switch, tile URL |
| `test_layer_rules.py` | 12 | Max 2 layers, SRV+CC gating, mode enforcement |

### Live Verification (at release)

| Metric | Value |
|---|---|
| Alert visibility | 98% (136/139) |
| Active alerts (land) | 80 (marine filtered) |
| API response (cached) | 4-13ms |
| API response gzip reduction | 86-89% |
| Redis cache hit ratio | 99% (1314 hits / 19 misses) |
| NWS ingest cycle | 4.2s |
| Zone polygons fetched | 262/262 |
| Zone geometries cached | 201 in Redis |
| Radar animation frames | 13 (2hr span) |
| Service uptime | Continuous since deploy |
| Redis memory | 20.8 MB / 64 MB limit |
| Disk usage | 20% (1.5 GB / 7.8 GB) |
| RAM usage | 217 MB / 1 GB |

### Build Phases Completed

| Phase | Description | Status |
|---|---|---|
| 1A | Backend skeleton, ingestion, API, tests | COMPLETE |
| 1B | Frontend map, county coloring, polygons, panel | COMPLETE |
| 1C | LXC deploy, systemd, Redis | COMPLETE |
| Pre-2 | Operational audit, journald, observability | COMPLETE |
| 2A | Radar animation (preload, scrub, dwell) | COMPLETE |
| 2B | SRV provider, NEXRAD lookup, layer rules | COMPLETE |
| 2D | Alert focus, distance, countdown, badges | COMPLETE |
| 2E | Gzip, Redis caching, service worker | COMPLETE |
| 3A | Trust signals (freshness, staleness, offline, source labels) | COMPLETE |
| 3B | SRV legend, range circle, zone polygon fetch | COMPLETE |
| 3C | Marine filter, radar retry indicator | COMPLETE |

---

## 8. Release Snapshot

### Version

```
Storm Tracker v1.0.0
Release date: 2026-03-20
```

### LXC 119 Runtime

| Component | Version |
|---|---|
| Ubuntu | 24.04 LTS |
| Python | 3.12.3 |
| FastAPI | 0.135.1 |
| Uvicorn | 0.42.0 |
| Redis | 7.0.15 |
| SQLite | 3.45.1 |
| aiosqlite | 0.22.1 |
| httpx | 0.28.1 |
| Pydantic | 2.12.5 |
| Leaflet.js | 1.9.4 (CDN) |

### Counts at Release

| Item | Count |
|---|---|
| Python source files | 16 |
| JavaScript files | 8 |
| CSS files | 1 |
| HTML templates | 1 |
| Test files | 6 |
| Test cases | 59 |
| Total project files | 37 |
| Project size (excl. venv) | 2.0 MB |
| GeoJSON data | 1.4 MB (2170 counties) |
| NEXRAD sites | 43 |
| API endpoints | 12 |
| Redis cache keys (typical) | ~205 |
| SQLite tables | 3 |
| Systemd services | 2 |

### API Endpoints

```
GET  /                                    → UI
GET  /api/health                          → Health + cache stats
GET  /api/alerts                          → Alert list (sort, filter, marine, cache)
GET  /api/alerts/{id}                     → Alert detail
GET  /api/alerts/counties                 → FIPS→event map (cached)
GET  /api/radar/products                  → Radar product availability (cached)
GET  /api/radar/frames/{product_id}       → Animation frames
POST /api/radar/validate-layers           → Layer combination check
GET  /api/radar/nexrad/nearest            → Nearest NEXRAD by lat/lon
POST /api/radar/nexrad/select             → Switch active radar site
GET  /api/location/default                → Default location
GET  /api/location/resolve                → Location resolver
GET  /data/counties_midwest.geojson       → County boundaries (static)
```

### Cache Architecture

| Key Pattern | TTL | Invalidation |
|---|---|---|
| `alerts:{sort}:{order}:{cat}:{active}:{marine}:{lat}:{lon}` | 30s | Ingest flush |
| `counties:alert_map` | 30s | Ingest flush |
| `radar:products` | 60s | Radar site change |
| `nws:alerts:raw` | 300s | Each ingest overwrites |
| `zone:{zone_id}` | 3600s | Never (zone boundaries stable) |
