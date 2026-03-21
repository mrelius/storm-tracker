"""Tests for true client-relative detection (Phase 10).

Verifies that the same shared storm data produces different detection
outcomes for clients at different locations.
"""
import time
from services.detection.adapter import (
    BaseStormCandidate, _candidate_to_storm, evaluate_for_client,
    _base_candidates,
)
from services.detection.models import StormObject, Trend, DetectionType
from services.detection.pipeline import DetectionPipeline


def _candidate(lat=39.5, lon=-84.5, dbz=60, velocity=None, cc=None):
    return BaseStormCandidate(
        id="nws_test1", lat=lat, lon=lon,
        reflectivity_dbz=dbz, velocity_delta=velocity, cc_min=cc,
        nws_event="Tornado Warning", nws_severity="Extreme",
        last_updated=time.time(),
    )


class TestCandidateToStorm:
    def test_near_client(self):
        c = _candidate(lat=39.5, lon=-84.5)
        storm = _candidate_to_storm(c, ref_lat=39.5, ref_lon=-84.5)
        assert storm.distance_mi < 1.0

    def test_far_client(self):
        c = _candidate(lat=39.5, lon=-84.5)
        storm = _candidate_to_storm(c, ref_lat=41.8, ref_lon=-87.6)
        assert storm.distance_mi > 100

    def test_bearing_changes_with_client(self):
        c = _candidate(lat=40.0, lon=-84.0)
        storm_south = _candidate_to_storm(c, ref_lat=39.0, ref_lon=-84.0)
        storm_north = _candidate_to_storm(c, ref_lat=41.0, ref_lon=-84.0)
        # From south: storm is north. From north: storm is south.
        assert storm_south.direction in ("N", "NE", "NW")
        assert storm_north.direction in ("S", "SE", "SW")

    def test_preserves_metadata(self):
        c = _candidate(dbz=58, velocity=42, cc=0.74)
        storm = _candidate_to_storm(c, 39.5, -84.5)
        assert storm.reflectivity_dbz == 58
        assert storm.velocity_delta == 42
        assert storm.cc_min == 0.74


class TestClientRelativeDetection:
    """Core Phase 10 test: same storm, different clients, different outcomes."""

    def test_proximity_near_client_only(self):
        """Client A is close (< 20 mi) → proximity detection.
        Client B is far (> 100 mi) → no proximity detection.
        Note: proximity requires trend=closing. We set it explicitly to test
        the location-dependent behavior (trend is not derivable from NWS snapshots yet)."""
        c = _candidate(lat=39.55, lon=-84.45)

        # Client A: very close
        pipeline_a = DetectionPipeline()
        storm_a = _candidate_to_storm(c, ref_lat=39.5, ref_lon=-84.5)
        storm_a.trend = Trend.closing  # simulate known closing trend
        result_a = pipeline_a.process([storm_a])
        types_a = {e.type for e in result_a.events}

        # Client B: far away
        pipeline_b = DetectionPipeline()
        storm_b = _candidate_to_storm(c, ref_lat=41.8, ref_lon=-87.6)
        storm_b.trend = Trend.closing
        result_b = pipeline_b.process([storm_b])
        types_b = {e.type for e in result_b.events}

        # A should get proximity (< 20 mi), B should not (> 100 mi)
        assert DetectionType.storm_proximity in types_a
        assert DetectionType.storm_proximity not in types_b

    def test_strong_storm_both_clients(self):
        """Strong storm detection is location-independent (dbz >= 55)."""
        c = _candidate(dbz=60)

        pipeline_a = DetectionPipeline()
        storm_a = _candidate_to_storm(c, 39.5, -84.5)
        result_a = pipeline_a.process([storm_a])

        pipeline_b = DetectionPipeline()
        storm_b = _candidate_to_storm(c, 41.8, -87.6)
        result_b = pipeline_b.process([storm_b])

        # Both should get strong_storm (location-independent)
        assert DetectionType.strong_storm in {e.type for e in result_a.events}
        assert DetectionType.strong_storm in {e.type for e in result_b.events}

    def test_distance_differs_between_clients(self):
        c = _candidate(lat=39.55, lon=-84.45)

        storm_near = _candidate_to_storm(c, ref_lat=39.5, ref_lon=-84.5)
        storm_far = _candidate_to_storm(c, ref_lat=41.8, ref_lon=-87.6)

        assert storm_near.distance_mi < 10
        assert storm_far.distance_mi > 100

    def test_independent_cooldown_per_client(self):
        """Each client's pipeline has its own cooldown state."""
        c = _candidate(dbz=60)

        pipeline_a = DetectionPipeline()
        pipeline_b = DetectionPipeline()

        storm_a = _candidate_to_storm(c, 39.5, -84.5)
        storm_b = _candidate_to_storm(c, 39.5, -84.5)

        # First run: both emit
        r_a1 = pipeline_a.process([storm_a])
        r_b1 = pipeline_b.process([storm_b])
        assert len(r_a1.events) > 0
        assert len(r_b1.events) > 0

        # Second run: both in cooldown
        r_a2 = pipeline_a.process([storm_a])
        r_b2 = pipeline_b.process([storm_b])
        assert len(r_a2.events) == 0
        assert len(r_b2.events) == 0


class TestEvaluateForClient:
    def test_with_candidates(self):
        import services.detection.adapter as adapter
        original = adapter._base_candidates

        adapter._base_candidates = [_candidate(lat=39.55, lon=-84.45, dbz=60)]
        pipeline = DetectionPipeline()
        result = evaluate_for_client(39.5, -84.5, pipeline)
        assert result.storms_processed == 1
        assert len(result.events) > 0

        adapter._base_candidates = original

    def test_empty_candidates(self):
        import services.detection.adapter as adapter
        original = adapter._base_candidates

        adapter._base_candidates = []
        pipeline = DetectionPipeline()
        result = evaluate_for_client(39.5, -84.5, pipeline)
        assert result.storms_processed == 0
        assert result.events == []

        adapter._base_candidates = original


class TestDefaultFallback:
    def test_default_location_works(self):
        """Legacy path with default location still functions."""
        c = _candidate(dbz=60)
        storm = _candidate_to_storm(c, ref_lat=39.5, ref_lon=-84.5)
        pipeline = DetectionPipeline()
        result = pipeline.process([storm])
        assert result.storms_processed == 1
