"""Tests for individual storm detectors."""
import time
from services.detection.models import StormObject, DetectionType, Trend
from services.detection.detectors import (
    detect_proximity,
    detect_strong_storm,
    detect_rotation,
    detect_debris_signature,
)


def _storm(**kwargs):
    defaults = dict(
        id="c1", lat=39.5, lon=-84.5, distance_mi=15.0,
        bearing_deg=235, direction="NE", speed_mph=30,
        trend=Trend.closing, last_updated=time.time(),
    )
    defaults.update(kwargs)
    return StormObject(**defaults)


# --- Proximity Detector ---

class TestProximity:
    def test_triggers_within_20_closing(self):
        events = detect_proximity(_storm(distance_mi=12, trend=Trend.closing))
        assert len(events) == 1
        assert events[0].type == DetectionType.storm_proximity

    def test_severity_1_at_15_miles(self):
        events = detect_proximity(_storm(distance_mi=15))
        assert events[0].severity == 1

    def test_severity_2_under_10_miles(self):
        events = detect_proximity(_storm(distance_mi=8))
        assert events[0].severity == 2

    def test_no_trigger_at_25_miles(self):
        assert detect_proximity(_storm(distance_mi=25)) == []

    def test_no_trigger_departing(self):
        assert detect_proximity(_storm(distance_mi=10, trend=Trend.departing)) == []

    def test_no_trigger_steady(self):
        assert detect_proximity(_storm(distance_mi=10, trend=Trend.steady)) == []

    def test_includes_eta(self):
        events = detect_proximity(_storm(distance_mi=15, speed_mph=30))
        assert events[0].eta_min == 30.0

    def test_detail_string(self):
        events = detect_proximity(_storm(distance_mi=12.4, speed_mph=38))
        assert "12.4 mi" in events[0].detail
        assert "38 mph" in events[0].detail

    def test_confidence_higher_when_closer(self):
        far = detect_proximity(_storm(distance_mi=18))[0].confidence
        close = detect_proximity(_storm(distance_mi=5))[0].confidence
        assert close > far


# --- Strong Storm Detector ---

class TestStrongStorm:
    def test_triggers_at_55(self):
        events = detect_strong_storm(_storm(reflectivity_dbz=55))
        assert len(events) == 1
        assert events[0].type == DetectionType.strong_storm
        assert events[0].severity == 2

    def test_triggers_at_65(self):
        events = detect_strong_storm(_storm(reflectivity_dbz=65))
        assert events[0].confidence > 0.6

    def test_no_trigger_at_50(self):
        assert detect_strong_storm(_storm(reflectivity_dbz=50)) == []

    def test_no_trigger_none(self):
        assert detect_strong_storm(_storm(reflectivity_dbz=None)) == []

    def test_confidence_scales_with_dbz(self):
        low = detect_strong_storm(_storm(reflectivity_dbz=55))[0].confidence
        high = detect_strong_storm(_storm(reflectivity_dbz=70))[0].confidence
        assert high > low


# --- Rotation Detector ---

class TestRotation:
    def test_triggers_at_35(self):
        events = detect_rotation(_storm(velocity_delta=35))
        assert len(events) == 1
        assert events[0].type == DetectionType.rotation
        assert events[0].severity == 2

    def test_severity_3_at_50(self):
        events = detect_rotation(_storm(velocity_delta=50))
        assert events[0].severity == 3

    def test_severity_3_at_60(self):
        events = detect_rotation(_storm(velocity_delta=60))
        assert events[0].severity == 3

    def test_no_trigger_at_30(self):
        assert detect_rotation(_storm(velocity_delta=30)) == []

    def test_no_trigger_none(self):
        assert detect_rotation(_storm(velocity_delta=None)) == []

    def test_confidence_scales(self):
        low = detect_rotation(_storm(velocity_delta=35))[0].confidence
        high = detect_rotation(_storm(velocity_delta=55))[0].confidence
        assert high > low


# --- Debris Signature Detector ---

class TestDebrisSignature:
    def test_triggers_all_conditions(self):
        s = _storm(cc_min=0.74, reflectivity_dbz=58, velocity_delta=42)
        events = detect_debris_signature(s)
        assert len(events) == 1
        assert events[0].type == DetectionType.debris_signature
        assert events[0].severity == 4

    def test_no_trigger_cc_too_high(self):
        s = _storm(cc_min=0.85, reflectivity_dbz=58, velocity_delta=42)
        assert detect_debris_signature(s) == []

    def test_no_trigger_dbz_too_low(self):
        s = _storm(cc_min=0.74, reflectivity_dbz=40, velocity_delta=42)
        assert detect_debris_signature(s) == []

    def test_no_trigger_velocity_too_low(self):
        s = _storm(cc_min=0.74, reflectivity_dbz=58, velocity_delta=30)
        assert detect_debris_signature(s) == []

    def test_no_trigger_missing_cc(self):
        s = _storm(cc_min=None, reflectivity_dbz=58, velocity_delta=42)
        assert detect_debris_signature(s) == []

    def test_no_trigger_missing_dbz(self):
        s = _storm(cc_min=0.74, reflectivity_dbz=None, velocity_delta=42)
        assert detect_debris_signature(s) == []

    def test_no_trigger_missing_velocity(self):
        s = _storm(cc_min=0.74, reflectivity_dbz=58, velocity_delta=None)
        assert detect_debris_signature(s) == []

    def test_detail_includes_all_values(self):
        s = _storm(cc_min=0.74, reflectivity_dbz=58, velocity_delta=42)
        events = detect_debris_signature(s)
        d = events[0].detail
        assert "DEBRIS" in d
        assert "0.74" in d
        assert "42" in d
        assert "58" in d

    def test_boundary_cc_0_80_does_not_trigger(self):
        """CC must be strictly < 0.80."""
        s = _storm(cc_min=0.80, reflectivity_dbz=58, velocity_delta=42)
        assert detect_debris_signature(s) == []

    def test_boundary_dbz_45_does_not_trigger(self):
        """Reflectivity must be strictly > 45."""
        s = _storm(cc_min=0.74, reflectivity_dbz=45, velocity_delta=42)
        assert detect_debris_signature(s) == []

    def test_boundary_velocity_35_does_not_trigger(self):
        """Velocity delta must be strictly > 35."""
        s = _storm(cc_min=0.74, reflectivity_dbz=58, velocity_delta=35)
        assert detect_debris_signature(s) == []
