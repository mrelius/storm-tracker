"""
Storm Tracker — AI API Router

Endpoints for AI advisory subsystem.
All results are advisory — no control over deterministic logic.
"""

import logging
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from services.ai.ai_config import get_ai_config
from services.ai import ollama_client
from services.ai.ai_queue import get_stats as get_queue_stats
from services.ai.ai_worker import get_cached_result, get_all_cached, get_event_log
from services.ai.ai_hooks import request_summary, request_narration
from config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/status")
async def ai_status():
    """AI subsystem status — health, queue, config."""
    cfg = get_ai_config()
    health = ollama_client.get_health_info()
    queue = get_queue_stats()

    return {
        "enabled": cfg.enabled,
        "healthy": health["healthy"],
        "status": health.get("status", "unknown"),
        "startup_grace": health.get("startup_grace", False),
        "ollama_url": cfg.ollama_url,
        "fast_model": cfg.fast_model,
        "heavy_model": cfg.heavy_model,
        "health": health,
        "queue": queue,
    }


@router.get("/summary")
async def ai_summary():
    """Get the latest AI-generated storm summary."""
    result = get_cached_result("summary:latest")
    if result:
        return {"status": "ok", "summary": result}
    return {"status": "none", "summary": None}


@router.get("/narration")
async def ai_narration():
    """Get the latest AI-generated narration text (for browser TTS)."""
    result = get_cached_result("narration:latest")
    if result:
        return {"status": "ok", "narration": result}
    return {"status": "none", "narration": None}


@router.get("/priority")
async def ai_priority():
    """Get the latest AI-generated priority ranking."""
    result = get_cached_result("priority:latest")
    if result:
        return {"status": "ok", "priority": result}
    return {"status": "none", "priority": None}


@router.get("/interpretation")
async def ai_interpretation():
    """Get the latest AI-generated alert interpretation."""
    result = get_cached_result("interpretation:latest")
    if result:
        return {"status": "ok", "interpretation": result}
    return {"status": "none", "interpretation": None}


@router.get("/cache")
async def ai_cache():
    """All cached AI results with age."""
    return get_all_cached()


@router.get("/log")
async def ai_log():
    """Recent AI job event log for diagnostics."""
    return get_event_log()


@router.post("/trigger/summary")
async def trigger_summary():
    """Manually trigger a storm summary generation."""
    cfg = get_ai_config()
    if not cfg.enabled:
        return JSONResponse({"status": "disabled"}, status_code=503)

    if not ollama_client.is_healthy():
        return JSONResponse({"status": "unhealthy", "detail": "Ollama not reachable"}, status_code=503)

    # Build alert + location payload from current state
    from db import get_connection
    from services.prediction.model_context import get_environment_context

    settings = get_settings()
    location = {
        "lat": settings.default_lat,
        "lon": settings.default_lon,
        "name": settings.default_location_name,
    }

    alerts = []
    try:
        async with get_connection() as conn:
            rows = await conn.execute(
                "SELECT id, event, severity, headline, priority_score "
                "FROM alerts ORDER BY priority_score DESC LIMIT 8"
            )
            for row in await rows.fetchall():
                alerts.append({
                    "event": row[1],
                    "severity": row[2],
                    "headline": row[3],
                    "priority_score": row[4],
                })
    except Exception as e:
        logger.error(f"Failed to fetch alerts for AI summary: {e}")

    env = get_environment_context()
    ok = await request_summary(alerts, location, env)
    return {"status": "queued" if ok else "failed"}


@router.post("/trigger/narration")
async def trigger_narration(alert_id: str = Query(default="")):
    """Manually trigger narration for a specific alert or the top alert."""
    cfg = get_ai_config()
    if not cfg.enabled:
        return JSONResponse({"status": "disabled"}, status_code=503)

    if not ollama_client.is_healthy():
        return JSONResponse({"status": "unhealthy"}, status_code=503)

    from db import get_connection

    settings = get_settings()
    location = {
        "lat": settings.default_lat,
        "lon": settings.default_lon,
        "name": settings.default_location_name,
    }

    alert = {}
    try:
        async with get_connection() as conn:
            if alert_id:
                row = await conn.execute(
                    "SELECT id, event, severity, headline, description "
                    "FROM alerts WHERE id = ?", (alert_id,)
                )
            else:
                row = await conn.execute(
                    "SELECT id, event, severity, headline, description "
                    "FROM alerts ORDER BY priority_score DESC LIMIT 1"
                )
            r = await row.fetchone()
            if r:
                alert = {
                    "event": r[1],
                    "severity": r[2],
                    "headline": r[3],
                    "description": (r[4] or "")[:500],
                }
    except Exception as e:
        logger.error(f"Failed to fetch alert for AI narration: {e}")

    if not alert:
        return {"status": "no_alerts"}

    ok = await request_narration(alert, location)
    return {"status": "queued" if ok else "failed"}


@router.post("/toggle")
async def toggle_ai(enabled: bool = Query(...)):
    """Enable or disable AI subsystem."""
    cfg = get_ai_config()
    cfg.enabled = enabled
    logger.info(f"AI {'enabled' if enabled else 'disabled'} via API")
    return {"status": "ok", "enabled": cfg.enabled}
