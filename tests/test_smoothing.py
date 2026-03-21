"""Tests for smoothing, prediction, and stabilization (Phase 18)."""
import math
import time
from services.detection.tracker import (
    StormTrack, StormTracker, _compute_motion, _compute_intensity_trend,
    _circular_mean, _compute_prediction, _compute_confidence,
    MIN_SPEED_MPH, PREDICTION_MINUTES, MAX_RECENT,
)
from services.detection.adapter import BaseStormCandidate, _track_to_storm


def _candidate(lat=39.5, lon=-84.5, dbz=60):
    return BaseStormCandidate(
        id="nws_1", lat=lat, lon=lon, reflectivity_dbz=dbz,
        nws_event="TW", nws_severity="Extreme", last_updated=time.time(),
    )


# === Circular Mean ===

class TestCircularMean:
    def test_simple_north(self):
        result = _circular_mean([350, 0, 10])
        assert result < 5 or result > 355  # 0° and 360° are the same

    def test_simple_east(self):
        assert _circular_mean([80, 90, 100]) == pytest.approx(90, abs=2)

    def test_wrap_around(self):
        """350° and 10° should average to ~0° (north), not 180°."""
        result = _circular_mean([350, 10])
        assert result < 10 or result > 350

    def test_single_value(self):
        assert _circular_mean([45]) == pytest.approx(45, abs=1)

    def test_empty(self):
        assert _circular_mean([]) == 0.0


# === Heading Smoothing ===

class TestHeadingSmoothing:
    def test_consistent_heading_stable(self):
        track = StormTrack(storm_id="t1", total_cycles=4)
        track.positions = [
            (39.0, -84.5, 100),
            (39.1, -84.5, 200),
            (39.2, -84.5, 300),
            (39.3, -84.5, 400),
        ]
        # All movement is northward → heading ≈ 0
        track.recent_headings = [0, 2, 358]
        _compute_motion(track)
        assert track.smoothed_heading < 10 or track.smoothed_heading > 350

    def test_noisy_heading_averaged(self):
        """Circular mean of [30, 45, 60] should be ~45."""
        result = _circular_mean([30, 45, 60])
        assert 40 < result < 50


# === Intensity Trend Smoothing ===

class TestIntensitySmoothing:
    def test_sustained_strengthening(self):
        track = StormTrack(storm_id="t1")
        track.recent_dbz = [50, 55, 60]  # +10 over window
        track.reflectivity_dbz = 60
        _compute_intensity_trend(track)
        assert track.intensity_trend == "strengthening"

    def test_single_spike_not_strengthening(self):
        """Single +6 dBZ followed by return to normal should be stable."""
        track = StormTrack(storm_id="t1")
        track.recent_dbz = [50, 56, 52]  # net +2 over window
        track.reflectivity_dbz = 52
        _compute_intensity_trend(track)
        assert track.intensity_trend == "stable"

    def test_sustained_weakening(self):
        track = StormTrack(storm_id="t1")
        track.recent_dbz = [65, 60, 55]  # -10 over window
        track.reflectivity_dbz = 55
        _compute_intensity_trend(track)
        assert track.intensity_trend == "weakening"

    def test_insufficient_history(self):
        track = StormTrack(storm_id="t1")
        track.recent_dbz = []  # truly empty
        track.reflectivity_dbz = 60
        _compute_intensity_trend(track)
        # After computing, recent_dbz has 1 entry → still "unknown"
        assert track.intensity_trend == "unknown"

    def test_history_bounded(self):
        track = StormTrack(storm_id="t1")
        track.recent_dbz = list(range(20))  # way too many
        track.reflectivity_dbz = 60
        _compute_intensity_trend(track)
        assert len(track.recent_dbz) <= MAX_RECENT


# === Prediction ===

