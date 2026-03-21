"""ETA (Estimated Time of Arrival) helper.

Simple distance/speed calculation. Structured so smoothing
or acceleration-based estimates can be added later.
"""
from services.detection.models import StormObject, Trend


def compute_eta(storm: StormObject) -> float | None:
    """Compute ETA in minutes for a storm to reach the user.

    Returns None if:
    - storm is not closing
    - speed is zero or negligible
    - distance is zero (already arrived)

    Basic formula: ETA = distance / speed * 60
    """
    if storm.trend != Trend.closing:
        return None

    if storm.speed_mph < 1.0:
        return None

    if storm.distance_mi <= 0:
        return 0.0

    eta_hours = storm.distance_mi / storm.speed_mph
    eta_minutes = round(eta_hours * 60, 1)

    return eta_minutes
