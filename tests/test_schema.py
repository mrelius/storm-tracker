import pytest
import asyncio
import aiosqlite
from db import init_db, get_connection, set_db_path


@pytest.fixture(autouse=True)
def setup_db(tmp_db_path):
    set_db_path(tmp_db_path)
    asyncio.get_event_loop().run_until_complete(init_db())
    yield
    set_db_path(None)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_tables_created():
    """AC-1: All 3 tables exist with correct structure."""
    async def check():
        db = await get_connection()
        try:
            # Check tables exist
            rows = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
            tables = [r[0] for r in await rows.fetchall()]
            assert "alerts" in tables
            assert "counties" in tables
            assert "alert_counties" in tables
        finally:
            await db.close()
    run(check())


def test_counties_table_columns():
    """Counties table has all required columns."""
    async def check():
        db = await get_connection()
        try:
            rows = await db.execute("PRAGMA table_info(counties)")
            cols = {r[1] for r in await rows.fetchall()}
            assert cols == {"fips", "name", "state", "geometry", "centroid_lat", "centroid_lon"}
        finally:
            await db.close()
    run(check())


def test_alerts_table_columns():
    """Alerts table has all required columns."""
    async def check():
        db = await get_connection()
        try:
            rows = await db.execute("PRAGMA table_info(alerts)")
            cols = {r[1] for r in await rows.fetchall()}
            expected = {"id", "event", "severity", "urgency", "certainty", "category",
                        "headline", "description", "instruction", "polygon",
                        "onset", "expires", "issued", "sender", "priority_score",
                        "ingested_at", "raw_json"}
            assert cols == expected
        finally:
            await db.close()
    run(check())


def test_alert_counties_join_table():
    """Alert-counties join table has correct PK."""
    async def check():
        db = await get_connection()
        try:
            rows = await db.execute("PRAGMA table_info(alert_counties)")
            cols = {r[1] for r in await rows.fetchall()}
            assert cols == {"alert_id", "county_fips"}
        finally:
            await db.close()
    run(check())


def test_foreign_keys_enforced():
    """FK constraint prevents inserting alert_county with nonexistent alert."""
    async def check():
        db = await get_connection()
        try:
            # Insert a county first
            await db.execute(
                "INSERT INTO counties VALUES (?, ?, ?, ?, ?, ?)",
                ("39049", "Franklin", "OH", '{"type":"Polygon"}', 39.96, -82.99)
            )
            await db.commit()

            # Try to link nonexistent alert
            with pytest.raises(aiosqlite.IntegrityError):
                await db.execute(
                    "INSERT INTO alert_counties VALUES (?, ?)",
                    ("nonexistent", "39049")
                )
                await db.commit()
        finally:
            await db.close()
    run(check())


def test_cascade_delete():
    """Deleting an alert cascades to alert_counties."""
    async def check():
        db = await get_connection()
        try:
            # Insert county
            await db.execute(
                "INSERT INTO counties VALUES (?, ?, ?, ?, ?, ?)",
                ("39049", "Franklin", "OH", '{}', 39.96, -82.99)
            )
            # Insert alert
            await db.execute(
                """INSERT INTO alerts (id, event, severity, urgency, certainty, category,
                   onset, expires, issued, priority_score, ingested_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("alert-1", "Tornado Warning", "Extreme", "Immediate", "Observed",
                 "primary", "2026-01-01T00:00:00Z", "2099-01-01T00:00:00Z",
                 "2026-01-01T00:00:00Z", 100, "2026-01-01T00:00:00Z")
            )
            # Link
            await db.execute("INSERT INTO alert_counties VALUES (?, ?)", ("alert-1", "39049"))
            await db.commit()

            # Delete alert
            await db.execute("DELETE FROM alerts WHERE id = ?", ("alert-1",))
            await db.commit()

            # Verify cascade
            rows = await db.execute("SELECT * FROM alert_counties WHERE alert_id = ?", ("alert-1",))
            assert await rows.fetchone() is None
        finally:
            await db.close()
    run(check())


def test_indexes_exist():
    """All specified indexes are created."""
    async def check():
        db = await get_connection()
        try:
            rows = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
            )
            indexes = {r[0] for r in await rows.fetchall()}
            assert "idx_alerts_expires" in indexes
            assert "idx_alerts_event" in indexes
            assert "idx_alerts_priority" in indexes
            assert "idx_alert_counties_fips" in indexes
        finally:
            await db.close()
    run(check())


def test_wal_mode():
    """Database uses WAL journal mode."""
    async def check():
        db = await get_connection()
        try:
            row = await db.execute("PRAGMA journal_mode")
            mode = (await row.fetchone())[0]
            assert mode == "wal"
        finally:
            await db.close()
    run(check())
