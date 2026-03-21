# Storm Tracker

Real-time severe weather decision-support system focused on tornado awareness, warning clarity, and fast situational decision-making.

## Features

- **Multi-product radar**: Reflectivity (RainViewer), Storm Relative Velocity (IEM), Correlation Coefficient (NEXRAD Level-II via Py-ART)
- **NWS alert integration**: 60s polling, polygon rendering, zone geometry, 98% alert visibility
- **Storm detection engine**: Motion tracking, ETA computation, impact prediction (CPA), debris signature detection
- **Decision layer**: Action state (Monitor / Be ready / Take action), lifecycle tracking, confidence calibration
- **Threat prioritization**: Composite scoring with anti-thrash hysteresis, primary reason explanation
- **Notification intelligence**: Event-based triggers, cooldown/dedup, confidence gating, quiet hours
- **WebSocket push**: Real-time per-client alerts with location-relative detection
- **Feedback system**: In-app feedback submission with admin review

## Architecture

```
Browser (Leaflet.js)
  |
LXC 119 — FastAPI + SQLite (WAL) + Redis
  |
LXC 121 — Py-ART + GDAL (CC radar pipeline)
```

## Quick Start

```bash
# Install dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Configure
cp .env.example .env  # edit with your settings

# Run
uvicorn main:app --host 0.0.0.0 --port 8119
```

## Deployment

```bash
./deploy.sh  # rsync to LXC 119 + restart service
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health + cache stats |
| GET | `/api/alerts` | NWS alerts (filterable, sortable) |
| GET | `/api/storm-alerts` | Active storm detection alerts |
| GET | `/api/radar/products` | Available radar products |
| GET | `/api/radar/frames/{id}` | Radar animation frames |
| POST | `/api/feedback` | Submit user feedback |
| GET | `/api/feedback` | List feedback (admin) |
| PATCH | `/api/feedback/{id}` | Update feedback status |
| WS | `/ws/storm-alerts` | Real-time storm alert push |

## Configuration

Environment variables (`.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_LAT` | 39.5 | Default reference latitude |
| `DEFAULT_LON` | -84.5 | Default reference longitude |
| `NWS_POLL_INTERVAL` | 60 | NWS alert poll interval (seconds) |
| `ALERT_POLL_INTERVAL` | 60 | Detection cycle interval (seconds) |
| `DEBUG_MODE` | false | Enable simulation endpoints |
| `LOG_LEVEL` | INFO | Logging level |

## License

Private project.
