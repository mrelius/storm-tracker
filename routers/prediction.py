"""
Storm Tracker — Prediction API Router (Phase 1.5 Hardened)

GET /api/prediction/{storm_id}  → Full prediction for a tracked storm
GET /api/prediction/summary     → Prediction for current primary threat

All output clearly marked as app-generated estimates, not official forecasts.

Suppression reason codes:
- no_active_severe_target: no qualifying storm alerts
- unsupported_alert_type: alert is not a severe warning product
- stale_data: underlying data too old for reliable prediction
- low_confidence: motion/track confidence below threshold
- missing_motion: no speed/heading data available
"""

import time
import logging
from typing import Optional
from fastapi import APIRouter, Query

try:
    from logging_config import get_logger
    pred_logger = get_logger("prediction")
except ImportError:
    pred_logger = logging.getLogger("prediction")

from services.prediction.path_projection import project_path
from services.prediction.eta_engine import compute_refined_eta
from services.prediction.severity_trends import analyze_severity_trend
from services.prediction.confidence_engine import compute_confidence
from services.prediction.model_context import get_environment_context
from services.prediction.lightning_context import assess_lightning, get_lightning_stub
from services.prediction.timeline import capture_snapshot, get_timeline, get_storm_ids, get_validation_report

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prediction", tags=["prediction"])

# Only these storm alert types can drive prediction output.
# Flood, marine, winter, and informational alerts are excluded.
ELIGIBLE_ALERT_TYPES = {
    "storm_proximity",
    "strong_storm",
    "rotation",
    "debris_signature",
}

# NWS events that qualify for prediction (linked via nws_event field)
ELIGIBLE_NWS_EVENTS = {
    "Tornado Warning",
    "Severe Thunderstorm Warning",
    "Tornado Watch",
}


def _get_storm_alert(storm_id: str) -> Optional[dict]:
    """Find a storm alert by storm_id from the current snapshot."""
    try:
        from services.detection.alert_service import get_snapshot
        snapshot = get_snapshot()
        if not snapshot or "alerts" not in snapshot:
            return None
        for alert in snapshot["alerts"]:
            if alert.get("storm_id") == storm_id or alert.get("alert_id") == storm_id:
                return alert
        return None
    except Exception:
        return None


def _get_primary_storm() -> Optional[dict]:
    """Get the highest-priority storm alert."""
    try:
        from services.detection.alert_service import get_snapshot
        snapshot = get_snapshot()
        if not snapshot:
            return None
        if snapshot.get("primary_threat"):
            return snapshot["primary_threat"]
        alerts = snapshot.get("alerts", [])
        return alerts[0] if alerts else None
    except Exception:
        return None


def _check_eligibility(alert: dict) -> Optional[str]:
    """Check if alert is eligible for prediction. Returns suppression reason or None."""
    alert_type = alert.get("type", "")
    nws_event = alert.get("nws_event", "")

    if alert_type not in ELIGIBLE_ALERT_TYPES:
        return "unsupported_alert_type"

    # If NWS-linked, check the NWS event
    if nws_event and nws_event not in ELIGIBLE_NWS_EVENTS:
        return "unsupported_alert_type"

    # Check for motion data
    speed = alert.get("speed_mph", 0)
    mc = alert.get("motion_confidence", 0)
    if speed < 0.5 and mc < 0.1:
        return "missing_motion"

    return None