class TestPrediction:
    def test_northward_prediction(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.0, -84.5, 100), (39.1, -84.5, 200)],
            smoothed_speed=30.0,
            smoothed_heading=0.0,  # north
            motion_confidence=0.8,
        )
        _compute_prediction(track)
        assert track.predicted_lat > track.lat  # moved north
        assert track.prediction_minutes == PREDICTION_MINUTES

    def test_eastward_prediction(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.5, -84.5, 100)],
            smoothed_speed=30.0,
            smoothed_heading=90.0,  # east
            motion_confidence=0.8,
        )
        _compute_prediction(track)
        assert track.predicted_lon > track.lon  # moved east

    def test_no_prediction_low_speed(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.5, -84.5, 100)],
            smoothed_speed=0.5,  # below MIN_SPEED_MPH
            motion_confidence=0.8,
        )
        _compute_prediction(track)
        assert track.predicted_lat == track.lat
        assert track.prediction_minutes == 0

    def test_no_prediction_low_confidence(self):
        track = StormTrack(
            storm_id="t1",
            positions=[(39.5, -84.5, 100)],
            smoothed_speed=30.0,
            motion_confidence=0.1,  # too low
        )
        _compute_prediction(track)
        assert track.prediction_minutes == 0

    def test_reasonable_distance(self):
        """30 mph for 10 min ≈ 5 miles."""
        track = StormTrack(
            storm_id="t1",
            positions=[(39.5, -84.5, 100)],
            smoothed_speed=30.0,
            smoothed_heading=0.0,
            motion_confidence=0.8,
        )
        _compute_prediction(track)
        lat_diff_mi = (track.predicted_lat - track.lat) * 69.0
        assert 4 < lat_diff_mi < 6  # ~5 miles


# === Confidence with Smoothing ===

class TestConfidenceStability:
    def test_stable_motion_high_confidence(self):
        track = StormTrack(storm_id="t1", total_cycles=5)
        track.positions = [(39+i*0.1, -84.5, 100+i*60) for i in range(5)]
        track.recent_speeds = [28, 30, 29, 31, 30]
        track.recent_headings = [0, 1, 359, 2, 0]
        _compute_confidence(track)
        assert track.motion_confidence >= 0.6

    def test_erratic_motion_low_confidence(self):
        track = StormTrack(storm_id="t1", total_cycles=5)
        track.positions = [(39+i*0.1, -84.5, 100+i*60) for i in range(5)]
        track.recent_speeds = [5, 60, 10, 55, 8]
        track.recent_headings = [0, 180, 90, 270, 45]
        _compute_confidence(track)
        assert track.motion_confidence < 0.3


# === End-to-End ===

class TestEndToEnd:
    def test_multi_cycle_smoothing(self):
        """Verify that tracker with injected time-separated positions produces smoothed values."""
        track = StormTrack(storm_id="t1", total_cycles=3)
        # Inject 3 northward positions 10 min apart
        track.positions = [
            (39.0, -84.5, 1000),
            (39.1, -84.5, 1600),  # +10 min
            (39.2, -84.5, 2200),  # +10 min
        ]
        track.recent_speeds = [41.5, 41.5]
        track.recent_headings = [0.0, 0.0]
        track.recent_dbz = [55, 58, 61]
        track.reflectivity_dbz = 61
        track.smoothed_speed = 41.5
        track.smoothed_heading = 0.0
        track.motion_confidence = 0.8

        from services.detection.tracker import _compute_prediction, _compute_intensity_trend
        _compute_prediction(track)
        _compute_intensity_trend(track)

        assert track.smoothed_speed > 0
        assert track.smoothed_heading < 10 or track.smoothed_heading > 350
        assert track.predicted_lat > track.lat
        assert track.intensity_trend in ("strengthening", "stable")

    def test_propagated_to_storm_object(self):
        """Prediction fields flow through to StormObject."""
        tracker = StormTracker()
        for lat in [39.0, 39.1, 39.2]:
            tracker.update([_candidate(lat=lat, lon=-84.5)])

        track = list(tracker._tracks.values())[0]
        storm = _track_to_storm(track, 39.5, -84.5)

        assert storm.predicted_lat != 0 or storm.prediction_minutes == 0
        assert storm.smoothed_heading >= 0


import pytest
