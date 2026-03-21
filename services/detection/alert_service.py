"""Background alert service — periodic detection/alert cycle with snapshot and history.

Runs as an async background task (same pattern as nws_ingest.py).
Maintains:
- current active alert snapshot (for instant API reads)
- bounded recent alert history (lifecycle events)
"""
import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Optional

from config import get_settings
from services.detection.alert_engine import (
    AlertStore, AlertStatus, StormAlert,
    get_store, run_alert_cycle,
)
from services.detection.geometry import haversine_mi, compute_bearing, bearing_to_direction
from services.detection.eta import compute_eta
from services.detection.models import StormObject, Trend
from services.detection.ws_manager import get_ws_manager, ClientContext

logger = logging.getLogger(__name__)

_running = False
_lock = asyncio.Lock()


# --- Snapshot ---

@dataclass
class AlertSnapshot:
    """Point-in-time snapshot of active alert state."""
    alerts: list[StormAlert]
    count: int
    updated_at: float
    detections_processed: int
    alerts_changed: int
    alerts_expired: int
    cycle_status: str  # "ok", "error", "pending"
    last_success: float  # epoch of last successful cycle


_snapshot = AlertSnapshot(
    alerts=[], count=0, updated_at=0, detections_processed=0,
    alerts_changed=0, alerts_expired=0, cycle_status="pending", last_success=0,
)


def get_snapshot() -> AlertSnapshot:
    return _snapshot


# --- History ---

@dataclass
class HistoryEntry:
    """A single lifecycle event in alert history."""
    timestamp: float
    alert_id: str
    storm_id: str
    type: str
    severity: int
    title: str
    message: str
    action: str  # "created", "escalated", "expired"
    distance_mi: Optional[float] = None
    eta_min: Optional[float] = None


_history: deque[HistoryEntry] = deque(maxlen=100)


def get_history() -> list[HistoryEntry]:
    """Return recent history, newest first."""
    return list(_history)


def record_history(alert: StormAlert, action: str):
    """Record a lifecycle event to history."""
    _history.appendleft(HistoryEntry(
        timestamp=time.time(),
        alert_id=alert.alert_id,
        storm_id=alert.storm_id,
        type=alert.type,
        severity=alert.severity,
        title=alert.title,
        message=alert.message,
        action=action,
        distance_mi=alert.distance_mi,
        eta_min=alert.eta_min,
    ))


# --- Background Cycle ---

async def run_cycle_once(
    ref_lat: float | None = None,
    ref_lon: float | None = None,
):
    """Execute one detection/alert cycle and update snapshot + history.

    Protected by async lock to prevent concurrent execution.
    """
    global _snapshot

    if _lock.locked():
        logger.debug("Alert cycle skipped — previous cycle still running")
        return

    async with _lock:
        settings = get_settings()
        lat = ref_lat if ref_lat is not None else settings.default_lat
        lon = ref_lon if ref_lon is not None else settings.default_lon

        try:
            # Run the full alert cycle
            result = await run_alert_cycle(ref_lat=lat, ref_lon=lon)

            # Record history + collect lifecycle events for WS broadcast
            store = get_store()
            ws_events = []
            for alert in result.get("alerts", []):
                if alert.status == AlertStatus.new:
                    record_history(alert, "created")
                    ws_events.append(("created", alert))
                elif alert.status == AlertStatus.escalated:
                    record_history(alert, "escalated")
                    ws_events.append(("escalated", alert))

            for alert in store.get_all_alerts():
                if alert.status == AlertStatus.expired:
                    if time.time() - alert.updated_at < 5:
                        record_history(alert, "expired")
                        ws_events.append(("expired", alert))

            # Update snapshot
            now = time.time()
            _snapshot = AlertSnapshot(
                alerts=result["alerts"],
                count=result["count"],
                updated_at=now,
                detections_processed=result["detections_processed"],
                alerts_changed=result["alerts_changed"],
                alerts_expired=result["alerts_expired"],
                cycle_status="ok",
                last_success=now,
            )

            # Broadcast via WebSocket if there are changes or clients
            manager = get_ws_manager()
            if manager.client_count > 0:
                # Send lifecycle events (same for all clients — raw event data)
                for action, alert in ws_events:
                    await manager.broadcast(_alert_ws_payload(action, alert))

                # Send per-client reprojected snapshots if anything changed
                if result["alerts_changed"] > 0 or result["alerts_expired"] > 0 or ws_events:
                    await manager.send_to_each(
                        lambda ctx: build_client_snapshot(ctx)
                    )

        except Exception as e:
            logger.error(f"Alert cycle failed: {e}")
            # Preserve last good snapshot, just update status
            _snapshot.cycle_status = "error"
            _snapshot.updated_at = time.time()


