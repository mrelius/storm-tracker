import pytest
import asyncio
import json
from datetime import datetime, timezone, timedelta
from db import init_db, get_connection, set_db_path
from services.alert_processor import (
    store_alert, purge_expired, classify_alert, compute_priority,
    extract_county_fips
)


@pytest.fixture(autouse=True)
def setup_db(tmp_db_path):
    set_db_path(tmp_db_path)
    asyncio.get_event_loop().run_until_complete(init_db())
    # Pre-load test counties
    asyncio.get_event_loop().run_until_complete(_seed_counties())
    yield
    set_db_path(None)


async def _seed_counties():
    db = await get_connection()
    try:
        counties = [
            ("39049", "Franklin", "OH", '{"type":"Polygon"}', 39.96, -82.99),
            ("39089", "Licking", "OH", '{"type":"Polygon"}', 40.09, -82.48),
            ("18097", "Marion", "IN", '{"type":"Polygon"}', 39.77, -86.16),
        ]
        for c in counties:
            await db.execute("INSERT OR IGNORE INTO counties VALUES (?,?,?,?,?,?)", c)
        await db.commit()
    finally:
        await db.close()


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _make_alert(alert_id="test-1", event="Tornado Warning", expires_hours=2,
                fips_codes=None, severity="Extreme", urgency="Immediate",
                certainty="Observed"):
    """Build a mock NWS alert feature."""
    now = datetime.now(timezone.utc)
    expires = (now + timedelta(hours=expires_hours)).isoformat()
    onset = now.isoformat()
    issued = now.isoformat()

    geocode = {}
    if fips_codes:
        geocode["SAME"] = ["0" + f for f in fips_codes]

    return {
        "type": "Feature",
        "properties": {
            "id": alert_id,
            "event": event,
            "severity": severity,
            "urgency": urgency,
            "certainty": certainty,
            "headline": f"Test {event}",
            "description": f"Test description for {event}",
            "instruction": "Take cover",
            "onset": onset,
            "expires": expires,
            "sent": issued,
            "senderName": "NWS Test",
            "geocode": geocode,
        },
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
    }


def test_classify_alert():
    assert classify_alert("Tornado Warning") == "primary"
    assert classify_alert("Severe Thunderstorm Warning") == "primary"
    assert classify_alert("Tornado Watch") == "primary"
    assert classify_alert("Flood Warning") == "secondary"
    assert classify_alert("Unknown Event") == "informational"


def test_compute_priority():
    assert compute_priority("Tornado Warning") == 100
    assert compute_priority("Severe Thunderstorm Warning") == 80
    assert compute_priority("Tornado Watch") == 60
    assert compute_priority("Random Event") == 10


def test_extract_fips_from_same():
    """SAME codes are the primary FIPS source in modern NWS API."""
    geocode = {"SAME": ["039049", "039089"]}
    fips = extract_county_fips(geocode)
    assert fips == ["39049", "39089"]


def test_extract_fips_from_fips6():
    """FIPS6 is legacy fallback when SAME is absent."""
    geocode = {"FIPS6": ["039049", "039089"]}
    fips = extract_county_fips(geocode)
    assert fips == ["39049", "39089"]


def test_extract_fips_from_ugc():
    """UGC county codes are final fallback."""
    geocode = {"UGC": ["OHC049", "OHC089"]}
    fips = extract_county_fips(geocode)
    assert fips == ["39049", "39089"]


def test_extract_fips_same_takes_priority():
    """SAME codes win over UGC when both present."""
    geocode = {"SAME": ["039049"], "UGC": ["OHC089"]}
    fips = extract_county_fips(geocode)
    assert fips == ["39049"]  # SAME only, UGC not used


def test_extract_fips_empty():
    assert extract_county_fips(None) == []
    assert extract_county_fips({}) == []


