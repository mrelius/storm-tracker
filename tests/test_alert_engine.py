"""Tests for the alert engine — lifecycle, deduplication, escalation, expiration, messaging."""
import time
from unittest.mock import patch
from services.detection.models import DetectionEvent, DetectionType
from services.detection.alert_engine import (
    AlertStore, AlertStatus, StormAlert,
    create_alert_from_event, format_message,
    ALERT_TTL, _alert_key,
)


def _event(storm_id="c1", dtype=DetectionType.storm_proximity, severity=1,
           confidence=0.8, distance_mi=12.0, direction="SW", eta_min=20.0,
           speed_mph=30.0, **kwargs):
    return DetectionEvent(
        type=dtype, severity=severity, confidence=confidence,
        storm_id=storm_id, distance_mi=distance_mi, direction=direction,
        bearing_deg=225, eta_min=eta_min, timestamp=time.time(),
        lat=39.5, lon=-84.5, speed_mph=speed_mph,
        detail=f"Test detection {dtype.value}",
    )


# === Alert Creation ===

class TestAlertCreation:
    def test_proximity_alert(self):
        a = create_alert_from_event(_event(dtype=DetectionType.storm_proximity))
        assert a.type == "storm_proximity"
        assert a.title == "Approaching Storm"
        assert a.status == AlertStatus.new
        assert a.severity == 1

    def test_strong_storm_alert(self):
        a = create_alert_from_event(_event(dtype=DetectionType.strong_storm, severity=2))
        assert a.title == "Strong Storm Nearby"
        assert a.severity == 2

    def test_rotation_alert(self):
        a = create_alert_from_event(_event(dtype=DetectionType.rotation, severity=3))
        assert a.title == "Rotation Detected"
        assert a.severity == 3

    def test_debris_alert(self):
        a = create_alert_from_event(_event(dtype=DetectionType.debris_signature, severity=4))
        assert a.title == "Potential Debris Signature"
        assert a.severity == 4

    def test_alert_id_format(self):
        a = create_alert_from_event(_event(storm_id="c1", dtype=DetectionType.rotation))
        assert a.alert_id == "c1:rotation"

    def test_timestamps_set(self):
        a = create_alert_from_event(_event())
        assert a.created_at > 0
        assert a.updated_at > 0
        assert a.expires_at > a.created_at

    def test_eta_included(self):
        a = create_alert_from_event(_event(eta_min=14.5))
        assert a.eta_min == 14.5

    def test_no_eta(self):
        a = create_alert_from_event(_event(eta_min=None))
        assert a.eta_min is None


# === Message Formatting ===

class TestMessageFormatting:
    def test_proximity_with_direction_and_eta(self):
        e = _event(dtype=DetectionType.storm_proximity, direction="SW", eta_min=14)
        msg = format_message(e)
        assert "SW" in msg
        assert "14 min" in msg

    def test_proximity_no_eta(self):
        e = _event(dtype=DetectionType.storm_proximity, eta_min=None)
        msg = format_message(e)
        assert "min" not in msg

    def test_proximity_unknown_direction(self):
        e = _event(dtype=DetectionType.storm_proximity, direction="unknown")
        msg = format_message(e)
        assert "unknown" not in msg

    def test_debris_includes_shelter(self):
        e = _event(dtype=DetectionType.debris_signature, severity=4)
        msg = format_message(e)
        assert "shelter" in msg.lower()

    def test_strong_storm_message(self):
        e = _event(dtype=DetectionType.strong_storm, direction="NE")
        msg = format_message(e)
        assert "Strong storm" in msg

    def test_rotation_message(self):
        e = _event(dtype=DetectionType.rotation)
        msg = format_message(e)
        assert "Rotation" in msg

    def test_message_ends_with_period(self):
        for dtype in DetectionType:
            e = _event(dtype=dtype)
            msg = format_message(e)
            assert msg.endswith(".")


# === Deduplication ===

class TestDeduplication:
    def test_same_storm_same_type_updates(self):
        store = AlertStore()
        e = _event(storm_id="c1", dtype=DetectionType.rotation)
        store.update_from_detections([e])
        assert store.active_count == 1

        store.update_from_detections([e])
        assert store.active_count == 1  # no duplicate

    def test_same_storm_different_types_separate(self):
        store = AlertStore()
        e1 = _event(storm_id="c1", dtype=DetectionType.rotation)
        e2 = _event(storm_id="c1", dtype=DetectionType.strong_storm)
        store.update_from_detections([e1, e2])
        assert store.active_count == 2

    def test_different_storms_separate(self):
        store = AlertStore()
        e1 = _event(storm_id="c1")
        e2 = _event(storm_id="c2")
        store.update_from_detections([e1, e2])
        assert store.active_count == 2


# === Lifecycle ===

class TestLifecycle:
    def test_new_on_first_detection(self):
        store = AlertStore()
        store.update_from_detections([_event()])
        alerts = store.get_active_alerts()
        assert alerts[0].status == AlertStatus.new

    def test_active_on_refresh(self):
        store = AlertStore()
        e = _event()
        store.update_from_detections([e])
        store.update_from_detections([e])
        alerts = store.get_active_alerts()
        assert alerts[0].status == AlertStatus.active

    def test_escalated_on_severity_increase(self):
        store = AlertStore()
        e1 = _event(severity=1)
        e2 = _event(severity=3)
        store.update_from_detections([e1])
        store.update_from_detections([e2])
        alerts = store.get_active_alerts()
        assert alerts[0].status == AlertStatus.escalated
        assert alerts[0].severity == 3

    def test_no_downgrade(self):
        """Same severity doesn't change status to escalated."""
        store = AlertStore()
        e = _event(severity=2)
        store.update_from_detections([e])
        store.update_from_detections([e])
        alerts = store.get_active_alerts()
        assert alerts[0].status == AlertStatus.active  # not escalated
        assert alerts[0].severity == 2

    def test_updated_at_changes_on_refresh(self):
        store = AlertStore()
        e = _event()
        store.update_from_detections([e])
        first_update = store.get_active_alerts()[0].updated_at

        time.sleep(0.01)
        store.update_from_detections([e])
        second_update = store.get_active_alerts()[0].updated_at
        assert second_update > first_update


