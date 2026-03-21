"""ETA (Estimated Time of Arrival) helper.

Simple distance/speed calculation with confidence gating.
ETA is only returned when motion confidence is sufficient.
"""
from services.detection.models import StormObject, Trend

MIN_MOTION_CONFIDENCE = 0.3  # below this, ETA is omitted


def compute_eta(storm: StormObject) -> float | None:
    """Compute ETA in minutes for a storm to reach the user.

    Returns None if:
    - storm is not closing
    - speed is zero or negligible
    - distance is zero (already arrived)
    - motion confidence is too low

    Basic formula: ETA = distance / speed * 60
    """
    if storm.trend != Trend.closing:
        return None

    if storm.speed_mph < 1.0:
        return None

    if storm.distance_mi <= 0:
        return 0.0

    # Confidence gate: suppress ETA when motion is unreliable
    if storm.motion_confidence < MIN_MOTION_CONFIDENCE:
        return None

    eta_hours = storm.distance_mi / storm.speed_mph
    eta_minutes = round(eta_hours * 60, 1)

    # Clamp unrealistic ETA (> 6 hours probably meaningless)
    if eta_minutes > 360:
        return None

    return eta_minutes