def _build_prediction(alert: dict, client_lat: float, client_lon: float) -> dict:
    """Build a complete prediction from a storm alert dict."""
    now = time.time()
    storm_id = alert.get("storm_id", "?")
    storm_lat = alert.get("lat", 0)
    storm_lon = alert.get("lon", 0)
    speed = alert.get("speed_mph", 0)
    heading = alert.get("heading_deg", 0)
    mc = alert.get("motion_confidence", 0)
    tc = alert.get("track_confidence", 0)
    trend = alert.get("trend", "unknown")
    intensity = alert.get("intensity_trend", "unknown")
    nws_event = alert.get("nws_event", alert.get("type", ""))
    nws_severity = alert.get("severity", 0)
    radius = alert.get("storm_radius_mi", 5.0)
    impact = alert.get("impact", "uncertain")
    cpa = alert.get("cpa_distance_mi")
    updated_at = alert.get("updated_at", now)

    # Eligibility check
    suppress_reason = _check_eligibility(alert)
    if suppress_reason:
        pred_logger.info("prediction_suppressed",
                         storm_id=storm_id, reason=suppress_reason,
                         alert_type=alert.get("type", ""))
        return {
            "storm_id": storm_id,
            "generated_at": now,
            "disclaimer": "App-generated estimate. Not an official NWS forecast.",
            "suppressed": True,
            "suppress_reason": suppress_reason,
            "projection": {"suppressed": True, "suppress_reason": suppress_reason, "points": []},
            "eta": {"suppressed": True, "suppress_reason": suppress_reason},
            "severity_trend": {"suppressed": True, "suppress_reason": suppress_reason},
            "quality": {"confidence_score": 0, "confidence_grade": "suppressed",
                       "suppress_reason": suppress_reason},
        }

    # Path projection
    path = project_path(
        storm_id=storm_id,
        storm_lat=storm_lat, storm_lon=storm_lon,
        speed_mph=speed, heading_deg=heading,
        motion_confidence=mc,
        generated_at=now,
    )

    # ETA
    eta = compute_refined_eta(
        storm_lat=storm_lat, storm_lon=storm_lon,
        speed_mph=speed, heading_deg=heading,
        client_lat=client_lat, client_lon=client_lon,
        motion_confidence=mc,
        trend=trend,
        storm_radius_mi=radius,
    )

    # Severity trend
    sev = analyze_severity_trend(
        intensity_trend=intensity,
        nws_event=nws_event,
        nws_severity=str(nws_severity),
        speed_mph=speed,
        motion_confidence=mc,
        track_confidence=tc,
        cpa_distance_mi=cpa,
        impact=impact,
    )

    # Confidence (at 30min horizon as representative middle)
    conf = compute_confidence(
        motion_confidence=mc,
        track_confidence=tc,
        data_timestamp=updated_at,
        prediction_horizon_min=30,
    )

    # Phase 3: Environment context
    env_ctx = get_environment_context()
    env_modifier = 0.0
    if env_ctx and not env_ctx.get("suppressed"):
        env_modifier = env_ctx.get("confidence_modifier", 0)

    # Phase 3: Lightning context (proxy from intensity_trend)
    lightning = assess_lightning(
        intensity_trend=intensity,
        speed_mph=speed,
        motion_confidence=mc,
        nws_event=nws_event,
    )
    ltg_modifier = lightning.confidence_modifier if not lightning.suppressed else 0

    # Apply enrichment modifiers to confidence (additive, clamped)
    enriched_score = max(0, min(1, conf.score + env_modifier + ltg_modifier))
    confidence_drivers = []
    if env_modifier > 0:
        confidence_drivers.append(f"Environment favorable (+{env_modifier:.0%})")
    elif env_modifier < 0:
        confidence_drivers.append(f"Environment unfavorable ({env_modifier:.0%})")
    if ltg_modifier > 0:
        confidence_drivers.append(f"Lightning increasing (+{ltg_modifier:.0%})")
    elif ltg_modifier < 0:
        confidence_drivers.append(f"Lightning decreasing ({ltg_modifier:.0%})")

    # Prediction age for UI display
    data_age_sec = max(0, now - updated_at) if updated_at > 0 else 0

    # Structured prediction log
    pred_logger.info("prediction_generated",
                     storm_id=storm_id,
                     base_confidence=conf.score,
                     enriched_confidence=enriched_score,
                     grade=conf.grade,
                     env_category=env_ctx.get("category") if env_ctx else "none",
                     ltg_state=lightning.state,
                     path_suppressed=path.suppressed,
                     data_age_sec=round(data_age_sec, 1))

    result = {
        "storm_id": storm_id,
        "generated_at": now,
        "data_age_sec": round(data_age_sec, 1),
        "disclaimer": "App-generated estimate. Not an official NWS forecast.",
        "suppressed": False,
        "suppress_reason": None,

        "projection": {
            "suppressed": path.suppressed,
            "suppress_reason": path.suppress_reason if path.suppressed else None,
            "explanation": path.explanation,
            "speed_mph": speed,
            "heading_deg": heading,
            "points": [
                {
                    "minutes": p.minutes,
                    "lat": p.lat,
                    "lon": p.lon,
                    "cone_half_angle_deg": p.cone_half_angle_deg,
                    "cone_left": {"lat": p.cone_left_lat, "lon": p.cone_left_lon},
                    "cone_right": {"lat": p.cone_right_lat, "lon": p.cone_right_lon},
                    "confidence": p.confidence,
                }
                for p in path.points
            ] if not path.suppressed else [],
        },

        "eta": {
            "suppressed": eta.suppressed,
            "suppress_reason": eta.suppress_reason if eta.suppressed else None,
            "eta_minutes": eta.eta_minutes,
            "eta_window": {
                "min": eta.eta_window_min,
                "max": eta.eta_window_max,
            } if eta.eta_window_min else None,
            "cpa_distance_mi": eta.cpa_distance_mi,
            "cpa_time_minutes": eta.cpa_time_minutes,
            "impact_type": eta.impact_type,
            "confidence": eta.confidence,
            "explanation": eta.explanation,
        },

        "severity_trend": {
            "suppressed": sev.suppressed,
            "state": sev.state,
            "confidence": sev.confidence,
            "signals": sev.signals,
            "projected": {
                "15m": sev.projected_state_15m,
                "30m": sev.projected_state_30m,
                "60m": sev.projected_state_60m,
            },
            "explanation": sev.explanation,
        },

        "quality": {
            "confidence_score": conf.score,
            "enriched_score": enriched_score,
            "confidence_grade": conf.grade,
            "radar_fresh": conf.radar_fresh,
            "radar_age_sec": conf.radar_age_sec,
            "source_health": conf.source_health,
            "confidence_drivers": confidence_drivers,
            "explanation": conf.explanation,
        },

        "environment_context": env_ctx if env_ctx else {
            "category": "unknown",
            "suppressed": True,
            "suppress_reason": "no_data",
        },

        "lightning_context": {
            "state": lightning.state,
            "confidence": lightning.confidence,
            "signals": lightning.signals,
            "source": lightning.source,
            "confidence_modifier": lightning.confidence_modifier,
            "explanation": lightning.explanation,
            "suppressed": lightning.suppressed,
        } if not lightning.suppressed else get_lightning_stub(),
    }

    # Phase 5: Timeline snapshot capture (bounded, rate-limited)
    try:
        capture_snapshot(
            storm_id=storm_id,
            prediction=result,
            actual_lat=storm_lat,
            actual_lon=storm_lon,
            actual_speed=speed,
            actual_heading=heading,
            nws_event=nws_event,
        )
    except Exception:
        pass  # Never break prediction for timeline

    return result


