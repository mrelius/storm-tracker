"""
Storm Tracker — SPC Data Parser & Risk Assessment

Parses SPC outlook/watch/MD data and computes:
- User location risk category (from Day 1 outlook)
- Watch status relative to user/storm (in_watch / near_watch / none)
- Nearby mesoscale discussion summary
- Regional risk level (none / monitor / elevated / high_concern)

Derived ONLY from SPC data — not from prediction engine.
"""

import math
import logging
from typing import Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ── Risk category ordering ───────────────────────────────────────
RISK_LEVELS = {
    "TSTM": 1,
    "MRGL": 2,
    "SLGT": 3,
    "ENH": 4,
    "MDT": 5,
    "HIGH": 6,
}

RISK_LABELS = {
    "TSTM": "General Thunderstorms",
    "MRGL": "Marginal Risk",
    "SLGT": "Slight Risk",
    "ENH": "Enhanced Risk",
    "MDT": "Moderate Risk",
    "HIGH": "High Risk",
}

RISK_COLORS = {
    "TSTM": "#55BB55",
    "MRGL": "#005500",
    "SLGT": "#DDAA00",
    "ENH": "#FF6600",
    "MDT": "#FF0000",
    "HIGH": "#FF00FF",
}

# Near-watch proximity threshold
NEAR_WATCH_MI = 50


@dataclass
class SPCAssessment:
    """Regional risk assessment from SPC data."""
    # Outlook
    risk_category: str = "none"       # TSTM, MRGL, SLGT, ENH, MDT, HIGH, or none
    risk_label: str = "No Risk"
    risk_color: str = "#475569"
    risk_level_num: int = 0

    # Watch status
    watch_status: str = "none"        # in_watch, near_watch, none
    active_watches: list = field(default_factory=list)

    # Mesoscale
    nearby_md: Optional[dict] = None
    md_count: int = 0

    # Regional risk level (composite)
    regional_level: str = "none"      # none, monitor, elevated, high_concern
    regional_drivers: list = field(default_factory=list)

    # Storm-to-context linking
    storm_in_outlook: Optional[str] = None    # risk category if storm is inside
    storm_in_watch: bool = False
    storm_near_md: bool = False

    # Context messages (plain language)
    context_messages: list = field(default_factory=list)

    # Data freshness
    outlook_age_sec: float = 0
    watches_age_sec: float = 0
    md_age_sec: float = 0
    data_available: bool = False


def assess_risk(
    spc_data: dict,
    user_lat: float,
    user_lon: float,
    now: float,
    storm_lat: Optional[float] = None,
    storm_lon: Optional[float] = None,
) -> SPCAssessment:
    """Compute regional risk assessment from SPC data and user location.

    Args:
        spc_data: from spc_ingest.get_spc_data()
        user_lat/lon: user GPS position
        now: current unix timestamp
        storm_lat/lon: optional tracked storm position for context linking
    """
    result = SPCAssessment()

    outlook = spc_data.get("outlook")
    watches = spc_data.get("watches", [])
    mesoscale = spc_data.get("mesoscale", [])

    # Data availability and freshness
    result.data_available = bool(outlook or watches)
    result.outlook_age_sec = now - spc_data.get("outlook_updated", 0) if spc_data.get("outlook_updated") else 0
    result.watches_age_sec = now - spc_data.get("watches_updated", 0) if spc_data.get("watches_updated") else 0
    result.md_age_sec = now - spc_data.get("mesoscale_updated", 0) if spc_data.get("mesoscale_updated") else 0

    messages = []

    # ── 1. Day 1 Outlook risk category ──
    if outlook and "features" in outlook:
        best_risk = _find_outlook_risk(outlook, user_lat, user_lon)
        if best_risk:
            result.risk_category = best_risk
            result.risk_label = RISK_LABELS.get(best_risk, best_risk)
            result.risk_color = RISK_COLORS.get(best_risk, "#475569")
            result.risk_level_num = RISK_LEVELS.get(best_risk, 0)
            messages.append(f"Your area is in the SPC {result.risk_label} area")

    # ── 2. Watch status ──
    if watches:
        in_watch, near_watches = _check_watches(watches, user_lat, user_lon)
        if in_watch:
            result.watch_status = "in_watch"
            result.active_watches = in_watch
            watch_types = list({w.get("event", "") for w in in_watch})
            messages.append(f"You are inside an active {' and '.join(watch_types)}")
        elif near_watches:
            result.watch_status = "near_watch"
            result.active_watches = near_watches
            messages.append("An active watch is nearby")

    # ── 3. Mesoscale discussions ──
    result.md_count = len(mesoscale)
    if mesoscale:
        nearest = _find_nearest_md(mesoscale, user_lat, user_lon)
        if nearest:
            result.nearby_md = nearest
            messages.append("Mesoscale discussion nearby — environment may be favorable for development")

    # ── 4. Storm-to-context linking ──
    if storm_lat is not None and storm_lon is not None:
        # Storm in outlook?
        if outlook and "features" in outlook:
            storm_risk = _find_outlook_risk(outlook, storm_lat, storm_lon)
            if storm_risk:
                result.storm_in_outlook = storm_risk
                storm_risk_label = RISK_LABELS.get(storm_risk, storm_risk)
                messages.append(f"Tracked storm is within SPC {storm_risk_label} area")

        # Storm in watch?
        if watches:
            storm_in, _ = _check_watches(watches, storm_lat, storm_lon)
            if storm_in:
                result.storm_in_watch = True
                watch_type = storm_in[0].get("event", "watch")
                messages.append(f"Tracked storm is within active {watch_type}")

        # Storm near MD?
        if mesoscale:
            storm_md = _find_nearest_md(mesoscale, storm_lat, storm_lon)
            if storm_md:
                result.storm_near_md = True
                messages.append("Tracked storm is near a mesoscale discussion area")

    result.context_messages = messages

    # ── 5. Regional risk level (deterministic composite) ──
    # Priority stacking: highest signal wins, ties go to leftmost rule
    drivers = []
    level = "none"

    # Tier 1: High concern
    if result.risk_level_num >= 5:  # MDT or HIGH
        level = "high_concern"
        drivers.append(f"SPC {result.risk_label}")
    elif result.watch_status == "in_watch":
        level = "high_concern"
        watch_types = list({w.get("event", "") for w in result.active_watches[:2]})
        drivers.append(f"Inside {', '.join(watch_types)}")

    # Tier 2: Elevated (only if not already high)
    if level == "none":
        if result.risk_level_num >= 4:  # ENH
            level = "elevated"
            drivers.append(f"SPC {result.risk_label}")
        elif result.watch_status == "near_watch":
            level = "elevated"
            drivers.append("Near active watch")
        elif result.storm_in_watch:
            level = "elevated"
            drivers.append("Tracked storm in watch area")

    # Tier 3: Monitor (only if not already elevated+)
    if level == "none":
        if result.risk_level_num >= 3:  # SLGT
            level = "monitor"
            drivers.append(f"SPC {result.risk_label}")
        elif result.risk_level_num >= 2:  # MRGL
            level = "monitor"
            drivers.append(f"SPC {result.risk_label}")
        elif result.nearby_md:
            level = "monitor"
            drivers.append("Nearby mesoscale discussion")
        elif result.storm_near_md:
            level = "monitor"
            drivers.append("Tracked storm near mesoscale discussion")
        elif result.risk_level_num >= 1:  # TSTM
            level = "monitor"
            drivers.append("General thunderstorm risk")

    # Additive drivers (secondary signals that don't change level but add context)
    if level != "none":
        if result.nearby_md and "mesoscale discussion" not in " ".join(drivers).lower():
            drivers.append(f"MD active")
        if result.storm_in_outlook and "Tracked storm" not in " ".join(drivers):
            drivers.append(f"Storm in {RISK_LABELS.get(result.storm_in_outlook, 'risk')} area")

    result.regional_level = level
    result.regional_drivers = drivers

    return result


