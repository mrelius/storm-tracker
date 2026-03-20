"""NEXRAD radar site database and nearest-site lookup.

Contains Midwest/tornado-alley radar sites with coordinates.
Used by IEM provider to select which radar's tiles to serve.
"""
import math

# Midwest + Tornado Alley NEXRAD sites
# Format: (site_id, name, lat, lon)
NEXRAD_SITES = [
    ("ILN", "Wilmington OH", 39.4203, -83.8217),
    ("LOT", "Chicago IL", 41.6045, -88.0847),
    ("IND", "Indianapolis IN", 39.7075, -86.2803),
    ("IWX", "North Webster IN", 41.3586, -85.7),
    ("GRR", "Grand Rapids MI", 42.8939, -85.5447),
    ("DTX", "Detroit MI", 42.6997, -83.4717),
    ("MKX", "Milwaukee WI", 42.9678, -88.5506),
    ("DVN", "Davenport IA", 41.6117, -90.5811),
    ("ARX", "La Crosse WI", 43.8228, -91.1911),
    ("MPX", "Minneapolis MN", 44.8489, -93.5653),
    ("FSD", "Sioux Falls SD", 43.5878, -96.7292),
    ("OAX", "Omaha NE", 41.3203, -96.3667),
    ("ICT", "Wichita KS", 37.6544, -97.4431),
    ("SGF", "Springfield MO", 37.2353, -93.4006),
    ("LSX", "St Louis MO", 38.6986, -90.6828),
    ("PAH", "Paducah KY", 37.0683, -88.7719),
    ("JKL", "Jackson KY", 37.5908, -83.3131),
    ("RLX", "Charleston WV", 38.3111, -81.7228),
    ("CLE", "Cleveland OH", 41.4131, -81.86),
    ("PBZ", "Pittsburgh PA", 40.5317, -80.2181),
    ("ILX", "Lincoln IL", 40.1506, -89.3367),
    ("VWX", "Evansville IN", 38.2603, -87.7247),
    ("LVX", "Louisville KY", 37.9753, -85.9436),
    ("MRX", "Morristown TN", 36.1686, -83.4017),
    ("OHX", "Nashville TN", 36.2472, -86.5625),
    ("BMX", "Birmingham AL", 33.1722, -86.7697),
    ("NQA", "Memphis TN", 35.3447, -89.8733),
    ("LZK", "Little Rock AR", 34.8364, -92.2622),
    ("TSA", "Tulsa OK", 36.1317, -95.5764),
    ("INX", "Tulsa OK (2)", 36.175, -95.5642),
    ("TLX", "Oklahoma City OK", 35.3331, -97.2778),
    ("DDC", "Dodge City KS", 37.7608, -99.9686),
    ("GLD", "Goodland KS", 39.3667, -101.7003),
    ("UEX", "Hastings NE", 40.3208, -98.4417),
    ("ABR", "Aberdeen SD", 45.4558, -98.4131),
    ("BIS", "Bismarck ND", 46.7708, -100.7603),
    ("FGF", "Fargo ND", 47.5278, -97.3253),
    ("DLH", "Duluth MN", 46.8369, -92.2097),
    ("GRB", "Green Bay WI", 44.4986, -88.1111),
    ("EAX", "Kansas City MO", 38.8103, -94.2644),
    ("TWX", "Topeka KS", 38.9969, -96.2325),
    ("DMX", "Des Moines IA", 41.7311, -93.7228),
]


def find_nearest(lat: float, lon: float, count: int = 1) -> list[dict]:
    """Find the nearest NEXRAD radar site(s) to a given lat/lon.

    Returns list of dicts with: site_id, name, lat, lon, distance_km
    """
    results = []
    for site_id, name, slat, slon in NEXRAD_SITES:
        dist = _haversine(lat, lon, slat, slon)
        results.append({
            "site_id": site_id,
            "name": name,
            "lat": slat,
            "lon": slon,
            "distance_km": round(dist, 1),
        })
    results.sort(key=lambda r: r["distance_km"])
    return results[:count]


def get_site(site_id: str) -> dict | None:
    """Get a specific radar site by ID."""
    for sid, name, lat, lon in NEXRAD_SITES:
        if sid.upper() == site_id.upper():
            return {"site_id": sid, "name": name, "lat": lat, "lon": lon}
    return None


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
