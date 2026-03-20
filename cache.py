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
