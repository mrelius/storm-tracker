"""Tests for storm detection data models."""
import time
from services.detection.models import (
    StormObject, DetectionEvent, DetectionResult, DetectionType, Trend,
)


def _storm(**kwargs):
    defaults = dict(
        id="cell_1", lat=39.5, lon=-84.5, distance_mi=15.0,
        bearing_deg=235, direction="NE", speed_mph=35,
        trend=Trend.closing, last_updated=time.time(),
    )
    defaults.update(kwargs)
    return StormObject(**defaults)


def test_storm_object_defaults():
    s = StormObject(id="x", lat=0, lon=0, distance_mi=10, bearing_deg=0)
    assert s.direction == "unknown"
    assert s.speed_mph == 0.0
    assert s.reflectivity_dbz is None
    assert s.velocity_delta is None
    assert s.cc_min is None
    assert s.trend == Trend.unknown


def test_storm_object_full():
    s = _storm(reflectivity_dbz=58, velocity_delta=42, cc_min=0.74)
    assert s.id == "cell_1"
    assert s.reflectivity_dbz == 58
    assert s.velocity_delta == 42
    assert s.cc_min == 0.74
    assert s.trend == Trend.closing


def test_detection_event_fields():
    e = DetectionEvent(
        type=DetectionType.rotation,
        severity=3,
        confidence=0.85,
        storm_id="cell_1",
        distance_mi=12.0,
        direction="NE",
        bearing_deg=235,
        eta_min=20.6,
        timestamp=time.time(),
    )
    assert e.type == DetectionType.rotation
    assert e.severity == 3
    assert e.eta_min == 20.6


def test_detection_result_defaults():
    r = DetectionResult()
    assert r.events == []
    assert r.storms_processed == 0
    assert r.detections_suppressed == 0


def test_trend_enum():
    assert Trend.closing.value == "closing"
    assert Trend.departing.value == "departing"
    assert Trend("steady") == Trend.steady
