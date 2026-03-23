"""
Storm Tracker — Multi-Horizon Path Projection

Projects storm position forward at 15/30/45/60 minute horizons
using smoothed speed and heading. Generates widening uncertainty
cones based on motion confidence and time horizon.

NOT an official forecast. Projections are app-generated estimates
based on current motion data.
"""

import math
from dataclasses import dataclass, field
from typing import Optional

# Approximate conversion: 1 degree latitude ≈ 69 miles
DEG_PER_MI_LAT = 1 / 69.0

# Projection horizons in minutes
HORIZONS = [15, 30, 45, 60]

# Uncertainty cone half-angle grows with time and inversely with confidence
# Base half-angle at 15 min with perfect confidence = 5 degrees
BASE_CONE_HALF_ANGLE_DEG = 5.0
# Additional degrees per 15 min beyond first horizon
CONE_GROWTH_PER_15MIN = 3.0
# Confidence scaling: low confidence multiplies cone width
CONFIDENCE_FLOOR = 0.2  # minimum confidence to produce projection


@dataclass
class ProjectedPoint:
    """A single projected position at a specific time horizon."""
    minutes: int
    lat: float
    lon: float
    cone_half_angle_deg: float  # uncertainty half-angle at this horizon
    cone_left_lat: float = 0.0
    cone_left_lon: float = 0.0
    cone_right_lat: float = 0.0
    cone_right_lon: float = 0.0
    confidence: float = 0.0


@dataclass
class PathProjection:
    """Complete multi-horizon projection for a storm."""
    storm_id: str
    storm_lat: float
    storm_lon: float
    speed_mph: float
    heading_deg: float
    motion_confidence: float
    generated_at: float = 0.0  # unix timestamp
    points: list[ProjectedPoint] = field(default_factory=list)
    suppressed: bool = False
    suppress_reason: str = ""
    explanation: str = ""


def project_path(
    storm_id: str,
    storm_lat: float,
    storm_lon: float,
    speed_mph: float,
    heading_deg: float,
    motion_confidence: float,
    generated_at: float,
) -> PathProjection:
    """Generate multi-horizon path projection with uncertainty cones.

    Args:
        storm_id: Unique storm identifier
        storm_lat/lon: Current storm centroid
        speed_mph: Smoothed speed in mph
        heading_deg: Smoothed heading (0=N, 90=E)
        motion_confidence: 0-1 motion quality metric
        generated_at: Unix timestamp when data was captured

    Returns:
        PathProjection with points at 15/30/45/60 min horizons.
        If data is insufficient, returns suppressed projection.
    """
    result = PathProjection(
        storm_id=storm_id,
        storm_lat=storm_lat,
        storm_lon=storm_lon,
        speed_mph=speed_mph,
        heading_deg=heading_deg,
        motion_confidence=motion_confidence,
        generated_at=generated_at,
    )

    # Gate: minimum confidence
    if motion_confidence < CONFIDENCE_FLOOR:
        result.suppressed = True
        result.suppress_reason = f"motion_confidence {motion_confidence:.2f} < {CONFIDENCE_FLOOR}"
        result.explanation = "Insufficient motion data to generate projection."
        return result

    # Gate: minimum speed
    if speed_mph < 2.0:
        result.suppressed = True
        result.suppress_reason = f"speed {speed_mph:.1f} mph < 2.0 mph (stationary)"
        result.explanation = "Storm appears stationary. No forward projection."
        return result

    heading_rad = math.radians(heading_deg)
    cos_lat = max(math.cos(math.radians(storm_lat)), 0.01)

    # Confidence inversely scales uncertainty
    # confidence=1.0 → 1.0x cone, confidence=0.3 → 2.3x cone
    confidence_scale = 1.0 + (1.0 - motion_confidence) * 2.0

    drivers = []
    if speed_mph >= 40:
        drivers.append(f"fast-moving ({speed_mph:.0f} mph)")
    elif speed_mph >= 20:
        drivers.append(f"moderate speed ({speed_mph:.0f} mph)")
    else:
        drivers.append(f"slow-moving ({speed_mph:.0f} mph)")

    if motion_confidence >= 0.7:
        drivers.append("high track confidence")
    elif motion_confidence >= 0.4:
        drivers.append("moderate track confidence")
    else:
        drivers.append("low track confidence — wider uncertainty")

    for minutes in HORIZONS:
        hours = minutes / 60.0
        distance_mi = speed_mph * hours

        # Forward projection
        lat_offset = distance_mi * math.cos(heading_rad) * DEG_PER_MI_LAT
        lon_offset = distance_mi * math.sin(heading_rad) * DEG_PER_MI_LAT / cos_lat

        proj_lat = storm_lat + lat_offset
        proj_lon = storm_lon + lon_offset

        # Uncertainty cone half-angle
        horizon_factor = (minutes / 15.0)  # 1.0 at 15min, 4.0 at 60min
        cone_half_deg = (BASE_CONE_HALF_ANGLE_DEG + CONE_GROWTH_PER_15MIN * (horizon_factor - 1)) * confidence_scale

        # Confidence decays with time horizon
        time_decay = max(0.1, 1.0 - (minutes / 120.0))  # halves at 60min
        point_confidence = motion_confidence * time_decay

        # Compute cone edges (left and right)
        left_heading_rad = heading_rad - math.radians(cone_half_deg)
        right_heading_rad = heading_rad + math.radians(cone_half_deg)

        left_lat = storm_lat + distance_mi * math.cos(left_heading_rad) * DEG_PER_MI_LAT
        left_lon = storm_lon + distance_mi * math.sin(left_heading_rad) * DEG_PER_MI_LAT / cos_lat
        right_lat = storm_lat + distance_mi * math.cos(right_heading_rad) * DEG_PER_MI_LAT
        right_lon = storm_lon + distance_mi * math.sin(right_heading_rad) * DEG_PER_MI_LAT / cos_lat

        point = ProjectedPoint(
            minutes=minutes,
            lat=round(proj_lat, 6),
            lon=round(proj_lon, 6),
            cone_half_angle_deg=round(cone_half_deg, 1),
            cone_left_lat=round(left_lat, 6),
            cone_left_lon=round(left_lon, 6),
            cone_right_lat=round(right_lat, 6),
            cone_right_lon=round(right_lon, 6),
            confidence=round(point_confidence, 3),
        )
        result.points.append(point)

    result.explanation = (
        f"Projected path based on current motion: {', '.join(drivers)}. "
        f"Uncertainty widens with time. This is an app estimate, not an official NWS forecast."
    )

    return result
