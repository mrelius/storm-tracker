import asyncio
import time
import httpx
import logging
from datetime import datetime, timezone
from config import get_settings
from services.alert_processor import store_alert, purge_expired, process_pending_zone_fetches
import cache

logger = logging.getLogger(__name__)

_last_poll: datetime | None = None
_running = False


def get_last_poll() -> datetime | None:
    return _last_poll


async def fetch_active_alerts() -> dict | None:
    """Fetch active alerts from NWS API."""
    settings = get_settings()
    url = f"{settings.nws_api_base}/alerts/active"
    headers = {"User-Agent": settings.nws_user_agent, "Accept": "application/geo+json"}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            # Cache raw response for degraded mode
            cache.set("nws:alerts:raw", data, ttl=300)
            return data
    except Exception as e:
        logger.error(f"NWS API fetch failed: {e}")
        # Try cached data
        cached = cache.get("nws:alerts:raw")
        if cached:
            logger.warning("Using cached NWS data")
            return cached
        return None


async def ingest_once() -> int:
    """Run one ingest cycle. Returns number of alerts stored."""
    global _last_poll
    start = time.monotonic()

    data = await fetch_active_alerts()
    if not data:
        return 0
    fetch_ms = (time.monotonic() - start) * 1000

    features = data.get("features", [])
    store_start = time.monotonic()
    stored = 0
    for feature in features:
        if await store_alert(feature):
            stored += 1
    store_ms = (time.monotonic() - store_start) * 1000

    purged = await purge_expired()
    ingest_ms = (time.monotonic() - start) * 1000
    _last_poll = datetime.now(timezone.utc)

    # Invalidate all cached alert responses — data has changed
    cache.flush_pattern("alerts:*")
    cache.delete("counties:alert_map")

    logger.info(
        f"NWS ingest: {stored}/{len(features)} stored, {purged} purged "
        f"(fetch={fetch_ms:.0f}ms store={store_ms:.0f}ms total={ingest_ms:.0f}ms) "
        f"cache invalidated"
    )

    # Process zone polygon fetches AFTER ingest completes (non-blocking to ingest timing)
    await process_pending_zone_fetches()

    return stored


async def run_ingest_loop():
    """Background ingest loop. Runs until cancelled."""
    global _running
    settings = get_settings()
    _running = True
    logger.info(f"NWS ingest loop starting (interval: {settings.nws_poll_interval}s)")

    while _running:
        try:
            await ingest_once()
        except Exception as e:
            logger.error(f"Ingest loop error: {e}")
        await asyncio.sleep(settings.nws_poll_interval)


def stop_ingest():
    global _running
    _running = False
