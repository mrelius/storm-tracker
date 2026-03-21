"""Tests for the detection pipeline — end-to-end from storm objects to events."""
import time
from unittest.mock import patch
from services.detection.models import StormObject, DetectionType, Trend
from services.detection.pipeline import DetectionPipeline
from services.detection.state import COOLDOWN_BY_SEVERITY


def _storm(**kwargs):
    defaults = dict(
        id="c1", lat=39.5, lon=-84.5, distance_mi=12.4,
        bearing_deg=235, direction="NE", speed_mph=38,
        trend=Trend.closing, last_updated=time.time(),
    )
    defaults.update(kwargs)
    return StormObject(**defaults)


class TestPipelineBasic:
    def test_empty_input(self):
        p = DetectionPipeline()
        result = p.process([])
        assert result.events == []
        assert result.storms_processed == 0

    def test_no_detection_on_calm_storm(self):
        """Storm that triggers no detectors."""
        p = DetectionPipeline()
        s = _storm(distance_mi=50, reflectivity_dbz=30, velocity_delta=10,
                   trend=Trend.departing)
        result = p.process([s])
        assert result.events == []
        assert result.storms_processed == 1

    def test_proximity_only(self):
        p = DetectionPipeline()
        s = _storm(distance_mi=15, reflectivity_dbz=40, velocity_delta=10)
        result = p.process([s])
        assert len(result.events) == 1
        assert result.events[0].type == DetectionType.storm_proximity

    def test_multiple_detections(self):
        """Storm that triggers proximity + strong storm + rotation."""
        p = DetectionPipeline()
        s = _storm(distance_mi=8, reflectivity_dbz=60, velocity_delta=45)
        result = p.process([s])
        types = {e.type for e in result.events}
        assert DetectionType.storm_proximity in types
        assert DetectionType.strong_storm in types
        assert DetectionType.rotation in types
        assert len(result.events) == 3


class TestPipelineDebris:
    def test_full_debris_signature(self):
        """The example storm from the spec."""
        p = DetectionPipeline()
        s = _storm(
            distance_mi=12.4, reflectivity_dbz=58,
            velocity_delta=42, cc_min=0.74,
        )
        result = p.process([s])
        types = {e.type for e in result.events}
        # Should trigger: proximity, strong_storm, rotation, debris_signature
        assert DetectionType.storm_proximity in types
        assert DetectionType.strong_storm in types
        assert DetectionType.rotation in types
        assert DetectionType.debris_signature in types
        assert len(result.events) == 4

    def test_debris_is_severity_4(self):
        p = DetectionPipeline()
        s = _storm(reflectivity_dbz=58, velocity_delta=42, cc_min=0.74)
        result = p.process([s])
        debris = [e for e in result.events if e.type == DetectionType.debris_signature]
        assert len(debris) == 1
        assert debris[0].severity == 4


class TestPipelineMultipleStorms:
    def test_two_storms(self):
        p = DetectionPipeline()
        s1 = _storm(id="c1", distance_mi=10, reflectivity_dbz=60)
        s2 = _storm(id="c2", distance_mi=30, reflectivity_dbz=55, trend=Trend.departing)
        result = p.process([s1, s2])
        assert result.storms_processed == 2
        # c1: proximity + strong_storm. c2: strong_storm only (departing, so no proximity)
        c1_events = [e for e in result.events if e.storm_id == "c1"]
        c2_events = [e for e in result.events if e.storm_id == "c2"]
        assert len(c1_events) == 2
        assert len(c2_events) == 1


class TestPipelineCooldown:
    def test_duplicate_suppressed(self):
        """Same storm processed twice — second run suppressed."""
        p = DetectionPipeline()
        s = _storm(distance_mi=15)
        r1 = p.process([s])
        assert len(r1.events) == 1

        r2 = p.process([s])
        assert len(r2.events) == 0
        assert r2.detections_suppressed == 1

    def test_cooldown_expires(self):
        """After cooldown, same storm emits again."""
        p = DetectionPipeline()
        s = _storm(distance_mi=15)
        cooldown = COOLDOWN_BY_SEVERITY[1]

        with patch("services.detection.state.time") as mock_time:
            mock_time.time.return_value = 1000.0
            r1 = p.process([s])
            assert len(r1.events) == 1

            mock_time.time.return_value = 1000.0 + cooldown + 1
            r2 = p.process([s])
            assert len(r2.events) == 1

    def test_severity_escalation_bypasses_cooldown(self):
        """Storm gets worse — new higher-severity detection emits immediately."""
        p = DetectionPipeline()

        # First: rotation at severity 2
        s1 = _storm(velocity_delta=40)
        r1 = p.process([s1])
        rot_events = [e for e in r1.events if e.type == DetectionType.rotation]
        assert rot_events[0].severity == 2

        # Second: rotation intensifies to severity 3 — should bypass cooldown
        s2 = _storm(velocity_delta=55)
        r2 = p.process([s2])
        rot_events2 = [e for e in r2.events if e.type == DetectionType.rotation]
        assert len(rot_events2) == 1
        assert rot_events2[0].severity == 3


class TestPipelineReset:
    def test_reset_clears_state(self):
        p = DetectionPipeline()
        s = _storm(distance_mi=15)
        p.process([s])
        p.reset()
        # After reset, same storm should emit again
        r = p.process([s])
        assert len(r.events) == 1


class TestPipelineOutputContract:
    def test_event_has_all_fields(self):
        """Verify the output contract is complete."""
        p = DetectionPipeline()
        s = _storm(distance_mi=12.4, speed_mph=38, reflectivity_dbz=58,
                   velocity_delta=42, cc_min=0.74)
        result = p.process([s])
        for event in result.events:
            assert event.type is not None
            assert isinstance(event.severity, int)
            assert 0 <= event.confidence <= 1.0
            assert event.storm_id == "c1"
            assert event.distance_mi > 0
            assert event.direction == "NE"
            assert event.bearing_deg == 235
            assert event.timestamp > 0
            assert event.lat != 0
            assert event.lon != 0
            assert isinstance(event.detail, str)
            assert len(event.detail) > 0
