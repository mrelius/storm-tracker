import asyncio
import time
import httpx
import logging
from datetime import datetime, timezone
from config import get_settings
from services.alert_processor import store_alert, purge_expired, process_pending_zone_fetches
from services import alert_watchdog as wd
import cache

logger = logging.getLogger(__name__)

_last_poll: datetime | None = None
_running = False

# Debug counters for expired-alert rejection tracking
_expired_rejected_last_cycle = 0
_expired_rejected_total = 0


def get_last_poll() -> datetime | None:
    return _last_poll


def get_expired_stats() -> dict:
    return {
        "expired_rejected_last_cycle": _expired_rejected_last_cycle,
        "expired_rejected_total": _expired_rejected_total,
    }


async def fetch_active_alerts() -> dict | None:
    """Fetch active alerts from NWS API."""
    settings = get_settings()
    url = f"{settings.nws_api_base}/alerts/active"
    headers = {"User-Agent": settings.nws_user_agent, "Accept": "application/geo+json"}

    wd.record_fetch_start()
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            # Cache raw response for degraded mode
            cache.set("nws:alerts:raw", data, ttl=300)
            wd.record_fetch_success(alert_count=len(data.get("features", [])))
            return data
    except Exception as e:
        logger.error(f"NWS API fetch failed: {e}")
        wd.record_fetch_failure()
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
        wd.tick()
        return 0
    fetch_ms = (time.monotonic() - start) * 1000

    wd.record_parse_success()  # JSON parsed successfully

    global _expired_rejected_last_cycle, _expired_rejected_total

    features = data.get("features", [])
    store_start = time.monotonic()
    stored = 0
    expired_rejected = 0
    alert_ids = []
    now_utc = datetime.now(timezone.utc)
    for feature in features:
        # Count upstream alerts that arrive already expired
        props = feature.get("properties", {})
        exp_str = props.get("expires")
        if exp_str:
            try:
                exp_dt = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
                if exp_dt < now_utc:
                    expired_rejected += 1
            except (ValueError, TypeError):
                pass

        if await store_alert(feature):
            stored += 1
        aid = props.get("id", "")
        if aid:
            alert_ids.append(aid)
    store_ms = (time.monotonic() - store_start) * 1000

    _expired_rejected_last_cycle = expired_rejected
    _expired_rejected_total += expired_rejected

    wd.record_write_success(alert_count=stored, alert_ids=alert_ids)

    purged = await purge_expired()
    ingest_ms = (time.monotonic() - start) * 1000
    _last_poll = datetime.now(timezone.utc)

    # Invalidate all cached alert responses — data has changed
    cache.flush_pattern("alerts:*")
    cache.delete("counties:alert_map")
    wd.record_cache_update()
    wd.record_pipeline_success()

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
            wd.tick()
        await asyncio.sleep(settings.nws_poll_interval)


def stop_ingest():
    global _running
    _running = False
