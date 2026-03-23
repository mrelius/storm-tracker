"""
Storm Tracker — Guidance API

GET /api/guidance → Prioritized situational guidance for the user.
Combines prediction, SPC, and tracking data into a single actionable output.

App-generated interpretation — not an official forecast.
"""

import time
import logging
from typing import Optional
from fastapi import APIRouter, Query

from services.guidance.guidance_engine import generate_guidance

_last_logged_priority = None
_last_logged_headline = None
_last_logged_at = 0
_LOG_DEDUP_SEC = 60  # don't log same priority+headline within 60s

try:
    from logging_config import get_logger
    guid_logger = get_logger("guidance")
except ImportError:
    guid_logger = logging.getLogger("guidance")

router = APIRouter(prefix="/api/guidance", tags=["guidance"])


@router.get("")
async def get_guidance(
    lat: float = Query(39.5),
    lon: float = Query(-84.5),
):
    """Get current guidance based on all available signals."""

    # Gather prediction
    prediction = None
    tracked_event = None
    try:
        from services.detection.alert_service import get_snapshot
        snap = get_snapshot()
        if snap and snap.get("primary_threat"):
            pt = snap["primary_threat"]
            tracked_event = pt.get("nws_event", pt.get("type", ""))

            from routers.prediction import _build_prediction, _check_eligibility
            if not _check_eligibility(pt):
                prediction = _build_prediction(pt, lat, lon)
    except Exception:
        pass

    # Gather SPC risk
    spc_risk = None
    try:
        from services.prediction.spc_ingest import get_spc_data
        from services.prediction.spc_parser import assess_risk
        spc_data = get_spc_data()
        assessment = assess_risk(spc_data, lat, lon, time.time())
        spc_risk = {
            "risk": {
                "category": assessment.risk_category,
                "label": assessment.risk_label,
            },
            "watch": {
                "status": assessment.watch_status,
                "watches": [{"event": w.get("event", "")} for w in assessment.active_watches[:3]],
            },
            "regional": {
                "level": assessment.regional_level,
            },
            "context_messages": assessment.context_messages,
        }
    except Exception:
        pass

    # Generate guidance
    result = generate_guidance(
        prediction=prediction,
        spc_risk=spc_risk,
        tracked_event=tracked_event,
        user_lat=lat,
        user_lon=lon,
    )

    # Log guidance decisions — deduplicated to avoid logging identical repeat outputs
    global _last_logged_priority, _last_logged_headline, _last_logged_at
    now_log = time.time()
    is_dup = (result.priority == _last_logged_priority and
              result.headline == _last_logged_headline and
              now_log - _last_logged_at < _LOG_DEDUP_SEC)

    if result.suppressed:
        if not is_dup:
            guid_logger.info("guidance_suppressed",
                             reason=result.suppress_reason)
            _last_logged_priority = result.priority
            _last_logged_headline = ""
            _last_logged_at = now_log
    else:
        # Extract contributing signal details for logging
        eta_min = None
        impact = None
        sev_trend = None
        spc_cat = None
        if prediction and not prediction.get("suppressed"):
            eta_min = prediction.get("eta", {}).get("eta_minutes")
            impact = prediction.get("eta", {}).get("impact_type")
            sev_trend = prediction.get("severity_trend", {}).get("state")
        if spc_risk:
            spc_cat = spc_risk.get("risk", {}).get("category")

        if not is_dup:
            guid_logger.info("guidance_generated",
                             priority=result.priority,
                             headline=result.headline,
                             event_type=tracked_event or "none",
                             eta_minutes=eta_min,
                             impact=impact,
                             severity_trend=sev_trend,
                             spc_risk=spc_cat,
                             score=result.reasoning[0] if result.reasoning else None)
            _last_logged_priority = result.priority
            _last_logged_headline = result.headline
            _last_logged_at = now_log

    return {
        "guidance": {
            "priority": result.priority,
            "score": result.score,
            "headline": result.headline,
            "messages": result.messages,
            "reasoning": result.reasoning,
            "suppressed": result.suppressed,
            "suppress_reason": result.suppress_reason,
        },
        "disclaimer": "App-generated guidance. Not an official NWS product.",
    }
