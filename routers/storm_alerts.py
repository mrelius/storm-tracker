"""Storm alert API endpoints.

GET /api/storm-alerts — returns current maintained snapshot (no recompute)
GET /api/storm-alert-history — returns recent alert lifecycle history
"""
from fastapi import APIRouter
from pydantic import BaseModel
from services.detection.alert_service import get_snapshot, get_history

router = APIRouter(prefix="/api/storm-alerts", tags=["storm-alerts"])


class StormAlertOut(BaseModel):
    alert_id: str
    storm_id: str
    type: str
    severity: int
    confidence: float
    title: str
    message: str
    status: str
    created_at: float
    updated_at: float
    expires_at: float
    distance_mi: float
    direction: str
    bearing_deg: float
    eta_min: float | None = None
    lat: float
    lon: float
    speed_mph: float


class StormAlertResponse(BaseModel):
    alerts: list[StormAlertOut]
    count: int
    updated_at: float
    detections_processed: int
    alerts_changed: int
    alerts_expired: int
    cycle_status: str
    last_success: float


class HistoryEntryOut(BaseModel):
    timestamp: float
    alert_id: str
    storm_id: str
    type: str
    severity: int
    title: str
    message: str
    action: str
    distance_mi: float | None = None
    eta_min: float | None = None


class HistoryResponse(BaseModel):
    entries: list[HistoryEntryOut]
    count: int


@router.get("", response_model=StormAlertResponse)
async def get_storm_alerts():
    """Return current active storm alerts from maintained server-side snapshot.

    Updated by background polling cycle (default every 60s).
    No recomputation on each request.
    """
    snap = get_snapshot()

    alerts_out = []
    for a in snap.alerts:
        alerts_out.append(StormAlertOut(
            alert_id=a.alert_id,
            storm_id=a.storm_id,
            type=a.type,
            severity=a.severity,
            confidence=a.confidence,
            title=a.title,
            message=a.message,
            status=a.status.value,
            created_at=a.created_at,
            updated_at=a.updated_at,
            expires_at=a.expires_at,
            distance_mi=a.distance_mi,
            direction=a.direction,
            bearing_deg=a.bearing_deg,
            eta_min=a.eta_min,
            lat=a.lat,
            lon=a.lon,
            speed_mph=a.speed_mph,
        ))

    return StormAlertResponse(
        alerts=alerts_out,
        count=snap.count,
        updated_at=snap.updated_at,
        detections_processed=snap.detections_processed,
        alerts_changed=snap.alerts_changed,
        alerts_expired=snap.alerts_expired,
        cycle_status=snap.cycle_status,
        last_success=snap.last_success,
    )


@router.get("/history", response_model=HistoryResponse)
async def get_alert_history():
    """Return recent alert lifecycle history (newest first).

    Bounded to last 100 entries. Records: created, escalated, expired.
    """
    history = get_history()
    entries = [
        HistoryEntryOut(
            timestamp=h.timestamp,
            alert_id=h.alert_id,
            storm_id=h.storm_id,
            type=h.type,
            severity=h.severity,
            title=h.title,
            message=h.message,
            action=h.action,
            distance_mi=h.distance_mi,
            eta_min=h.eta_min,
        )
        for h in history
    ]
    return HistoryResponse(entries=entries, count=len(entries))