def _find_outlook_risk(outlook: dict, lat: float, lon: float) -> Optional[str]:
    """Find the highest SPC risk category containing the user's location.

    Uses ray-casting point-in-polygon test on GeoJSON features.
    """
    best = None
    best_level = 0

    for feat in outlook.get("features", []):
        props = feat.get("properties", {})
        label = props.get("LABEL", "")
        level = RISK_LEVELS.get(label, 0)

        if level <= best_level:
            continue

        geo = feat.get("geometry", {})
        if _point_in_geometry(lat, lon, geo):
            best = label
            best_level = level

    return best


def _point_in_geometry(lat: float, lon: float, geometry: dict) -> bool:
    """Test if point is inside a GeoJSON geometry (Polygon or MultiPolygon)."""
    geo_type = geometry.get("type", "")
    coords = geometry.get("coordinates", [])

    if geo_type == "Polygon":
        return _point_in_polygon(lon, lat, coords[0]) if coords else False
    elif geo_type == "MultiPolygon":
        for poly in coords:
            if poly and _point_in_polygon(lon, lat, poly[0]):
                return True
    return False


def _point_in_polygon(x: float, y: float, polygon: list) -> bool:
    """Ray-casting point-in-polygon. Polygon is a list of [lon, lat] pairs."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _check_watches(watches: list, lat: float, lon: float) -> tuple:
    """Check if user is inside or near any active watches.

    Returns (in_watch_list, near_watch_list).
    """
    in_watch = []
    near_watch = []

    for watch in watches:
        geo = watch.get("geometry")
        if not geo:
            continue

        if _point_in_geometry(lat, lon, geo):
            in_watch.append(watch)
        else:
            # Check proximity by finding nearest polygon point
            min_dist = _min_distance_to_geometry(lat, lon, geo)
            if min_dist is not None and min_dist < NEAR_WATCH_MI:
                near_watch.append(watch)

    return in_watch, near_watch


def _min_distance_to_geometry(lat: float, lon: float, geometry: dict) -> Optional[float]:
    """Find minimum distance from point to any vertex in the geometry."""
    geo_type = geometry.get("type", "")
    coords = geometry.get("coordinates", [])
    min_d = None

    def check_ring(ring):
        nonlocal min_d
        for pt in ring:
            d = _haversine_mi(lat, lon, pt[1], pt[0])
            if min_d is None or d < min_d:
                min_d = d

    if geo_type == "Polygon" and coords:
        check_ring(coords[0])
    elif geo_type == "MultiPolygon":
        for poly in coords:
            if poly:
                check_ring(poly[0])

    return min_d


def _find_nearest_md(mds: list, lat: float, lon: float) -> Optional[dict]:
    """Find the nearest mesoscale discussion to the user."""
    nearest = None
    nearest_dist = None

    for md in mds:
        geo = md.get("geometry")
        if geo:
            if _point_in_geometry(lat, lon, geo):
                return md  # Inside MD area — return immediately
            dist = _min_distance_to_geometry(lat, lon, geo)
            if dist is not None and dist < 200:  # within 200mi
                if nearest_dist is None or dist < nearest_dist:
                    nearest = md
                    nearest_dist = dist

    return nearest


def _haversine_mi(lat1, lon1, lat2, lon2):
    R = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
