"""WebSocket connection manager for storm alert broadcasts.

Tracks connected clients, broadcasts messages safely,
removes dead clients on error.
"""
import json
import logging
import time
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class AlertWSManager:
    """Manages WebSocket connections for storm alert push delivery."""

    def __init__(self):
        self._clients: list[WebSocket] = []
        self._last_broadcast: float = 0

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._clients.append(ws)
        logger.info(f"WS client connected ({self.client_count} total)")

    def disconnect(self, ws: WebSocket):
        if ws in self._clients:
            self._clients.remove(ws)
        logger.info(f"WS client disconnected ({self.client_count} remaining)")

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def last_broadcast(self) -> float:
        return self._last_broadcast

    async def broadcast(self, message: dict):
        """Send message to all connected clients. Dead clients removed safely."""
        if not self._clients:
            return

        payload = json.dumps(message, default=str)
        self._last_broadcast = time.time()
        dead = []

        for client in self._clients:
            try:
                await client.send_text(payload)
            except Exception:
                dead.append(client)

        for client in dead:
            self.disconnect(client)

        if dead:
            logger.debug(f"Removed {len(dead)} dead WS clients")

    async def send_to(self, ws: WebSocket, message: dict):
        """Send message to a single client."""
        try:
            await ws.send_text(json.dumps(message, default=str))
        except Exception:
            self.disconnect(ws)


# Singleton
_manager: AlertWSManager | None = None


def get_ws_manager() -> AlertWSManager:
    global _manager
    if _manager is None:
        _manager = AlertWSManager()
    return _manager
