"""
Storm Tracker — Prediction Timeline Capture

Stores periodic snapshots of prediction state for post-storm validation.
Captures prediction + actual storm position every 30-60 seconds during
active storms. Uses a lightweight SQLite table (separate from main DB).

Bounded: keeps max 24 hours of snapshots, auto-purges older entries.
Each snapshot is a JSON blob keyed by (storm_id, timestamp).

Timeline data is read-only for validation — never feeds back into
live prediction or alert logic.
"""

import time
import json
import logging
import sqlite3
import os
from typing import Optional
from pathlib import Path

logger = logging.getLogger(__name__)

DB_PATH = Path(os.environ.get("TIMELINE_DB", "./data/prediction_timeline.db"))
MAX_AGE_HOURS = 24
SNAPSHOT_INTERVAL_SEC = 45  # target interval between snapshots per storm
MAX_SNAPSHOTS = 5000        # hard cap on total rows

_db: Optional[sqlite3.Connection] = None
_last_snapshot: dict[str, float] = {}  # storm_id → last snapshot timestamp


def _get_db() -> sqlite3.Connection:
    """Get or create the timeline database connection."""
    global _db
    if _db is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _db.execute("PRAGMA journal_mode=WAL")
        _db.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                storm_id TEXT NOT NULL,
                ts REAL NOT NULL,
                prediction_json TEXT NOT NULL,
                actual_lat REAL,
                actual_lon REAL,
                actual_speed_mph REAL,
                actual_heading_deg REAL,
                nws_event TEXT,
                confidence_score REAL,
                enriched_score REAL,
                environment_category TEXT,
                lightning_state TEXT,
                spc_risk TEXT,
                eta_minutes REAL,
                severity_trend TEXT
            )
        """)
        _db.execute("CREATE INDEX IF NOT EXISTS idx_snap_storm_ts ON snapshots(storm_id, ts)")
        _db.commit()
    return _db


def capture_snapshot(
    storm_id: str,
    prediction: dict,
    actual_lat: float = None,
    actual_lon: float = None,
    actual_speed: float = None,
    actual_heading: float = None,
    nws_event: str = None,
):
    """Store a prediction snapshot if enough time has passed since last one.

    Called from the prediction API on each generation. Rate-limited per storm_id
    to avoid excessive writes.
    """
    now = time.time()

    # Rate limit per storm
    last = _last_snapshot.get(storm_id, 0)
    if now - last < SNAPSHOT_INTERVAL_SEC:
        return

    _last_snapshot[storm_id] = now

    # Extract key fields from prediction
    quality = prediction.get("quality", {})
    eta = prediction.get("eta", {})
    sev = prediction.get("severity_trend", {})
    env = prediction.get("environment_context", {})
    ltg = prediction.get("lightning_context", {})

    try:
        db = _get_db()
        db.execute("""
            INSERT INTO snapshots (
                storm_id, ts, prediction_json,
                actual_lat, actual_lon, actual_speed_mph, actual_heading_deg,
                nws_event, confidence_score, enriched_score,
                environment_category, lightning_state, spc_risk,
                eta_minutes, severity_trend
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            storm_id, now,
            json.dumps(prediction, default=str),
            actual_lat, actual_lon, actual_speed, actual_heading,
            nws_event,
            quality.get("confidence_score"),
            quality.get("enriched_score"),
            env.get("category") if isinstance(env, dict) else None,
            ltg.get("state") if isinstance(ltg, dict) else None,
            None,  # SPC risk filled separately if needed
            eta.get("eta_minutes"),
            sev.get("state") if isinstance(sev, dict) else None,
        ))
        db.commit()

        # Purge old entries
        _purge_old(db, now)
    except Exception as e:
        logger.warning(f"Timeline snapshot failed: {e}")


def _purge_old(db: sqlite3.Connection, now: float):
    """Remove snapshots older than MAX_AGE_HOURS and enforce row cap."""
    cutoff = now - MAX_AGE_HOURS * 3600
    db.execute("DELETE FROM snapshots WHERE ts < ?", (cutoff,))

    # Hard cap
    count = db.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
    if count > MAX_SNAPSHOTS:
        excess = count - MAX_SNAPSHOTS
        db.execute("""
            DELETE FROM snapshots WHERE id IN (
                SELECT id FROM snapshots ORDER BY ts ASC LIMIT ?
            )
        """, (excess,))
    db.commit()


