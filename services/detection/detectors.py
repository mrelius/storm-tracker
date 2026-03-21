"""Storm detection rules.

Each detector is a pure function: StormObject → list[DetectionEvent].
Detectors do not manage state or cooldowns — that is handled by the pipeline.
"""
import time
from services.detection.models import (
    StormObject, DetectionEvent, DetectionType, Trend,
)
from services.detection.eta import compute_eta


def _common_fields(storm: StormObject) -> dict:
    """Extract common signal fields from StormObject for DetectionEvent."""
    return dict(
        storm_id=storm.id,
        distance_mi=storm.distance_mi,
        direction=storm.direction,
        bearing_deg=storm.bearing_deg,
        eta_min=compute_eta(storm),
        timestamp=time.time(),
        lat=storm.lat,
        lon=storm.lon,
        speed_mph=storm.speed_mph,
        heading_deg=storm.heading_deg,
        trend=storm.trend.value if hasattr(storm.trend, "value") else str(storm.trend),
        intensity_trend=getattr(storm, "intensity_trend", "unknown"),
        impact=getattr(storm, "impact", "uncertain"),
        impact_description=getattr(storm, "impact_description", ""),
        cpa_distance_mi=getattr(storm, "cpa_distance_mi", None),
        time_to_cpa_min=getattr(storm, "time_to_cpa_min", None),
        track_confidence=storm.track_confidence,
        motion_confidence=storm.motion_confidence,
        trend_confidence=storm.trend_confidence,
    )


MIN_TREND_CONFIDENCE = 0.15  # below this, suppress proximity detection


def detect_proximity(storm: StormObject) -> list[DetectionEvent]:
    """Trigger when storm is within 20 miles and closing with sufficient confidence.

    Severity 2 if < 10 miles, severity 1 if 10-20 miles.
    Suppressed when trend confidence is too low (noisy/new track).
    """
    if storm.distance_mi >= 20:
        return []
    if storm.trend != Trend.closing:
        return []
    if storm.trend_confidence < MIN_TREND_CONFIDENCE:
        return []

    severity = 2 if storm.distance_mi < 10 else 1

    # Confidence incorporates track quality + distance + speed
    dist_factor = max(0, 1.0 - storm.distance_mi / 20.0)
    speed_factor = min(1.0, storm.speed_mph / 50.0) if storm.speed_mph > 0 else 0.3
    base_conf = dist_factor * 0.5 + speed_factor * 0.2 + storm.trend_confidence * 0.3
    confidence = round(min(1.0, base_conf), 2)

    return [DetectionEvent(
        type=DetectionType.storm_proximity,
        severity=severity,
        confidence=confidence,
        detail=f"Storm {storm.distance_mi:.1f} mi {storm.direction}, closing at {storm.speed_mph:.0f} mph",
        **_common_fields(storm),
    )]


def detect_strong_storm(storm: StormObject) -> list[DetectionEvent]:
    """Trigger when reflectivity >= 55 dBZ.

    Severity 2. Higher confidence for stronger returns.
    """
    if storm.reflectivity_dbz is None:
        return []
    if storm.reflectivity_dbz < 55:
        return []

    # Confidence scales with intensity above threshold
    confidence = round(min(1.0, 0.6 + (storm.reflectivity_dbz - 55) * 0.04), 2)

    return [DetectionEvent(
        type=DetectionType.strong_storm,
        severity=2,
        confidence=confidence,
        detail=f"Strong storm: {storm.reflectivity_dbz:.0f} dBZ, {storm.distance_mi:.1f} mi {storm.direction}",
        **_common_fields(storm),
    )]


def detect_rotation(storm: StormObject) -> list[DetectionEvent]:
    """Trigger when velocity delta >= 35 kt.

    Severity 2 for 35-50 kt, severity 3 for >= 50 kt.
    """
    if storm.velocity_delta is None:
        return []
    if storm.velocity_delta < 35:
        return []

    severity = 3 if storm.velocity_delta >= 50 else 2

    confidence = round(min(1.0, 0.5 + (storm.velocity_delta - 35) * 0.025), 2)

    return [DetectionEvent(
        type=DetectionType.rotation,
        severity=severity,
        confidence=confidence,
        detail=f"Rotation detected: {storm.velocity_delta:.0f} kt shear, {storm.distance_mi:.1f} mi {storm.direction}",
        **_common_fields(storm),
    )]


def detect_debris_signature(storm: StormObject) -> list[DetectionEvent]:
    """Trigger when ALL conditions align: low CC + high reflectivity + rotation.

    This is the strongest indicator of a tornado with debris.
    Severity 4 (critical). Requires:
    - cc_min < 0.80
    - reflectivity_dbz > 45
    - velocity_delta > 35
    """
    if storm.cc_min is None or storm.reflectivity_dbz is None or storm.velocity_delta is None:
        return []

    if storm.cc_min >= 0.80:
        return []
    if storm.reflectivity_dbz <= 45:
        return []
    if storm.velocity_delta <= 35:
        return []

    cc_factor = max(0, 1.0 - storm.cc_min) * 1.5
    vel_factor = min(1.0, storm.velocity_delta / 60.0)
    confidence = round(min(1.0, cc_factor * 0.5 + vel_factor * 0.5), 2)

    return [DetectionEvent(
        type=DetectionType.debris_signature,
        severity=4,
        confidence=confidence,
        detail=(f"DEBRIS SIGNATURE: CC={storm.cc_min:.2f}, "
                f"{storm.velocity_delta:.0f} kt shear, "
                f"{storm.reflectivity_dbz:.0f} dBZ, "
                f"{storm.distance_mi:.1f} mi {storm.direction}"),
        **_common_fields(storm),
    )]


# Registry of all active detectors — pipeline iterates this list
ALL_DETECTORS = [
    detect_proximity,
    detect_strong_storm,
    detect_rotation,
    detect_debris_signature,
]
