"""
Storm Tracker — Refined ETA Engine

Computes closest-point-of-approach timing with trend-aware
adjustments. Accounts for closing/departing trends and
provides time windows rather than single-point estimates.

NOT an official forecast.
"""

import math
from dataclasses import dataclass
from typing import Optional

DEG_PER_MI_LAT = 1 / 69.0


@dataclass
class ETAResult:
    """Refined ETA with uncertainty window."""
    eta_minutes: Optional[float] = None
    eta_window_min: Optional[float] = None   # earliest possible arrival
    eta_window_max: Optional[float] = None   # latest possible arrival
    cpa_distance_mi: Optional[float] = None  # closest point of approach
    cpa_time_minutes: Optional[float] = None
    impact_type: str = "uncertain"  # direct_hit, near_miss, passing, uncertain
    confidence: float = 0.0
    explanation: str = ""
    suppressed: bool = False
    suppress_reason: str = ""


def compute_refined_eta(
    storm_lat: float,
    storm_lon: float,
    speed_mph: float,
    heading_deg: float,
    client_lat: float,
    client_lon: float,
    motion_confidence: float,
    trend: str = "unknown",
    storm_radius_mi: float = 5.0,
) -> ETAResult:
    """Compute refined ETA with uncertainty window.

    Uses vector projection to find closest point of approach,
    then adds confidence-based time window.
    """
    result = ETAResult()

    # Gate
    if motion_confidence < 0.2:
        result.suppressed = True
        result.suppress_reason = "motion_confidence too low"
        result.explanation = "Insufficient track data for ETA estimate."
        return result

    if speed_mph < 1.0:
        result.suppressed = True
        result.suppress_reason = "storm stationary"
        result.explanation = "Storm appears stationary."
        return result

    if trend == "departing":
        result.impact_type = "passing"
        result.explanation = "Storm is moving away."
        result.confidence = motion_confidence * 0.8
        return result

    # Vector math for CPA
    heading_rad = math.radians(heading_deg)
    cos_lat = max(math.cos(math.radians(storm_lat)), 0.01)

    # Storm velocity in degrees/hour
    vy = speed_mph * DEG_PER_MI_LAT * math.cos(heading_rad)
    vx = speed_mph * DEG_PER_MI_LAT * math.sin(heading_rad) / cos_lat

    # Vector from storm to client
    dx = client_lon - storm_lon
    dy = client_lat - storm_lat

    # Time to CPA (dot product method)
    v_dot_v = vx * vx + vy * vy
    if v_dot_v < 1e-10:
        result.suppressed = True
        result.suppress_reason = "zero velocity"
        return result

    t_cpa_hours = max(0, (dx * vx + dy * vy) / v_dot_v)
    t_cpa_hours = min(t_cpa_hours, 2.0)  # cap at 2 hours

    # CPA position
    cpa_lat = storm_lat + vy * t_cpa_hours
    cpa_lon = storm_lon + vx * t_cpa_hours

    # CPA distance
    cpa_dist = _haversine_mi(client_lat, client_lon, cpa_lat, cpa_lon)
    t_cpa_min = round(t_cpa_hours * 60, 1)

    result.cpa_distance_mi = round(cpa_dist, 1)
    result.cpa_time_minutes = t_cpa_min

    # Impact type
    if cpa_dist <= storm_radius_mi:
        result.impact_type = "direct_hit"
    elif cpa_dist <= storm_radius_mi + 5.0:
        result.impact_type = "near_miss"
    else:
        result.impact_type = "passing"

    # ETA: time until storm is within storm_radius of client
    # Approximate: if closing, eta ≈ (current_distance - storm_radius) / speed
    current_dist = _haversine_mi(client_lat, client_lon, storm_lat, storm_lon)
    if trend == "closing" and current_dist > storm_radius_mi:
        eta_hours = (current_dist - storm_radius_mi) / speed_mph
        result.eta_minutes = round(eta_hours * 60, 1)

        # Uncertainty window: ±20% at high confidence, ±50% at low
        uncertainty_pct = 0.2 + (1.0 - motion_confidence) * 0.3
        result.eta_window_min = round(result.eta_minutes * (1 - uncertainty_pct), 1)
        result.eta_window_max = round(result.eta_minutes * (1 + uncertainty_pct), 1)
    elif result.impact_type == "direct_hit":
        result.eta_minutes = t_cpa_min
        result.eta_window_min = round(t_cpa_min * 0.8, 1)
        result.eta_window_max = round(t_cpa_min * 1.3, 1)

    # Confidence
    time_decay = max(0.1, 1.0 - (t_cpa_min / 120.0))
    result.confidence = round(motion_confidence * time_decay, 3)

    # Explanation
    parts = []
    if result.eta_minutes is not None:
        parts.append(f"Estimated arrival in {result.eta_minutes:.0f} min")
        if result.eta_window_min and result.eta_window_max:
            parts.append(f"(window: {result.eta_window_min:.0f}–{result.eta_window_max:.0f} min)")
    if result.cpa_distance_mi is not None:
        parts.append(f"Closest approach: {result.cpa_distance_mi:.1f} mi at ~{t_cpa_min:.0f} min")
    parts.append(f"Impact: {result.impact_type}")
    result.explanation = ". ".join(parts) + ". App estimate, not official."

    return result


def _haversine_mi(lat1, lon1, lat2, lon2):
    R = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