def get_timeline(
    storm_id: Optional[str] = None,
    minutes: int = 60,
    limit: int = 500,
) -> list[dict]:
    """Retrieve timeline snapshots for validation.

    Args:
        storm_id: filter to specific storm (or all if None)
        minutes: time window
        limit: max rows
    """
    try:
        db = _get_db()
        cutoff = time.time() - minutes * 60

        if storm_id:
            rows = db.execute(
                "SELECT * FROM snapshots WHERE storm_id = ? AND ts > ? ORDER BY ts DESC LIMIT ?",
                (storm_id, cutoff, limit),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM snapshots WHERE ts > ? ORDER BY ts DESC LIMIT ?",
                (cutoff, limit),
            ).fetchall()

        # Get column names
        cols = [d[0] for d in db.execute("SELECT * FROM snapshots LIMIT 0").description]

        return [dict(zip(cols, row)) for row in rows]
    except Exception as e:
        logger.warning(f"Timeline query failed: {e}")
        return []


def get_storm_ids(minutes: int = 60) -> list[str]:
    """Get unique storm IDs in the timeline within the time window."""
    try:
        db = _get_db()
        cutoff = time.time() - minutes * 60
        rows = db.execute(
            "SELECT DISTINCT storm_id FROM snapshots WHERE ts > ? ORDER BY storm_id",
            (cutoff,),
        ).fetchall()
        return [r[0] for r in rows]
    except Exception:
        return []


def get_validation_report(storm_id: str, minutes: int = 120) -> dict:
    """Generate a validation report for a specific storm.

    Compares predicted positions with actual positions over time.
    """
    snapshots = get_timeline(storm_id=storm_id, minutes=minutes, limit=1000)
    if not snapshots:
        return {"storm_id": storm_id, "snapshots": 0, "report": "No timeline data"}

    # Reverse to chronological order
    snapshots.reverse()

    report = {
        "storm_id": storm_id,
        "snapshots": len(snapshots),
        "time_span_min": round((snapshots[-1]["ts"] - snapshots[0]["ts"]) / 60, 1) if len(snapshots) > 1 else 0,
        "first_seen": snapshots[0]["ts"],
        "last_seen": snapshots[-1]["ts"],
        "nws_event": snapshots[-1].get("nws_event"),

        # Confidence tracking
        "confidence_min": None,
        "confidence_max": None,
        "confidence_avg": None,
        "enriched_min": None,
        "enriched_max": None,

        # ETA tracking
        "eta_first": None,
        "eta_last": None,
        "eta_trend": [],  # list of (ts, eta_min) tuples

        # Severity trend tracking
        "severity_states": [],

        # Environment/lightning summary
        "env_categories": [],
        "ltg_states": [],

        # Position deltas (predicted vs actual) — for future accuracy calc
        "position_samples": 0,
    }

    confs = [s["confidence_score"] for s in snapshots if s.get("confidence_score") is not None]
    enriched = [s["enriched_score"] for s in snapshots if s.get("enriched_score") is not None]

    if confs:
        report["confidence_min"] = round(min(confs), 3)
        report["confidence_max"] = round(max(confs), 3)
        report["confidence_avg"] = round(sum(confs) / len(confs), 3)

    if enriched:
        report["enriched_min"] = round(min(enriched), 3)
        report["enriched_max"] = round(max(enriched), 3)

    # ETA trend
    for s in snapshots:
        if s.get("eta_minutes") is not None:
            report["eta_trend"].append({"ts": s["ts"], "eta": s["eta_minutes"]})
    if report["eta_trend"]:
        report["eta_first"] = report["eta_trend"][0]["eta"]
        report["eta_last"] = report["eta_trend"][-1]["eta"]

    # Severity states over time
    report["severity_states"] = list(dict.fromkeys(
        s["severity_trend"] for s in snapshots if s.get("severity_trend")
    ))

    # Env/lightning
    report["env_categories"] = list(dict.fromkeys(
        s["environment_category"] for s in snapshots if s.get("environment_category")
    ))
    report["ltg_states"] = list(dict.fromkeys(
        s["lightning_state"] for s in snapshots if s.get("lightning_state")
    ))

    # Position samples
    report["position_samples"] = sum(1 for s in snapshots if s.get("actual_lat") is not None)

    return report
