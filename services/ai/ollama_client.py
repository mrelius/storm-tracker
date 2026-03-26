"""
Storm Tracker — Ollama Client

Async HTTP client for remote Ollama inference over LAN.
Handles health checks, generation, and error recovery.
"""

import asyncio
import time
import logging
import httpx
from typing import Optional

from services.ai.ai_config import get_ai_config

logger = logging.getLogger(__name__)

# Health state
_healthy = False
_startup_grace = True          # True until first health check completes
_last_health_check = 0.0
_last_health_error: Optional[str] = None
_consecutive_failures = 0


def is_healthy() -> bool:
    return _healthy


def get_health_info() -> dict:
    now = time.time()
    probe_age_ms = round((now - _last_health_check) * 1000) if _last_health_check > 0 else None

    # Determine status with startup grace
    if _startup_grace:
        status = "unknown"
        reason = "startup_grace_no_probe_yet"
    elif _healthy:
        status = "healthy"
        reason = None
    else:
        status = "degraded"
        reason = _last_health_error or "probe_failed"

    return {
        "healthy": _healthy,
        "status": status,
        "reason": reason,
        "startup_grace": _startup_grace,
        "last_probe_at": _last_health_check if _last_health_check > 0 else None,
        "probe_age_ms": probe_age_ms,
        "consecutive_failures": _consecutive_failures,
        "ollama_url": get_ai_config().ollama_url,
    }


async def check_health() -> bool:
    """Probe Ollama /api/tags to verify connectivity."""
    global _healthy, _last_health_check, _last_health_error, _consecutive_failures
    global _startup_grace
    cfg = get_ai_config()
    _last_health_check = time.time()
    _startup_grace = False  # First probe completed — no longer in grace period

    try:
        async with httpx.AsyncClient(timeout=cfg.health_check_timeout) as client:
            resp = await client.get(f"{cfg.ollama_url}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            models = [m["name"] for m in data.get("models", [])]

            # Verify our required models are available
            fast_available = any(cfg.fast_model.split(":")[0] in m for m in models)
            heavy_available = any(cfg.heavy_model.split(":")[0] in m for m in models)

            if not fast_available or not heavy_available:
                _last_health_error = f"Missing models: fast={fast_available} heavy={heavy_available}"
                logger.warning(f"AI health: {_last_health_error} (available: {models})")
                _healthy = False
                _consecutive_failures += 1
                return False

            _healthy = True
            _last_health_error = None
            _consecutive_failures = 0
            return True

    except Exception as e:
        _healthy = False
        _last_health_error = str(e)
        _consecutive_failures += 1
        logger.warning(f"AI health check failed ({_consecutive_failures}x): {e}")
        return False


async def generate(prompt: str, model: Optional[str] = None, temperature: float = 0.3,
                   max_tokens: int = 500) -> Optional[str]:
    """
    Call Ollama /api/generate. Returns response text or None on failure.
    Uses the heavy model by default.
    """
    cfg = get_ai_config()
    if not cfg.enabled:
        return None

    target_model = model or cfg.heavy_model
    url = f"{cfg.ollama_url}/api/generate"

    payload = {
        "model": target_model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }

    start = time.monotonic()
    retries = 0

    while retries <= cfg.max_retries:
        try:
            async with httpx.AsyncClient(timeout=cfg.inference_timeout) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                result = data.get("response", "").strip()
                elapsed = (time.monotonic() - start) * 1000

                logger.info(f"AI generate: model={target_model} "
                           f"prompt_len={len(prompt)} response_len={len(result)} "
                           f"elapsed={elapsed:.0f}ms")
                return result

        except httpx.TimeoutException:
            retries += 1
            logger.warning(f"AI timeout (attempt {retries}/{cfg.max_retries + 1}): "
                          f"model={target_model}")
            if retries <= cfg.max_retries:
                await asyncio.sleep(cfg.retry_delay)

        except Exception as e:
            retries += 1
            logger.error(f"AI generate error (attempt {retries}/{cfg.max_retries + 1}): {e}")
            if retries <= cfg.max_retries:
                await asyncio.sleep(cfg.retry_delay)

    elapsed = (time.monotonic() - start) * 1000
    logger.error(f"AI generate FAILED after {retries} attempts: "
                f"model={target_model} elapsed={elapsed:.0f}ms")
    return None
