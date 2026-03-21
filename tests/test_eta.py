"""Tests for ETA helper."""
import time
from services.detection.eta import compute_eta
from services.detection.models import StormObject, Trend


def _storm(**kwargs):
    defaults = dict(
        id="c1", lat=39.5, lon=-84.5, distance_mi=15.0,
        bearing_deg=235, direction="NE", speed_mph=30,
        trend=Trend.closing, last_updated=time.time(),
        motion_confidence=0.8,
    )
    defaults.update(kwargs)
    return StormObject(**defaults)


def test_basic_eta():
    """15 miles at 30 mph = 30 minutes."""
    s = _storm(distance_mi=15.0, speed_mph=30.0)
    eta = compute_eta(s)
    assert eta == 30.0


def test_fast_storm():
    """10 miles at 60 mph = 10 minutes."""
    s = _storm(distance_mi=10.0, speed_mph=60.0)
    eta = compute_eta(s)
    assert eta == 10.0


def test_slow_storm():
    """20 miles at 10 mph = 120 minutes."""
    s = _storm(distance_mi=20.0, speed_mph=10.0)
    eta = compute_eta(s)
    assert eta == 120.0


def test_departing_returns_none():
    s = _storm(trend=Trend.departing)
    assert compute_eta(s) is None


def test_steady_returns_none():
    s = _storm(trend=Trend.steady)
    assert compute_eta(s) is None


def test_unknown_trend_returns_none():
    s = _storm(trend=Trend.unknown)
    assert compute_eta(s) is None


def test_zero_speed_returns_none():
    s = _storm(speed_mph=0.0)
    assert compute_eta(s) is None


def test_very_slow_returns_none():
    """Speed < 1 mph treated as stationary."""
    s = _storm(speed_mph=0.5)
    assert compute_eta(s) is None


def test_zero_distance_returns_zero():
    """Already at location."""
    s = _storm(distance_mi=0.0)
    eta = compute_eta(s)
    assert eta == 0.0


def test_fractional_eta():
    """12.4 miles at 38 mph."""
    s = _storm(distance_mi=12.4, speed_mph=38.0)
    eta = compute_eta(s)
    assert eta == 19.6  # 12.4/38*60 = 19.578... → 19.6
