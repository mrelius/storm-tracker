import asyncio
import time
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware

from fastapi.requests import Request

from config import get_settings
from db import init_db, seed_counties
import cache
from services.nws_ingest import run_ingest_loop, stop_ingest
from services.detection.alert_service import run_alert_loop, stop_alert_loop
from services.radar.registry import register
from services.radar.rainviewer import RainViewerProvider
from services.radar.iem import IEMRadarProvider
from services.radar.nexrad_cc import NexradCCProvider
from fastapi import WebSocket, WebSocketDisconnect
from routers import alerts, radar, location, health, detections, storm_alerts

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

_ingest_task: asyncio.Task | None = None
_alert_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ingest_task
    # Startup
    await init_db()
    await seed_counties()
    cache.init_cache()
    Path("data/cc_tiles").mkdir(parents=True, exist_ok=True)

    # Register radar providers
    register(RainViewerProvider())
    register(IEMRadarProvider(site_id="ILN"))  # default: Wilmington OH (Ohio Valley)
    register(NexradCCProvider())

    # Start background tasks
    _ingest_task = asyncio.create_task(run_ingest_loop())
    _alert_task = asyncio.create_task(run_alert_loop())
    logger.info("Storm Tracker started")

    yield

    # Shutdown
    stop_ingest()
    stop_alert_loop()
    for task in [_ingest_task, _alert_task]:
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


class RequestTimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/api/"):
            start = time.monotonic()
            response = await call_next(request)
            elapsed_ms = (time.monotonic() - start) * 1000
            logger.info(f"{request.method} {request.url.path} → {response.status_code} ({elapsed_ms:.1f}ms)")
            return response
        return await call_next(request)


app.add_middleware(RequestTimingMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=500)  # gzip responses > 500 bytes

# Mount routers
app.include_router(alerts.router)
app.include_router(radar.router)
app.include_router(location.router)
app.include_router(health.router)
app.include_router(detections.router)
app.include_router(storm_alerts.router)

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
            await run_cycle_once(ref_lat=lat, ref_lon=lon)

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
    await run_cycle_once(ref_lat=lat, ref_lon=lon)

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
    # Clear global snapshot
    from services.detection.alert_service import reset_service
    reset_service()
    return {"message": "Simulation and alert state fully reset"}


@app.get("/api/debug/features")
async def debug_features():
    """Show active feature phases and system version."""
    return {
        "version": "2.0.0-phase20",
        "phases": {
            "1-4": "detection engine + frontend",
            "5": "background polling + history",
            "6": "websocket push",
            "7": "audio notifications",
            "8": "browser notifications",
            "9": "per-client location",
            "10": "client-relative detection",
            "11": "storm persistence + tracking",
            "12": "confidence + signal quality",
            "13": "UI truthfulness + ETA stability",
            "14": "threat prioritization",
            "15": "canonical alert schema",
            "16": "motion + freshness UI",
            "17": "intensity trend + heading fix",
            "18": "smoothing + prediction",
            "19": "impact prediction (CPA)",
            "20": "storm footprint + severity projection",
        },
        "alert_schema_fields": [
            "trend", "speed_mph", "heading_deg", "intensity_trend",
            "impact", "impact_description", "cpa_distance_mi", "time_to_cpa_min",
            "storm_radius_mi", "projected_severity_label", "impact_severity_label",
            "impact_severity_score", "freshness", "threat_score", "threat_reason",
            "track_confidence", "motion_confidence", "trend_confidence",
        ],
    }


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


app.mount("/data", StaticFiles(directory="data"), name="data")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.get("/")
async def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


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
