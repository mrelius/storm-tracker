import math
import logging
from fastapi import APIRouter, Query
from models import AlertOut, AlertCountyMap, AlertSortField, SortOrder, AlertCategory
from db import get_connection
from datetime import datetime, timezone
import cache
from services.freshness import check as freshness_check, validate_timestamp

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

# Cache TTLs (seconds)
ALERTS_CACHE_TTL = 30
COUNTIES_CACHE_TTL = 30

MARINE_KEYWORDS = ["Marine", "Craft", "Gale", "Sea", "Surf", "Rip Current", "Coastal", "High Surf"]


def _bucket_coord(val: float | None) -> str:
    if val is None:
        return "_"
    return f"{round(val * 2) / 2:.1f}"


def _alerts_cache_key(sort: str, order: str, category: str | None, active: bool,
                      lat: float | None, lon: float | None, marine: bool) -> str:
    cat = category or "_"
    act = "1" if active else "0"
    mar = "1" if marine else "0"
    return f"alerts:{sort}:{order}:{cat}:{act}:{mar}:{_bucket_coord(lat)}:{_bucket_coord(lon)}"


def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in miles between two lat/lon points."""
    R = 3958.8  # Earth radius in miles
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@router.get("", response_model=list[AlertOut])
async def list_alerts(
    sort: AlertSortField = Query(AlertSortField.severity),
    order: SortOrder = Query(SortOrder.desc),
    category: AlertCategory | None = Query(None),
    active: bool = Query(True),
    marine: bool = Query(False),
    warnings_only: bool = Query(False),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
):
    """List alerts with sorting and filtering. Redis-cached with 30s TTL.
    marine=false (default) excludes marine advisories.
    warnings_only=true shows only Tornado Warning + Severe Thunderstorm Warning.
    """
    cache_key = _alerts_cache_key(sort.value, order.value, category.value if category else None,
                                  active, lat, lon, marine) + (":w" if warnings_only else "")

    # Try cache
    cached = cache.get(cache_key)
    if cached is not None:
        logger.debug(f"Cache HIT: {cache_key}")
        return [AlertOut(**a) for a in cached]

    logger.debug(f"Cache MISS: {cache_key}")

    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conditions = []
    params = []

    if active:
        conditions.append("a.expires > ?")
        params.append(now_utc)
    if category:
        conditions.append("a.category = ?")
        params.append(category.value)
    if not marine:
        marine_clauses = " AND ".join(f"a.event NOT LIKE '%{kw}%'" for kw in MARINE_KEYWORDS)
        conditions.append(f"({marine_clauses})")
    if warnings_only:
        conditions.append("(a.event = 'Tornado Warning' OR a.event = 'Severe Thunderstorm Warning')")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    db = await get_connection()
    try:
        rows = await db.execute(
            f"""SELECT a.*, GROUP_CONCAT(ac.county_fips) as fips_list
                FROM alerts a
                LEFT JOIN alert_counties ac ON a.id = ac.alert_id
                {where}
                GROUP BY a.id""",
            params,
        )
        alerts_raw = await rows.fetchall()

        alerts = []
        for row in alerts_raw:
            fips_str = row["fips_list"] or ""
            county_fips = [f for f in fips_str.split(",") if f]

            alert = AlertOut(
                id=row["id"],
                event=row["event"],
                severity=row["severity"],
                urgency=row["urgency"],
                certainty=row["certainty"],
                category=row["category"],
                headline=row["headline"],
                description=row["description"],
                instruction=row["instruction"],
                polygon=row["polygon"],
                onset=row["onset"],
                expires=row["expires"],
                issued=row["issued"],
                sender=row["sender"],
                priority_score=row["priority_score"],
                county_fips=county_fips,
            )

            if lat is not None and lon is not None and county_fips:
                c_row = await db.execute(
                    "SELECT centroid_lat, centroid_lon FROM counties WHERE fips = ?",
                    (county_fips[0],),
                )
                county = await c_row.fetchone()
                if county:
                    alert.distance_mi = round(
                        haversine_mi(lat, lon, county["centroid_lat"], county["centroid_lon"]), 1
                    )

            # HARD FAIL: freshness check on expires timestamp
            # Alerts past their expiration + max_age buffer are dropped
            expires_epoch = validate_timestamp(alert.expires)
            if expires_epoch:
                fr = freshness_check("nws_alerts", expires_epoch, entity_id=alert.id)
                if not fr["is_fresh"] and fr["action"] == "drop":
                    continue  # expired alert — hard fail, never reaches UI

            alerts.append(alert)

        # Sort
        reverse = order == SortOrder.desc
        if sort == AlertSortField.severity:
            alerts.sort(key=lambda a: a.priority_score, reverse=reverse)
        elif sort == AlertSortField.distance:
            alerts.sort(key=lambda a: a.distance_mi if a.distance_mi is not None else 99999,
                        reverse=reverse)
        elif sort == AlertSortField.issued:
            alerts.sort(key=lambda a: a.issued, reverse=reverse)
        elif sort == AlertSortField.expiration:
            alerts.sort(key=lambda a: a.expires, reverse=reverse)

        # Cache the result
        cache.set(cache_key, [a.model_dump() for a in alerts], ttl=ALERTS_CACHE_TTL)

        return alerts
    finally:
        await db.close()


@router.get("/counties", response_model=AlertCountyMap)
async def get_alert_county_map():
    """Return FIPS → highest-priority event mapping. Redis-cached with 30s TTL."""
    cache_key = "counties:alert_map"

    cached = cache.get(cache_key)
    if cached is not None:
        logger.debug(f"Cache HIT: {cache_key}")
        return AlertCountyMap(**cached)

    logger.debug(f"Cache MISS: {cache_key}")

    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    db = await get_connection()
    try:
        rows = await db.execute(
            """SELECT ac.county_fips, a.event, a.priority_score
               FROM alert_counties ac
               JOIN alerts a ON a.id = ac.alert_id
               WHERE a.expires > ?
               ORDER BY a.priority_score DESC""",
            (now_utc,),
        )
        results = await rows.fetchall()

        county_map = {}
        for row in results:
            fips = row["county_fips"]
            if fips not in county_map:
                county_map[fips] = row["event"]

        result = AlertCountyMap(counties=county_map)
        cache.set(cache_key, result.model_dump(), ttl=COUNTIES_CACHE_TTL)
        return result
    finally:
        await db.close()


@router.get("/{alert_id}", response_model=AlertOut)
async def get_alert_detail(alert_id: str):
    """Get full alert detail including linked counties. Not cached (infrequent)."""
    db = await get_connection()
    try:
        row = await db.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,))
        alert = await row.fetchone()
        if not alert:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Alert not found")

        fips_rows = await db.execute(
            "SELECT county_fips FROM alert_counties WHERE alert_id = ?", (alert_id,)
        )
        fips_list = [r["county_fips"] for r in await fips_rows.fetchall()]

        return AlertOut(
            id=alert["id"],
            event=alert["event"],
            severity=alert["severity"],
            urgency=alert["urgency"],
            certainty=alert["certainty"],
            category=alert["category"],
            headline=alert["headline"],
            description=alert["description"],
            instruction=alert["instruction"],
            polygon=alert["polygon"],
            onset=alert["onset"],
            expires=alert["expires"],
            issued=alert["issued"],
            sender=alert["sender"],
            priority_score=alert["priority_score"],
            county_fips=fips_list,
        )
    finally:
        await db.close()
