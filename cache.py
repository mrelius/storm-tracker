import json
import logging
from typing import Any
from redis import Redis
from config import get_settings

logger = logging.getLogger(__name__)

_client: Redis | None = None
_available: bool = False
_stats = {"hits": 0, "misses": 0, "sets": 0, "errors": 0}


def init_cache() -> bool:
    """Initialize Redis connection. Returns True if available."""
    global _client, _available
    settings = get_settings()
    try:
        _client = Redis.from_url(settings.redis_url, decode_responses=True)
        _client.ping()
        _available = True
        logger.info("Redis cache connected")
        return True
    except Exception as e:
        logger.warning(f"Redis unavailable, running without cache: {e}")
        _client = None
        _available = False
        return False


def is_available() -> bool:
    return _available


def get(key: str) -> Any | None:
    if not _available or not _client:
        _stats["misses"] += 1
        return None
    try:
        val = _client.get(key)
        if val:
            _stats["hits"] += 1
            return json.loads(val)
        _stats["misses"] += 1
    except Exception as e:
        _stats["errors"] += 1
        logger.warning(f"Cache get error for {key}: {e}")
    return None


def set(key: str, value: Any, ttl: int | None = None):
    if not _available or not _client:
        return
    settings = get_settings()
    ttl = ttl or settings.redis_cache_ttl
    try:
        _client.setex(key, ttl, json.dumps(value, default=str))
        _stats["sets"] += 1
    except Exception as e:
        _stats["errors"] += 1
        logger.warning(f"Cache set error for {key}: {e}")


def delete(key: str):
    if not _available or not _client:
        return
    try:
        _client.delete(key)
    except Exception as e:
        logger.warning(f"Cache delete error for {key}: {e}")


def flush_pattern(pattern: str):
    if not _available or not _client:
        return
    try:
        keys = _client.keys(pattern)
        if keys:
            _client.delete(*keys)
    except Exception as e:
        logger.warning(f"Cache flush error for {pattern}: {e}")


def get_stats() -> dict:
    return dict(_stats)


def get_memory_info() -> dict:
    """Get Redis memory usage and eviction stats."""
    if not _available or not _client:
        return {"available": False}
    try:
        info = _client.info("memory")
        stats = _client.info("stats")
        used_mb = info.get("used_memory", 0) / (1024 * 1024)
        max_mb = info.get("maxmemory", 0) / (1024 * 1024)
        pct = (used_mb / max_mb * 100) if max_mb > 0 else 0
        evictions = stats.get("evicted_keys", 0)

        result = {
            "available": True,
            "used_mb": round(used_mb, 1),
            "max_mb": round(max_mb, 1),
            "used_pct": round(pct, 1),
            "evicted_keys": evictions,
            "peak_mb": round(info.get("used_memory_peak", 0) / (1024 * 1024), 1),
        }

        if evictions > 0:
            logger.warning(f"redis_eviction_detected: {evictions} keys evicted")
        if pct > 85:
            logger.warning(f"redis_memory_high: {used_mb:.1f}MB / {max_mb:.1f}MB ({pct:.0f}%)")

        return result
    except Exception as e:
        return {"available": True, "error": str(e)[:100]}
