"""Tests for storm tracking, motion, trend, and detection integration."""
import time
from services.detection.tracker import (
    StormTracker, StormTrack, compute_trend,
    MATCH_RADIUS_MI, EXPIRE_CYCLES, TREND_THRESHOLD_MI,
)
from services.detection.adapter import (
    BaseStormCandidate, _track_to_storm, evaluate_for_client,
)
from services.detection.models import Trend, DetectionType
from services.detection.pipeline import DetectionPipeline
from services.detection.geometry import haversine_mi


def _candidate(lat=39.5, lon=-84.5, dbz=60, cid="nws_1"):
    return BaseStormCandidate(
        id=cid, lat=lat, lon=lon,
        reflectivity_dbz=dbz, nws_event="Tornado Warning",
        nws_severity="Extreme", last_updated=time.time(),
    )


# === Storm Identity ===

class TestStormIdentity:
    def test_new_storm_gets_id(self):
        tracker = StormTracker()
        tracks = tracker.update([_candidate()])
        assert len(tracks) == 1
        assert tracks[0].storm_id.startswith("st_")

    def test_same_storm_keeps_id(self):
        tracker = StormTracker()
        c1 = _candidate(lat=39.50, lon=-84.50)
        tracks1 = tracker.update([c1])
        sid = tracks1[0].storm_id

        # Same position next cycle
        c2 = _candidate(lat=39.50, lon=-84.50)
        tracks2 = tracker.update([c2])
        assert tracks2[0].storm_id == sid

    def test_moved_storm_keeps_id(self):
        tracker = StormTracker()
        c1 = _candidate(lat=39.50, lon=-84.50)
        tracks1 = tracker.update([c1])
        sid = tracks1[0].storm_id

        # Moved slightly (within match radius)
        c2 = _candidate(lat=39.55, lon=-84.45)
        tracks2 = tracker.update([c2])
        assert tracks2[0].storm_id == sid

    def test_far_storm_gets_new_id(self):
        tracker = StormTracker()
        c1 = _candidate(lat=39.50, lon=-84.50)
        tracks1 = tracker.update([c1])
        sid1 = tracks1[0].storm_id

        # Far away (> MATCH_RADIUS_MI) — should be new track
        c2 = _candidate(lat=42.00, lon=-88.00)
        tracks2 = tracker.update([c2])
        # Should have 2 tracks (old one still alive for a cycle)
        sids = {t.storm_id for t in tracks2}
        assert sid1 in sids
        assert len(sids) == 2

    def test_two_storms_different_ids(self):
        tracker = StormTracker()
        c1 = _candidate(lat=39.50, lon=-84.50, cid="a")
        c2 = _candidate(lat=41.00, lon=-87.00, cid="b")
        tracks = tracker.update([c1, c2])
        assert len(tracks) == 2
        assert tracks[0].storm_id != tracks[1].storm_id


# === Expiration ===

class TestExpiration:
    def test_expires_after_missed_cycles(self):
        tracker = StormTracker()
        tracker.update([_candidate()])
        assert tracker.track_count == 1

        for _ in range(EXPIRE_CYCLES):
            tracker.update([])  # no candidates

        assert tracker.track_count == 0

    def test_refresh_resets_expiry(self):
        tracker = StormTracker()
        c = _candidate()
        tracker.update([c])

        # Miss 2 cycles
        tracker.update([])
        tracker.update([])
        assert tracker.track_count == 1  # still alive

        # Refresh
        tracker.update([c])
        # Miss 2 more
        tracker.update([])
        tracker.update([])
        assert tracker.track_count == 1  # still alive


# === Motion ===

class TestMotion:
    def test_no_motion_single_position(self):
        tracker = StormTracker()
        tracks = tracker.update([_candidate()])
        assert tracks[0].speed_mph == 0.0

    def test_speed_computed(self):
        tracker = StormTracker()
        c1 = _candidate(lat=39.50, lon=-84.50)
        tracker.update([c1])

        # Simulate time passing + movement
        track = list(tracker._tracks.values())[0]
        # Inject a position 1 hour ago, 30 miles south
        old_lat = 39.50 - 30 / 69.0  # ~30 mi south
        track.positions = [
            (old_lat, -84.50, time.time() - 3600),
            (39.50, -84.50, time.time()),
        ]
        from services.detection.tracker import _compute_motion
        _compute_motion(track)
        assert 25 < track.speed_mph < 35  # ~30 mph

    def test_stationary_storm(self):
        tracker = StormTracker()
        c = _candidate()
        tracker.update([c])
        # Update at same position
        tracker.update([c])
        track = list(tracker._tracks.values())[0]
        assert track.speed_mph == 0.0


# === Trend ===

class TestTrend:
    def test_closing(self):
        track = StormTrack(
            storm_id="t1",
            positions=[
                (39.60, -84.50, 100),
                (39.52, -84.50, 200),
            ],
        )
        trend, conf = compute_trend(track, 39.50, -84.50)
        assert trend == "closing"

    def test_departing(self):
        track = StormTrack(
            storm_id="t1",
            positions=[
                (39.52, -84.50, 100),
                (39.60, -84.50, 200),
            ],
        )
        trend, conf = compute_trend(track, 39.50, -84.50)
        assert trend == "departing"

    def test_unknown_no_history(self):
        track = StormTrack(storm_id="t1", positions=[(39.50, -84.50, 100)])
        trend, conf = compute_trend(track, 39.50, -84.50)
        assert trend == "unknown"

    def test_unknown_negligible_change(self):
        track = StormTrack(
            storm_id="t1",
            positions=[
                (39.500, -84.500, 100),
                (39.501, -84.500, 200),
            ],
        )
        trend, conf = compute_trend(track, 39.50, -84.50)
        assert trend == "unknown"

    def test_client_relative(self):
        track = StormTrack(
            storm_id="t1",
            positions=[
                (39.50, -84.50, 100),
                (39.55, -84.50, 200),
            ],
        )
        trend_north, _ = compute_trend(track, 39.70, -84.50)
        trend_south, _ = compute_trend(track, 39.30, -84.50)
        assert trend_north == "closing"
        assert trend_south == "departing"