async def run_alert_loop():
    """Background loop — runs detection/alert cycle on interval."""
    global _running
    settings = get_settings()
    _running = True
    interval = settings.alert_poll_interval

    logger.info(f"Alert service starting (interval: {interval}s)")

    # Initial cycle immediately
    await run_cycle_once()

    while _running:
        await asyncio.sleep(interval)
        try:
            await run_cycle_once()
        except Exception as e:
            logger.error(f"Alert loop error: {e}")


def stop_alert_loop():
    global _running
    _running = False


def _reproject_alert(alert_dict: dict, ref_lat: float, ref_lon: float) -> dict:
    """Recompute distance/bearing/direction/ETA for an alert relative to a client location."""
    d = dict(alert_dict)  # shallow copy
    storm_lat = d.get("lat", 0)
    storm_lon = d.get("lon", 0)
    if storm_lat == 0 and storm_lon == 0:
        return d

    d["distance_mi"] = round(haversine_mi(ref_lat, ref_lon, storm_lat, storm_lon), 1)
    bearing = compute_bearing(ref_lat, ref_lon, storm_lat, storm_lon)
    d["bearing_deg"] = bearing
    d["direction"] = bearing_to_direction(bearing)

    speed = d.get("speed_mph", 0)
    if speed > 0 and d["distance_mi"] > 0:
        d["eta_min"] = round(d["distance_mi"] / speed * 60, 1)
    else:
        d["eta_min"] = None

    return d


def build_client_snapshot(ctx: ClientContext) -> dict:
    """Build a snapshot payload reprojected to a client's location."""
    base = _snapshot_ws_payload()

    if ctx.using_client_location and ctx.lat is not None and ctx.lon is not None:
        base["alerts"] = [
            _reproject_alert(a, ctx.lat, ctx.lon) for a in base["alerts"]
        ]
        # Re-sort: severity desc, distance asc
        base["alerts"].sort(key=lambda a: (-a.get("severity", 0), a.get("distance_mi", 9999)))
        base["location_source"] = "client"
    else:
        base["location_source"] = "default"

    return base


def _alert_to_dict(alert: StormAlert) -> dict:
    return {
        "alert_id": alert.alert_id,
        "storm_id": alert.storm_id,
        "type": alert.type,
        "severity": alert.severity,
        "confidence": alert.confidence,
        "title": alert.title,
        "message": alert.message,
        "status": alert.status.value if hasattr(alert.status, "value") else alert.status,
        "distance_mi": alert.distance_mi,
        "direction": alert.direction,
        "bearing_deg": alert.bearing_deg,
        "eta_min": alert.eta_min,
        "lat": alert.lat,
        "lon": alert.lon,
        "speed_mph": alert.speed_mph,
    }


def _snapshot_ws_payload() -> dict:
    return {
        "type": "snapshot",
        "alerts": [_alert_to_dict(a) for a in _snapshot.alerts],
        "count": _snapshot.count,
        "updated_at": _snapshot.updated_at,
        "cycle_status": _snapshot.cycle_status,
    }


def _alert_ws_payload(action: str, alert: StormAlert) -> dict:
    return {
        "type": action,
        "alert": _alert_to_dict(alert),
        "updated_at": time.time(),
    }


def reset_service():
    """Reset all service state. For testing."""
    global _snapshot
    _snapshot = AlertSnapshot(
        alerts=[], count=0, updated_at=0, detections_processed=0,
        alerts_changed=0, alerts_expired=0, cycle_status="pending", last_success=0,
    )
    _history.clear()
    get_store().clear()
