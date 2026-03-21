"""WebSocket connection manager for storm alert broadcasts.

Tracks connected clients with per-client location context.
Broadcasts messages safely, removes dead clients on error.
"""
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Optional
from fastapi import WebSocket

logger = logging.getLogger(__name__)


@dataclass
class ClientContext:
    """Per-connection metadata with client-specific detection state."""
    ws: WebSocket
    lat: Optional[float] = None
    lon: Optional[float] = None
    using_client_location: bool = False
    connected_at: float = 0.0
    last_subscribe: float = 0.0
    # Per-client detection pipeline + alert store (lazy-initialized)
    _pipeline: object = field(default=None, repr=False)
    _alert_store: object = field(default=None, repr=False)

    def get_pipeline(self):
        if self._pipeline is None:
            from services.detection.pipeline import DetectionPipeline
            self._pipeline = DetectionPipeline()
        return self._pipeline

    def get_alert_store(self):
        if self._alert_store is None:
            from services.detection.alert_engine import AlertStore
            self._alert_store = AlertStore()
        return self._alert_store


class AlertWSManager:
    """Manages WebSocket connections with per-client location context."""

    def __init__(self):
        self._clients: dict[WebSocket, ClientContext] = {}
        self._last_broadcast: float = 0

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._clients[ws] = ClientContext(ws=ws, connected_at=time.time())
        logger.info(f"WS client connected ({self.client_count} total)")

    def disconnect(self, ws: WebSocket):
        if ws in self._clients:
            del self._clients[ws]
        logger.info(f"WS client disconnected ({self.client_count} remaining)")

    def get_context(self, ws: WebSocket) -> Optional[ClientContext]:
        return self._clients.get(ws)

    def set_location(self, ws: WebSocket, lat: float, lon: float) -> bool:
        """Set client-specific reference location. Returns True if valid."""
        if ws not in self._clients:
            return False
        if not _valid_coords(lat, lon):
            return False
        ctx = self._clients[ws]
        ctx.lat = lat
        ctx.lon = lon
        ctx.using_client_location = True
        ctx.last_subscribe = time.time()
        return True

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def last_broadcast(self) -> float:
        return self._last_broadcast

    def get_all_contexts(self) -> list[ClientContext]:
        return list(self._clients.values())

    async def broadcast(self, message: dict):
        """Send message to all connected clients. Dead clients removed safely."""
        if not self._clients:
            return

        payload = json.dumps(message, default=str)
        self._last_broadcast = time.time()
        dead = []

        for ws in list(self._clients.keys()):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)

        for ws in dead:
            self.disconnect(ws)

    async def send_to(self, ws: WebSocket, message: dict):
        """Send message to a single client."""
        try:
            await ws.send_text(json.dumps(message, default=str))
        except Exception:
            self.disconnect(ws)

    async def send_to_each(self, message_fn):
        """Send per-client messages. message_fn(ctx) → dict or None."""
        dead = []
        for ws, ctx in list(self._clients.items()):
            try:
                msg = message_fn(ctx)
                if msg:
                    await ws.send_text(json.dumps(msg, default=str))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


def _valid_coords(lat: float, lon: float) -> bool:
    try:
        return -90 <= float(lat) <= 90 and -180 <= float(lon) <= 180
    except (TypeError, ValueError):
        return False


# Singleton
_manager: AlertWSManager | None = None


def get_ws_manager() -> AlertWSManager:
    global _manager
    if _manager is None:
        _manager = AlertWSManager()
    return _manager
