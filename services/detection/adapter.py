"""Detection adapter — converts live project data into StormObjects.

Architecture (Phase 10):
- Global phase: fetch NWS alerts → extract centroids → enrich CC → BaseStormCandidates
- Per-client phase: base candidates + client lat/lon → StormObjects → detection pipeline

Storm source strategy:
1. NWS severe alerts from SQLite as storm anchors
2. Polygon centroid as provisional storm position
3. CC sampling from LXC 121 (via proxy) for enrichment

Documented data gaps:
- reflectivity_dbz: estimated from NWS severity metadata (not measured)
- velocity_delta: None unless CC is very low (proxy heuristic)
- speed_mph: NWS alerts don't include motion vectors; defaults to 0
- trend: defaults to Trend.unknown; no temporal context from single snapshot
"""
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import httpx

from config import get_settings
from db import get_connection
from services.detection.models import StormObject, Trend, DetectionResult
from services.detection.geometry import (
    extract_centroid, haversine_mi, compute_bearing, bearing_to_direction,
)
from services.detection.pipeline import DetectionPipeline
from services.detection.tracker import get_tracker, StormTrack, compute_trend
from services.detection.impact import compute_impact

logger = logging.getLogger(__name__)

# NWS event types that represent actual storm cells
STORM_EVENTS = {
    "Tornado Warning",
    "Severe Thunderstorm Warning",
    "Tornado Watch",
}

# Reflectivity estimates from NWS severity metadata
SEVERITY_DBZ_ESTIMATE = {
    "Extreme": 60.0,
    "Severe": 50.0,
    "Moderate": 40.0,
}


@dataclass
class BaseStormCandidate:
    """Shared storm data — position + metadata. No client-relative fields.

    Produced once per background cycle. Evaluated per-client to create StormObjects.
    """
    id: str
    lat: float
    lon: float
    reflectivity_dbz: Optional[float] = None
    velocity_delta: Optional[float] = None
    cc_min: Optional[float] = None
    nws_event: str = ""
    nws_severity: str = ""
    last_updated: float = 0.0


# Shared base storm candidates — updated by background cycle
_base_candidates: list[BaseStormCandidate] = []
# Tracked storms — updated by tracker after each refresh
_tracked_storms: list[StormTrack] = []


def get_base_candidates() -> list[BaseStormCandidate]:
    return list(_base_candidates)


def get_tracked_storms() -> list[StormTrack]:
    return list(_tracked_storms)


async def refresh_base_candidates():
    """Global phase: fetch NWS alerts → extract centroids → enrich CC → track.

    Produces shared tracked storms with motion vectors.
    """
    global _base_candidates, _tracked_storms

    alerts = await fetch_severe_alerts()
    if not alerts:
        _base_candidates = []
        # Still update tracker with empty candidates (tracks will expire)
        tracker = get_tracker()
        _tracked_storms = tracker.update([])
        return

    candidates = []
    for alert in alerts:
        candidate = _build_candidate(alert)
        if candidate:
            candidates.append(candidate)

    if candidates:
        await _enrich_candidates_cc(candidates)

    _base_candidates = candidates

    # Update tracker — produces tracked storms with motion vectors
    tracker = get_tracker()
    _tracked_storms = tracker.update(candidates)
    logger.debug(f"Tracked storms: {len(_tracked_storms)} ({tracker.track_count} active tracks)")


def evaluate_for_client(
    ref_lat: float, ref_lon: float,
    pipeline: DetectionPipeline,
) -> DetectionResult:
    """Per-client phase: build StormObjects from tracked storms relative to
    client location, with client-relative trend.

    Each client should pass their own pipeline instance for independent cooldown state.
    """
    tracks = get_tracked_storms()
    if not tracks:
        return DetectionResult(storms_processed=0)

    storms = []
    for track in tracks:
        storm = _track_to_storm(track, ref_lat, ref_lon)
        storms.append(storm)

    return pipeline.process(storms)


def _build_candidate(alert: dict) -> BaseStormCandidate | None:
    """Extract a base candidate from an NWS alert."""
    polygon = alert.get("polygon")
    centroid = extract_centroid(polygon)
    if not centroid:
        return None

    storm_lat, storm_lon = centroid
    nws_severity = alert.get("severity", "Unknown")
    dbz_estimate = SEVERITY_DBZ_ESTIMATE.get(nws_severity)

    alert_id = alert.get("id", "unknown")
    short_id = alert_id.split(".")[-1] if "." in alert_id else alert_id[-8:]

    return BaseStormCandidate(
        id=f"nws_{short_id}",
        lat=storm_lat,
        lon=storm_lon,
        reflectivity_dbz=dbz_estimate,
        velocity_delta=None,
        cc_min=None,
        nws_event=alert.get("event", ""),
        nws_severity=nws_severity,
        last_updated=time.time(),
    )


