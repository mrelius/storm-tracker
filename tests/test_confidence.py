"""Tests for confidence/signal-quality layer (Phase 12)."""
import time
from services.detection.tracker import (
    StormTracker, StormTrack, _compute_motion, _compute_confidence,
    compute_trend, MAX_RECENT,
)
from services.detection.adapter import BaseStormCandidate, _track_to_storm
from services.detection.models import Trend, DetectionType
from services.detection.pipeline import DetectionPipeline
from services.detection.eta import compute_eta, MIN_MOTION_CONFIDENCE


def _candidate(lat=39.5, lon=-84.5, dbz=60):
    return BaseStormCandidate(
        id="nws_1", lat=lat, lon=lon, reflectivity_dbz=dbz,
        nws_event="TW", nws_severity="Extreme", last_updated=time.time(),
    )


# === Track Confidence ===

class TestTrackConfidence:
    def test_new_track_low_confidence(self):
        tracker = StormTracker()
        tracks = tracker.update([_candidate()])
        assert tracks[0].track_confidence <= 0.3

    def test_confidence_increases_with_age(self):
        tracker = StormTracker()
        c = _candidate()
        tracker.update([c])
        conf1 = list(tracker._tracks.values())[0].track_confidence

        tracker.update([c])
        conf2 = list(tracker._tracks.values())[0].track_confidence
        assert conf2 > conf1

    def test_mature_track_high_confidence(self):
        tracker = StormTracker()
        c = _candidate()
        for _ in range(5):
            tracker.update([c])
        track = list(tracker._tracks.values())[0]
        assert track.track_confidence >= 0.7

    def test_missed_cycle_reduces_confidence(self):
        tracker = StormTracker()
        c = _candidate()
        for _ in range(4):
            tracker.update([c])
        conf_before = list(tracker._tracks.values())[0].track_confidence

        tracker.update([])  # miss
        tracker.update([c])  # re-acquire
        conf_after = list(tracker._tracks.values())[0].track_confidence
        assert conf_after <= conf_before


# === Motion Confidence ===

class TestMotionConfidence:
    def test_consistent_speed_high_confidence(self):
        track = StormTrack(storm_id="t1", total_cycles=4)
        track.positions = [
            (39.00, -84.50, 100),
            (39.10, -84.50, 460),
            (39.20, -84.50, 820),
            (39.30, -84.50, 1180),
        ]
        track.recent_speeds = [25.0, 25.0, 25.0]
        track.recent_headings = [0.0, 0.0, 0.0]
        _compute_confidence(track)
        assert track.motion_confidence >= 0.6

    def test_wildly_varying_speed_low_confidence(self):
        track = StormTrack(storm_id="t1", total_cycles=4)
        track.positions = [
            (39.00, -84.50, 100),
            (39.10, -84.50, 460),
        ]
        track.recent_speeds = [5.0, 50.0, 10.0]
        track.recent_headings = [0.0, 0.0, 0.0]
        _compute_confidence(track)
        assert track.motion_confidence < 0.5

    def test_wildly_varying_heading_low_confidence(self):
        track = StormTrack(storm_id="t1", total_cycles=4)
        track.positions = [
            (39.00, -84.50, 100),
            (39.10, -84.50, 460),
        ]
        track.recent_speeds = [30.0, 30.0]
        track.recent_headings = [0.0, 90.0, 180.0]  # 90° changes
        _compute_confidence(track)
        assert track.motion_confidence < 0.3


# === Trend Confidence ===

class TestTrendConfidence:
    def test_strong_closing_high_confidence(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.70, -84.50, 100), (39.55, -84.50, 200)],
            motion_confidence=0.8,
        )
        trend, conf = compute_trend(track, 39.50, -84.50)
        assert trend == "closing"
        assert conf > 0.3

    def test_weak_closing_low_confidence(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.510, -84.50, 100), (39.505, -84.50, 200)],
            motion_confidence=0.8,
        )
        # Very small movement — just above threshold
        trend, conf = compute_trend(track, 39.50, -84.50)
        # Either unknown (below threshold) or closing with low confidence
        if trend == "closing":
            assert conf < 0.3

    def test_no_history_zero_confidence(self):
        track = StormTrack(storm_id="t1", positions=[(39.50, -84.50, 100)])
        trend, conf = compute_trend(track, 39.50, -84.50)
        assert trend == "unknown"
        assert conf == 0.0

    def test_low_motion_confidence_reduces_trend(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.70, -84.50, 100), (39.55, -84.50, 200)],
            motion_confidence=0.1,  # very low
        )
        trend, conf = compute_trend(track, 39.50, -84.50)
        assert trend == "closing"
        assert conf <= 0.1  # low motion conf → low trend conf


