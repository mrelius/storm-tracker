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

            # Record history for changed alerts
            store = get_store()
            for alert in result.get("alerts", []):
                if alert.status == AlertStatus.new:
                    record_history(alert, "created")
                elif alert.status == AlertStatus.escalated:
                    record_history(alert, "escalated")

            # Record expired alerts (they're in the store but not in active list)
            for alert in store.get_all_alerts():
                if alert.status == AlertStatus.expired:
                    # Only record if recently expired (within this cycle)
                    if time.time() - alert.updated_at < 5:
                        record_history(alert, "expired")

            # Update snapshot
            _snapshot = AlertSnapshot(
                alerts=result["alerts"],
                count=result["count"],
                updated_at=time.time(),
                detections_processed=result["detections_processed"],
                alerts_changed=result["alerts_changed"],
                alerts_expired=result["alerts_expired"],
                cycle_status="ok",
                last_success=time.time(),
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


def reset_service():
    """Reset all service state. For testing."""
    global _snapshot
    _snapshot = AlertSnapshot(
        alerts=[], count=0, updated_at=0, detections_processed=0,
        alerts_changed=0, alerts_expired=0, cycle_status="pending", last_success=0,
    )
    _history.clear()
    get_store().clear()
