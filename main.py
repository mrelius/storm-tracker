import asyncio
import json
import time
import uuid
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware

from fastapi.requests import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

from config import get_settings
from logging_config import setup_logging, get_logger, request_id_var
from db import init_db, seed_counties
import cache
from services.nws_ingest import run_ingest_loop, stop_ingest
from services.detection.alert_service import run_alert_loop, stop_alert_loop
from services.radar.registry import register
from services.radar.rainviewer import RainViewerProvider
from services.radar.iem import IEMRadarProvider
from services.radar.nexrad_cc import NexradCCProvider
from fastapi import WebSocket, WebSocketDisconnect
from routers import alerts, radar, location, health, detections, storm_alerts, feedback, prediction, spc, guidance, ai, freshness, storm, storm_demo

settings = get_settings()
setup_logging(settings.log_level)
logger = get_logger("main")

_ingest_task: asyncio.Task | None = None
_alert_task: asyncio.Task | None = None
_ai_worker_task: asyncio.Task | None = None
_ai_health_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ingest_task
    # Startup
    await init_db()
    await seed_counties()
    cache.init_cache()

    # Initialize authoritative storm state
    from services.storm_state import register_primary_callback
    def _log_primary_change(old_id, new_id):
        logger.info("primary_target_changed", old_id=old_id, new_id=new_id)
    register_primary_callback(_log_primary_change)

    # Register state-changed broadcast callback
    from services.storm_state import register_state_changed_callback

    def _on_storm_state_changed(snapshot):
        """Bridge sync callback to async WS broadcast."""
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_broadcast_storm_state(snapshot))
        except RuntimeError:
            pass  # No event loop — skip broadcast

    register_state_changed_callback(_on_storm_state_changed)
    logger.info("storm_state initialized with WS broadcast")

    Path("data/cc_tiles").mkdir(parents=True, exist_ok=True)

    # Register radar providers
    register(RainViewerProvider())
    register(IEMRadarProvider(site_id="ILN"))  # default: Wilmington OH (Ohio Valley)
    register(NexradCCProvider())

    # TWC regional radar — activate if API key configured
    from config import TWC_API_KEY, TWC_REGIONAL_LAYER
    if TWC_API_KEY:
        from services.radar.twc import TWCRadarProvider, configure as twc_configure
        twc_configure(TWC_API_KEY, TWC_REGIONAL_LAYER)
        register(TWCRadarProvider())
        logger.info("TWC regional radar provider registered")

    # Start background tasks
    _ingest_task = asyncio.create_task(run_ingest_loop())
    _alert_task = asyncio.create_task(run_alert_loop())

    from services.prediction.spc_ingest import run_spc_loop, stop_spc
    from services.prediction.model_context import run_environment_loop, stop_environment
    _spc_task = asyncio.create_task(run_spc_loop())
    _env_task = asyncio.create_task(run_environment_loop())

    # Start AI advisory subsystem (remote Ollama over LAN)
    global _ai_worker_task, _ai_health_task
    from services.ai.ai_queue import init as init_ai_queue
    from services.ai.ai_worker import run_worker as run_ai_worker, run_health_loop as run_ai_health, stop as stop_ai
    init_ai_queue()
    _ai_health_task = asyncio.create_task(run_ai_health())
    _ai_worker_task = asyncio.create_task(run_ai_worker())

    # Start DB maintenance loop (purge, vacuum, raw_json trim)
    from services.db_maintenance import run_maintenance_loop, stop_maintenance
    _maintenance_task = asyncio.create_task(run_maintenance_loop())

    logger.info("Storm Tracker started (with AI advisory + DB maintenance)")

    yield

    # Shutdown
    stop_ingest()
    stop_alert_loop()
    stop_spc()
    stop_environment()
    stop_ai()
    stop_maintenance()
    for task in [_ingest_task, _alert_task, _spc_task, _env_task, _ai_worker_task, _ai_health_task, _maintenance_task]:
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    logger.info("Storm Tracker stopped")