def _track_to_storm(
    track: StormTrack, ref_lat: float, ref_lon: float,
) -> StormObject:
    """Convert a tracked storm to a client-relative StormObject with motion + confidence."""
    distance = haversine_mi(ref_lat, ref_lon, track.lat, track.lon)
    bearing = compute_bearing(ref_lat, ref_lon, track.lat, track.lon)
    direction = bearing_to_direction(bearing)
    trend_str, trend_conf = compute_trend(track, ref_lat, ref_lon)
    trend = Trend(trend_str) if trend_str in Trend.__members__ else Trend.unknown

    # Use smoothed speed when available for more stable ETA
    speed = track.smoothed_speed if track.smoothed_speed > 0 else track.speed_mph

    # Impact analysis
    impact_data = compute_impact(
        storm_lat=track.lat, storm_lon=track.lon,
        heading_deg=track.smoothed_heading if track.smoothed_heading > 0 else track.heading_deg,
        speed_mph=speed,
        client_lat=ref_lat, client_lon=ref_lon,
        motion_confidence=track.motion_confidence,
    )

    return StormObject(
        id=track.storm_id,
        lat=track.lat,
        lon=track.lon,
        distance_mi=round(distance, 1),
        bearing_deg=bearing,
        direction=direction,
        speed_mph=speed,
        reflectivity_dbz=track.reflectivity_dbz,
        velocity_delta=track.velocity_delta,
        cc_min=track.cc_min,
        trend=trend,
        heading_deg=track.heading_deg,
        smoothed_heading=track.smoothed_heading,
        intensity_trend=track.intensity_trend,
        predicted_lat=track.predicted_lat,
        predicted_lon=track.predicted_lon,
        prediction_minutes=track.prediction_minutes,
        cpa_distance_mi=impact_data.get("cpa_distance_mi"),
        time_to_cpa_min=impact_data.get("time_to_cpa_min"),
        impact=impact_data.get("impact", "uncertain"),
        impact_description=impact_data.get("impact_description", ""),
        track_confidence=track.track_confidence,
        motion_confidence=track.motion_confidence,
        trend_confidence=trend_conf,
        last_updated=track.last_updated,
    )


def _candidate_to_storm(
    c: BaseStormCandidate, ref_lat: float, ref_lon: float,
) -> StormObject:
    """Legacy: convert a base candidate to a StormObject (no motion data)."""
    distance = haversine_mi(ref_lat, ref_lon, c.lat, c.lon)
    bearing = compute_bearing(ref_lat, ref_lon, c.lat, c.lon)
    direction = bearing_to_direction(bearing)

    return StormObject(
        id=c.id,
        lat=c.lat,
        lon=c.lon,
        distance_mi=round(distance, 1),
        bearing_deg=bearing,
        direction=direction,
        speed_mph=0.0,
        reflectivity_dbz=c.reflectivity_dbz,
        velocity_delta=c.velocity_delta,
        cc_min=c.cc_min,
        trend=Trend.unknown,
        last_updated=c.last_updated,
    )


# --- Legacy compatibility ---

# Singleton pipeline for default/HTTP path
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
    """Legacy: full detection cycle for HTTP endpoint / default path.

    Uses shared base candidates + provided or default location.
    """
    settings = get_settings()
    lat = ref_lat if ref_lat is not None else settings.default_lat
    lon = ref_lon if ref_lon is not None else settings.default_lon

    # Ensure base candidates are fresh
    await refresh_base_candidates()

    pipeline = get_pipeline()
    return evaluate_for_client(lat, lon, pipeline)


# --- Shared helpers ---

async def fetch_severe_alerts() -> list[dict]:
    """Fetch active severe alerts from SQLite."""
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


async def _enrich_candidates_cc(candidates: list[BaseStormCandidate]):
    """Enrich base candidates with CC values from radar sampling."""
    for c in candidates:
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                resp = await client.get(
                    "http://localhost:8119/proxy/cc-sample",
                    params={"lat": c.lat, "lon": c.lon},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    cc_val = data.get("cc_value")
                    if cc_val is not None:
                        c.cc_min = round(max(0, min(1, cc_val)), 4)
                        if (c.cc_min < 0.75
                                and c.reflectivity_dbz is not None
                                and c.reflectivity_dbz >= 50):
                            c.velocity_delta = 40.0
        except Exception as e:
            logger.debug(f"CC enrichment failed for {c.id}: {e}")
