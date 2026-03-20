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
