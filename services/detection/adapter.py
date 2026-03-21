"""Detection adapter — converts live project data into StormObjects.

Storm source strategy:
1. NWS severe alerts from SQLite as storm anchors
2. Polygon centroid as provisional storm position
3. CC sampling from LXC 121 (via proxy) for enrichment
4. Distance/bearing computed from user reference location

Documented data gaps:
- reflectivity_dbz: estimated from NWS severity metadata (not measured)
- velocity_delta: None unless CC is very low (proxy heuristic)
- speed_mph: NWS alerts don't include motion vectors; defaults to 0
- trend: defaults to Trend.unknown; future: derive from alert timing
"""
import logging
import time
from datetime import datetime, timezone

import httpx

from config import get_settings
from db import get_connection
from services.detection.models import StormObject, Trend, DetectionResult
from services.detection.geometry import (
    extract_centroid, haversine_mi, compute_bearing, bearing_to_direction,
)
from services.detection.pipeline import DetectionPipeline

logger = logging.getLogger(__name__)

# NWS event types that represent actual storm cells
STORM_EVENTS = {
    "Tornado Warning",
    "Severe Thunderstorm Warning",
    "Tornado Watch",
}

# Reflectivity estimates from NWS severity metadata (documented approximation)
# NWS doesn't include dBZ in alerts; these are conservative proxies
SEVERITY_DBZ_ESTIMATE = {
    "Extreme": 60.0,
    "Severe": 50.0,
    "Moderate": 40.0,
}

# Singleton pipeline instance (stateful — owns cooldown state)
_pipeline: DetectionPipeline | None = None


def get_pipeline() -> DetectionPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = DetectionPipeline()
    return _pipeline


async def run_detection_cycle(
    ref_lat: float | None = None,
    ref_lon: float | None = None,
) -> DetectionResult:
    """Full detection cycle: fetch alerts → build storms → detect.

    Args:
        ref_lat/ref_lon: user reference point. Falls back to config default.

    Returns:
        DetectionResult with emitted events.
    """
    settings = get_settings()
    lat = ref_lat if ref_lat is not None else settings.default_lat
    lon = ref_lon if ref_lon is not None else settings.default_lon

    # 1. Fetch severe alerts from DB
    alerts = await fetch_severe_alerts()
    if not alerts:
        return DetectionResult(storms_processed=0)

    # 2. Build StormObjects
    storms = []
    for alert in alerts:
        storm = build_storm_from_alert(alert, lat, lon)
        if storm:
            storms.append(storm)

    if not storms:
        return DetectionResult(storms_processed=0)

    # 3. Enrich with CC sampling (best-effort, non-blocking)
    await enrich_storms_cc(storms)

    # 4. Run detection pipeline
    pipeline = get_pipeline()
    result = pipeline.process(storms)

    if result.events:
        logger.info(
            f"Detection cycle: {len(alerts)} alerts → {len(storms)} storms → "
            f"{len(result.events)} detections ({result.detections_suppressed} suppressed)"
        )

    return result


async def fetch_severe_alerts() -> list[dict]:
    """Fetch active severe alerts from SQLite.

    Returns list of dicts with: id, event, severity, polygon, onset, expires, issued.
    """
    now = datetime.now(timezone.utc).isoformat()
    db = await get_connection()
    try:
        rows = await db.execute(
            """SELECT id, event, severity, polygon, onset, expires, issued,
                      headline, priority_score
               FROM alerts
               WHERE expires > ? AND event IN ({})
               ORDER BY priority_score DESC""".format(
                ",".join(f"'{e}'" for e in STORM_EVENTS)
            ),
            (now,),
        )
        results = await rows.fetchall()
        return [dict(r) for r in results]
    except Exception as e:
        logger.error(f"Failed to fetch severe alerts: {e}")
        return []
    finally:
        await db.close()


def build_storm_from_alert(
    alert: dict, ref_lat: float, ref_lon: float,
) -> StormObject | None:
    """Convert an NWS alert dict into a StormObject.

    Returns None if centroid cannot be extracted.
    """
    polygon = alert.get("polygon")
    centroid = extract_centroid(polygon)

    if not centroid:
        return None

    storm_lat, storm_lon = centroid
    distance = haversine_mi(ref_lat, ref_lon, storm_lat, storm_lon)
    bearing = compute_bearing(ref_lat, ref_lon, storm_lat, storm_lon)
    direction = bearing_to_direction(bearing)

    # Reflectivity estimate from NWS severity
    nws_severity = alert.get("severity", "Unknown")
    dbz_estimate = SEVERITY_DBZ_ESTIMATE.get(nws_severity)

    # Create a stable short ID from the NWS alert ID
    alert_id = alert.get("id", "unknown")
    short_id = alert_id.split(".")[-1] if "." in alert_id else alert_id[-8:]

    return StormObject(
        id=f"nws_{short_id}",
        lat=storm_lat,
        lon=storm_lon,
        distance_mi=round(distance, 1),
        bearing_deg=bearing,
        direction=direction,
        speed_mph=0.0,        # NWS alerts don't include motion vectors
        reflectivity_dbz=dbz_estimate,
        velocity_delta=None,  # not available from NWS alerts
        cc_min=None,          # populated by enrichment step
        trend=Trend.unknown,  # no temporal context from single snapshot
        last_updated=time.time(),
    )


async def enrich_storms_cc(storms: list[StormObject]):
    """Enrich storm objects with CC values from radar sampling.

    Best-effort: failure leaves cc_min as None (detectors handle gracefully).
    Uses the proxy endpoint on LXC 119 (no direct LXC 121 access).
    Timeout 2s per storm. Skips storms outside radar range.
    """
    for storm in storms:
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                resp = await client.get(
                    f"http://localhost:8119/proxy/cc-sample",
                    params={"lat": storm.lat, "lon": storm.lon},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    cc_val = data.get("cc_value")
                    if cc_val is not None:
                        storm.cc_min = round(max(0, min(1, cc_val)), 4)

                        # Heuristic: very low CC with high reflectivity suggests rotation
                        # This is a documented proxy — not a measured velocity delta
                        if (storm.cc_min < 0.75
                                and storm.reflectivity_dbz is not None
                                and storm.reflectivity_dbz >= 50):
                            storm.velocity_delta = 40.0  # proxy estimate
        except Exception as e:
            logger.debug(f"CC enrichment failed for {storm.id}: {e}")
            # Leave cc_min as None — detectors handle this