@router.get("/summary")
async def prediction_summary(
    lat: float = Query(39.5, description="Client latitude"),
    lon: float = Query(-84.5, description="Client longitude"),
):
    """Get prediction for the current primary threat."""
    alert = _get_primary_storm()
    if not alert:
        return {
            "prediction": None,
            "reason": "no_active_severe_target",
            "message": "No active storm alerts with motion data.",
        }

    prediction = _build_prediction(alert, lat, lon)
    return {"prediction": prediction}


@router.get("/{storm_id}")
async def prediction_for_storm(
    storm_id: str,
    lat: float = Query(39.5, description="Client latitude"),
    lon: float = Query(-84.5, description="Client longitude"),
):
    """Get prediction for a specific storm."""
    alert = _get_storm_alert(storm_id)
    if not alert:
        return {
            "prediction": None,
            "reason": "no_active_severe_target",
            "message": f"Storm {storm_id} not found in active alerts.",
        }

    prediction = _build_prediction(alert, lat, lon)
    return {"prediction": prediction}


# ── Phase 5: Timeline & Validation Endpoints ─────────────────────

@router.get("/timeline/storms")
async def timeline_storms(minutes: int = Query(120, description="Time window in minutes")):
    """List storm IDs with timeline data in the given window."""
    ids = get_storm_ids(minutes=minutes)
    return {"storms": ids, "window_minutes": minutes}


@router.get("/timeline/data/{storm_id}")
async def timeline_for_storm(
    storm_id: str,
    minutes: int = Query(120, description="Time window in minutes"),
    limit: int = Query(200, description="Max snapshots"),
):
    """Get timeline snapshots for a specific storm — for replay/validation."""
    snapshots = get_timeline(storm_id=storm_id, minutes=minutes, limit=limit)
    lightweight = []
    for s in snapshots:
        entry = {k: v for k, v in s.items() if k != "prediction_json"}
        lightweight.append(entry)
    return {
        "storm_id": storm_id,
        "count": len(lightweight),
        "snapshots": lightweight,
    }


@router.get("/validate/{storm_id}")
async def validate_storm(
    storm_id: str,
    minutes: int = Query(120, description="Time window in minutes"),
):
    """Generate validation report comparing predictions vs actuals for a storm."""
    report = get_validation_report(storm_id, minutes=minutes)
    return {"report": report}