app = FastAPI(
    title="Storm Tracker",
    description="Severe weather decision-support system",
    version="0.1.0",
    lifespan=lifespan,
)


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Assigns a short request ID and logs API request timing."""
    async def dispatch(self, request: Request, call_next):
        rid = uuid.uuid4().hex[:8]
        request_id_var.set(rid)

        if request.url.path.startswith("/api/"):
            start = time.monotonic()
            response = await call_next(request)
            elapsed_ms = (time.monotonic() - start) * 1000
            logger.info("api_request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                elapsed_ms=round(elapsed_ms, 1))
            response.headers["X-Request-ID"] = rid
            return response
        return await call_next(request)


app.add_middleware(RequestIDMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=500)  # gzip responses > 500 bytes

# Mount routers
app.include_router(alerts.router)
app.include_router(radar.router)
app.include_router(location.router)
app.include_router(health.router)
app.include_router(detections.router)
app.include_router(storm_alerts.router)
app.include_router(feedback.router)
app.include_router(prediction.router)
app.include_router(spc.router)
app.include_router(guidance.router)
app.include_router(ai.router)
app.include_router(freshness.router)
app.include_router(storm.router)
app.include_router(storm_demo.router)

_sim_last_call = 0
_SIM_RATE_LIMIT = 5  # seconds between simulate calls


@app.get("/api/debug/simulate")
async def simulate_storm(scenario: str = "direct_hit", lat: float = 39.5, lon: float = -84.5):
    """Inject synthetic storms into the real detection pipeline."""
    global _sim_last_call
    from services.detection.simulator import (
        get_scenario_candidates, list_scenarios, TIMED_SCENARIOS,
        run_timed_scenario, set_active_task, set_simulation_active,
    )
    from services.detection.adapter import get_tracker
    from services.detection.alert_service import run_cycle_once
    import services.detection.adapter as adapter

    if not settings.debug_mode:
        return {"error": "Simulation disabled. Set DEBUG_MODE=true."}

    if scenario == "list":
        return {"scenarios": list_scenarios()}

    # Rate limit
    now = time.time()
    if now - _sim_last_call < _SIM_RATE_LIMIT:
        return {"error": f"Rate limited. Wait {_SIM_RATE_LIMIT}s between calls."}
    _sim_last_call = now

    # Timed scenario
    if scenario in TIMED_SCENARIOS:
        set_simulation_active(True)

        async def inject(candidates):
            tracker = get_tracker()
            tracked = tracker.update(candidates)
            adapter._tracked_storms = tracked
            adapter._base_candidates = candidates
            # Run detection for default path
            from services.detection.adapter import evaluate_for_client, get_pipeline
            from services.detection.alert_engine import get_store
            from services.detection.alert_service import _broadcast_per_client, _update_snapshot
            from services.detection.ws_manager import get_ws_manager as _gwm
            pipeline = get_pipeline()
            pipeline.state.clear()  # Reset cooldown so sim steps re-emit with updated motion
            det = evaluate_for_client(lat, lon, pipeline)
            store = get_store()
            changed = store.update_from_detections(det.events)
            expired = store.expire_stale()
            active = store.get_active_alerts()
            # Update HTTP snapshot so /api/storm-alerts reflects sim data
            _update_snapshot(active, len(changed), expired, det.storms_processed)
            # Broadcast to WS clients
            mgr = _gwm()
            if mgr.client_count > 0:
                await _broadcast_per_client(mgr, settings)

        task = asyncio.create_task(run_timed_scenario(scenario, lat, lon, inject))
        set_active_task(task)
        return {
            "scenario": scenario, "type": "timed",
            "message": f"Timed simulation '{scenario}' started.",
        }

    # Instant scenario
    candidates = get_scenario_candidates(scenario, lat, lon)
    if not candidates:
        return {"error": f"Unknown scenario: {scenario}", "available": list(list_scenarios().keys())}

    set_simulation_active(True)
    tracker = get_tracker()
    tracked = tracker.update(candidates)
    adapter._tracked_storms = tracked
    adapter._base_candidates = candidates
    # Run detection directly (skip NWS refresh which would wipe sim data)
    from services.detection.adapter import evaluate_for_client, get_pipeline
    from services.detection.alert_engine import get_store
    from services.detection.alert_service import _update_snapshot
    pipeline = get_pipeline()
    pipeline.state.clear()
    det = evaluate_for_client(lat, lon, pipeline)
    store = get_store()
    changed = store.update_from_detections(det.events)
    expired = store.expire_stale()
    active = store.get_active_alerts()
    _update_snapshot(active, len(changed), expired, det.storms_processed)

    return {
        "scenario": scenario, "type": "instant",
        "candidates_injected": len(candidates),
        "message": f"Simulation '{scenario}' active.",
    }


@app.get("/api/debug/simulate/reset")
async def reset_simulation():
    """Clear all simulation and alert state."""
    from services.detection.simulator import reset_simulation as _reset
    from services.detection.adapter import get_tracker, get_pipeline
    from services.detection.alert_engine import get_store
    from services.detection.ws_manager import get_ws_manager
    import services.detection.adapter as adapter
    _reset()
    get_tracker().clear()
    get_pipeline().reset()
    get_store().clear()
    adapter._base_candidates = []
    adapter._tracked_storms = []
    for ctx in get_ws_manager().get_all_contexts():
        ctx.get_pipeline().reset()
        ctx.get_alert_store().clear()
        ctx.get_threat_ranker().reset()
        ctx.get_state_tracker().clear()
        ctx.get_notification_gate().clear()
        ctx.get_notification_engine().clear()
    # Clear global snapshot
    from services.detection.alert_service import reset_service
    reset_service()
    return {"message": "Simulation and alert state fully reset"}


@app.get("/api/debug/features")
async def debug_features():
    """Show active feature phases and system version."""
    return {
        "version": "3.0.0",
        "phases": {
            "1-4": "detection engine + frontend",
            "5": "background polling + history",
            "6": "websocket push",
            "7-8": "audio + browser notifications",
            "9-10": "per-client location + detection",
            "11-12": "storm tracking + confidence",
            "13-15": "UI truthfulness + prioritization + schema",
            "16-20": "motion, prediction, impact, footprint",
            "21-25": "geographic context, noise reduction, ETA",
            "26": "action state (decision layer)",
            "27": "lifecycle clarity",
            "28": "multi-storm prioritization",
            "29": "confidence UX / trust calibration",
            "30-32": "UX polish + trust gap corrections",
            "33": "notification intelligence",
        },
        "alert_schema_fields": [
            "trend", "speed_mph", "heading_deg", "intensity_trend",
            "impact", "impact_description", "cpa_distance_mi", "time_to_cpa_min",
            "storm_radius_mi", "projected_severity_label", "impact_severity_label",
            "impact_severity_score", "freshness", "threat_score", "threat_reason",
            "track_confidence", "motion_confidence", "trend_confidence",
        ],
    }


@app.get("/api/debug/build")
async def debug_build():
    """Return active build identity from deployed .build-info.json."""
    import json as _json
    build_file = Path(__file__).parent / ".build-info.json"
    deploy_file = Path(__file__).parent / ".last_deploy.json"
    result = {}
    if build_file.exists():
        result["build"] = _json.loads(build_file.read_text())
    else:
        result["build"] = {"error": ".build-info.json not found"}
    if deploy_file.exists():
        result["deploy"] = _json.loads(deploy_file.read_text())
    else:
        result["deploy"] = None
    return result


@app.websocket("/ws/storm-alerts")
async def storm_alerts_ws(ws: WebSocket):
    import json as _json
    from services.detection.ws_manager import get_ws_manager
    from services.detection.alert_service import build_client_snapshot
    from routers.ws_alerts import _snapshot_message
    manager = get_ws_manager()
    await manager.connect(ws)

    # Send default snapshot immediately
    try:
        await manager.send_to(ws, _snapshot_message())
    except Exception:
        manager.disconnect(ws)
        return

    try:
        while True:
            raw = await ws.receive_text()
            if raw == "ping":
                await manager.send_to(ws, {"type": "pong"})
                continue

            # Parse JSON messages
            try:
                msg = _json.loads(raw)
            except (ValueError, TypeError):
                continue

            if msg.get("type") == "subscribe":
                lat = msg.get("lat")
                lon = msg.get("lon")
                if lat is not None and lon is not None:
                    if manager.set_location(ws, float(lat), float(lon)):
                        # Send client-relative snapshot
                        ctx = manager.get_context(ws)
                        if ctx:
                            await manager.send_to(ws, build_client_snapshot(ctx))
    except WebSocketDisconnect:
        manager.disconnect(ws)
    except Exception:
        manager.disconnect(ws)


# ── Storm State WebSocket — Unified broadcast ────────────────────
# All storm_state changes (demo + live) are broadcast here.
# Frontend connects once, receives state_sync messages.

_storm_state_ws_clients: set = set()
_storm_state_seq: int = 0


@app.websocket("/ws/storm-state")
async def storm_state_ws(ws: WebSocket):
    """WebSocket for unified storm state updates.

    On connect: sends full state snapshot.
    On state change: broadcasts state_sync with sequence_id.
    Ordering guaranteed by monotonic sequence_id.
    """
    await ws.accept()
    _storm_state_ws_clients.add(ws)
    logger.info("ws_storm_state_connected", clients=len(_storm_state_ws_clients))

    # Send initial state
    try:
        from services.storm_state import get_serializable_state
        state = get_serializable_state()
        state["type"] = "state_sync"
        await ws.send_json(state)
    except Exception as e:
        logger.warning(f"ws_storm_state initial send failed: {e}")
        _storm_state_ws_clients.discard(ws)
        return

    # Keep alive — listen for pings
    try:
        while True:
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _storm_state_ws_clients.discard(ws)
        logger.info("ws_storm_state_disconnected", clients=len(_storm_state_ws_clients))


async def _broadcast_storm_state(snapshot: dict):
    """Broadcast state_sync to all connected /ws/storm-state clients."""
    if not _storm_state_ws_clients:
        return

    message = dict(snapshot)
    message["type"] = "state_sync"

    payload = json.dumps(message, default=str)
    dead = []

    for ws in list(_storm_state_ws_clients):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)

    for ws in dead:
        _storm_state_ws_clients.discard(ws)

    logger.info("ws_broadcast_storm_state",
                sequence_id=message.get("sequence_id", 0),
                alert_count=message.get("polygon_count", 0),
                primary_id=message.get("primary_id"),
                clients=len(_storm_state_ws_clients))


# ── Phase 2: Client telemetry endpoint ───────────────────────────
_client_logger = get_logger("client")
_client_dedup: dict[str, float] = {}  # key → last_time for dedup
_CLIENT_DEDUP_WINDOW = 10  # seconds
_CLIENT_MAX_PAYLOAD = 2048  # chars


class ClientLogEntry(BaseModel):
    level: str = "info"
    module: str = "unknown"
    event: str = ""
    message: str = ""
    extra: Optional[dict] = None


@app.post("/api/logs/client")
async def receive_client_log(entry: ClientLogEntry):
    """Receive structured log from frontend. Validates, deduplicates, and persists."""
    # Validate level
    level = entry.level.upper()
    if level not in ("DEBUG", "INFO", "WARN", "WARNING", "ERROR"):
        level = "INFO"

    # Cap payload size
    msg = (entry.message or entry.event)[:_CLIENT_MAX_PAYLOAD]

    # Dedup: same module+event within window
    dedup_key = f"{entry.module}:{entry.event}"
    now = time.time()
    last = _client_dedup.get(dedup_key, 0)
    if now - last < _CLIENT_DEDUP_WINDOW:
        return {"status": "throttled"}
    _client_dedup[dedup_key] = now

    # Prune old dedup entries (keep < 200)
    if len(_client_dedup) > 200:
        cutoff = now - _CLIENT_DEDUP_WINDOW * 2
        _client_dedup.clear()

    # Sanitize extra
    extra = {}
    if entry.extra and isinstance(entry.extra, dict):
        # Limit extra to 10 keys, string values capped at 500 chars
        for k, v in list(entry.extra.items())[:10]:
            extra[str(k)[:50]] = str(v)[:500]

    # Log through structured pipeline
    log_fn = getattr(_client_logger, level.lower().replace("warning", "warn"), _client_logger.info)
    log_fn(entry.event or "client_event",
           client_module=entry.module,
           client_level=level,
           message=msg,
           **extra)

    return {"status": "ok"}


# ── Phase 3: Log viewer endpoint ─────────────────────────────────
@app.get("/api/logs")
async def get_logs(
    level: Optional[str] = None,
    module: Optional[str] = None,
    search: Optional[str] = None,
    minutes: int = 15,
    limit: int = 200,
):
    """Retrieve recent structured logs from the rotating log file.
    Filters by level, module, and text search. Returns newest first."""
    import json as _json
    from logging_config import LOG_FILE

    if not LOG_FILE.exists():
        return {"logs": [], "total": 0, "file": str(LOG_FILE)}

    results = []
    cutoff_ts = time.time() - (minutes * 60)

    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = _json.loads(line)
                except (ValueError, TypeError):
                    continue

                # Time filter
                ts_str = entry.get("ts", "")
                if ts_str:
                    from datetime import datetime, timezone
                    try:
                        ts = datetime.fromisoformat(ts_str).timestamp()
                        if ts < cutoff_ts:
                            continue
                    except (ValueError, TypeError):
                        pass

                # Level filter
                if level and entry.get("level", "").upper() != level.upper():
                    continue

                # Module filter
                if module and module.lower() not in entry.get("module", "").lower():
                    continue

                # Text search
                if search:
                    search_lower = search.lower()
                    searchable = f"{entry.get('event', '')} {entry.get('message', '')} {entry.get('module', '')}".lower()
                    if search_lower not in searchable:
                        continue

                results.append(entry)
        # Newest first, capped
        results = results[-limit:]
        results.reverse()
    except (OSError, PermissionError) as e:
        return {"logs": [], "total": 0, "error": str(e)}

    return {"logs": results, "total": len(results)}


app.mount("/data", StaticFiles(directory="data"), name="data")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.get("/")
async def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/feedback")
async def feedback_review(request: Request):
    return templates.TemplateResponse("feedback.html", {"request": request})


@app.get("/proxy/rainviewer/{path:path}")
async def proxy_rainviewer_tiles(path: str):
    """Reverse proxy RainViewer tiles. Returns transparent PNG for missing tiles."""
    import httpx as _httpx
    from fastapi.responses import Response as _Resp
    try:
        async with _httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"https://tilecache.rainviewer.com/{path}")
            if resp.status_code == 200:
                return _Resp(
                    content=resp.content,
                    media_type="image/png",
                    headers={"Cache-Control": "public, max-age=300"},
                )
            return _Resp(content=_EMPTY_TILE, media_type="image/png")
    except Exception:
        return _Resp(content=_EMPTY_TILE, media_type="image/png")


@app.get("/proxy/iem/{path:path}")
async def proxy_iem_tiles(path: str):
    """Reverse proxy IEM SRV tiles. Returns transparent PNG for missing tiles."""
    import httpx as _httpx
    from fastapi.responses import Response as _Resp
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/{path}")
            if resp.status_code == 200:
                return _Resp(
                    content=resp.content,
                    media_type="image/png",
                    headers={"Cache-Control": "public, max-age=120"},
                )
            return _Resp(content=_EMPTY_TILE, media_type="image/png")
    except Exception:
        return _Resp(content=_EMPTY_TILE, media_type="image/png")


# 1x1 transparent PNG (67 bytes) — returned for missing tiles instead of 404
_EMPTY_TILE = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
               b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
               b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
               b"\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82")


@app.get("/proxy/cc/{path:path}")
async def proxy_cc_tiles(path: str):
    """Reverse proxy CC tiles from LXC 121. Returns transparent PNG for missing tiles."""
    import httpx as _httpx
    from fastapi.responses import Response as _Resp
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"http://10.206.8.121:8121/tiles/{path}")
            if resp.status_code == 200:
                return _Resp(
                    content=resp.content,
                    media_type="image/png",
                    headers={"Cache-Control": "public, max-age=60"},
                )
            # Return transparent PNG instead of 404 (edge-of-coverage is normal)
            return _Resp(content=_EMPTY_TILE, media_type="image/png",
                         headers={"Cache-Control": "public, max-age=300"})
    except Exception:
        return _Resp(content=_EMPTY_TILE, media_type="image/png")


@app.get("/proxy/cc-sample")
async def proxy_cc_sample(lat: float = 0, lon: float = 0):
    """Proxy CC raw value sampling from LXC 121."""
    import httpx as _httpx
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"http://10.206.8.121:8121/api/radar/sample?lat={lat}&lon={lon}")
            return resp.json()
    except Exception:
        return {"cc_value": None, "error": "CC pipeline unreachable"}


@app.get("/proxy/cc-status")
async def proxy_cc_status():
    """Proxy CC pipeline status from LXC 121."""
    import httpx as _httpx
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get("http://10.206.8.121:8121/api/status")
            return resp.json()
    except Exception:
        return {"status": "unreachable", "available": False}
