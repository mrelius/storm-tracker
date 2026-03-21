"""Detection API endpoint.

Exposes current detection results from the weather detection engine.
Runs a detection cycle on demand and returns structured events.
"""
from fastapi import APIRouter, Query
from pydantic import BaseModel
from services.detection.adapter import run_detection_cycle

router = APIRouter(prefix="/api/detections", tags=["detections"])


class DetectionEventOut(BaseModel):
    type: str
    severity: int
    confidence: float
    storm_id: str
    distance_mi: float
    direction: str
    bearing_deg: float
    eta_min: float | None = None
    timestamp: float
    lat: float
    lon: float
    speed_mph: float
    detail: str


class DetectionResultOut(BaseModel):
    events: list[DetectionEventOut]
    storms_processed: int
    detections_suppressed: int


@router.get("", response_model=DetectionResultOut)
async def get_detections(
    lat: float | None = Query(None, description="User reference latitude"),
    lon: float | None = Query(None, description="User reference longitude"),
):
    """Run detection cycle and return current detections.

    Pass lat/lon for distance-based detections relative to your location.
    Falls back to configured default location if omitted.
    """
    result = await run_detection_cycle(ref_lat=lat, ref_lon=lon)

    events_out = []
    for e in result.events:
        events_out.append(DetectionEventOut(
            type=e.type.value,
            severity=e.severity,
            confidence=e.confidence,
            storm_id=e.storm_id,
            distance_mi=e.distance_mi,
            direction=e.direction,
            bearing_deg=e.bearing_deg,
            eta_min=e.eta_min,
            timestamp=e.timestamp,
            lat=e.lat,
            lon=e.lon,
            speed_mph=e.speed_mph,
            detail=e.detail,
        ))

    return DetectionResultOut(
        events=events_out,
        storms_processed=result.storms_processed,
        detections_suppressed=result.detections_suppressed,
    )
