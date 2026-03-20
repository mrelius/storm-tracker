import asyncio
import json
import logging
import re
import httpx
from datetime import datetime, timezone
from config import ALERT_PRIORITY, ALERT_PRIORITY_DEFAULT, ALERT_CATEGORIES
from db import get_connection
import cache

logger = logging.getLogger(__name__)

# Pending zone polygon fetches — collected during ingest, processed after
_pending_zone_fetches: list[tuple[str, list[str]]] = []

# FIPS code regex: UGC format like "OHC049" → state=OH, type=C (county), code=049
UGC_PATTERN = re.compile(r"([A-Z]{2})([CZ])(\d{3})")

# Map state abbreviation to FIPS state code
STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06",
    "CO": "08", "CT": "09", "DE": "10", "FL": "12", "GA": "13",
    "HI": "15", "ID": "16", "IL": "17", "IN": "18", "IA": "19",
    "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24",
    "MA": "25", "MI": "26", "MN": "27", "MS": "28", "MO": "29",
    "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34",
    "NM": "35", "NY": "36", "NC": "37", "ND": "38", "OH": "39",
    "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45",
    "SD": "46", "TN": "47", "TX": "48", "UT": "49", "VT": "50",
    "VA": "51", "WA": "53", "WV": "54", "WI": "55", "WY": "56",
    "DC": "11",
}


def classify_alert(event: str) -> str:
    """Classify an alert event into primary/secondary/informational."""
    for cat, events in ALERT_CATEGORIES.items():
        if event in events:
            return cat
    return "informational"


def compute_priority(event: str) -> int:
    """Compute priority score for an alert event."""
    return ALERT_PRIORITY.get(event, ALERT_PRIORITY_DEFAULT)


def extract_county_fips(geocode: dict | None) -> list[str]:
    """Extract 5-digit county FIPS codes from NWS geocode block.

    Priority order:
    1. SAME codes (6-digit with leading 0) — present on ALL modern NWS alerts
    2. FIPS6 codes (legacy, rarely populated now)
    3. UGC county codes (SSC### format where type=C)
    """
    if not geocode:
        return []

    fips_codes = set()

    # SAME codes (primary — always present in modern NWS API)
    for code in geocode.get("SAME", []):
        if len(code) == 6 and code[0] == "0":
            fips_codes.add(code[1:])  # strip leading 0
        elif len(code) == 5:
            fips_codes.add(code)

    # FIPS6 codes (legacy fallback)
    if not fips_codes:
        for code in geocode.get("FIPS6", []):
            if len(code) == 6 and code.startswith("0"):
                fips_codes.add(code[1:])
            elif len(code) == 5:
                fips_codes.add(code)

    # UGC county codes as final fallback
    if not fips_codes:
        for ugc in geocode.get("UGC", []):
            match = UGC_PATTERN.match(ugc)
            if match:
                state_abbr, zone_type, code = match.groups()
                if zone_type == "C" and state_abbr in STATE_FIPS:
                    fips = STATE_FIPS[state_abbr] + code
                    fips_codes.add(fips)

    return sorted(fips_codes)


def extract_polygon(geometry: dict | None) -> str | None:
    """Extract GeoJSON polygon string from NWS alert geometry."""
    if not geometry:
        return None
    return json.dumps(geometry)


