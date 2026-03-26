"""
Storm Tracker — Storm State Model

Authoritative backend state for all active NWS alerts.
Single source of truth for alert tracking, primary target selection,
and state observability.

Primary target selection uses NWS alert type priority:
  TOR (Tornado Warning)              = 1 (highest)
  SVR (Severe Thunderstorm Warning)  = 2
  FFW (Flash Flood Warning)          = 3
  Everything else                    = 4

Within same type: closest to user location, then newest by timestamp.

Performance guards:
  - Max 25 active polygons tracked
  - Stale alert cleanup (>60s past expiry)
  - Update cycle time tracking
"""

import asyncio
import json
import math
import time
import logging
import copy
from typing import Optional, Callable

try:
    from logging_config import get_logger
    logger = get_logger("storm_state")
except ImportError:
    logger = logging.getLogger("storm_state")

# ── Constants ────────────────────────────────────────────────────

MAX_ACTIVE_POLYGONS = 25
STALE_EXPIRY_GRACE_SEC = 60

# NWS alert type → priority (lower = higher priority)
# Uses full event name substrings for reliable matching
ALERT_TYPE_PRIORITY: dict[str, int] = {
    "Tornado Warning": 1,
    "Severe Thunderstorm Warning": 2,
    "Flash Flood Warning": 3,
}
DEFAULT_PRIORITY = 4

# Earth radius in miles for haversine
_EARTH_RADIUS_MI = 3958.8


# ── Haversine ────────────────────────────────────────────────────

def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great-circle distance in miles between two points."""
    lat1_r, lon1_r = math.radians(lat1), math.radians(lon1)
    lat2_r, lon2_r = math.radians(lat2), math.radians(lon2)

    dlat = lat2_r - lat1_r
    dlon = lon2_r - lon1_r

    a = (math.sin(dlat / 2) ** 2
         + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlon / 2) ** 2)
    c = 2 * math.asin(math.sqrt(a))

    return _EARTH_RADIUS_MI * c


# ── Alert Type Helpers ───────────────────────────────────────────

def _get_type_priority(alert: dict) -> int:
    """Return numeric priority for an alert's NWS event type."""
    event = alert.get("event", "")
    # Match on full event name substrings
    for name, priority in ALERT_TYPE_PRIORITY.items():
        if name in event:
            return priority
    return DEFAULT_PRIORITY


def _get_alert_centroid(alert: dict) -> tuple[float, float] | None:
    """Extract centroid lat/lon from an alert's geometry or properties."""
    # Direct lat/lon on alert
    if "lat" in alert and "lon" in alert:
        try:
            return float(alert["lat"]), float(alert["lon"])
        except (ValueError, TypeError):
            pass

    # Centroid field
    centroid = alert.get("centroid")
    if centroid and isinstance(centroid, (list, tuple)) and len(centroid) >= 2:
        try:
            return float(centroid[0]), float(centroid[1])
        except (ValueError, TypeError):
            pass

    # GeoJSON geometry — compute centroid from polygon coordinates
    geometry = alert.get("geometry")
    if geometry and isinstance(geometry, dict):
        coords = geometry.get("coordinates")
        if coords:
            try:
                # Flatten first ring of first polygon
                ring = coords[0] if isinstance(coords[0][0], (list, tuple)) else coords
                if isinstance(ring[0][0], (list, tuple)):
                    ring = ring[0]
                lats = [p[1] for p in ring]
                lons = [p[0] for p in ring]
                return sum(lats) / len(lats), sum(lons) / len(lons)
            except (IndexError, TypeError, ZeroDivisionError):
                pass

    return None


def _get_alert_timestamp(alert: dict) -> float:
    """Extract timestamp as epoch seconds from alert. Higher = newer."""
    for key in ("sent", "onset", "effective", "timestamp"):
        val = alert.get(key)
        if isinstance(val, (int, float)):
            return float(val)
        if isinstance(val, str):
            try:
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
                return dt.timestamp()
            except (ValueError, AttributeError):
                pass
    return 0.0


