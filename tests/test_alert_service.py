"""Tests for the background alert service — snapshot, history, cycle behavior."""
import time
import asyncio
from collections import deque
from unittest.mock import patch, AsyncMock

from services.detection.models import DetectionEvent, DetectionType
from services.detection.alert_engine import (
    AlertStore, AlertStatus, StormAlert, create_alert_from_event,
    get_store, ALERT_TTL,
)
from services.detection.alert_service import (
    AlertSnapshot, HistoryEntry,
    get_snapshot, get_history, record_history,
    run_cycle_once, reset_service,
    _history,
)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _event(storm_id="c1", dtype=DetectionType.storm_proximity, severity=1,
           distance_mi=12.0, direction="SW", eta_min=20.0):
    return DetectionEvent(
        type=dtype, severity=severity, confidence=0.8,
        storm_id=storm_id, distance_mi=distance_mi, direction=direction,
        bearing_deg=225, eta_min=eta_min, timestamp=time.time(),
        lat=39.5, lon=-84.5, speed_mph=30.0,
        detail=f"Test {dtype.value}",
    )


def _alert_result(alerts=None, count=0, changed=0, expired=0, processed=0):
    """Mock result from run_alert_cycle."""
    return {
        "alerts": alerts or [],
        "count": count,
        "updated_at": time.time(),
        "detections_processed": processed,
        "alerts_changed": changed,
        "alerts_expired": expired,
    }


class TestSnapshot:
    def test_initial_snapshot_pending(self):
        reset_service()
        snap = get_snapshot()
        assert snap.cycle_status == "pending"
        assert snap.count == 0
        assert snap.alerts == []

    def test_snapshot_updated_after_cycle(self):
        reset_service()

        async def check():
            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, return_value=_alert_result(count=0)):
                await run_cycle_once()

            snap = get_snapshot()
            assert snap.cycle_status == "ok"
            assert snap.updated_at > 0
            assert snap.last_success > 0

        run(check())

    def test_snapshot_preserves_on_error(self):
        reset_service()

        async def check():
            # First successful cycle
            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, return_value=_alert_result()):
                await run_cycle_once()

            first_success = get_snapshot().last_success

            # Second cycle fails
            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, side_effect=Exception("fail")):
                await run_cycle_once()

            snap = get_snapshot()
            assert snap.cycle_status == "error"
            assert snap.last_success == first_success  # preserved

        run(check())


class TestHistory:
    def test_record_created(self):
        reset_service()
        alert = create_alert_from_event(_event())
        record_history(alert, "created")
        history = get_history()
        assert len(history) == 1
        assert history[0].action == "created"
        assert history[0].alert_id == alert.alert_id

    def test_record_escalated(self):
        reset_service()
        alert = create_alert_from_event(_event(severity=3))
        record_history(alert, "escalated")
        history = get_history()
        assert history[0].action == "escalated"
        assert history[0].severity == 3

    def test_record_expired(self):
        reset_service()
        alert = create_alert_from_event(_event())
        record_history(alert, "expired")
        history = get_history()
        assert history[0].action == "expired"

    def test_newest_first(self):
        reset_service()
        a1 = create_alert_from_event(_event(storm_id="c1"))
        a2 = create_alert_from_event(_event(storm_id="c2"))
        record_history(a1, "created")
        time.sleep(0.01)
        record_history(a2, "created")
        history = get_history()
        assert history[0].storm_id == "c2"  # newest first
        assert history[1].storm_id == "c1"

    def test_bounded_capacity(self):
        reset_service()
        # Override maxlen for test
        _history.clear()
        original_maxlen = _history.maxlen

        # Fill beyond capacity
        for i in range(150):
            alert = create_alert_from_event(_event(storm_id=f"c{i}"))
            record_history(alert, "created")

        # Should be capped at maxlen (100)
        assert len(get_history()) <= 100

    def test_empty_history(self):
        reset_service()
        assert get_history() == []


class TestCycleBehavior:
    def test_cycle_updates_snapshot(self):
        reset_service()

        async def check():
            mock_result = _alert_result(count=2, processed=5, changed=2)
            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, return_value=mock_result):
                await run_cycle_once()

            snap = get_snapshot()
            assert snap.count == 2
            assert snap.detections_processed == 5
            assert snap.alerts_changed == 2
            assert snap.cycle_status == "ok"

        run(check())

    def test_no_alerts_cycle(self):
        reset_service()

        async def check():
            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, return_value=_alert_result()):
                await run_cycle_once()

            snap = get_snapshot()
            assert snap.count == 0
            assert snap.alerts == []
            assert snap.cycle_status == "ok"

        run(check())

    def test_cycle_failure_isolated(self):
        reset_service()

        async def check():
            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, side_effect=RuntimeError("boom")):
                await run_cycle_once()  # should not raise

            snap = get_snapshot()
            assert snap.cycle_status == "error"

        run(check())

    def test_history_records_new_alerts(self):
        reset_service()

        async def check():
            alert = create_alert_from_event(_event())
            alert.status = AlertStatus.new
            mock_result = _alert_result(alerts=[alert], count=1, changed=1)

            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, return_value=mock_result):
                with patch("services.detection.alert_service.get_store") as mock_store:
                    mock_store.return_value.get_all_alerts.return_value = []
                    await run_cycle_once()

            history = get_history()
            created = [h for h in history if h.action == "created"]
            assert len(created) >= 1

        run(check())


class TestConcurrency:
    def test_no_concurrent_cycles(self):
        """Second cycle should skip if first is still running."""
        reset_service()
        call_count = 0

        async def slow_cycle(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(0.5)
            return _alert_result()

        async def check():
            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, side_effect=slow_cycle):
                # Start two cycles concurrently
                t1 = asyncio.create_task(run_cycle_once())
                await asyncio.sleep(0.05)  # let first acquire lock
                t2 = asyncio.create_task(run_cycle_once())
                await asyncio.gather(t1, t2)

            # Only one should have executed
            assert call_count == 1

        run(check())


class TestEndToEnd:
    def test_detection_to_snapshot_to_history(self):
        """Full path: mock detections → cycle → snapshot updated → history recorded."""
        reset_service()

        async def check():
            alert1 = create_alert_from_event(_event(
                storm_id="c1", dtype=DetectionType.strong_storm, severity=2))
            alert1.status = AlertStatus.new

            mock_result = _alert_result(
                alerts=[alert1], count=1, changed=1, processed=3)

            with patch("services.detection.alert_service.run_alert_cycle",
                       new_callable=AsyncMock, return_value=mock_result):
                with patch("services.detection.alert_service.get_store") as mock_store:
                    mock_store.return_value.get_all_alerts.return_value = []
                    await run_cycle_once()

            # Verify snapshot
            snap = get_snapshot()
            assert snap.count == 1
            assert snap.cycle_status == "ok"
            assert snap.detections_processed == 3

            # Verify history
            history = get_history()
            assert any(h.action == "created" and h.storm_id == "c1" for h in history)

        run(check())

    def test_output_contracts(self):
        """Verify snapshot and history entry shapes."""
        reset_service()

        snap = get_snapshot()
        assert hasattr(snap, "alerts")
        assert hasattr(snap, "count")
        assert hasattr(snap, "updated_at")
        assert hasattr(snap, "cycle_status")
        assert hasattr(snap, "last_success")

        alert = create_alert_from_event(_event())
        record_history(alert, "created")
        h = get_history()[0]
        assert hasattr(h, "timestamp")
        assert hasattr(h, "alert_id")
        assert hasattr(h, "action")
        assert hasattr(h, "severity")
