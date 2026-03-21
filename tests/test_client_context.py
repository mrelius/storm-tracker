"""Tests for per-client WebSocket context and client-relative snapshots."""
import asyncio
import time
from unittest.mock import AsyncMock
from services.detection.ws_manager import AlertWSManager, ClientContext, _valid_coords
from services.detection.alert_service import (
    build_client_snapshot, reset_service,
)
from services.detection.alert_engine import create_alert_from_event, AlertStatus
from services.detection.models import DetectionEvent, DetectionType


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _mock_ws():
    ws = AsyncMock()
    return ws


def _event(**kwargs):
    defaults = dict(
        type=DetectionType.storm_proximity, severity=1, confidence=0.8,
        storm_id="c1", distance_mi=12.0, direction="SW", bearing_deg=225,
        eta_min=20.0, timestamp=time.time(), lat=39.5, lon=-84.5,
        speed_mph=30.0, detail="test",
    )
    defaults.update(kwargs)
    return DetectionEvent(**defaults)


class TestCoordValidation:
    def test_valid(self):
        assert _valid_coords(39.5, -84.5) is True

    def test_boundary(self):
        assert _valid_coords(90, 180) is True
        assert _valid_coords(-90, -180) is True

    def test_out_of_range(self):
        assert _valid_coords(91, 0) is False
        assert _valid_coords(0, 181) is False

    def test_none(self):
        assert _valid_coords(None, None) is False

    def test_string(self):
        assert _valid_coords("abc", "def") is False

    def test_numeric_string(self):
        assert _valid_coords("39.5", "-84.5") is True


class TestClientContext:
    def test_connect_creates_context(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            ctx = mgr.get_context(ws)
            assert ctx is not None
            assert ctx.using_client_location is False
            assert ctx.lat is None
        run(check())

    def test_set_location_valid(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            result = mgr.set_location(ws, 39.5, -84.5)
            assert result is True
            ctx = mgr.get_context(ws)
            assert ctx.lat == 39.5
            assert ctx.lon == -84.5
            assert ctx.using_client_location is True
        run(check())

    def test_set_location_invalid(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            result = mgr.set_location(ws, 999, 999)
            assert result is False
            ctx = mgr.get_context(ws)
            assert ctx.using_client_location is False
        run(check())

    def test_set_location_unknown_ws(self):
        mgr = AlertWSManager()
        ws = _mock_ws()
        assert mgr.set_location(ws, 39.5, -84.5) is False

    def test_disconnect_cleans_context(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            mgr.set_location(ws, 39.5, -84.5)
            mgr.disconnect(ws)
            assert mgr.get_context(ws) is None
        run(check())

    def test_multiple_clients_isolated(self):
        async def check():
            mgr = AlertWSManager()
            ws1 = _mock_ws()
            ws2 = _mock_ws()
            await mgr.connect(ws1)
            await mgr.connect(ws2)
            mgr.set_location(ws1, 39.5, -84.5)
            mgr.set_location(ws2, 41.8, -87.6)
            assert mgr.get_context(ws1).lat == 39.5
            assert mgr.get_context(ws2).lat == 41.8
        run(check())

    def test_location_update_replaces(self):
        async def check():
            mgr = AlertWSManager()
            ws = _mock_ws()
            await mgr.connect(ws)
            mgr.set_location(ws, 39.5, -84.5)
            mgr.set_location(ws, 41.0, -81.0)
            ctx = mgr.get_context(ws)
            assert ctx.lat == 41.0
            assert ctx.lon == -81.0
        run(check())



class TestBuildClientSnapshot:
    def test_default_location_source(self):
        reset_service()
        ctx = ClientContext(ws=_mock_ws())
        snap = build_client_snapshot(ctx)
        assert snap["location_source"] == "default"

    def test_client_location_source(self):
        reset_service()
        ctx = ClientContext(ws=_mock_ws(), lat=39.5, lon=-84.5, using_client_location=True)
        snap = build_client_snapshot(ctx)
        assert snap["location_source"] == "client"


class TestSendToEach:
    def test_per_client_messages(self):
        async def check():
            mgr = AlertWSManager()
            ws1 = _mock_ws()
            ws2 = _mock_ws()
            await mgr.connect(ws1)
            await mgr.connect(ws2)
            mgr.set_location(ws1, 39.5, -84.5)
            mgr.set_location(ws2, 41.8, -87.6)

            await mgr.send_to_each(lambda ctx: {"lat": ctx.lat})
            assert ws1.send_text.await_count == 1
            assert ws2.send_text.await_count == 1
        run(check())