def _get_alert_expiry(alert: dict) -> float:
    """Extract expiry timestamp as epoch seconds from alert."""
    val = alert.get("expires")
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        try:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return dt.timestamp()
        except (ValueError, AttributeError):
            pass
    return 0.0


# ── Storm State ──────────────────────────────────────────────────

storm_state: dict = {
    "alerts": {},           # Map<alert_id, alert_dict>
    "active_ids": set(),    # Set of active alert IDs
    "primary_id": None,     # Current primary target ID
    "last_update_ts": 0,    # Last update timestamp (epoch)
    "polygon_count": 0,     # Number of rendered polygons
    "update_cycle_ms": 0,   # Last update cycle time in ms
}

# Async lock for thread-safe state mutations
_state_lock = asyncio.Lock()

# External subscriber callbacks for primary change events
_on_primary_changed_callbacks: list[Callable[[Optional[str], Optional[str]], None]] = []

# State-changed callbacks — fired after EVERY update_from_ingest
# Callback signature: (state_snapshot: dict) -> None
_on_state_changed_callbacks: list[Callable[[dict], None]] = []

# Monotonic sequence ID for ordering guarantees
_sequence_id: int = 0


# ── Callbacks ────────────────────────────────────────────────────

def _on_primary_changed(old_id: Optional[str], new_id: Optional[str]) -> None:
    """Internal handler when primary target changes. Logs and notifies subscribers."""
    if old_id == new_id:
        return

    new_alert = storm_state["alerts"].get(new_id) if new_id else None
    log_data: dict = {
        "old_id": old_id,
        "new_id": new_id,
    }
    if new_alert:
        log_data["type"] = new_alert.get("event", "unknown")
        centroid = _get_alert_centroid(new_alert)
        if centroid:
            log_data["distance"] = "computed_at_selection"

    logger.info("primary_selected %s", log_data)

    for cb in _on_primary_changed_callbacks:
        try:
            cb(old_id, new_id)
        except Exception:
            logger.exception("primary_changed callback error")


def register_primary_callback(callback: Callable[[Optional[str], Optional[str]], None]) -> None:
    """Register an external callback for primary target changes.

    Callback signature: (old_id: str | None, new_id: str | None) -> None
    """
    _on_primary_changed_callbacks.append(callback)


def unregister_primary_callback(callback: Callable[[Optional[str], Optional[str]], None]) -> None:
    """Remove a previously registered primary change callback."""
    try:
        _on_primary_changed_callbacks.remove(callback)
    except ValueError:
        pass


def register_state_changed_callback(callback: Callable[[dict], None]) -> None:
    """Register callback for any state change. Called after every update_from_ingest.

    Callback receives a serializable state snapshot dict with sequence_id.
    """
    _on_state_changed_callbacks.append(callback)


def unregister_state_changed_callback(callback: Callable[[dict], None]) -> None:
    """Remove a previously registered state change callback."""
    try:
        _on_state_changed_callbacks.remove(callback)
    except ValueError:
        pass


# ── Core Functions ───────────────────────────────────────────────

