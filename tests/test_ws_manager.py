"""Tests for WebSocket connection manager and broadcast behavior."""
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch
from services.detection.ws_manager import AlertWSManager
from services.detection.alert_service import (
    _alert_to_dict, _snapshot_ws_payload, _alert_ws_payload,
    reset_service,
)
from services.detection.alert_engine import create_alert_from_event
from services.detection.models import DetectionEvent, DetectionType


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _event(**kwargs):
    defaults = dict(
        type=DetectionType.storm_proximity, severity=1, confidence=0.8,
        storm_id="c1", distance_mi=12.0, direction="SW", bearing_deg=225,
        eta_min=20.0, timestamp=time.time(), lat=39.5, lon=-84.5,
        speed_mph=30.0, detail="test",
    )
    defaults.update(kwargs)
    return DetectionEvent(**defaults)


def _mock_ws(alive=True):
    ws = AsyncMock()
    if not alive:
        ws.send_text.side_effect = Exception("connection closed")
    return ws


class TestConnectionManager:
    def test_connect(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            assert mgr.client_count == 1
            ws.accept.assert_awaited_once()
        run(check())

    def test_disconnect(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            mgr.disconnect(ws)
            assert mgr.client_count == 0
        run(check())

    def test_disconnect_unknown_client(self):
        mgr = AlertWSManager()
        ws = _mock_ws()
        mgr.disconnect(ws)  # should not crash
        assert mgr.client_count == 0

    def test_multiple_clients(self):
        async def check():
            mgr = AlertWSManager()
            ws1 = _mock_ws()
            ws2 = _mock_ws()
            await mgr.connect(ws1)
            await mgr.connect(ws2)
            assert mgr.client_count == 2
        run(check())


class TestBroadcast:
    def test_broadcast_to_all(self):
        async def check():
            mgr = AlertWSManager()
            ws1 = _mock_ws()
            ws2 = _mock_ws()
            await mgr.connect(ws1)
            await mgr.connect(ws2)

            await mgr.broadcast({"type": "snapshot", "count": 0})
            assert ws1.send_text.await_count == 1
            assert ws2.send_text.await_count == 1
        run(check())

    def test_broadcast_no_clients(self):
        async def check():
            mgr = AlertWSManager()
            await mgr.broadcast({"type": "snapshot"})  # should not crash
        run(check())

    def test_dead_client_removed(self):
        async def check():
            mgr = AlertWSManager()
            alive = _mock_ws(alive=True)
            dead = _mock_ws(alive=False)
            await mgr.connect(alive)
            await mgr.connect(dead)
            assert mgr.client_count == 2

            await mgr.broadcast({"type": "snapshot"})
            assert mgr.client_count == 1  # dead removed
            alive.send_text.assert_awaited()
        run(check())

    def test_broadcast_updates_timestamp(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            assert mgr.last_broadcast == 0
            await mgr.broadcast({"type": "test"})
            assert mgr.last_broadcast > 0
        run(check())


class TestSendTo:
    def test_send_to_single(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            await mgr.send_to(ws, {"type": "snapshot"})
            assert ws.send_text.await_count == 1
        run(check())

    def test_send_to_dead_removes(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws(alive=False)
            await mgr.connect(ws)
            await mgr.send_to(ws, {"type": "snapshot"})
            assert mgr.client_count == 0
        run(check())


class TestPayloads:
    def test_alert_to_dict(self):
        alert = create_alert_from_event(_event())
        d = _alert_to_dict(alert)
        assert d["alert_id"] == alert.alert_id
        assert d["severity"] == 1
        assert "status" in d

    def test_snapshot_payload(self):
        reset_service()
        payload = _snapshot_ws_payload()
        assert payload["type"] == "snapshot"
        assert "alerts" in payload
        assert "count" in payload
        assert "updated_at" in payload
        assert "cycle_status" in payload

    def test_lifecycle_payload(self):
        alert = create_alert_from_event(_event())
        payload = _alert_ws_payload("created", alert)
        assert payload["type"] == "created"
        assert payload["alert"]["alert_id"] == alert.alert_id
        assert "updated_at" in payload

    def test_escalation_payload(self):
        alert = create_alert_from_event(_event(severity=3))
        payload = _alert_ws_payload("escalated", alert)
        assert payload["type"] == "escalated"
        assert payload["alert"]["severity"] == 3
