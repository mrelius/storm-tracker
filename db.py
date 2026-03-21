import json
import aiosqlite
import logging
from pathlib import Path
from config import get_settings

logger = logging.getLogger(__name__)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS counties (
    fips TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    geometry TEXT NOT NULL,
    centroid_lat REAL NOT NULL,
    centroid_lon REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    severity TEXT NOT NULL,
    urgency TEXT NOT NULL,
    certainty TEXT NOT NULL,
    category TEXT NOT NULL,
    headline TEXT,
    description TEXT,
    instruction TEXT,
    polygon TEXT,
    onset TEXT NOT NULL,
    expires TEXT NOT NULL,
    issued TEXT NOT NULL,
    sender TEXT,
    priority_score INTEGER NOT NULL,
    ingested_at TEXT NOT NULL,
    raw_json TEXT
);

CREATE TABLE IF NOT EXISTS alert_counties (
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    county_fips TEXT NOT NULL REFERENCES counties(fips),
    PRIMARY KEY (alert_id, county_fips)
);

CREATE INDEX IF NOT EXISTS idx_alerts_expires ON alerts(expires);
CREATE INDEX IF NOT EXISTS idx_alerts_event ON alerts(event);
CREATE INDEX IF NOT EXISTS idx_alerts_priority ON alerts(priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_alert_counties_fips ON alert_counties(county_fips);

CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    message TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    page_context TEXT,
    user_agent TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
"""

_db_path: str | None = None


def set_db_path(path: str):
    """Override DB path (used by tests)."""
    global _db_path
    _db_path = path


def get_db_path() -> str:
    if _db_path:
        return _db_path
    return get_settings().sqlite_db_path


async def get_connection() -> aiosqlite.Connection:
    path = get_db_path()
    db = await aiosqlite.connect(path)
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    path = get_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = await get_connection()
    try:
        await db.executescript(SCHEMA_SQL)
        await db.commit()
        logger.info(f"Database initialized at {path}")
    finally:
        await db.close()


async def seed_counties(geojson_path: str = "data/counties_midwest.geojson"):
    """Load county boundaries from GeoJSON into the counties table."""
    path = Path(geojson_path)
    if not path.exists():
        logger.warning(f"County GeoJSON not found at {path}")
        return 0

    db = await get_connection()
    try:
        # Check if already seeded
        row = await db.execute("SELECT COUNT(*) FROM counties")
        count = (await row.fetchone())[0]
        if count > 0:
            logger.info(f"Counties already seeded ({count} rows)")
            return count

        with open(path) as f:
            data = json.load(f)

        inserted = 0
        for feature in data.get("features", []):
            fips = feature.get("id", "")
            props = feature.get("properties", {})
            geometry = feature.get("geometry")
            if not fips or not geometry:
                continue

            name = props.get("NAME", "Unknown")
            state = props.get("STATE", "??")

            # Compute centroid from geometry coordinates
            coords = geometry.get("coordinates", [])
            centroid_lat, centroid_lon = _compute_centroid(geometry["type"], coords)

            await db.execute(
                "INSERT OR IGNORE INTO counties (fips, name, state, geometry, centroid_lat, centroid_lon) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (fips, name, state, json.dumps(geometry), centroid_lat, centroid_lon),
            )
            inserted += 1

        await db.commit()
        logger.info(f"Seeded {inserted} counties from {path}")
        return inserted
    finally:
        await db.close()


def _compute_centroid(geom_type: str, coords: list) -> tuple[float, float]:
    """Compute approximate centroid from GeoJSON coordinates."""
    points = []
    if geom_type == "Polygon":
        points = coords[0] if coords else []
    elif geom_type == "MultiPolygon":
        for polygon in coords:
            if polygon:
                points.extend(polygon[0])
    else:
        return 0.0, 0.0

    if not points:
        return 0.0, 0.0

    avg_lon = sum(p[0] for p in points) / len(points)
    avg_lat = sum(p[1] for p in points) / len(points)
    return round(avg_lat, 6), round(avg_lon, 6)


async def close_db():
    pass  # aiosqlite connections are closed individually