def update_alerts(alerts: list[dict]) -> None:
    """Atomic update of all alerts into storm state.

    Replaces entire alert set. Cleans stale alerts, enforces polygon cap,
    and tracks update cycle time.

    Each alert dict must have an 'id' field.
    """
    t0 = time.monotonic()

    now = time.time()
    new_alerts: dict[str, dict] = {}
    new_active: set[str] = set()
    stale_count = 0

    for alert in alerts:
        alert_id = alert.get("id")
        if not alert_id:
            continue

        # Stale alert cleanup: skip alerts expired >60s ago
        expiry = _get_alert_expiry(alert)
        if expiry > 0 and (now - expiry) > STALE_EXPIRY_GRACE_SEC:
            stale_count += 1
            continue

        new_alerts[alert_id] = alert
        new_active.add(alert_id)

    # Enforce polygon cap — keep highest-priority alerts
    if len(new_active) > MAX_ACTIVE_POLYGONS:
        sorted_ids = sorted(
            new_active,
            key=lambda aid: (
                _get_type_priority(new_alerts[aid]),
                -_get_alert_timestamp(new_alerts[aid]),
            ),
        )
        kept = set(sorted_ids[:MAX_ACTIVE_POLYGONS])
        dropped = new_active - kept
        new_active = kept
        for aid in dropped:
            del new_alerts[aid]

    # Compute expired count (alerts in old state not in new)
    old_ids = storm_state["active_ids"]
    expired_count = len(old_ids - new_active) if isinstance(old_ids, set) else 0

    # Atomic state update
    storm_state["alerts"] = new_alerts
    storm_state["active_ids"] = new_active
    storm_state["last_update_ts"] = now
    storm_state["polygon_count"] = len(new_active)

    elapsed_ms = round((time.monotonic() - t0) * 1000, 1)
    storm_state["update_cycle_ms"] = elapsed_ms

    logger.info(
        "alerts_updated count=%d active=%d expired=%d",
        len(alerts), len(new_active), expired_count,
    )

    if stale_count > 0:
        logger.info("stale_alerts_dropped count=%d", stale_count)

    logger.debug("update_cycle_time ms=%.1f", elapsed_ms)


async def update_from_ingest(alert_rows: list[dict], user_lat: float = 39.5, user_lon: float = -84.5) -> dict:
    """Update storm state from ingest pipeline results.

    This is the PRIMARY entry point for alert data. Called after DB storage.
    Atomically updates all state and selects primary target.

    Args:
        alert_rows: List of alert dicts (from DB rows or ingest)
        user_lat: Default user latitude for primary selection
        user_lon: Default user longitude for primary selection

    Returns:
        Dict with update summary: {active_count, primary_id, cycle_ms}
    """
    async with _state_lock:
        update_alerts(alert_rows)
        primary = select_primary(user_lat, user_lon)

        global _sequence_id
        _sequence_id += 1
        storm_state["sequence_id"] = _sequence_id

        logger.info(
            "state_updated seq=%d active=%d primary=%s cycle_ms=%.1f",
            _sequence_id,
            len(storm_state["active_ids"]),
            primary or "none",
            storm_state["update_cycle_ms"],
        )

        # Fire state-changed callbacks
        snapshot = get_serializable_state()
        for cb in _on_state_changed_callbacks:
            try:
                cb(snapshot)
            except Exception:
                logger.exception("state_changed callback error")

        return {
            "active_count": len(storm_state["active_ids"]),
            "primary_id": primary,
            "cycle_ms": storm_state["update_cycle_ms"],
        }


def select_primary(user_lat: float, user_lon: float) -> Optional[str]:
    """Select primary target alert based on type priority, distance, and recency.

    Priority order:
      1. Alert type (TOR > SVR > FFW > other)
      2. Distance to user (closest first)
      3. Timestamp (newest first)

    Returns the alert ID of the selected primary, or None if no active alerts.
    """
    active_ids = storm_state["active_ids"]
    alerts = storm_state["alerts"]

    if not active_ids:
        old_primary = storm_state["primary_id"]
        if old_primary is not None:
            storm_state["primary_id"] = None
            _on_primary_changed(old_primary, None)
        return None

    def sort_key(alert_id: str) -> tuple[int, float, float]:
        alert = alerts[alert_id]
        priority = _get_type_priority(alert)
        centroid = _get_alert_centroid(alert)
        distance = _haversine(user_lat, user_lon, centroid[0], centroid[1]) if centroid else 9999.0
        timestamp = _get_alert_timestamp(alert)
        # Sort: lowest priority number first, closest distance, newest timestamp (negative for desc)
        return (priority, distance, -timestamp)

    sorted_ids = sorted(active_ids, key=sort_key)
    new_primary_id = sorted_ids[0]

    old_primary = storm_state["primary_id"]
    storm_state["primary_id"] = new_primary_id

    if old_primary != new_primary_id:
        # Enrich log with distance
        new_alert = alerts[new_primary_id]
        centroid = _get_alert_centroid(new_alert)
        distance = _haversine(user_lat, user_lon, centroid[0], centroid[1]) if centroid else None
        logger.info(
            "primary_selected id=%s type=%s distance=%.1f",
            new_primary_id,
            new_alert.get("event", "unknown"),
            distance if distance is not None else -1,
        )
        _on_primary_changed(old_primary, new_primary_id)

    return new_primary_id


