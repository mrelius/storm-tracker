"""
Storm Tracker — Data Freshness Service

Central authority for data freshness enforcement across all feeds.
Validates timestamps, computes age, enforces per-feed TTL policies,
detects clock skew, and tracks feed health.

HARD FAIL policy for alerts and audio: stale data is DROPPED, never
served as fallback. No last-known-good for safety-critical paths.

Feed isolation: one degraded source cannot poison other sources.
"""

import time
import logging
from datetime import datetime, timezone
from typing import Optional

try:
    from logging_config import get_logger
    logger = get_logger("freshness")
except ImportError:
    logger = logging.getLogger("freshness")


# ── Per-Feed Freshness Policies ──────────────────────────────────
# max_age_sec: hard cutoff — data older than this is STALE
# warn_age_sec: soft threshold — data older than this triggers warning
# stale_action: what happens when data exceeds max_age
#   "drop"       — HARD FAIL, data is rejected (alerts, audio, AI)
#   "quarantine"  — data stored but flagged, not served to UI
#   "warn"        — data served with stale badge
#   "expire"      — data auto-removed from active state

FRESHNESS_POLICIES = {
    # NWS individual alert staleness — based on 'expires' not 'sent'
    # NWS alerts can have 'sent' hours ago but still be active until 'expires'.
    # This policy is used for alerts whose expires is past or nearly past.
    "nws_alerts": {
        "max_age_sec": 300,       # 5 min past expiration = stale
        "warn_age_sec": 120,      # 2 min past expiration warning
        "stale_action": "drop",   # HARD FAIL — expired alerts never reach UI
        "description": "NWS active alerts (expires-based)",
    },
    # NWS feed health (pipeline-level)
    "nws_feed": {
        "max_age_sec": 300,       # 5 min since last successful fetch
        "warn_age_sec": 180,      # 3 min warning
        "stale_action": "drop",   # HARD FAIL — no stale feed data
        "description": "NWS API feed health",
    },
    # SPC outlooks — longer TTL (updated every 6hrs)
    "spc_outlook": {
        "max_age_sec": 3600,      # 1 hour
        "warn_age_sec": 1800,     # 30 min
        "stale_action": "warn",
        "description": "SPC categorical outlooks",
    },
    # SPC watches
    "spc_watches": {
        "max_age_sec": 600,
        "warn_age_sec": 300,
        "stale_action": "warn",
        "description": "SPC watches and MDs",
    },
    # Radar reflectivity (RainViewer)
    "radar_reflectivity": {
        "max_age_sec": 900,       # 15 min
        "warn_age_sec": 600,      # 10 min
        "stale_action": "warn",
        "description": "Radar reflectivity frames",
    },
    # Radar SRV (IEM)
    "radar_srv": {
        "max_age_sec": 600,
        "warn_age_sec": 300,
        "stale_action": "warn",
        "description": "Storm relative velocity",
    },
    # AI results — hard fail for audio safety
    "ai_result": {
        "max_age_sec": 900,       # 15 min
        "warn_age_sec": 600,
        "stale_action": "drop",   # HARD FAIL — no stale AI narration
        "description": "AI advisory results",
    },
    # Detection events
    "detection_event": {
        "max_age_sec": 300,       # 5 min
        "warn_age_sec": 180,
        "stale_action": "expire",
        "description": "Detection pipeline events",
    },
    # Audio streams — hard fail
    "audio": {
        "max_age_sec": 300,       # 5 min
        "warn_age_sec": 120,
        "stale_action": "drop",   # HARD FAIL — no stale audio data
        "description": "Audio stream data",
    },
}

# Clock skew: reject timestamps more than 30s in the future
FUTURE_TOLERANCE_SEC = 30

# Duplicate detection window
DEDUP_WINDOW_SEC = 120


# ── Feed State Tracking ──────────────────────────────────────────

_feed_state = {}  # source_name -> {last_good_ts, last_update_ts, consecutive_stale, ...}
_stale_drop_log = []  # recent stale drop events (capped at 100)
_dedup_seen = {}  # entity_id -> timestamp (for duplicate detection)


def _get_feed(source: str) -> dict:
    """Get or create feed state entry."""
    if source not in _feed_state:
        _feed_state[source] = {
            "last_good_ts": 0,
            "last_good_data_ts": 0,  # timestamp OF the data (not when received)
            "last_update_ts": 0,
            "consecutive_stale": 0,
            "total_fresh": 0,
            "total_stale": 0,
            "total_dropped": 0,
            "total_future_rejected": 0,
            "total_duplicates": 0,
            "health_score": 100,
            "status": "unknown",
        }
    return _feed_state[source]


# ── Core Freshness Check ─────────────────────────────────────────

