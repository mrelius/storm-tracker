"""
Storm Tracker — AI Worker

Background worker that consumes AI jobs from the queue,
calls Ollama, and caches results.

Rate-limited per job type to prevent GPU saturation.
"""

import asyncio
import time
import logging
from typing import Optional

from services.ai.ai_config import get_ai_config
from services.ai.ai_queue import (
    AIJob, JobType, JobStatus,
    get_queue, record_complete, record_failure,
)
from services.ai import ollama_client
from services.ai.prompts import (
    storm_summary_prompt, narration_prompt,
    priority_prompt, interpretation_prompt,
)
from services.freshness import check as freshness_check

logger = logging.getLogger(__name__)

_running = False

# Rate limit tracking (per job type)
_last_run: dict[str, float] = {}

# Result cache (simple dict with TTL)
_cache: dict[str, dict] = {}

# Event log for UI display
_event_log: list[dict] = []
_max_log_entries = 50


def get_cached_result(key: str) -> Optional[str]:
    """Get cached AI result if still valid.

    HARD FAIL: stale AI results are discarded, never served to audio/UI.
    """
    entry = _cache.get(key)
    if not entry:
        return None
    cfg = get_ai_config()
    if time.time() - entry["time"] > cfg.result_cache_ttl:
        del _cache[key]
        return None
    # Freshness check on AI result
    fr = freshness_check("ai_result", entry["time"])
    if not fr["is_fresh"]:
        logger.info(f"AI_STALE_DROP: cached result '{key}' age={fr['age_sec']}s — dropped")
        del _cache[key]
        return None
    return entry["result"]


def get_all_cached() -> dict:
    """Return all non-expired cached results."""
    cfg = get_ai_config()
    now = time.time()
    valid = {}
    expired_keys = []
    for k, v in _cache.items():
        if now - v["time"] > cfg.result_cache_ttl:
            expired_keys.append(k)
        else:
            valid[k] = {
                "result": v["result"],
                "age_sec": round(now - v["time"]),
                "model": v.get("model", "unknown"),
                "elapsed_ms": v.get("elapsed_ms"),
            }
    for k in expired_keys:
        del _cache[k]
    return valid


def get_event_log() -> list[dict]:
    return list(_event_log)


def _log_event(job: AIJob, result: Optional[str]):
    entry = {
        "job_id": job.job_id,
        "type": job.job_type.value,
        "status": job.status.value,
        "elapsed_ms": job.elapsed_ms(),
        "time": time.time(),
        "result_len": len(result) if result else 0,
        "error": job.error,
    }
    _event_log.append(entry)
    if len(_event_log) > _max_log_entries:
        _event_log.pop(0)


def _is_rate_limited(job_type: JobType) -> bool:
    cfg = get_ai_config()
    limits = {
        JobType.SUMMARY: cfg.min_interval_summary,
        JobType.NARRATION: cfg.min_interval_narration,
        JobType.PRIORITY: cfg.min_interval_priority,
        JobType.INTERPRETATION: cfg.min_interval_priority,
    }
    min_interval = limits.get(job_type, 15.0)
    last = _last_run.get(job_type.value, 0)
    return (time.time() - last) < min_interval


async def _process_job(job: AIJob) -> Optional[str]:
    """Execute a single AI job. Returns result text or None."""
    cfg = get_ai_config()
    payload = job.payload

    if job.job_type == JobType.SUMMARY:
        prompt = storm_summary_prompt(
            alerts=payload.get("alerts", []),
            location=payload.get("location", {}),
            environment=payload.get("environment"),
        )
        return await ollama_client.generate(
            prompt, model=cfg.heavy_model, temperature=0.3, max_tokens=300
        )

    elif job.job_type == JobType.NARRATION:
        prompt = narration_prompt(
            alert=payload.get("alert", {}),
            location=payload.get("location", {}),
        )
        return await ollama_client.generate(
            prompt, model=cfg.heavy_model, temperature=0.2, max_tokens=150
        )

    elif job.job_type == JobType.PRIORITY:
        prompt = priority_prompt(
            alerts=payload.get("alerts", []),
            location=payload.get("location", {}),
        )
        return await ollama_client.generate(
            prompt, model=cfg.fast_model, temperature=0.1, max_tokens=300
        )

    elif job.job_type == JobType.INTERPRETATION:
        prompt = interpretation_prompt(
            alert=payload.get("alert", {}),
            environment=payload.get("environment"),
        )
        return await ollama_client.generate(
            prompt, model=cfg.fast_model, temperature=0.2, max_tokens=200
        )

    return None


async def run_worker():
    """Background worker loop. Consumes jobs from queue."""
    global _running
    _running = True
    cfg = get_ai_config()
    logger.info("AI worker started")

    while _running:
        try:
            queue = get_queue()
            job = await asyncio.wait_for(queue.get(), timeout=5.0)
        except asyncio.TimeoutError:
            continue
        except Exception:
            await asyncio.sleep(1)
            continue

        # Skip if AI disabled
        if not cfg.enabled:
            job.status = JobStatus.DROPPED
            logger.debug(f"AI disabled — dropping {job.job_id}")
            continue

        # Skip if Ollama unhealthy
        if not ollama_client.is_healthy():
            job.status = JobStatus.FAILED
            job.error = "ollama_unhealthy"
            record_failure(job)
            _log_event(job, None)
            logger.debug(f"AI unhealthy — failing {job.job_id}")
            continue

        # Rate limit check
        if _is_rate_limited(job.job_type):
            job.status = JobStatus.DROPPED
            logger.debug(f"AI rate limited — dropping {job.job_id} ({job.job_type.value})")
            continue

        # Execute
        job.status = JobStatus.RUNNING
        job.started_at = time.time()

        try:
            result = await _process_job(job)

            if result:
                job.status = JobStatus.COMPLETE
                job.result = result
                job.completed_at = time.time()
                _last_run[job.job_type.value] = time.time()

                # Cache the result
                cache_key = f"{job.job_type.value}:latest"
                _cache[cache_key] = {
                    "result": result,
                    "time": time.time(),
                    "model": cfg.heavy_model if job.job_type in (JobType.SUMMARY, JobType.NARRATION)
                             else cfg.fast_model,
                    "elapsed_ms": job.elapsed_ms(),
                }

                record_complete(job)
                logger.info(f"AI job complete: {job.job_id} ({job.job_type.value}) "
                           f"elapsed={job.elapsed_ms():.0f}ms result_len={len(result)}")
            else:
                job.status = JobStatus.FAILED
                job.error = "no_result"
                job.completed_at = time.time()
                record_failure(job)

        except Exception as e:
            job.status = JobStatus.FAILED
            job.error = str(e)
            job.completed_at = time.time()
            record_failure(job)
            logger.error(f"AI job failed: {job.job_id} — {e}")

        _log_event(job, job.result)


async def run_health_loop():
    """Periodic health check for Ollama endpoint."""
    cfg = get_ai_config()
    logger.info("AI health loop started")

    # Initial check
    healthy = await ollama_client.check_health()
    logger.info(f"AI initial health: {'OK' if healthy else 'FAILED'}")

    prev_healthy = healthy
    while _running:
        await asyncio.sleep(cfg.health_check_interval)
        try:
            now_healthy = await ollama_client.check_health()
            if now_healthy != prev_healthy:
                logger.info(
                    f"ai_health_transition before={'healthy' if prev_healthy else 'degraded'} "
                    f"after={'healthy' if now_healthy else 'degraded'}"
                )
                prev_healthy = now_healthy
        except Exception as e:
            logger.error(f"AI health loop error: {e}")


def stop():
    global _running
    _running = False
