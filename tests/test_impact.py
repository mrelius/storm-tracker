"""Tests for impact prediction — CPA, classification, and integration (Phase 19)."""
from services.detection.impact import (
    compute_impact, DIRECT_HIT_MI, NEAR_MISS_MI, _offset_direction,
)


class TestCPA:
    def test_direct_hit(self):
        """Storm heading straight at client → CPA ≈ 0."""
        result = compute_impact(
            storm_lat=39.0, storm_lon=-84.5,
            heading_deg=0,  # north
            speed_mph=30,
            client_lat=39.5, client_lon=-84.5,  # directly north
            motion_confidence=0.8,
        )
        assert result["impact"] == "direct_hit"
        assert result["cpa_distance_mi"] < DIRECT_HIT_MI
        assert result["time_to_cpa_min"] > 0

    def test_parallel_miss(self):
        """Storm moving parallel (east) past client to the south → passing."""
        result = compute_impact(
            storm_lat=39.0, storm_lon=-85.0,
            heading_deg=90,  # east
            speed_mph=30,
            client_lat=39.5, client_lon=-84.5,  # north of storm
            motion_confidence=0.8,
        )
        # Storm moves east, client is 0.5° north → miss by ~35 miles
        assert result["impact"] in ("passing", "near_miss")
        assert result["cpa_distance_mi"] > DIRECT_HIT_MI

    def test_near_miss(self):
        """Storm passes close but offset."""
        result = compute_impact(
            storm_lat=39.0, storm_lon=-84.6,
            heading_deg=0,  # north
            speed_mph=30,
            client_lat=39.5, client_lon=-84.5,  # slightly east
            motion_confidence=0.8,
        )
        cpa = result["cpa_distance_mi"]
        # 0.1° longitude ≈ 6 miles → near miss range
        assert result["impact"] in ("direct_hit", "near_miss")

    def test_departing_storm(self):
        """Storm moving away from client."""
        result = compute_impact(
            storm_lat=39.5, storm_lon=-84.5,
            heading_deg=180,  # south (away from client at 40.0)
            speed_mph=30,
            client_lat=40.0, client_lon=-84.5,
            motion_confidence=0.8,
        )
        # CPA is at t=0 (current position is closest)
        assert result["time_to_cpa_min"] == 0

    def test_stationary_storm(self):
        result = compute_impact(
            storm_lat=39.5, storm_lon=-84.5,
            heading_deg=0, speed_mph=0,
            client_lat=39.6, client_lon=-84.5,
            motion_confidence=0.8,
        )
        assert result["impact"] == "uncertain"
        assert "stationary" in result["impact_description"].lower()

    def test_low_confidence(self):
        result = compute_impact(
            storm_lat=39.5, storm_lon=-84.5,
            heading_deg=0, speed_mph=30,
            client_lat=39.6, client_lon=-84.5,
            motion_confidence=0.1,
        )
        assert result["impact"] == "uncertain"


class TestClassification:
    def test_direct_hit_threshold(self):
        """Storm heading at client with slight offset ≤ DIRECT_HIT_MI."""
        result = compute_impact(
            storm_lat=39.0, storm_lon=-84.5,
            heading_deg=0, speed_mph=40,
            client_lat=39.5, client_lon=-84.5,
            motion_confidence=0.9,
        )
        assert result["impact"] == "direct_hit"

    def test_passing_classification(self):
        """Storm heading well east of client."""
        result = compute_impact(
            storm_lat=39.0, storm_lon=-84.5,
            heading_deg=90, speed_mph=40,  # due east
            client_lat=39.5, client_lon=-84.5,  # 35mi north
            motion_confidence=0.9,
        )
        assert result["impact"] in ("passing", "near_miss")

    def test_description_present(self):
        result = compute_impact(
            storm_lat=39.0, storm_lon=-84.5,
            heading_deg=0, speed_mph=40,
            client_lat=39.5, client_lon=-84.5,
            motion_confidence=0.9,
        )
        assert len(result["impact_description"]) > 0


class TestTimeToImpact:
    def test_time_positive_for_approaching(self):
        result = compute_impact(
            storm_lat=39.0, storm_lon=-84.5,
            heading_deg=0, speed_mph=30,
            client_lat=39.5, client_lon=-84.5,
            motion_confidence=0.8,
        )
        assert result["time_to_cpa_min"] > 0

    def test_time_zero_for_departed(self):
        result = compute_impact(
            storm_lat=39.5, storm_lon=-84.5,
            heading_deg=180, speed_mph=30,
            client_lat=40.0, client_lon=-84.5,
            motion_confidence=0.8,
        )
        assert result["time_to_cpa_min"] == 0

    def test_reasonable_time(self):
        """35 mi at 30 mph ≈ 70 min → should be within 90 min horizon."""
        result = compute_impact(
            storm_lat=39.0, storm_lon=-84.5,
            heading_deg=0, speed_mph=30,
            client_lat=39.5, client_lon=-84.5,  # ~35 mi
            motion_confidence=0.8,
        )
        assert 60 < result["time_to_cpa_min"] < 90


class TestOffsetDirection:
    def test_north(self):
        assert _offset_direction(39.0, -84.5, 40.0, -84.5) == "north"

    def test_south(self):
        assert _offset_direction(40.0, -84.5, 39.0, -84.5) == "south"

    def test_east(self):
        assert _offset_direction(39.5, -85.0, 39.5, -84.0) == "east"


class TestIntegration:
    def test_impact_in_storm_object(self):
        """Impact fields propagate through adapter."""
        from services.detection.adapter import _track_to_storm
        from services.detection.tracker import StormTrack

        track = StormTrack(
            storm_id="t1",
            positions=[(39.0, -84.5, 100), (39.1, -84.5, 460)],
            speed_mph=30, heading_deg=0,
            smoothed_speed=30, smoothed_heading=0,
            motion_confidence=0.8,
        )
        storm = _track_to_storm(track, 39.5, -84.5)  # client north
        assert storm.impact in ("direct_hit", "near_miss", "passing", "uncertain")
        assert storm.impact_description != ""