def check(entity_type: str, data_timestamp: float, entity_id: str = "") -> dict:
    """
    Check freshness of a data entity.

    Args:
        entity_type: key into FRESHNESS_POLICIES
        data_timestamp: epoch timestamp of the data (when it was generated/sent)
        entity_id: optional ID for dedup tracking

    Returns:
        {
            "is_fresh": bool,
            "age_sec": float,
            "status": "fresh" | "warning" | "stale" | "future" | "duplicate",
            "expires_at": float (epoch),
            "action": "accept" | "drop" | "quarantine" | "warn" | "expire",
            "reason": str,
        }
    """
    now = time.time()
    policy = FRESHNESS_POLICIES.get(entity_type)
    if not policy:
        return {
            "is_fresh": True,
            "age_sec": 0,
            "status": "unknown_type",
            "expires_at": now + 3600,
            "action": "accept",
            "reason": f"no policy for {entity_type}",
        }

    feed = _get_feed(entity_type)
    age_sec = now - data_timestamp

    # ── Future timestamp detection (clock skew) ──
    if age_sec < -FUTURE_TOLERANCE_SEC:
        feed["total_future_rejected"] += 1
        _log_stale_event(entity_type, entity_id, "future_timestamp",
                         age_sec, policy["stale_action"])
        return {
            "is_fresh": False,
            "age_sec": age_sec,
            "status": "future",
            "expires_at": 0,
            "action": "drop",
            "reason": f"future timestamp: {abs(age_sec):.0f}s ahead of server clock",
        }

    # ── Duplicate detection ──
    if entity_id:
        prev_ts = _dedup_seen.get(entity_id)
        if prev_ts and abs(data_timestamp - prev_ts) < 1.0:
            feed["total_duplicates"] += 1
            return {
                "is_fresh": False,
                "age_sec": age_sec,
                "status": "duplicate",
                "expires_at": 0,
                "action": "drop",
                "reason": f"duplicate entity {entity_id}",
            }
        _dedup_seen[entity_id] = data_timestamp
        # Prune dedup cache
        if len(_dedup_seen) > 5000:
            cutoff = now - DEDUP_WINDOW_SEC
            _dedup_seen.clear()  # simple reset to avoid memory growth

    # ── Staleness check ──
    expires_at = data_timestamp + policy["max_age_sec"]

    if age_sec > policy["max_age_sec"]:
        # STALE — apply policy action
        feed["consecutive_stale"] += 1
        feed["total_stale"] += 1
        feed["total_dropped"] += 1 if policy["stale_action"] == "drop" else 0
        _update_health(entity_type, False)
        _log_stale_event(entity_type, entity_id, "stale",
                         age_sec, policy["stale_action"])
        return {
            "is_fresh": False,
            "age_sec": round(age_sec, 1),
            "status": "stale",
            "expires_at": expires_at,
            "action": policy["stale_action"],
            "reason": f"age {age_sec:.0f}s exceeds max {policy['max_age_sec']}s",
        }

    if age_sec > policy["warn_age_sec"]:
        # WARNING — still served but flagged
        feed["consecutive_stale"] = 0
        feed["total_fresh"] += 1
        _update_health(entity_type, True)
        feed["last_good_ts"] = now
        feed["last_good_data_ts"] = data_timestamp
        return {
            "is_fresh": True,
            "age_sec": round(age_sec, 1),
            "status": "warning",
            "expires_at": expires_at,
            "action": "accept",
            "reason": f"age {age_sec:.0f}s exceeds warn threshold {policy['warn_age_sec']}s",
        }

    # ── FRESH ──
    feed["consecutive_stale"] = 0
    feed["total_fresh"] += 1
    _update_health(entity_type, True)
    feed["last_good_ts"] = now
    feed["last_good_data_ts"] = data_timestamp
    feed["last_update_ts"] = now
    feed["status"] = "ok"
    return {
        "is_fresh": True,
        "age_sec": round(age_sec, 1),
        "status": "fresh",
        "expires_at": expires_at,
        "action": "accept",
        "reason": "within freshness threshold",
    }


def is_fresh(entity_type: str, data_timestamp: float, entity_id: str = "") -> bool:
    """Simple boolean freshness check."""
    result = check(entity_type, data_timestamp, entity_id)
    return result["is_fresh"]


def get_age(data_timestamp: float) -> float:
    """Compute age in seconds from epoch timestamp."""
    return round(time.time() - data_timestamp, 1)


def should_expire(entity_type: str, data_timestamp: float) -> bool:
    """Check if an entity should be expired/purged."""
    result = check(entity_type, data_timestamp)
    return result["action"] in ("drop", "expire")


def compute_expires_at(entity_type: str, data_timestamp: float) -> float:
    """Compute when this entity expires (epoch)."""
    policy = FRESHNESS_POLICIES.get(entity_type, {})
    max_age = policy.get("max_age_sec", 3600)
    return data_timestamp + max_age


# ── Feed Health ──────────────────────────────────────────────────

