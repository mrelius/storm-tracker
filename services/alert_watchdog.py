"""
Storm Tracker — Alert Update Watchdog

Continuously monitors the alert pipeline for freshness and integrity.
Tracks fetch/parse/write/cache timestamps, detects partial breakage,
and surfaces stale/degraded/failed conditions.

Does NOT change alert logic. Read-only monitoring.

Thresholds (for 60s ingest interval):
  OK:       all stages within 120s
  STALE:    no good update for >180s
  DEGRADED: partial pipeline lagging or repeated single-stage failure
  FAILED:   no end-to-end success for >300s OR 5+ consecutive failures
"""

import time
import hashlib
import json
import logging
from typing import Optional

try:
    from logging_config import get_logger
    logger = get_logger("watchdog")
except ImportError:
    logger = logging.getLogger("watchdog")

# ── Thresholds ───────────────────────────────────────────────────
# Based on 60s ingest interval — allow 2 missed cycles before concern
OK_THRESHOLD_SEC = 120         # 2 cycles
STALE_THRESHOLD_SEC = 180      # 3 cycles
FAILED_THRESHOLD_SEC = 300     # 5 cycles
MAX_CONSECUTIVE_FAILURES = 5
SUMMARY_LOG_INTERVAL_SEC = 600  # log summary every 10 min while non-ok

# ── State ────────────────────────────────────────────────────────
_state = {
    "last_fetch_started_at": 0,
    "last_fetch_succeeded_at": 0,
    "last_parse_succeeded_at": 0,
    "last_alert_write_at": 0,
    "last_cache_update_at": 0,
    "last_good_update_at": 0,       # last full pipeline success
    "newest_upstream_alert_ts": 0,   # newest alert timestamp from NWS
    "active_alert_count": 0,
    "alert_set_hash": "",
    "hash_changed_at": 0,
    "consecutive_fetch_failures": 0,
    "consecutive_parse_failures": 0,
    "consecutive_write_failures": 0,
    "status": "ok",
    "reason": "init",
    "last_status_change_at": 0,
    "last_summary_log_at": 0,
}


# ── Recording functions (called by ingest pipeline) ──────────────

def record_fetch_start():
    _state["last_fetch_started_at"] = time.time()


def record_fetch_success(alert_count: int = 0, newest_ts: float = 0):
    now = time.time()
    _state["last_fetch_succeeded_at"] = now
    _state["consecutive_fetch_failures"] = 0
    if newest_ts:
        _state["newest_upstream_alert_ts"] = newest_ts


def record_fetch_failure():
    _state["consecutive_fetch_failures"] += 1


def record_parse_success():
    _state["last_parse_succeeded_at"] = time.time()
    _state["consecutive_parse_failures"] = 0


def record_parse_failure():
    _state["consecutive_parse_failures"] += 1


def record_write_success(alert_count: int = 0, alert_ids: list = None):
    now = time.time()
    _state["last_alert_write_at"] = now
    _state["consecutive_write_failures"] = 0
    _state["active_alert_count"] = alert_count

    # Hash the active alert set for change detection
    if alert_ids:
        h = hashlib.md5(",".join(sorted(alert_ids)).encode()).hexdigest()[:12]
        if h != _state["alert_set_hash"]:
            _state["alert_set_hash"] = h
            _state["hash_changed_at"] = now
    elif not _state["hash_changed_at"]:
        _state["hash_changed_at"] = now


def record_write_failure():
    _state["consecutive_write_failures"] += 1


def record_cache_update():
    _state["last_cache_update_at"] = time.time()


def record_pipeline_success():
    """Called when full fetch→parse→write→cache cycle completes."""
    _state["last_good_update_at"] = time.time()
    _evaluate()


def tick():
    """Called periodically (e.g. after each ingest cycle) to re-evaluate status."""
    _evaluate()


# ── Status computation ───────────────────────────────────────────