def get_active_alerts() -> list[dict]:
    """Return active alerts sorted by type priority, then distance-agnostic order.

    Returns copies to prevent external mutation.
    """
    alerts = storm_state["alerts"]
    active_ids = storm_state["active_ids"]

    if not active_ids:
        return []

    sorted_alerts = sorted(
        (alerts[aid] for aid in active_ids if aid in alerts),
        key=lambda a: (
            _get_type_priority(a),
            -_get_alert_timestamp(a),
        ),
    )

    return [copy.deepcopy(a) for a in sorted_alerts]


def get_state() -> dict:
    """Return a deep copy of the current storm state for observability."""
    return {
        "alerts": {k: copy.deepcopy(v) for k, v in storm_state["alerts"].items()},
        "active_ids": list(storm_state["active_ids"]),
        "primary_id": storm_state["primary_id"],
        "last_update_ts": storm_state["last_update_ts"],
        "polygon_count": storm_state["polygon_count"],
        "update_cycle_ms": storm_state["update_cycle_ms"],
        "sequence_id": storm_state.get("sequence_id", 0),
    }


def clear() -> None:
    """Reset all storm state to initial values."""
    old_primary = storm_state["primary_id"]

    storm_state["alerts"] = {}
    storm_state["active_ids"] = set()
    storm_state["primary_id"] = None
    storm_state["last_update_ts"] = 0
    storm_state["polygon_count"] = 0
    storm_state["update_cycle_ms"] = 0

    if old_primary is not None:
        _on_primary_changed(old_primary, None)

    logger.info("state_cleared")


async def remove_stale() -> int:
    """Remove stale alerts from state. Returns count removed."""
    async with _state_lock:
        now = time.time()
        stale_ids = set()
        for aid, alert in storm_state["alerts"].items():
            expiry = _get_alert_expiry(alert)
            if expiry > 0 and (now - expiry) > STALE_EXPIRY_GRACE_SEC:
                stale_ids.add(aid)

        if not stale_ids:
            return 0

        for aid in stale_ids:
            del storm_state["alerts"][aid]
            storm_state["active_ids"].discard(aid)

        storm_state["polygon_count"] = len(storm_state["active_ids"])

        logger.info("stale_alerts_removed count=%d ids=%s", len(stale_ids), list(stale_ids)[:5])
        return len(stale_ids)


async def compute_primary(user_lat: float = 39.5, user_lon: float = -84.5) -> str | None:
    """Recompute primary target. Thread-safe."""
    async with _state_lock:
        return select_primary(user_lat, user_lon)


def get_serializable_state() -> dict:
    """Return state suitable for JSON serialization to frontend.

    Strips raw_json and description fields to keep payload small.
    """
    alerts_slim = {}
    for aid, alert in storm_state["alerts"].items():
        slim = {k: v for k, v in alert.items() if k not in ("raw_json", "description", "instruction")}
        alerts_slim[aid] = slim

    return {
        "primary_id": storm_state["primary_id"],
        "active_ids": list(storm_state["active_ids"]),
        "alerts": alerts_slim,
        "timestamp": storm_state["last_update_ts"],
        "polygon_count": storm_state["polygon_count"],
        "update_cycle_ms": storm_state["update_cycle_ms"],
        "sequence_id": storm_state.get("sequence_id", 0),
    }