def _update_health(source: str, success: bool):
    """Update rolling health score for a feed."""
    feed = _get_feed(source)
    # Simple EWMA: health = 0.9 * health + 0.1 * (100 if success else 0)
    current = feed["health_score"]
    feed["health_score"] = round(0.9 * current + 0.1 * (100 if success else 0), 1)
    if feed["health_score"] >= 80:
        feed["status"] = "ok"
    elif feed["health_score"] >= 50:
        feed["status"] = "degraded"
    else:
        feed["status"] = "failed"


def record_update(source: str, data_timestamp: float):
    """Record a successful data update for a source."""
    feed = _get_feed(source)
    feed["last_good_ts"] = time.time()
    feed["last_good_data_ts"] = data_timestamp
    feed["last_update_ts"] = time.time()
    feed["status"] = "ok"


def get_feed_health(source: str = None) -> dict:
    """Get health status for one or all feeds."""
    now = time.time()
    if source:
        feed = _get_feed(source)
        policy = FRESHNESS_POLICIES.get(source, {})
        feed_age = now - feed["last_good_ts"] if feed["last_good_ts"] else None
        return {
            "source": source,
            "description": policy.get("description", source),
            "status": feed["status"],
            "health_score": feed["health_score"],
            "last_good_age_sec": round(feed_age, 1) if feed_age else None,
            "last_good_data_ts": feed["last_good_data_ts"] or None,
            "consecutive_stale": feed["consecutive_stale"],
            "total_fresh": feed["total_fresh"],
            "total_stale": feed["total_stale"],
            "total_dropped": feed["total_dropped"],
            "total_future_rejected": feed["total_future_rejected"],
            "total_duplicates": feed["total_duplicates"],
            "policy": policy,
        }

    # All feeds
    result = {}
    for src in FRESHNESS_POLICIES:
        result[src] = get_feed_health(src)
    return result


# ── Stale Event Logging ──────────────────────────────────────────

def _log_stale_event(entity_type: str, entity_id: str, reason: str,
                     age_sec: float, action: str):
    """Log structured stale data event."""
    event = {
        "ts": time.time(),
        "source": entity_type,
        "entity_id": entity_id or "unknown",
        "reason": reason,
        "age_sec": round(age_sec, 1),
        "action": action,
    }
    _stale_drop_log.append(event)
    # Cap at 100 entries
    if len(_stale_drop_log) > 100:
        _stale_drop_log.pop(0)

    logger.info("stale_drop",
                source=entity_type,
                entity_id=entity_id or "unknown",
                reason=reason,
                age_sec=round(age_sec, 1),
                action=action)


def get_stale_log(limit: int = 50) -> list:
    """Return recent stale drop events."""
    return _stale_drop_log[-limit:]


# ── Dashboard Data ───────────────────────────────────────────────

def get_dashboard_data() -> dict:
    """Full freshness state for UI dashboard."""
    now = time.time()
    feeds = {}
    overall_health = 100
    stale_sources = []

    for source, policy in FRESHNESS_POLICIES.items():
        feed = _get_feed(source)
        feed_age = now - feed["last_good_ts"] if feed["last_good_ts"] else None

        status = "unknown"
        if feed["last_good_ts"] == 0:
            status = "no_data"
        elif feed_age and feed_age > policy["max_age_sec"]:
            status = "stale"
            stale_sources.append(source)
        elif feed_age and feed_age > policy["warn_age_sec"]:
            status = "warning"
        else:
            status = "fresh"

        feeds[source] = {
            "description": policy["description"],
            "status": status,
            "health_score": feed["health_score"],
            "age_sec": round(feed_age, 1) if feed_age else None,
            "max_age_sec": policy["max_age_sec"],
            "warn_age_sec": policy["warn_age_sec"],
            "stale_action": policy["stale_action"],
            "stats": {
                "fresh": feed["total_fresh"],
                "stale": feed["total_stale"],
                "dropped": feed["total_dropped"],
                "future_rejected": feed["total_future_rejected"],
                "duplicates": feed["total_duplicates"],
            },
        }
        overall_health = min(overall_health, feed["health_score"])

    return {
        "timestamp": now,
        "overall_health": overall_health,
        "overall_status": "stale" if stale_sources else "ok",
        "stale_sources": stale_sources,
        "feeds": feeds,
        "recent_drops": get_stale_log(20),
    }


# ── Validate Timestamp Helper ────────────────────────────────────

def validate_timestamp(ts_str: str) -> Optional[float]:
    """
    Parse an ISO 8601 timestamp string to epoch float.
    Returns None if unparseable. Rejects future timestamps.
    """
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        epoch = dt.timestamp()
        now = time.time()
        if epoch > now + FUTURE_TOLERANCE_SEC:
            logger.warning(f"future_timestamp_rejected: {ts_str} is {epoch - now:.0f}s ahead")
            return None
        return epoch
    except (ValueError, TypeError, OSError):
        return None


def validate_epoch(epoch: float) -> Optional[float]:
    """
    Validate an epoch timestamp. Returns None if invalid or future.
    """
    if not epoch or epoch <= 0:
        return None
    now = time.time()
    if epoch > now + FUTURE_TOLERANCE_SEC:
        return None
    return epoch