async def store_alert(alert_feature: dict) -> bool:
    """Store a single NWS alert feature in the database.

    Returns True if alert was inserted/updated, False if skipped.
    """
    props = alert_feature.get("properties", {})
    alert_id = props.get("id")
    if not alert_id:
        return False

    event = props.get("event", "Unknown")
    expires = props.get("expires")
    if not expires:
        return False

    # Skip already-expired alerts
    try:
        exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if exp_dt < datetime.now(timezone.utc):
            return False
    except (ValueError, TypeError):
        pass

    category = classify_alert(event)
    priority = compute_priority(event)
    polygon = extract_polygon(alert_feature.get("geometry"))
    geocode = props.get("geocode", {})
    county_fips = extract_county_fips(geocode)
    now = datetime.now(timezone.utc).isoformat()

    # Ensure onset is never null (NWS test messages can omit it)
    onset = props.get("onset") or props.get("sent") or now

    db = await get_connection()
    try:
        await db.execute(
            """INSERT INTO alerts (id, event, severity, urgency, certainty, category,
               headline, description, instruction, polygon, onset, expires, issued,
               sender, priority_score, ingested_at, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
               severity=excluded.severity, urgency=excluded.urgency,
               certainty=excluded.certainty, headline=excluded.headline,
               description=excluded.description, instruction=excluded.instruction,
               polygon=excluded.polygon, expires=excluded.expires,
               priority_score=excluded.priority_score, raw_json=excluded.raw_json""",
            (
                alert_id,
                event,
                props.get("severity", "Unknown"),
                props.get("urgency", "Unknown"),
                props.get("certainty", "Unknown"),
                category,
                props.get("headline"),
                props.get("description"),
                props.get("instruction"),
                polygon,
                onset,
                expires,
                props.get("sent", now),
                props.get("senderName"),
                priority,
                now,
                json.dumps(alert_feature),
            ),
        )

        # Link counties (delete old links first for upsert)
        await db.execute("DELETE FROM alert_counties WHERE alert_id = ?", (alert_id,))
        linked_count = 0
        for fips in county_fips:
            # Only link if county exists in our counties table
            row = await db.execute("SELECT fips FROM counties WHERE fips = ?", (fips,))
            if await row.fetchone():
                await db.execute(
                    "INSERT OR IGNORE INTO alert_counties (alert_id, county_fips) VALUES (?, ?)",
                    (alert_id, fips),
                )
                linked_count += 1

        await db.commit()

        # Track zone-based alerts for deferred polygon fetch
        if not polygon and linked_count == 0:
            affected_zones = props.get("affectedZones", [])
            if affected_zones:
                _pending_zone_fetches.append((alert_id, affected_zones))

        return True
    except Exception as e:
        logger.error(f"Failed to store alert {alert_id}: {e}")
        await db.rollback()
        return False
    finally:
        await db.close()


async def process_pending_zone_fetches():
    """Process all pending zone polygon fetches collected during ingest.

    Called AFTER the ingest loop completes. Runs with concurrency limit
    to avoid thundering herd on SQLite and NWS API.
    """
    global _pending_zone_fetches
    if not _pending_zone_fetches:
        return 0

    pending = _pending_zone_fetches[:]
    _pending_zone_fetches = []

    sem = asyncio.Semaphore(3)  # max 3 concurrent zone fetches
    fetched = 0

    async def fetch_one(alert_id, zone_urls):
        nonlocal fetched
        async with sem:
            result = await _fetch_zone_polygon(alert_id, zone_urls)
            if result:
                fetched += 1

    tasks = [fetch_one(aid, zurls) for aid, zurls in pending]
    await asyncio.gather(*tasks, return_exceptions=True)

    logger.info(f"Zone polygons: {fetched}/{len(pending)} fetched")
    return fetched


async def _fetch_zone_polygon(alert_id: str, zone_urls: list[str]) -> bool:
    """Fetch zone geometry from NWS API and store as alert polygon.

    Fetches first zone URL only. 2s timeout. No retry.
    Caches zone geometry in Redis (1hr TTL) to avoid re-fetching.
    Returns True if polygon was stored.
    """
    if not zone_urls:
        return False

    url = zone_urls[0]
    zone_id = url.rstrip("/").split("/")[-1]
    cache_key = f"zone:{zone_id}"

    # Check cache first
    cached_geom = cache.get(cache_key)
    if cached_geom is not None:
        await _store_polygon(alert_id, cached_geom)
        return True

    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(url, headers={
                "User-Agent": "StormTracker/1.0 (storm.mrelius.com contact@mrelius.com)",
                "Accept": "application/geo+json",
            })
            if resp.status_code != 200:
                return False

            data = resp.json()
            geometry = data.get("geometry")
            if not geometry:
                return False

            geom_str = json.dumps(geometry)
            cache.set(cache_key, geom_str, ttl=3600)
            await _store_polygon(alert_id, geom_str)
            return True

    except Exception as e:
        logger.info(f"Zone fetch failed for {zone_id}: {e}")
        return False


async def _store_polygon(alert_id: str, geom_str: str):
    """Update an alert's polygon in the database."""
    db = await get_connection()
    try:
        await db.execute("UPDATE alerts SET polygon = ? WHERE id = ? AND polygon IS NULL",
                         (geom_str, alert_id))
        await db.commit()
    except Exception as e:
        logger.debug(f"Failed to store zone polygon for {alert_id}: {e}")
    finally:
        await db.close()


async def purge_expired():
    """Remove alerts past their expiration time."""
    now = datetime.now(timezone.utc).isoformat()
    db = await get_connection()
    try:
        cursor = await db.execute("DELETE FROM alerts WHERE expires < ?", (now,))
        count = cursor.rowcount
        await db.commit()
        if count:
            logger.info(f"Purged {count} expired alerts")
        return count
    finally:
        await db.close()
