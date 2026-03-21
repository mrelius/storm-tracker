"""Impact prediction — CPA, footprint, area-aware classification, severity projection.

Determines whether a storm's projected path will impact, pass near, or miss
the client's location, accounting for storm width (radius).

CPA formula:
  t_cpa = -dot(S-C, V) / dot(V, V)

Area-aware classification:
  DIRECT_HIT: CPA ≤ storm_radius
  NEAR_MISS:  CPA ≤ storm_radius + GLANCE_MARGIN
  PASSING:    CPA > storm_radius + GLANCE_MARGIN
"""
import math
from services.detection.geometry import haversine_mi

# Glance margin beyond storm radius for near-miss (miles)
GLANCE_MARGIN_MI = 5.0

# Max storm radius cap
MAX_RADIUS_MI = 15.0

# Prediction horizon (minutes) — extended for impact analysis
MAX_PREDICTION_MIN = 90.0

# Minimum confidence to produce non-UNCERTAIN classification
MIN_IMPACT_CONFIDENCE = 0.3

# Approximate degrees per mile (for vector math)
DEG_PER_MI_LAT = 1.0 / 69.0


def compute_radius(reflectivity_dbz: float | None, has_debris: bool = False) -> float:
    """Estimate storm radius in miles from reflectivity.

    Documented model:
      ≥65 dBZ: 10 mi base
      55-64:   7 mi base
      45-54:   4 mi base
      <45:     2 mi base
      Debris:  +3/+3/+2/+1 mi bonus
      Cap:     15 mi
    """
    dbz = reflectivity_dbz or 0

    if dbz >= 65:
        base = 10.0
        debris_bonus = 3.0
    elif dbz >= 55:
        base = 7.0
        debris_bonus = 3.0
    elif dbz >= 45:
        base = 4.0
        debris_bonus = 2.0
    else:
        base = 2.0
        debris_bonus = 1.0

    radius = base + (debris_bonus if has_debris else 0)
    return min(radius, MAX_RADIUS_MI)


def project_severity(
    reflectivity_dbz: float | None,
    intensity_trend: str = "unknown",
    time_to_cpa_min: float | None = None,
) -> tuple[str, int]:
    """Project storm severity at time of closest approach.

    Returns (severity_label, severity_score 0-100).

    Model:
      Current dBZ determines baseline.
      Intensity trend shifts projection up/down.
      Longer time to CPA = more uncertainty.
    """
    dbz = reflectivity_dbz or 0

    # Baseline from current intensity
    if dbz >= 65:
        label, score = "severe", 90
    elif dbz >= 55:
        label, score = "strong", 70
    elif dbz >= 45:
        label, score = "moderate", 50
    else:
        label, score = "weak", 25

    # Trend adjustment
    if intensity_trend == "strengthening":
        score = min(100, score + 15)
        if label == "strong":
            label = "severe"
    elif intensity_trend == "weakening":
        score = max(0, score - 15)
        if label == "severe":
            label = "strong"
        elif label == "strong":
            label = "moderate"

    # Time uncertainty — slight reduction for distant impacts
    if time_to_cpa_min and time_to_cpa_min > 30:
        score = max(0, score - 5)

    return (label, score)


