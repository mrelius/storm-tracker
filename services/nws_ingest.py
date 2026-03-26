import asyncio
import time
import httpx
import logging
from datetime import datetime, timezone
from config import get_settings
from services.alert_processor import store_alert, purge_expired, process_pending_zone_fetches
from services import alert_watchdog as wd
from services.freshness import check as freshness_check, record_update, validate_timestamp
from services.storm_state import update_from_ingest as _update_storm_state
import cache

logger = logging.getLogger(__name__)

_last_poll: datetime | None = None
_running = False

# Debug counters for expired-alert rejection tracking
_expired_rejected_last_cycle = 0
_expired_rejected_total = 0

# Freshness counters
_stale_rejected_last_cycle = 0
_stale_rejected_total = 0
_feed_latency_last_ms = 0

# Marine filter — these events add DB/cache churn with zero value for severe weather
_marine_filtered_last_cycle = 0
_marine_filtered_total = 0

MARINE_KEYWORDS = [
    "Marine", "Craft", "Gale", "Sea", "Surf", "Rip Current",
    "Coastal", "High Surf", "Beach Hazards", "Dense Fog",
    "Brisk Wind", "Freezing Spray",
]


def _is_marine(feature: dict) -> bool:
    """Check if an NWS alert is a marine/coastal/non-severe event.
    Uses substring matching, consistent with the UI-side marine filter."""
    event = feature.get("properties", {}).get("event", "")
    return any(kw in event for kw in MARINE_KEYWORDS)


def get_last_poll() -> datetime | None:
    return _last_poll


