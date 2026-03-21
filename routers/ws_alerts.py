"""WebSocket endpoint for real-time storm alert updates.

Sends initial snapshot on connect, then receives pushed updates
from the background alert service.
"""
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from services.detection.ws_manager import get_ws_manager
from services.detection.alert_service import get_snapshot

logger = logging.getLogger(__name__)

router = APIRouter()


def _snapshot_message() -> dict:
    """Build a snapshot message from current maintained state."""
    snap = get_snapshot()
    return {
        "type": "snapshot",
        "alerts": [
            {
                "alert_id": a.alert_id,
                "storm_id": a.storm_id,
                "type": a.type,
                "severity": a.severity,
                "confidence": a.confidence,
                "title": a.title,
                "message": a.message,
                "status": a.status.value if hasattr(a.status, "value") else a.status,
                "distance_mi": a.distance_mi,
                "direction": a.direction,
                "bearing_deg": a.bearing_deg,
                "eta_min": a.eta_min,
                "lat": a.lat,
                "lon": a.lon,
                "speed_mph": a.speed_mph,
            }
            for a in snap.alerts
        ],
        "count": snap.count,
        "updated_at": snap.updated_at,
        "cycle_status": snap.cycle_status,
        "location_source": "default",
    }


@router.websocket("/ws/storm-alerts")
async def storm_alerts_ws(ws: WebSocket):
    manager = get_ws_manager()
    await manager.connect(ws)

    # Send current snapshot immediately on connect
    try:
        await manager.send_to(ws, _snapshot_message())
    except Exception:
        manager.disconnect(ws)
        return

    # Keep connection alive — listen for client messages (ping/close)
    try:
        while True:
            # Wait for client messages (keeps connection alive)
            # Client can send "ping" for keepalive
            data = await ws.receive_text()
            if data == "ping":
                await manager.send_to(ws, {"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(ws)
    except Exception:
        manager.disconnect(ws)
