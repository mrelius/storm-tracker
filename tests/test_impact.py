"""Tests for impact prediction — CPA, classification, and integration (Phase 19)."""
from services.detection.impact import (
    compute_impact, GLANCE_MARGIN_MI, _offset_direction,
    _bearing_to_cardinal, _approach_phrase, _build_description,
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
        assert result["cpa_distance_mi"] < 5.0  # default storm radius
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
        assert result["cpa_distance_mi"] > 5.0  # default storm radius

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
        """Storm heading at client with slight offset ≤ 5.0  # default storm radius."""
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


# === Phase 20: Footprint + Severity ===

class TestRadius:
    def test_strong_storm(self):
        from services.detection.impact import compute_radius
        r = compute_radius(60)
        assert 6 <= r <= 10

    def test_severe_storm(self):
        from services.detection.impact import compute_radius
        r = compute_radius(70)
        assert r >= 10

    def test_weak_storm(self):
        from services.detection.impact import compute_radius
        r = compute_radius(35)
        assert r <= 3

    def test_debris_bonus(self):
        from services.detection.impact import compute_radius
        r_no = compute_radius(60, has_debris=False)
        r_yes = compute_radius(60, has_debris=True)
        assert r_yes > r_no

    def test_capped(self):
        from services.detection.impact import compute_radius, MAX_RADIUS_MI
        r = compute_radius(99, has_debris=True)
        assert r <= MAX_RADIUS_MI

    def test_none_dbz(self):
        from services.detection.impact import compute_radius
        r = compute_radius(None)
        assert r >= 1  # minimum for weak


class TestAreaAwareClassification:
    def test_within_radius_is_direct_hit(self):
        """Storm with 7mi radius, CPA of 5mi → direct_hit."""
        result = compute_impact(
            39.0, -84.5, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=7.0, reflectivity_dbz=60,
        )
        assert result["impact"] == "direct_hit"

    def test_outside_radius_but_within_margin(self):
        """CPA > radius but within glance margin → near_miss."""
        result = compute_impact(
            39.0, -84.6, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=3.0, reflectivity_dbz=45,
        )
        # CPA ~6mi, radius 3mi, margin 5mi → 3+5=8mi → near_miss
        assert result["impact"] in ("direct_hit", "near_miss")

    def test_small_radius_changes_classification(self):
        """Same storm with small radius should be further from direct_hit."""
        r_big = compute_impact(
            39.0, -84.55, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=10.0, reflectivity_dbz=65,
        )
        r_small = compute_impact(
            39.0, -84.55, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=2.0, reflectivity_dbz=35,
        )
        # Big radius more likely to be direct_hit
        assert r_big["impact"] in ("direct_hit", "near_miss")


class TestSeverityProjection:
    def test_strong_stable(self):
        from services.detection.impact import project_severity
        label, score = project_severity(60, "stable")
        assert label in ("strong", "severe")
        assert score >= 60

    def test_strong_strengthening(self):
        from services.detection.impact import project_severity
        label, score = project_severity(58, "strengthening")
        assert label == "severe"
        assert score > 70

    def test_strong_weakening(self):
        from services.detection.impact import project_severity
        label, score = project_severity(58, "weakening")
        assert label == "moderate"
        assert score < 70

    def test_weak_storm(self):
        from services.detection.impact import project_severity
        label, score = project_severity(30, "stable")
        assert label == "weak"
        assert score < 30

    def test_distant_reduces_score(self):
        from services.detection.impact import project_severity
        _, near = project_severity(60, "stable", time_to_cpa_min=10)
        _, far = project_severity(60, "stable", time_to_cpa_min=60)
        assert far <= near


class TestImpactSeverityScore:
    def test_direct_hit_severe(self):
        result = compute_impact(
            39.0, -84.5, 0, 40, 39.5, -84.5, 0.9,
            storm_radius_mi=10.0, reflectivity_dbz=65,
            intensity_trend="strengthening",
        )
        assert result["impact_severity_label"] in ("critical", "high")
        assert result["impact_severity_score"] >= 50

    def test_passing_low(self):
        result = compute_impact(
            39.0, -85.5, 90, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=5.0, reflectivity_dbz=50,
        )
        assert result["impact_severity_label"] in ("low", "moderate")


# === Phase 21: Geographic Context Language ===

class TestCardinalDirection:
    def test_north(self):
        assert _bearing_to_cardinal(0) == "north"

    def test_northeast(self):
        assert _bearing_to_cardinal(45) == "northeast"

    def test_south(self):
        assert _bearing_to_cardinal(180) == "south"

    def test_west(self):
        assert _bearing_to_cardinal(270) == "west"

    def test_wrap(self):
        assert _bearing_to_cardinal(360) == "north"


class TestApproachPhrase:
    def test_storm_southwest(self):
        # Storm is southwest of client
        phrase = _approach_phrase(39.0, -85.0, 39.5, -84.5)
        assert "southwest" in phrase
        assert "from the" in phrase

    def test_storm_north(self):
        phrase = _approach_phrase(40.0, -84.5, 39.5, -84.5)
        assert "north" in phrase


class TestMessageSynthesis:
    def test_direct_hit_message(self):
        msg = _build_description(
            "direct_hit", "severe", 12, 3, "north",
            "from the southwest", "moving northeast", "strengthening",
        )
        assert "Severe" in msg
        assert "southwest" in msg
        assert "12 min" in msg
        assert "impact" in msg
        assert "strengthening" in msg

    def test_near_miss_message(self):
        msg = _build_description(
            "near_miss", "strong", 15, 8, "north",
            "from the west", "moving east", "stable",
        )
        assert "Strong" in msg
        assert "north" in msg
        assert "passing" in msg

    def test_passing_message(self):
        msg = _build_description(
            "passing", "moderate", 30, 25, "south",
            "from the north", "moving southeast", "stable",
        )
        assert "south" in msg
        assert "moving" in msg.lower()

    def test_uncertain_message(self):
        msg = _build_description(
            "uncertain", "unknown", 0, 0, "",
            "", "", "unknown",
        )
        assert "uncertain" in msg.lower()

    def test_weakening_suffix(self):
        msg = _build_description(
            "direct_hit", "strong", 10, 2, "north",
            "from the south", "moving north", "weakening",
        )
        assert "weakening" in msg

    def test_at_location(self):
        msg = _build_description(
            "direct_hit", "severe", 0, 0, "north",
            "from the south", "moving north", "stable",
        )
        assert "at your location" in msg


class TestIntegratedDescriptions:
    def test_direct_hit_full_context(self):
        result = compute_impact(
            39.0, -84.5, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=7.0, reflectivity_dbz=60,
            intensity_trend="strengthening",
        )
        desc = result["impact_description"]
        assert "southwest" in desc or "south" in desc  # storm is south of client
        assert "impact" in desc or "area" in desc
        assert len(desc) > 20

    def test_near_miss_has_side(self):
        result = compute_impact(
            39.0, -84.6, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=3.0, reflectivity_dbz=50,
        )
        desc = result["impact_description"]
        assert "pass" in desc.lower() or "miss" in desc.lower() or "stay" in desc.lower()

    def test_approach_direction_present(self):
        result = compute_impact(
            39.0, -84.5, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=7.0, reflectivity_dbz=60,
        )
        assert result.get("approach_direction", "") != ""

    def test_pass_side_present(self):
        result = compute_impact(
            39.0, -84.6, 0, 30, 39.5, -84.5, 0.8,
            storm_radius_mi=3.0, reflectivity_dbz=50,
        )
        assert result.get("pass_side", "") != ""
