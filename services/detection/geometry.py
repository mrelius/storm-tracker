"""Geometry helpers for storm detection adapter.

Centroid extraction from GeoJSON polygons, distance/bearing calculation
relative to a reference point.
"""
import json
import math


def extract_centroid(polygon_json: str | None) -> tuple[float, float] | None:
    """Extract approximate centroid from a GeoJSON polygon string.

    Handles Polygon and MultiPolygon geometry types.
    Returns (lat, lon) or None if parsing fails.
    """
    if not polygon_json:
        return None

    try:
        geom = json.loads(polygon_json) if isinstance(polygon_json, str) else polygon_json
    except (json.JSONDecodeError, TypeError):
        return None

    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None

    points = []
    if gtype == "Polygon":
        points = coords[0] if coords else []
    elif gtype == "MultiPolygon":
        for poly in coords:
            if poly:
                points.extend(poly[0])
    else:
        return None

    if not points:
        return None

    avg_lon = sum(p[0] for p in points) / len(points)
    avg_lat = sum(p[1] for p in points) / len(points)
    return (round(avg_lat, 6), round(avg_lon, 6))


def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in miles between two lat/lon points."""
    R_MI = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R_MI * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def compute_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Bearing in degrees from point 1 to point 2 (0=N, 90=E, 180=S, 270=W)."""
    dlon = math.radians(lon2 - lon1)
    lat1r = math.radians(lat1)
    lat2r = math.radians(lat2)

    x = math.sin(dlon) * math.cos(lat2r)
    y = (math.cos(lat1r) * math.sin(lat2r)
         - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon))
    bearing = math.degrees(math.atan2(x, y))
    return round(bearing % 360, 1)


def bearing_to_direction(bearing: float) -> str:
    """Convert bearing degrees to 8-point compass direction."""
    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    idx = round(bearing / 45) % 8
    return directions[idx]