def get_expired_stats() -> dict:
    return {
        "expired_rejected_last_cycle": _expired_rejected_last_cycle,
        "expired_rejected_total": _expired_rejected_total,
        "stale_rejected_last_cycle": _stale_rejected_last_cycle,
        "stale_rejected_total": _stale_rejected_total,
        "feed_latency_last_ms": _feed_latency_last_ms,
        "marine_filtered_last_cycle": _marine_filtered_last_cycle,
        "marine_filtered_total": _marine_filtered_total,
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
    stale_rejected = 0
    marine_filtered = 0
    alert_ids = []
    now_utc = datetime.now(timezone.utc)
    now_epoch = time.time()

    # Track feed latency: delta between newest alert 'sent' and our clock
    max_sent_epoch = 0

    for feature in features:
        props = feature.get("properties", {})
        aid = props.get("id", "")

        # MARINE FILTER: skip marine/coastal events — zero value for severe weather
        if _is_marine(feature):
            marine_filtered += 1
            continue

        # Count upstream alerts that arrive already expired
        exp_str = props.get("expires")
        if exp_str:
            try:
                exp_dt = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
                if exp_dt < now_utc:
                    expired_rejected += 1
            except (ValueError, TypeError):
                pass

        # FRESHNESS ENFORCEMENT: check 'expires' to ensure alert is still valid
        # NWS alerts can have 'sent' hours ago — that's normal. Staleness is
        # measured from 'expires': an alert past its expiration is stale.
        # HARD FAIL — expired alerts are DROPPED, never stored
        if exp_str:
            exp_epoch = validate_timestamp(exp_str)
            if exp_epoch:
                fr = freshness_check("nws_alerts", exp_epoch, entity_id=aid)
                if not fr["is_fresh"]:
                    stale_rejected += 1
                    logger.info(f"STALE_DROP alert={aid} expires_age={fr['age_sec']}s "
                                f"action={fr['action']} reason={fr['reason']}")
                    if fr["action"] == "drop":
                        continue  # HARD FAIL — skip expired alert

        # Track feed latency from 'sent' timestamp (how delayed the feed is)
        sent_str = props.get("sent", "")
        sent_epoch = validate_timestamp(sent_str)
        if sent_epoch and sent_epoch > max_sent_epoch:
            max_sent_epoch = sent_epoch

        if await store_alert(feature):
            stored += 1
        if aid:
            alert_ids.append(aid)
    store_ms = (time.monotonic() - store_start) * 1000

    _expired_rejected_last_cycle = expired_rejected
    _expired_rejected_total += expired_rejected

    global _stale_rejected_last_cycle, _stale_rejected_total, _feed_latency_last_ms
    global _marine_filtered_last_cycle, _marine_filtered_total
    _stale_rejected_last_cycle = stale_rejected
    _stale_rejected_total += stale_rejected
    _marine_filtered_last_cycle = marine_filtered
    _marine_filtered_total += marine_filtered

    # Record feed latency (how delayed the newest alert is)
    if max_sent_epoch > 0:
        _feed_latency_last_ms = round((now_epoch - max_sent_epoch) * 1000)
        record_update("nws_feed", max_sent_epoch)
        record_update("nws_alerts", max_sent_epoch)

    wd.record_write_success(alert_count=stored, alert_ids=alert_ids)

    purged = await purge_expired()
    ingest_ms = (time.monotonic() - start) * 1000
    _last_poll = datetime.now(timezone.utc)

    # Invalidate all cached alert responses — data has changed
    cache.flush_pattern("alerts:*")
    cache.delete("counties:alert_map")
    wd.record_cache_update()
    wd.record_pipeline_success()

    # ── Update authoritative storm state ──────────────────────────
    # storm_state is the runtime source of truth. DB is persistence.
    try:
        from db import get_connection
        _ss_db = await get_connection()
        try:
            _ss_now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            _ss_rows = await _ss_db.execute(
                """SELECT a.*, GROUP_CONCAT(ac.county_fips) as fips_list
                   FROM alerts a
                   LEFT JOIN alert_counties ac ON a.id = ac.alert_id
                   WHERE a.expires > ?
                   GROUP BY a.id""",
                (_ss_now,),
            )
            _ss_alerts = []
            for row in await _ss_rows.fetchall():
                _ss_alerts.append(dict(row))
            _ss_result = await _update_storm_state(_ss_alerts)
            logger.info(
                f"storm_state synced: active={_ss_result['active_count']} "
                f"primary={_ss_result['primary_id'] or 'none'} "
                f"cycle_ms={_ss_result['cycle_ms']:.1f}"
            )
        finally:
            await _ss_db.close()
    except Exception as _ss_err:
        logger.warning(f"storm_state sync failed (non-fatal): {_ss_err}")

    logger.info(
        f"NWS ingest: {stored}/{len(features)} stored, {purged} purged, "
        f"{marine_filtered} marine_filtered, {stale_rejected} stale_dropped "
        f"(fetch={fetch_ms:.0f}ms store={store_ms:.0f}ms total={ingest_ms:.0f}ms "
        f"feed_latency={_feed_latency_last_ms}ms) cache invalidated"
    )

    # Guard: warn if ingest count is unusually high (possible duplicate/burst)
    if stored > 100:
        logger.warning(f"ingest_count_high: {stored} alerts stored in single cycle")

    # Guard: check DB size periodically (every 10th cycle via simple counter)
    try:
        from services.db_maintenance import check_db_size
        check_db_size()
    except Exception:
        pass

    # Guard: check Redis evictions
    try:
        redis_mem = cache.get_memory_info() if hasattr(cache, 'get_memory_info') else {}
        if redis_mem.get("evicted_keys", 0) > 0:
            logger.warning(f"redis_eviction_detected: {redis_mem['evicted_keys']} keys evicted "
                           f"(used={redis_mem.get('used_mb', '?')}MB / {redis_mem.get('max_mb', '?')}MB)")
    except Exception:
        pass

    # Process zone polygon fetches AFTER ingest completes (non-blocking to ingest timing)
    await process_pending_zone_fetches()

    # Trigger AI advisory jobs (non-blocking — enqueue only)
    try:
        from services.ai.ai_hooks import on_alerts_updated
        from services.prediction.model_context import get_environment_context
        from config import get_settings as _get_settings
        _s = _get_settings()
        _ai_alerts = []
        for feature in features[:8]:
            p = feature.get("properties", {})
            _ai_alerts.append({
                "event": p.get("event", ""),
                "severity": p.get("severity", ""),
                "headline": p.get("headline", ""),
                "description": (p.get("description") or "")[:300],
            })
        _loc = {"lat": _s.default_lat, "lon": _s.default_lon, "name": _s.default_location_name}
        await on_alerts_updated(_ai_alerts, _loc, get_environment_context())
    except Exception as _ai_err:
        logger.debug(f"AI hook error (non-critical): {_ai_err}")

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