# === Expiration ===

class TestExpiration:
    def test_expires_after_ttl(self):
        store = AlertStore()
        e = _event(severity=1)
        ttl = ALERT_TTL[1]

        with patch("services.detection.alert_engine.time") as mock_time:
            mock_time.time.return_value = 1000.0
            store.update_from_detections([e])
            assert store.active_count == 1

            mock_time.time.return_value = 1000.0 + ttl + 1
            store.expire_stale()
            assert store.active_count == 0

    def test_not_expired_before_ttl(self):
        store = AlertStore()
        e = _event(severity=1)
        ttl = ALERT_TTL[1]

        with patch("services.detection.alert_engine.time") as mock_time:
            mock_time.time.return_value = 1000.0
            store.update_from_detections([e])

            mock_time.time.return_value = 1000.0 + ttl - 10
            store.expire_stale()
            assert store.active_count == 1

    def test_refresh_extends_ttl(self):
        store = AlertStore()
        e = _event(severity=1)
        ttl = ALERT_TTL[1]

        with patch("services.detection.alert_engine.time") as mock_time:
            mock_time.time.return_value = 1000.0
            store.update_from_detections([e])

            # Refresh near end of TTL
            mock_time.time.return_value = 1000.0 + ttl - 10
            store.update_from_detections([e])

            # Original TTL would have expired, but refresh extended it
            mock_time.time.return_value = 1000.0 + ttl + 50
            store.expire_stale()
            assert store.active_count == 1  # still alive

    def test_old_expired_cleaned_up(self):
        store = AlertStore()
        e = _event(severity=1)
        ttl = ALERT_TTL[1]

        with patch("services.detection.alert_engine.time") as mock_time:
            mock_time.time.return_value = 1000.0
            store.update_from_detections([e])

            # Expire it
            mock_time.time.return_value = 1000.0 + ttl + 1
            store.expire_stale()

            # Way past 2x TTL from the expire timestamp — should be purged
            # updated_at was set to expire time (~1301), so need 2x TTL after that
            mock_time.time.return_value = 1000.0 + ttl * 4
            store.expire_stale()
            assert len(store.get_all_alerts()) == 0

    def test_empty_input_no_crash(self):
        store = AlertStore()
        store.update_from_detections([])
        assert store.active_count == 0
        store.expire_stale()
        assert len(store.get_all_alerts()) == 0


# === Ordering ===

class TestOrdering:
    def test_severity_desc(self):
        store = AlertStore()
        e1 = _event(storm_id="c1", severity=1, dtype=DetectionType.storm_proximity)
        e2 = _event(storm_id="c2", severity=3, dtype=DetectionType.rotation)
        store.update_from_detections([e1, e2])
        alerts = store.get_active_alerts()
        assert alerts[0].severity == 3
        assert alerts[1].severity == 1

    def test_distance_asc_on_same_severity(self):
        store = AlertStore()
        e1 = _event(storm_id="c1", severity=2, distance_mi=20.0)
        e2 = _event(storm_id="c2", severity=2, distance_mi=5.0)
        store.update_from_detections([e1, e2])
        alerts = store.get_active_alerts()
        assert alerts[0].distance_mi == 5.0
        assert alerts[1].distance_mi == 20.0


# === End-to-End ===

class TestEndToEnd:
    def test_full_cycle(self):
        """Detection events → alert store → active alerts with correct lifecycle."""
        store = AlertStore()

        # First cycle: two detections
        events = [
            _event(storm_id="c1", dtype=DetectionType.storm_proximity, severity=1),
            _event(storm_id="c1", dtype=DetectionType.strong_storm, severity=2),
        ]
        changed = store.update_from_detections(events)
        assert len(changed) == 2
        assert store.active_count == 2

        # Second cycle: refresh + escalation
        events2 = [
            _event(storm_id="c1", dtype=DetectionType.storm_proximity, severity=2),  # escalated
            _event(storm_id="c1", dtype=DetectionType.strong_storm, severity=2),      # same
        ]
        changed2 = store.update_from_detections(events2)
        assert store.active_count == 2

        # Check escalation
        alerts = store.get_active_alerts()
        prox = [a for a in alerts if a.type == "storm_proximity"][0]
        assert prox.status == AlertStatus.escalated
        assert prox.severity == 2

        # Third cycle: no detections → alerts persist until TTL
        store.update_from_detections([])
        assert store.active_count == 2

    def test_output_contract(self):
        store = AlertStore()
        store.update_from_detections([
            _event(dtype=DetectionType.debris_signature, severity=4),
        ])
        alerts = store.get_active_alerts()
        a = alerts[0]
        assert a.alert_id
        assert a.storm_id
        assert a.type
        assert isinstance(a.severity, int)
        assert 0 <= a.confidence <= 1.0
        assert a.title
        assert a.message
        assert a.status in AlertStatus
        assert a.created_at > 0
        assert a.updated_at > 0
        assert a.expires_at > a.created_at
        assert isinstance(a.distance_mi, float)
        assert a.direction
