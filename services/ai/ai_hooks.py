"""
Storm Tracker — AI Integration Hooks

Hooks into existing storm tracker events to trigger AI jobs.
Called from nws_ingest after alert cycles and from API endpoints.

These hooks are the ONLY bridge between deterministic storm logic and AI.
AI never pushes results back into deterministic state.
"""

import logging
import time
from typing import Optional

from services.ai.ai_config import get_ai_config
from services.ai.ai_queue import AIJob, JobType, enqueue
from services.ai import ollama_client
from services.freshness import get_feed_health

logger = logging.getLogger(__name__)

# Track last trigger times to avoid spamming
_last_trigger: dict[str, float] = {}


def _should_trigger(key: str, min_interval: float) -> bool:
    now = time.time()
    last = _last_trigger.get(key, 0)
    if now - last < min_interval:
        return False
    _last_trigger[key] = now
    return True


async def on_alerts_updated(alerts: list[dict], location: dict,
                            environment: Optional[dict] = None):
    """
    Called after NWS ingest cycle stores new alerts.
    Enqueues summary + priority jobs if conditions met.
    """
    cfg = get_ai_config()
    if not cfg.enabled or not ollama_client.is_healthy():
        return

    if not alerts:
        return

    # HARD FAIL: block AI jobs if NWS feed is stale/failed
    nws_health = get_feed_health("nws_alerts")
    if nws_health.get("status") in ("failed", "stale"):
        logger.info("AI_BLOCKED: NWS feed stale/failed — refusing to generate AI content "
                     f"(health={nws_health.get('health_score')})")
        return

    # Summary job — at most every 30s
    if _should_trigger("summary", cfg.min_interval_summary):
        await enqueue(AIJob(
            job_type=JobType.SUMMARY,
            payload={
                "alerts": alerts[:cfg.max_alerts_in_prompt],
                "location": location,
                "environment": environment,
            },
        ))

    # Priority job — at most every 15s, only if 2+ alerts
    if len(alerts) >= 2 and _should_trigger("priority", cfg.min_interval_priority):
        await enqueue(AIJob(
            job_type=JobType.PRIORITY,
            payload={
                "alerts": alerts[:cfg.max_alerts_in_prompt],
                "location": location,
            },
        ))


async def on_target_changed(alert: dict, location: dict,
                            environment: Optional[dict] = None):
    """
    Called when AutoTrack acquires or switches target.
    Enqueues narration + interpretation jobs.
    """
    cfg = get_ai_config()
    if not cfg.enabled or not ollama_client.is_healthy():
        return

    # Narration job
    if _should_trigger("narration", cfg.min_interval_narration):
        await enqueue(AIJob(
            job_type=JobType.NARRATION,
            payload={
                "alert": alert,
                "location": location,
            },
        ))

    # Interpretation job
    if _should_trigger("interpretation", cfg.min_interval_priority):
        await enqueue(AIJob(
            job_type=JobType.INTERPRETATION,
            payload={
                "alert": alert,
                "environment": environment,
            },
        ))


async def request_summary(alerts: list[dict], location: dict,
                          environment: Optional[dict] = None) -> bool:
    """Manual summary request from API. Bypasses rate limit."""
    cfg = get_ai_config()
    if not cfg.enabled:
        return False

    _last_trigger["summary"] = time.time()
    return await enqueue(AIJob(
        job_type=JobType.SUMMARY,
        payload={
            "alerts": alerts[:cfg.max_alerts_in_prompt],
            "location": location,
            "environment": environment,
        },
    ))


async def request_narration(alert: dict, location: dict) -> bool:
    """Manual narration request from API. Bypasses rate limit."""
    cfg = get_ai_config()
    if not cfg.enabled:
        return False

    _last_trigger["narration"] = time.time()
    return await enqueue(AIJob(
        job_type=JobType.NARRATION,
        payload={
            "alert": alert,
            "location": location,
        },
    ))