# === ETA Suppression ===

class TestETASuppression:
    def test_eta_suppressed_low_confidence(self):
        from services.detection.models import StormObject
        storm = StormObject(
            id="t1", lat=39.55, lon=-84.50,
            distance_mi=10, bearing_deg=0,
            speed_mph=30, trend=Trend.closing,
            motion_confidence=0.1,  # below MIN_MOTION_CONFIDENCE
        )
        assert compute_eta(storm) is None

    def test_eta_available_high_confidence(self):
        from services.detection.models import StormObject
        storm = StormObject(
            id="t1", lat=39.55, lon=-84.50,
            distance_mi=10, bearing_deg=0,
            speed_mph=30, trend=Trend.closing,
            motion_confidence=0.6,
        )
        eta = compute_eta(storm)
        assert eta is not None
        assert eta == 20.0  # 10mi / 30mph * 60

    def test_eta_clamped_unrealistic(self):
        from services.detection.models import StormObject
        storm = StormObject(
            id="t1", lat=39.55, lon=-84.50,
            distance_mi=500, bearing_deg=0,
            speed_mph=5, trend=Trend.closing,
            motion_confidence=0.8,
        )
        # 500/5*60 = 6000 min > 360 → clamped to None
        assert compute_eta(storm) is None


# === Smoothed Speed ===

class TestSmoothing:
    def test_smoothed_speed_averages(self):
        track = StormTrack(storm_id="t1")
        track.recent_speeds = [20.0, 30.0, 25.0]
        track.smoothed_speed = sum(track.recent_speeds) / len(track.recent_speeds)
        assert track.smoothed_speed == 25.0

    def test_track_to_storm_uses_smoothed(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.55, -84.50, 100)],
            speed_mph=35.0,
            smoothed_speed=30.0,
            motion_confidence=0.6,
        )
        storm = _track_to_storm(track, 39.50, -84.50)
        assert storm.speed_mph == 30.0  # uses smoothed, not raw


# === Proximity with Confidence ===

class TestProximityConfidence:
    def test_high_confidence_closing_triggers(self):
        """Mature track + consistent closing → proximity fires."""
        from services.detection.detectors import detect_proximity
        from services.detection.models import StormObject
        storm = StormObject(
            id="t1", lat=39.55, lon=-84.50,
            distance_mi=10, bearing_deg=0,
            speed_mph=30, trend=Trend.closing,
            trend_confidence=0.5,
            motion_confidence=0.6,
        )
        events = detect_proximity(storm)
        assert len(events) == 1

    def test_low_confidence_closing_suppressed(self):
        """New noisy track → trend_confidence too low → proximity suppressed."""
        from services.detection.detectors import detect_proximity
        from services.detection.models import StormObject
        storm = StormObject(
            id="t1", lat=39.55, lon=-84.50,
            distance_mi=10, bearing_deg=0,
            speed_mph=30, trend=Trend.closing,
            trend_confidence=0.05,  # below MIN_TREND_CONFIDENCE
            motion_confidence=0.1,
        )
        events = detect_proximity(storm)
        assert len(events) == 0


# === End-to-End ===

class TestEndToEnd:
    def test_stable_track_produces_confident_proximity(self):
        """Multi-cycle stable closing → high confidence → proximity fires."""
        tracker = StormTracker()

        # Build a track with 3 cycles of consistent closing movement
        for i, lat in enumerate([39.70, 39.63, 39.56]):
            c = _candidate(lat=lat, lon=-84.50)
            tracker.update([c])

        tracks = list(tracker._tracks.values())
        assert len(tracks) == 1
        track = tracks[0]

        # Convert for client at 39.50
        storm = _track_to_storm(track, 39.50, -84.50)
        assert storm.trend == Trend.closing
        assert storm.trend_confidence > 0
        assert storm.track_confidence > 0.5

        pipeline = DetectionPipeline()
        result = pipeline.process([storm])
        types = {e.type for e in result.events}
        assert DetectionType.storm_proximity in types

    def test_noisy_track_suppresses_proximity(self):
        """Single-cycle new track → low confidence → proximity suppressed."""
        tracker = StormTracker()
        c = _candidate(lat=39.55, lon=-84.50)
        tracks = tracker.update([c])
        track = tracks[0]

        storm = _track_to_storm(track, 39.50, -84.50)
        # New track: no previous position → trend unknown
        assert storm.trend == Trend.unknown or storm.trend_confidence < 0.15

        pipeline = DetectionPipeline()
        result = pipeline.process([storm])
        prox = [e for e in result.events if e.type == DetectionType.storm_proximity]
        assert len(prox) == 0