def _evaluate():
    now = time.time()
    prev_status = _state["status"]

    good_age = now - _state["last_good_update_at"] if _state["last_good_update_at"] else now
    fetch_age = now - _state["last_fetch_succeeded_at"] if _state["last_fetch_succeeded_at"] else now
    write_age = now - _state["last_alert_write_at"] if _state["last_alert_write_at"] else now
    cache_age = now - _state["last_cache_update_at"] if _state["last_cache_update_at"] else now

    total_failures = (
        _state["consecutive_fetch_failures"] +
        _state["consecutive_parse_failures"] +
        _state["consecutive_write_failures"]
    )

    # Determine status
    if good_age > FAILED_THRESHOLD_SEC or total_failures >= MAX_CONSECUTIVE_FAILURES:
        new_status = "failed"
        reason = []
        if good_age > FAILED_THRESHOLD_SEC:
            reason.append(f"no good update for {int(good_age)}s")
        if total_failures >= MAX_CONSECUTIVE_FAILURES:
            reason.append(f"{total_failures} consecutive failures")
        reason_str = "; ".join(reason)

    elif good_age > STALE_THRESHOLD_SEC:
        new_status = "stale"
        reason_str = f"no good update for {int(good_age)}s (threshold {STALE_THRESHOLD_SEC}s)"

    elif (fetch_age > OK_THRESHOLD_SEC and write_age <= OK_THRESHOLD_SEC):
        new_status = "degraded"
        reason_str = f"fetch stale ({int(fetch_age)}s) but writes recent"

    elif (fetch_age <= OK_THRESHOLD_SEC and write_age > OK_THRESHOLD_SEC):
        new_status = "degraded"
        reason_str = f"fetch ok but writes stale ({int(write_age)}s)"

    elif _state["consecutive_fetch_failures"] >= 2 or _state["consecutive_write_failures"] >= 2:
        new_status = "degraded"
        reason_str = f"repeated failures (fetch={_state['consecutive_fetch_failures']}, write={_state['consecutive_write_failures']})"

    elif good_age <= OK_THRESHOLD_SEC:
        new_status = "ok"
        reason_str = f"pipeline healthy ({int(good_age)}s since last good update)"

    else:
        new_status = "stale"
        reason_str = f"pipeline age {int(good_age)}s exceeds {OK_THRESHOLD_SEC}s"

    _state["status"] = new_status
    _state["reason"] = reason_str

    # Log on state transition
    if new_status != prev_status:
        _state["last_status_change_at"] = now
        log_event = f"alert_watchdog_{new_status}"
        logger.info(log_event,
                     previous_status=prev_status,
                     new_status=new_status,
                     reason=reason_str,
                     pipeline_age_sec=int(good_age),
                     source_age_sec=int(fetch_age),
                     consecutive_failures=total_failures)

    # Periodic summary while non-ok (every 10 min)
    elif new_status != "ok" and (now - _state["last_summary_log_at"]) > SUMMARY_LOG_INTERVAL_SEC:
        _state["last_summary_log_at"] = now
        logger.info(f"alert_watchdog_{new_status}_summary",
                     status=new_status,
                     reason=reason_str,
                     pipeline_age_sec=int(good_age))


# ── Query functions ──────────────────────────────────────────────

def get_status() -> dict:
    """Return current watchdog state for health endpoint."""
    now = time.time()
    good_age = now - _state["last_good_update_at"] if _state["last_good_update_at"] else None
    source_age = now - _state["last_fetch_succeeded_at"] if _state["last_fetch_succeeded_at"] else None
    hash_age = now - _state["hash_changed_at"] if _state["hash_changed_at"] else None

    return {
        "status": _state["status"],
        "reason": _state["reason"],
        "last_good_update_at": _state["last_good_update_at"] or None,
        "pipeline_age_seconds": round(good_age, 1) if good_age is not None else None,
        "source_age_seconds": round(source_age, 1) if source_age is not None else None,
        "active_alert_count": _state["active_alert_count"],
        "consecutive_failures": (
            _state["consecutive_fetch_failures"] +
            _state["consecutive_parse_failures"] +
            _state["consecutive_write_failures"]
        ),
        "hash_age_seconds": round(hash_age, 1) if hash_age is not None else None,
        "alert_set_hash": _state["alert_set_hash"],
    }
