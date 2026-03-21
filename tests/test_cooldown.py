"""Tests for detection cooldown / state management."""
import time
from unittest.mock import patch
from services.detection.models import DetectionEvent, DetectionType
from services.detection.state import (
    DetectionState, COOLDOWN_BY_SEVERITY,
)


def _event(storm_id="c1", event_type=DetectionType.storm_proximity,
           severity=1, **kwargs):
    return DetectionEvent(
        type=event_type, severity=severity, confidence=0.8,
        storm_id=storm_id, distance_mi=10, direction="NE",
        bearing_deg=235, timestamp=time.time(), **kwargs,
    )


class TestCooldownBasic:
    def test_first_emission_allowed(self):
        state = DetectionState()
        e = _event()
        assert state.should_emit(e) is True

    def test_second_emission_blocked(self):
        state = DetectionState()
        e = _event()
        state.record_emission(e)
        assert state.should_emit(e) is False

    def test_different_storm_not_blocked(self):
        state = DetectionState()
        e1 = _event(storm_id="c1")
        e2 = _event(storm_id="c2")
        state.record_emission(e1)
        assert state.should_emit(e2) is True

    def test_different_event_type_not_blocked(self):
        state = DetectionState()
        e1 = _event(event_type=DetectionType.storm_proximity)
        e2 = _event(event_type=DetectionType.rotation)
        state.record_emission(e1)
        assert state.should_emit(e2) is True


class TestCooldownExpiry:
    def test_emission_allowed_after_cooldown(self):
        state = DetectionState()
        e = _event(severity=1)
        cooldown = COOLDOWN_BY_SEVERITY[1]

        # Emit, then advance time past cooldown
        with patch("services.detection.state.time") as mock_time:
            mock_time.time.return_value = 1000.0
            state.record_emission(e)

            # Still in cooldown
            mock_time.time.return_value = 1000.0 + cooldown - 1
            assert state.should_emit(e) is False

            # Cooldown expired
            mock_time.time.return_value = 1000.0 + cooldown + 1
            assert state.should_emit(e) is True

    def test_severity_2_longer_cooldown(self):
        state = DetectionState()
        e = _event(severity=2)
        cd_1 = COOLDOWN_BY_SEVERITY[1]
        cd_2 = COOLDOWN_BY_SEVERITY[2]
        assert cd_2 > cd_1

        with patch("services.detection.state.time") as mock_time:
            mock_time.time.return_value = 1000.0
            state.record_emission(e)

            # After sev-1 cooldown but before sev-2 cooldown
            mock_time.time.return_value = 1000.0 + cd_1 + 1
            assert state.should_emit(e) is False

            # After sev-2 cooldown
            mock_time.time.return_value = 1000.0 + cd_2 + 1
            assert state.should_emit(e) is True


class TestSeverityEscalation:
    def test_higher_severity_bypasses_cooldown(self):
        state = DetectionState()
        e1 = _event(severity=1)
        e2 = _event(severity=2)  # same storm, same type, higher severity

        state.record_emission(e1)
        assert state.should_emit(e2) is True  # escalation bypasses

    def test_same_severity_stays_blocked(self):
        state = DetectionState()
        e = _event(severity=2)
        state.record_emission(e)
        assert state.should_emit(e) is False

    def test_lower_severity_stays_blocked(self):
        state = DetectionState()
        e_high = _event(severity=3)
        e_low = _event(severity=2)
        state.record_emission(e_high)
        assert state.should_emit(e_low) is False


class TestSuppression:
    def test_suppression_counted(self):
        state = DetectionState()
        e = _event()
        state.record_emission(e)
        state.record_suppression()
        state.record_suppression()
        assert state.suppressed_count == 2

    def test_suppression_resets(self):
        state = DetectionState()
        state.record_suppression()
        state.reset_suppressed_count()
        assert state.suppressed_count == 0


class TestCleanup:
    def test_cleanup_removes_expired(self):
        state = DetectionState()
        e = _event(severity=1)
        cooldown = COOLDOWN_BY_SEVERITY[1]

        with patch("services.detection.state.time") as mock_time:
            mock_time.time.return_value = 1000.0
            state.record_emission(e)
            assert state.active_entries == 1

            # Way past cooldown (2x + extra)
            mock_time.time.return_value = 1000.0 + cooldown * 3
            state.cleanup_expired()
            assert state.active_entries == 0

    def test_cleanup_keeps_recent(self):
        state = DetectionState()
        e = _event(severity=1)
        state.record_emission(e)
        state.cleanup_expired()
        assert state.active_entries == 1  # still within cooldown


class TestClear:
    def test_clear_resets_everything(self):
        state = DetectionState()
        state.record_emission(_event())
        state.record_suppression()
        state.clear()
        assert state.active_entries == 0
        assert state.suppressed_count == 0