def compute_impact(
    storm_lat: float, storm_lon: float,
    heading_deg: float, speed_mph: float,
    client_lat: float, client_lon: float,
    motion_confidence: float,
    storm_radius_mi: float = 5.0,
    reflectivity_dbz: float | None = None,
    intensity_trend: str = "unknown",
) -> dict:
    """Compute closest point of approach between storm trajectory and client.

    Returns:
        {
            "cpa_distance_mi": float,       # closest approach distance
            "time_to_cpa_min": float | None, # time to closest approach
            "impact": str,                   # direct_hit, near_miss, passing, uncertain
            "impact_description": str,       # human-readable
        }
    """
    # Default: uncertain
    result = {
        "cpa_distance_mi": None,
        "time_to_cpa_min": None,
        "impact": "uncertain",
        "impact_description": "Trajectory uncertain",
        "storm_radius_mi": storm_radius_mi,
        "projected_severity_label": "unknown",
        "projected_severity_score": 0,
        "impact_severity_label": "unknown",
        "impact_severity_score": 0,
    }

    # Gate: need sufficient confidence and speed
    if motion_confidence < MIN_IMPACT_CONFIDENCE:
        return result
    if speed_mph < 2.0:
        result["impact"] = "uncertain"
        result["impact_description"] = "Storm nearly stationary"
        return result

    # Convert heading + speed to velocity in degrees/hour
    heading_rad = math.radians(heading_deg)
    cos_lat = math.cos(math.radians(storm_lat)) if storm_lat != 0 else 1
    cos_lat = max(cos_lat, 0.01)

    # Velocity in degrees per hour
    speed_deg_lat = speed_mph * DEG_PER_MI_LAT * math.cos(heading_rad)
    speed_deg_lon = speed_mph * DEG_PER_MI_LAT * math.sin(heading_rad) / cos_lat

    # Vector from storm to client (in degrees)
    dx = client_lon - storm_lon
    dy = client_lat - storm_lat

    # Velocity vector
    vx = speed_deg_lon
    vy = speed_deg_lat

    # dot(V, V) — velocity magnitude squared
    v_dot_v = vx * vx + vy * vy
    if v_dot_v < 1e-12:
        return result

    # dot(S-C, V) — but S-C = (-dx, -dy) since we want storm-to-client
    sc_dot_v = (-dx) * vx + (-dy) * vy

    # t_cpa in hours (negative = already passed, positive = future)
    t_cpa_hours = -sc_dot_v / v_dot_v

    # Clamp to future + horizon
    if t_cpa_hours < 0:
        t_cpa_hours = 0  # already at or past closest approach
    max_hours = MAX_PREDICTION_MIN / 60.0
    if t_cpa_hours > max_hours:
        # CPA is beyond our prediction horizon — evaluate at horizon
        t_cpa_hours = max_hours

    # CPA position
    cpa_lat = storm_lat + vy * t_cpa_hours
    cpa_lon = storm_lon + vx * t_cpa_hours

    # CPA distance
    cpa_dist = haversine_mi(client_lat, client_lon, cpa_lat, cpa_lon)
    t_cpa_min = round(t_cpa_hours * 60, 1)

    result["cpa_distance_mi"] = round(cpa_dist, 1)
    result["time_to_cpa_min"] = t_cpa_min
    result["storm_radius_mi"] = storm_radius_mi

    # Project severity at impact time
    sev_label, sev_score = project_severity(reflectivity_dbz, intensity_trend, t_cpa_min)
    result["projected_severity_label"] = sev_label
    result["projected_severity_score"] = sev_score

    # Area-aware classification using storm radius
    if cpa_dist <= storm_radius_mi:
        result["impact"] = "direct_hit"
        if t_cpa_min > 0:
            result["impact_description"] = f"{sev_label.capitalize()} storm on track to impact your area in ~{int(t_cpa_min)} min"
        else:
            result["impact_description"] = f"{sev_label.capitalize()} storm at your location"
    elif cpa_dist <= storm_radius_mi + GLANCE_MARGIN_MI:
        result["impact"] = "near_miss"
        cardinal = _offset_direction(client_lat, client_lon, cpa_lat, cpa_lon)
        result["impact_description"] = f"{sev_label.capitalize()} storm will pass ~{int(cpa_dist)} mi {cardinal} of you"
    else:
        result["impact"] = "passing"
        result["impact_description"] = "Likely to miss your area"

    # Impact severity score: combines classification + projected severity
    impact_weight = {"direct_hit": 1.0, "near_miss": 0.6, "passing": 0.2}.get(result["impact"], 0.3)
    result["impact_severity_score"] = round(sev_score * impact_weight)
    if result["impact_severity_score"] >= 70:
        result["impact_severity_label"] = "critical"
    elif result["impact_severity_score"] >= 45:
        result["impact_severity_label"] = "high"
    elif result["impact_severity_score"] >= 25:
        result["impact_severity_label"] = "moderate"
    else:
        result["impact_severity_label"] = "low"

    return result


def _offset_direction(ref_lat: float, ref_lon: float, point_lat: float, point_lon: float) -> str:
    """Get cardinal direction of point relative to reference (e.g., 'north', 'southeast')."""
    dlat = point_lat - ref_lat
    dlon = point_lon - ref_lon
    angle = math.degrees(math.atan2(dlon, dlat)) % 360

    directions = ["north", "northeast", "east", "southeast",
                  "south", "southwest", "west", "northwest"]
    idx = round(angle / 45) % 8
    return directions[idx]