# === Track to Storm ===

class TestTrackToStorm:
    def test_includes_speed(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.50, -84.50, 100), (39.55, -84.50, 200)],
            speed_mph=25.0,
        )
        storm = _track_to_storm(track, 39.50, -84.50)
        assert storm.speed_mph == 25.0

    def test_includes_trend(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.60, -84.50, 100), (39.52, -84.50, 200)],
        )
        storm = _track_to_storm(track, 39.50, -84.50)
        assert storm.trend == Trend.closing

    def test_preserves_metadata(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.50, -84.50, 100)],
            reflectivity_dbz=58, velocity_delta=42, cc_min=0.74,
        )
        storm = _track_to_storm(track, 39.50, -84.50)
        assert storm.reflectivity_dbz == 58
        assert storm.velocity_delta == 42
        assert storm.cc_min == 0.74


# === End-to-End: tracking → detection ===

class TestEndToEnd:
    def test_closing_storm_triggers_proximity(self):
        """Storm moves toward client → trend=closing → proximity fires."""
        tracker = StormTracker()

        # Cycle 1: storm at distance
        c1 = _candidate(lat=39.65, lon=-84.50, dbz=60)
        tracker.update([c1])

        # Cycle 2: storm moved closer to client at 39.50
        c2 = _candidate(lat=39.55, lon=-84.50, dbz=60)
        tracks = tracker.update([c2])

        # Client at 39.50: storm is < 20 mi and closing
        pipeline = DetectionPipeline()
        storm = _track_to_storm(tracks[0], 39.50, -84.50)

        assert storm.trend == Trend.closing
        assert storm.distance_mi < 20

        result = pipeline.process([storm])
        types = {e.type for e in result.events}
        assert DetectionType.storm_proximity in types

    def test_departing_storm_no_proximity(self):
        """Storm moves away → trend=departing → no proximity."""
        tracker = StormTracker()

        c1 = _candidate(lat=39.55, lon=-84.50)
        tracker.update([c1])

        c2 = _candidate(lat=39.65, lon=-84.50)
        tracks = tracker.update([c2])

        pipeline = DetectionPipeline()
        storm = _track_to_storm(tracks[0], 39.50, -84.50)
        assert storm.trend == Trend.departing

        result = pipeline.process([storm])
        types = {e.type for e in result.events}
        assert DetectionType.storm_proximity not in types


# === Intensity Trend ===

class TestIntensityTrend:
    def test_strengthening(self):
        from services.detection.tracker import _compute_intensity_trend
        track = StormTrack(storm_id="t1", positions=[(39.5, -84.5, 100)])
        track.prev_reflectivity_dbz = 50
        track.reflectivity_dbz = 60  # +10 dBZ
        _compute_intensity_trend(track)
        assert track.intensity_trend == "strengthening"

    def test_weakening(self):
        from services.detection.tracker import _compute_intensity_trend
        track = StormTrack(storm_id="t1", positions=[(39.5, -84.5, 100)])
        track.prev_reflectivity_dbz = 60
        track.reflectivity_dbz = 50  # -10 dBZ
        _compute_intensity_trend(track)
        assert track.intensity_trend == "weakening"

    def test_stable(self):
        from services.detection.tracker import _compute_intensity_trend
        track = StormTrack(storm_id="t1", positions=[(39.5, -84.5, 100)])
        track.prev_reflectivity_dbz = 55
        track.reflectivity_dbz = 57  # +2 dBZ (below threshold)
        _compute_intensity_trend(track)
        assert track.intensity_trend == "stable"

    def test_unknown_no_previous(self):
        from services.detection.tracker import _compute_intensity_trend
        track = StormTrack(storm_id="t1", positions=[(39.5, -84.5, 100)])
        track.reflectivity_dbz = 60
        track.prev_reflectivity_dbz = None
        _compute_intensity_trend(track)
        assert track.intensity_trend == "unknown"

    def test_velocity_strengthening(self):
        from services.detection.tracker import _compute_intensity_trend
        track = StormTrack(storm_id="t1", positions=[(39.5, -84.5, 100)])
        track.prev_reflectivity_dbz = 55
        track.reflectivity_dbz = 55  # stable dbz
        track.prev_velocity_delta = 30
        track.velocity_delta = 45  # +15 kt
        _compute_intensity_trend(track)
        assert track.intensity_trend == "strengthening"

    def test_propagated_to_storm(self):
        """Intensity trend flows through to StormObject."""
        tracker = StormTracker()
        c1 = _candidate(lat=39.5, lon=-84.5, dbz=50)
        tracker.update([c1])
        c2 = _candidate(lat=39.5, lon=-84.5, dbz=65)
        tracks = tracker.update([c2])
        assert tracks[0].intensity_trend == "strengthening"

        storm = _track_to_storm(tracks[0], 39.5, -84.5)
        assert storm.intensity_trend == "strengthening"