def test_store_alert():
    """AC-2: Alert is stored with FIPS linkage."""
    async def check():
        alert = _make_alert(fips_codes=["39049", "39089"])
        result = await store_alert(alert)
        assert result is True

        db = await get_connection()
        try:
            row = await db.execute("SELECT * FROM alerts WHERE id = ?", ("test-1",))
            stored = await row.fetchone()
            assert stored is not None
            assert stored["event"] == "Tornado Warning"
            assert stored["priority_score"] == 100
            assert stored["category"] == "primary"

            # Check county linkage
            rows = await db.execute(
                "SELECT county_fips FROM alert_counties WHERE alert_id = ? ORDER BY county_fips",
                ("test-1",)
            )
            fips = [r[0] for r in await rows.fetchall()]
            assert fips == ["39049", "39089"]
        finally:
            await db.close()
    run(check())


def test_store_alert_upsert():
    """Storing same alert twice updates it."""
    async def check():
        alert = _make_alert(fips_codes=["39049"])
        await store_alert(alert)

        # Update headline
        alert["properties"]["headline"] = "Updated headline"
        await store_alert(alert)

        db = await get_connection()
        try:
            row = await db.execute("SELECT headline FROM alerts WHERE id = ?", ("test-1",))
            stored = await row.fetchone()
            assert stored["headline"] == "Updated headline"
        finally:
            await db.close()
    run(check())


def test_expired_alert_not_stored():
    """AC-3 (partial): Expired alerts are rejected at ingest."""
    async def check():
        alert = _make_alert(alert_id="expired-1", expires_hours=-1)
        result = await store_alert(alert)
        assert result is False

        db = await get_connection()
        try:
            row = await db.execute("SELECT * FROM alerts WHERE id = ?", ("expired-1",))
            assert await row.fetchone() is None
        finally:
            await db.close()
    run(check())


def test_purge_expired():
    """AC-3: Purge removes expired alerts."""
    async def check():
        # Store a valid alert
        alert = _make_alert(alert_id="valid-1", expires_hours=2, fips_codes=["39049"])
        await store_alert(alert)

        # Manually insert an expired alert
        db = await get_connection()
        try:
            past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
            await db.execute(
                """INSERT INTO alerts (id, event, severity, urgency, certainty, category,
                   onset, expires, issued, priority_score, ingested_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("expired-manual", "Tornado Warning", "Extreme", "Immediate", "Observed",
                 "primary", past, past, past, 100, past)
            )
            await db.commit()
        finally:
            await db.close()

        count = await purge_expired()
        assert count == 1

        db = await get_connection()
        try:
            row = await db.execute("SELECT * FROM alerts WHERE id = ?", ("expired-manual",))
            assert await row.fetchone() is None
            row = await db.execute("SELECT * FROM alerts WHERE id = ?", ("valid-1",))
            assert await row.fetchone() is not None
        finally:
            await db.close()
    run(check())


def test_county_map_query():
    """AC-6: County map returns FIPS → highest priority event."""
    async def check():
        # Tornado Warning on Franklin County
        tw = _make_alert(alert_id="tw-1", event="Tornado Warning",
                         fips_codes=["39049"], expires_hours=2)
        await store_alert(tw)

        # Severe Thunderstorm on same county + Licking
        svr = _make_alert(alert_id="svr-1", event="Severe Thunderstorm Warning",
                          fips_codes=["39049", "39089"], expires_hours=2)
        await store_alert(svr)

        db = await get_connection()
        try:
            now = datetime.now(timezone.utc).isoformat()
            rows = await db.execute(
                """SELECT ac.county_fips, a.event, a.priority_score
                   FROM alert_counties ac
                   JOIN alerts a ON a.id = ac.alert_id
                   WHERE a.expires > ?
                   ORDER BY a.priority_score DESC""",
                (now,)
            )
            results = await rows.fetchall()
            county_map = {}
            for row in results:
                fips = row["county_fips"]
                if fips not in county_map:
                    county_map[fips] = row["event"]

            # Franklin should show Tornado Warning (higher priority)
            assert county_map["39049"] == "Tornado Warning"
            # Licking only has SVR
            assert county_map["39089"] == "Severe Thunderstorm Warning"
        finally:
            await db.close()
    run(check())
