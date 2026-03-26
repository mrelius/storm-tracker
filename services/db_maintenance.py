"""
Storm Tracker — Database Maintenance

Scheduled maintenance tasks:
- Hard purge: delete alerts older than 48 hours (regardless of expires)
- raw_json cleanup: NULL out raw_json on alerts older than 24 hours
- VACUUM: reclaim space (every 6 hours, after checkpoint)
- DB size monitoring: warn if > 150 MB

All operations are safe for WAL mode. VACUUM checkpoints WAL automatically.
"""

import asyncio
import os
import time
import logging
from datetime import datetime, timezone, timedelta

try:
    from logging_config import get_logger
    logger = get_logger("db_maintenance")
except ImportError:
    logger = logging.getLogger("db_maintenance")

from db import get_connection, get_db_path

# ── Configuration ────────────────────────────────────────────────
PURGE_INTERVAL_SEC = 3600          # run purge every 1 hour
VACUUM_INTERVAL_SEC = 21600        # run vacuum every 6 hours
RAW_JSON_TTL_HOURS = 24            # null out raw_json after 24 hours
HARD_PURGE_HOURS = 48              # delete alerts older than 48 hours
DB_SIZE_WARN_MB = 150              # warn if DB exceeds this size

# ── State ────────────────────────────────────────────────────────
_running = False
_last_purge = 0
_last_vacuum = 0
_stats = {
    "purge_runs": 0,
    "purge_rows_deleted": 0,
    "raw_json_trimmed": 0,
    "vacuum_runs": 0,
    "last_db_size_mb": 0,
}


def get_maintenance_stats() -> dict:
    return dict(_stats)


# ── Purge: delete old alerts ─────────────────────────────────────

async def purge_old_alerts() -> int:
    """Delete alerts older than HARD_PURGE_HOURS. Returns rows deleted."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=HARD_PURGE_HOURS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    db = await get_connection()
    try:
        # Delete from alert_counties first (CASCADE should handle it but be explicit)
        await db.execute(
            "DELETE FROM alert_counties WHERE alert_id IN "
            "(SELECT id FROM alerts WHERE issued < ?)",
            (cutoff,),
        )
        cursor = await db.execute(
            "DELETE FROM alerts WHERE issued < ?",
            (cutoff,),
        )
        deleted = cursor.rowcount
        await db.commit()

        _stats["purge_runs"] += 1
        _stats["purge_rows_deleted"] += deleted

        if deleted > 0:
            logger.info("db_purge_executed",
                        rows_deleted=deleted,
                        cutoff=cutoff,
                        total_purged=_stats["purge_rows_deleted"])
        return deleted
    except Exception as e:
        logger.error(f"Purge failed: {e}")
        return 0
    finally:
        await db.close()


# ── raw_json cleanup ─────────────────────────────────────────────

async def trim_raw_json() -> int:
    """NULL out raw_json on alerts older than RAW_JSON_TTL_HOURS.
    Keeps metadata but drops the heavy JSON blob."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=RAW_JSON_TTL_HOURS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    db = await get_connection()
    try:
        cursor = await db.execute(
            "UPDATE alerts SET raw_json = NULL WHERE issued < ? AND raw_json IS NOT NULL",
            (cutoff,),
        )
        trimmed = cursor.rowcount
        await db.commit()

        _stats["raw_json_trimmed"] += trimmed

        if trimmed > 0:
            logger.info("raw_json_trimmed",
                        rows_updated=trimmed,
                        cutoff=cutoff,
                        total_trimmed=_stats["raw_json_trimmed"])
        return trimmed
    except Exception as e:
        logger.error(f"raw_json trim failed: {e}")
        return 0
    finally:
        await db.close()


# ── VACUUM ───────────────────────────────────────────────────────

async def vacuum_db():
    """Run WAL checkpoint + VACUUM to reclaim space.

    Gracefully handles contention — if DB is busy with active statements,
    skip this cycle and retry at next maintenance window.
    """
    db_path = get_db_path()

    # Get size before
    try:
        size_before = os.path.getsize(db_path) / (1024 * 1024)
    except OSError:
        size_before = 0

    db = await get_connection()
    try:
        # Checkpoint WAL first
        await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        # VACUUM reclaims free pages
        await db.execute("VACUUM")
        await db.commit()

        # Get size after
        try:
            size_after = os.path.getsize(db_path) / (1024 * 1024)
        except OSError:
            size_after = 0

        _stats["vacuum_runs"] += 1
        _stats["last_db_size_mb"] = round(size_after, 1)

        saved = size_before - size_after
        logger.info("db_vacuum_completed",
                     size_before_mb=round(size_before, 1),
                     size_after_mb=round(size_after, 1),
                     saved_mb=round(saved, 1))
    except Exception as e:
        err_str = str(e).lower()
        if "sql statements in progress" in err_str or "database is locked" in err_str:
            logger.info("db_maintenance_skipped_busy",
                        reason="active_statements",
                        will_retry_sec=VACUUM_INTERVAL_SEC)
        else:
            logger.error(f"VACUUM failed: {e}")
    finally:
        await db.close()


# ── DB size check ────────────────────────────────────────────────

def check_db_size() -> float:
    """Check DB file size and warn if over threshold. Returns size in MB."""
    db_path = get_db_path()
    try:
        size_mb = os.path.getsize(db_path) / (1024 * 1024)
    except OSError:
        return 0

    _stats["last_db_size_mb"] = round(size_mb, 1)

    if size_mb > DB_SIZE_WARN_MB:
        logger.warning("db_size_warning",
                        size_mb=round(size_mb, 1),
                        threshold_mb=DB_SIZE_WARN_MB)
    return size_mb


# ── Background loop ──────────────────────────────────────────────

async def run_maintenance_loop():
    """Background maintenance loop. Runs purge every hour, vacuum every 6 hours."""
    global _running, _last_purge, _last_vacuum
    _running = True
    logger.info("DB maintenance loop starting "
                f"(purge every {PURGE_INTERVAL_SEC}s, vacuum every {VACUUM_INTERVAL_SEC}s)")

    # Initial delay — let the app start up first
    await asyncio.sleep(30)

    # Run initial maintenance
    await purge_old_alerts()
    await trim_raw_json()
    check_db_size()
    _last_purge = time.time()

    # Initial vacuum
    await vacuum_db()
    _last_vacuum = time.time()

    while _running:
        await asyncio.sleep(60)  # check every minute
        now = time.time()

        # Purge + trim every hour
        if now - _last_purge >= PURGE_INTERVAL_SEC:
            await purge_old_alerts()
            await trim_raw_json()
            check_db_size()
            _last_purge = now

        # Vacuum every 6 hours
        if now - _last_vacuum >= VACUUM_INTERVAL_SEC:
            await vacuum_db()
            _last_vacuum = now


def stop_maintenance():
    global _running
    _running = False
