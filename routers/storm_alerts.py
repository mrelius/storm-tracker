"""Storm alert API endpoint.

Exposes processed, lifecycle-managed alerts from the detection engine.
Distinct from /api/alerts which serves raw NWS alert data.
"""
from fastapi import APIRouter, Query
from pydantic import BaseModel
from services.detection.alert_engine import run_alert_cycle

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


@router.get("", response_model=StormAlertResponse)
async def get_storm_alerts(
    lat: float | None = Query(None, description="User reference latitude"),
    lon: float | None = Query(None, description="User reference longitude"),
):
    """Run alert cycle and return active storm alerts.

    Runs detection → alert lifecycle → returns ordered active alerts.
    Alerts are ordered by severity (highest first), then distance (nearest first).
    """
    result = await run_alert_cycle(ref_lat=lat, ref_lon=lon)

    alerts_out = []
    for a in result["alerts"]:
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
        count=result["count"],
        updated_at=result["updated_at"],
        detections_processed=result["detections_processed"],
        alerts_changed=result["alerts_changed"],
        alerts_expired=result["alerts_expired"],
    )
