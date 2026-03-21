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
    get_store, run_alert_cycle, format_message,
)
from services.detection.threat import ThreatRanker
from services.detection.adapter import refresh_base_candidates, evaluate_for_client
from services.detection.geometry import haversine_mi, compute_bearing, bearing_to_direction
from services.detection.models import DetectionType
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
    """Execute one detection/alert cycle.

    Phase 10 architecture:
    1. Global: refresh shared base storm candidates (fetch + enrich, once)
    2. Default: run detection with default location → update HTTP snapshot
    3. Per-client: run detection with each client's location → push client-specific results

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
            # 1. Global: refresh shared base candidates
            await refresh_base_candidates()

            # 2. Default: run detection + alert cycle for HTTP endpoint
            result = await run_alert_cycle(ref_lat=lat, ref_lon=lon)

            # Record history for default path
            store = get_store()
            for alert in result.get("alerts", []):
                if alert.status == AlertStatus.new:
                    record_history(alert, "created")
                elif alert.status == AlertStatus.escalated:
                    record_history(alert, "escalated")
            for alert in store.get_all_alerts():
                if alert.status == AlertStatus.expired:
                    if time.time() - alert.updated_at < 5:
                        record_history(alert, "expired")

            # Update default snapshot (for HTTP endpoint)
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

            # 3. Per-client: evaluate + push for each WS client
            manager = get_ws_manager()
            if manager.client_count > 0:
                await _broadcast_per_client(manager, settings)

        except Exception as e:
            logger.error(f"Alert cycle failed: {e}")
            _snapshot.cycle_status = "error"
            _snapshot.updated_at = time.time()


async def _broadcast_per_client(manager, settings):
    """Run client-specific detection and push results to each WS client."""
    dead = []
    for ws, ctx in list(manager._clients.items()):
        try:
            # Determine client reference location
            if ctx.using_client_location and ctx.lat is not None and ctx.lon is not None:
                c_lat, c_lon = ctx.lat, ctx.lon
                loc_source = "client"
            else:
                c_lat = settings.default_lat
                c_lon = settings.default_lon
                loc_source = "default"

            # Run detection with client's pipeline (independent cooldown)
            det_result = evaluate_for_client(c_lat, c_lon, ctx.get_pipeline())

            # Update client's alert store
            alert_store = ctx.get_alert_store()
            changed = alert_store.update_from_detections(det_result.events)
            expired = alert_store.expire_stale()
            active = alert_store.get_active_alerts()

            # Send lifecycle events for this client
            for alert in changed:
                if alert.status == AlertStatus.new:
                    await manager.send_to(ws, _alert_ws_payload("created", alert))
                elif alert.status == AlertStatus.escalated:
                    await manager.send_to(ws, _alert_ws_payload("escalated", alert))

            for alert in alert_store.get_all_alerts():
                if alert.status == AlertStatus.expired:
                    if time.time() - alert.updated_at < 5:
                        await manager.send_to(ws, _alert_ws_payload("expired", alert))

            # Rank alerts by threat score
            alert_dicts = [_alert_to_dict(a) for a in active]
            ranker = ctx.get_threat_ranker()
            ranked = ranker.rank(alert_dicts)

            # Send client-specific snapshot with ranking
            snapshot_msg = {
                "type": "snapshot",
                "primary_threat": ranked["primary_threat"],
                "alerts": ranked["alerts"],
                "count": ranked["count"],
                "updated_at": time.time(),
                "cycle_status": "ok",
                "location_source": loc_source,
            }
            await manager.send_to(ws, snapshot_msg)

        except Exception as e:
            logger.debug(f"Per-client broadcast failed: {e}")
            dead.append(ws)

    for ws in dead:
        manager.disconnect(ws)


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


def build_client_snapshot(ctx: ClientContext) -> dict:
    """Build a client-specific snapshot using client's own alert store + threat ranking."""
    alert_store = ctx.get_alert_store()
    active = alert_store.get_active_alerts()
    loc_source = "client" if ctx.using_client_location else "default"

    alert_dicts = [_alert_to_dict(a) for a in active]
    ranker = ctx.get_threat_ranker()
    ranked = ranker.rank(alert_dicts)

    return {
        "type": "snapshot",
        "primary_threat": ranked["primary_threat"],
        "alerts": ranked["alerts"],
        "count": ranked["count"],
        "updated_at": time.time(),
        "cycle_status": "ok",
        "location_source": loc_source,
    }


def _alert_to_dict(alert: StormAlert) -> dict:
    """Canonical alert serialization — all fields explicit, no inference downstream."""
    now = time.time()
    return {
        # Identity
        "alert_id": alert.alert_id,
        "storm_id": alert.storm_id,
        "type": alert.type,
        "severity": alert.severity,
        # Content
        "title": alert.title,
        "message": alert.message,
        "status": alert.status.value if hasattr(alert.status, "value") else alert.status,
        # Timestamps
        "created_at": alert.created_at,
        "updated_at": alert.updated_at,
        "expires_at": alert.expires_at,
        "freshness": round(now - alert.updated_at, 1),
        # Location
        "lat": alert.lat,
        "lon": alert.lon,
        "distance_mi": alert.distance_mi,
        "bearing_deg": alert.bearing_deg,
        "direction": alert.direction,
        # Motion
        "trend": alert.trend,
        "speed_mph": alert.speed_mph,
        "heading_deg": alert.heading_deg,
        # Timing
        "eta_min": alert.eta_min,
        # Confidence
        "confidence": alert.confidence,
        "track_confidence": alert.track_confidence,
        "motion_confidence": alert.motion_confidence,
        "trend_confidence": alert.trend_confidence,
        # Intensity
        "intensity_trend": getattr(alert, "intensity_trend", "unknown"),
        # Prediction
        "predicted_lat": getattr(alert, "predicted_lat", 0),
        "predicted_lon": getattr(alert, "predicted_lon", 0),
        "prediction_minutes": getattr(alert, "prediction_minutes", 0),
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
