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
from services.radar.registry import register
from services.radar.rainviewer import RainViewerProvider
from services.radar.iem import IEMRadarProvider
from services.radar.nexrad_cc import NexradCCProvider
from routers import alerts, radar, location, health

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

_ingest_task: asyncio.Task | None = None


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

    # Start background ingest
    _ingest_task = asyncio.create_task(run_ingest_loop())
    logger.info("Storm Tracker started")

    yield

    # Shutdown
    stop_ingest()
    if _ingest_task:
        _ingest_task.cancel()
        try:
            await _ingest_task
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

app.mount("/data", StaticFiles(directory="data"), name="data")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.get("/")
async def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/proxy/rainviewer/{path:path}")
async def proxy_rainviewer_tiles(path: str):
    """Reverse proxy RainViewer tiles."""
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
            return _Resp(content=b"", status_code=resp.status_code)
    except Exception:
        return _Resp(content=b"", status_code=502)


@app.get("/proxy/iem/{path:path}")
async def proxy_iem_tiles(path: str):
    """Reverse proxy IEM SRV tiles so browser doesn't need cross-origin access."""
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
            return _Resp(content=b"", status_code=resp.status_code)
    except Exception:
        return _Resp(content=b"", status_code=502)


@app.get("/proxy/cc/{path:path}")
async def proxy_cc_tiles(path: str):
    """Reverse proxy CC tiles from LXC 121 so browser doesn't need direct access."""
    import httpx as _httpx
    from fastapi.responses import Response as _Resp
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"http://10.206.8.121:8121/tiles/{path}")
            if resp.status_code == 200:
                return _Resp(
                    content=resp.content,
                    media_type=resp.headers.get("content-type", "image/png"),
                    headers={"Cache-Control": "public, max-age=60"},
                )
            return _Resp(content=b"", status_code=resp.status_code)
    except Exception:
        return _Resp(content=b"", status_code=502)


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
