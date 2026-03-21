"""Impact prediction — closest point of approach and trajectory classification.

Determines whether a storm's projected path will impact, pass near, or miss
the client's location. Uses vector math (no external libraries).

CPA formula:
  Storm at (sx, sy) with velocity (vx, vy). Client at (cx, cy).
  t_cpa = -dot(S-C, V) / dot(V, V)
  cpa_point = S + V * t_cpa
  cpa_distance = dist(cpa_point, C)
"""
import math
from services.detection.geometry import haversine_mi

# Classification thresholds (miles)
DIRECT_HIT_MI = 5.0
NEAR_MISS_MI = 15.0

# Prediction horizon (minutes) — extended for impact analysis
MAX_PREDICTION_MIN = 90.0

# Minimum confidence to produce non-UNCERTAIN classification
MIN_IMPACT_CONFIDENCE = 0.3

# Approximate degrees per mile (for vector math)
DEG_PER_MI_LAT = 1.0 / 69.0


def compute_impact(
    storm_lat: float, storm_lon: float,
    heading_deg: float, speed_mph: float,
    client_lat: float, client_lon: float,
    motion_confidence: float,
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

    # Classify
    if cpa_dist <= DIRECT_HIT_MI:
        result["impact"] = "direct_hit"
        if t_cpa_min > 0:
            result["impact_description"] = f"On track to reach you in ~{int(t_cpa_min)} min"
        else:
            result["impact_description"] = "Storm at your location"
    elif cpa_dist <= NEAR_MISS_MI:
        result["impact"] = "near_miss"
        cardinal = _offset_direction(client_lat, client_lon, cpa_lat, cpa_lon)
        result["impact_description"] = f"Passing ~{int(cpa_dist)} mi {cardinal} of you"
    else:
        result["impact"] = "passing"
        result["impact_description"] = "Likely to miss your area"

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
