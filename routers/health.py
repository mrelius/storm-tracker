import time
import os
import resource
from fastapi import APIRouter
from models import HealthOut
from db import get_connection
import cache
from services.nws_ingest import get_last_poll

router = APIRouter(prefix="/api/health", tags=["health"])


@router.get("", response_model=HealthOut)
async def health_check():
    # Check DB
    db_status = "ok"
    alert_count = 0
    try:
        db = await get_connection()
        row = await db.execute("SELECT COUNT(*) as cnt FROM alerts")
        result = await row.fetchone()
        alert_count = result[0] if result else 0
        await db.close()
    except Exception as e:
        db_status = f"error: {e}"

    # Check cache
    cache_status = "ok" if cache.is_available() else "unavailable"

    # Last poll
    last_poll = get_last_poll()
    poll_str = last_poll.isoformat() if last_poll else None

    return HealthOut(
        status="ok",
        db=db_status,
        cache=cache_status,
        nws_last_poll=poll_str,
        alert_count=alert_count,
        cache_stats=cache.get_stats(),
    )


@router.get("/deep")
async def deep_health():
    """Extended health check covering all subsystems including prediction engine."""
    now = time.time()
    subsystems = {}

    # Core
    db_ok = True
    try:
        db = await get_connection()
        row = await db.execute("SELECT COUNT(*) FROM alerts")
        result = await row.fetchone()
        alert_count = result[0] if result else 0
        await db.close()
        subsystems["db"] = {"status": "ok", "alerts": alert_count}
    except Exception as e:
        db_ok = False
        subsystems["db"] = {"status": "error", "error": str(e)[:100]}

    redis_mem = cache.get_memory_info()
    cache_status = "ok"
    if not cache.is_available():
        cache_status = "unavailable"
    elif redis_mem.get("used_pct", 0) > 85:
        cache_status = "warning"
    subsystems["cache"] = {
        "status": cache_status,
        "stats": cache.get_stats(),
        "memory": redis_mem,
    }

    # NWS ingest
    last_poll = get_last_poll()
    nws_age = (now - last_poll.timestamp()) if last_poll else None
    from services.nws_ingest import get_expired_stats
    exp_stats = get_expired_stats()
    subsystems["nws_ingest"] = {
        "status": "ok" if last_poll and nws_age < 180 else "degraded" if last_poll else "unavailable",
        "last_poll": last_poll.isoformat() if last_poll else None,
        "age_sec": round(nws_age) if nws_age else None,
        "expired_rejected_last_cycle": exp_stats["expired_rejected_last_cycle"],
        "expired_rejected_total": exp_stats["expired_rejected_total"],
    }

    # Alert watchdog
    try:
        from services.alert_watchdog import get_status as get_wd_status
        subsystems["alert_watchdog"] = get_wd_status()
    except Exception as e:
        subsystems["alert_watchdog"] = {"status": "unavailable", "error": str(e)[:100]}

    # SPC ingest
    try:
        from services.prediction.spc_ingest import get_spc_data
        spc = get_spc_data()
        spc_age = now - spc["last_poll"] if spc["last_poll"] else None
        subsystems["spc_ingest"] = {
            "status": "ok" if spc_age and spc_age < 300 else "degraded" if spc["last_poll"] else "unavailable",
            "last_poll_age_sec": round(spc_age) if spc_age else None,
            "outlook_features": len(spc["outlook"]["features"]) if spc.get("outlook") else 0,
            "watches": len(spc.get("watches", [])),
            "mesoscale": len(spc.get("mesoscale", [])),
            "recent_errors": len(spc.get("errors", [])),
        }
    except Exception as e:
        subsystems["spc_ingest"] = {"status": "error", "error": str(e)[:100]}

    # Environment context
    try:
        from services.prediction.model_context import get_environment_context
        env = get_environment_context()
        if env:
            subsystems["environment"] = {
                "status": "ok" if env["data_age_sec"] < 600 else "stale",
                "category": env["category"],
                "stations": env["stations_used"],
                "age_sec": env["data_age_sec"],
            }
        else:
            subsystems["environment"] = {"status": "unavailable"}
    except Exception as e:
        subsystems["environment"] = {"status": "error", "error": str(e)[:100]}

    # Detection engine
    try:
        from services.detection.alert_service import get_snapshot
        snap = get_snapshot()
        if snap:
            subsystems["detection"] = {
                "status": "ok",
                "active_alerts": snap.get("count", 0),
                "cycle_status": snap.get("cycle_status", "unknown"),
            }
        else:
            subsystems["detection"] = {"status": "unavailable"}
    except Exception:
        subsystems["detection"] = {"status": "unavailable"}

    # DB maintenance
    try:
        from services.db_maintenance import get_maintenance_stats, check_db_size
        maint = get_maintenance_stats()
        db_size = check_db_size()
        subsystems["db_maintenance"] = {
            "status": "ok" if db_size < 150 else "warning",
            "db_size_mb": round(db_size, 1),
            "purge_runs": maint["purge_runs"],
            "purge_rows_deleted": maint["purge_rows_deleted"],
            "raw_json_trimmed": maint["raw_json_trimmed"],
            "vacuum_runs": maint["vacuum_runs"],
        }
    except Exception as e:
        subsystems["db_maintenance"] = {"status": "error", "error": str(e)[:100]}

    # Data freshness
    try:
        from services.freshness import get_dashboard_data
        fd = get_dashboard_data()
        subsystems["freshness"] = {
            "status": fd["overall_status"],
            "health_score": fd["overall_health"],
            "stale_sources": fd["stale_sources"],
            "recent_drops": len(fd["recent_drops"]),
        }
    except Exception as e:
        subsystems["freshness"] = {"status": "error", "error": str(e)[:100]}

    # Process metrics
    try:
        ru = resource.getrusage(resource.RUSAGE_SELF)
        rss_mb = ru.ru_maxrss / 1024  # Linux: KB → MB
        subsystems["process"] = {
            "rss_mb": round(rss_mb, 1),
            "user_cpu_sec": round(ru.ru_utime, 1),
            "sys_cpu_sec": round(ru.ru_stime, 1),
            "pid": os.getpid(),
        }
    except Exception:
        subsystems["process"] = {"status": "unavailable"}

    # Overall status
    statuses = [s.get("status", "ok") for s in subsystems.values()]
    if "error" in statuses:
        overall = "degraded"
    elif "unavailable" in statuses:
        overall = "degraded"
    elif "stale" in statuses:
        overall = "degraded"
    else:
        overall = "ok"

    return {
        "status": overall,
        "subsystems": subsystems,
        "timestamp": now,
    }
