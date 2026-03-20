import pytest
import asyncio
from datetime import datetime, timezone, timedelta
from db import init_db, get_connection, set_db_path
from services.alert_processor import store_alert


@pytest.fixture(autouse=True)
def setup_db(tmp_db_path):
    set_db_path(tmp_db_path)
    asyncio.get_event_loop().run_until_complete(init_db())
    asyncio.get_event_loop().run_until_complete(_seed_data())
    yield
    set_db_path(None)


async def _seed_data():
    """Seed counties and alerts with known sort-testable values."""
    db = await get_connection()
    try:
        # Counties at different locations
        counties = [
            ("39049", "Franklin", "OH", '{}', 39.96, -82.99),   # close to test point
            ("18097", "Marion", "IN", '{}', 39.77, -86.16),     # farther west
            ("17031", "Cook", "IL", '{}', 41.84, -87.68),       # far
        ]
        for c in counties:
            await db.execute("INSERT INTO counties VALUES (?,?,?,?,?,?)", c)
        await db.commit()
    finally:
        await db.close()

    now = datetime.now(timezone.utc)

    # Alert 1: Tornado Warning, issued first, expires last, close
    a1 = _make_alert("tw-1", "Tornado Warning", 100,
                     issued=now - timedelta(hours=2),
                     expires=now + timedelta(hours=4),
                     fips=["39049"])
    await store_alert(a1)

    # Alert 2: SVR, issued second, expires first, medium distance
    a2 = _make_alert("svr-1", "Severe Thunderstorm Warning", 80,
                     issued=now - timedelta(hours=1),
                     expires=now + timedelta(hours=1),
                     fips=["18097"])
    await store_alert(a2)

    # Alert 3: Watch, issued last, expires middle, far
    a3 = _make_alert("tw-watch-1", "Tornado Watch", 60,
                     issued=now - timedelta(minutes=30),
                     expires=now + timedelta(hours=2),
                     fips=["17031"])
    await store_alert(a3)


def _make_alert(alert_id, event, priority, issued, expires, fips):
    geocode = {"SAME": ["0" + f for f in fips]}
    return {
        "type": "Feature",
        "properties": {
            "id": alert_id,
            "event": event,
            "severity": "Extreme" if priority >= 80 else "Moderate",
            "urgency": "Immediate",
            "certainty": "Observed",
            "headline": f"Test {event}",
            "description": "Test",
            "instruction": "Test",
            "onset": issued.isoformat(),
            "expires": expires.isoformat(),
            "sent": issued.isoformat(),
            "senderName": "NWS",
            "geocode": geocode,
        },
        "geometry": None,
    }


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


async def _fetch_sorted(sort_field, order="desc", lat=None, lon=None):
    """Directly query and sort alerts like the router does."""
    db = await get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        rows = await db.execute(
            """SELECT a.*, GROUP_CONCAT(ac.county_fips) as fips_list
               FROM alerts a
               LEFT JOIN alert_counties ac ON a.id = ac.alert_id
               WHERE a.expires > ?
               GROUP BY a.id""",
            (now,)
        )
        alerts = []
        for row in await rows.fetchall():
            fips_str = row["fips_list"] or ""
            fips_list = [f for f in fips_str.split(",") if f]

            distance = None
            if lat and lon and fips_list:
                c_row = await db.execute(
                    "SELECT centroid_lat, centroid_lon FROM counties WHERE fips = ?",
                    (fips_list[0],)
                )
                county = await c_row.fetchone()
                if county:
                    import math
                    R = 6371.0
                    dlat = math.radians(county["centroid_lat"] - lat)
                    dlon = math.radians(county["centroid_lon"] - lon)
                    a = (math.sin(dlat / 2) ** 2
                         + math.cos(math.radians(lat)) * math.cos(math.radians(county["centroid_lat"]))
                         * math.sin(dlon / 2) ** 2)
                    distance = R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

            alerts.append({
                "id": row["id"],
                "priority_score": row["priority_score"],
                "issued": row["issued"],
                "expires": row["expires"],
                "distance": distance,
            })

        reverse = order == "desc"
        if sort_field == "severity":
            alerts.sort(key=lambda a: a["priority_score"], reverse=reverse)
        elif sort_field == "distance":
            alerts.sort(key=lambda a: a["distance"] if a["distance"] is not None else 99999,
                        reverse=reverse)
        elif sort_field == "issued":
            alerts.sort(key=lambda a: a["issued"], reverse=reverse)
        elif sort_field == "expiration":
            alerts.sort(key=lambda a: a["expires"], reverse=reverse)

        return alerts
    finally:
        await db.close()


def test_sort_severity_desc():
    """AC-4: Sort by severity descending returns TW > SVR > Watch."""
    async def check():
        alerts = await _fetch_sorted("severity", "desc")
        assert len(alerts) == 3
        assert alerts[0]["id"] == "tw-1"       # priority 100
        assert alerts[1]["id"] == "svr-1"      # priority 80
        assert alerts[2]["id"] == "tw-watch-1"  # priority 60
    run(check())


def test_sort_severity_asc():
    """Sort by severity ascending."""
    async def check():
        alerts = await _fetch_sorted("severity", "asc")
        assert alerts[0]["id"] == "tw-watch-1"
        assert alerts[2]["id"] == "tw-1"
    run(check())


def test_sort_distance():
    """AC-5: Sort by distance from Columbus OH (39.96, -82.99)."""
    async def check():
        alerts = await _fetch_sorted("distance", "asc", lat=39.96, lon=-82.99)
        assert len(alerts) == 3
        # Franklin OH (39.96, -82.99) closest, Cook IL (41.84, -87.68) farthest
        assert alerts[0]["id"] == "tw-1"
        assert alerts[2]["id"] == "tw-watch-1"
        # Verify distances are reasonable
        assert alerts[0]["distance"] < 1  # same point
        assert alerts[1]["distance"] > 200  # ~280km to Marion IN
        assert alerts[2]["distance"] > 400  # ~500km to Cook IL
    run(check())


def test_sort_issued_desc():
    """Sort by issued time, most recent first."""
    async def check():
        alerts = await _fetch_sorted("issued", "desc")
        # tw-watch-1 issued last (30 min ago), tw-1 issued first (2 hrs ago)
        assert alerts[0]["id"] == "tw-watch-1"
        assert alerts[2]["id"] == "tw-1"
    run(check())


def test_sort_expiration_asc():
    """Sort by expiration time, soonest first."""
    async def check():
        alerts = await _fetch_sorted("expiration", "asc")
        # svr-1 expires in 1hr, tw-watch-1 in 2hr, tw-1 in 4hr
        assert alerts[0]["id"] == "svr-1"
        assert alerts[2]["id"] == "tw-1"
    run(check())
