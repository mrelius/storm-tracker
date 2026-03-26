"""
Storm Tracker — Unified Storm State API

GET /api/storm/state — Returns the authoritative runtime state.
All frontend modules should consume this endpoint for alert data.
DB is persistence only; this endpoint reads from in-memory storm_state.

Lightweight serialization: strips raw_json, description, instruction
to keep payload under 50KB for typical alert loads.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

try:
    from logging_config import get_logger
    logger = get_logger("storm_api")
except ImportError:
    import logging
    logger = logging.getLogger("storm_api")

from services.storm_state import get_serializable_state, storm_state

router = APIRouter(prefix="/api/storm", tags=["storm"])


@router.get("/state")
async def get_storm_state():
    """Return authoritative storm state for frontend consumption.

    Returns:
        {
            "primary_id": str | null,
            "active_ids": list[str],
            "alerts": dict[str, dict],
            "timestamp": float,
            "polygon_count": int,
            "update_cycle_ms": float,
        }

    RULES:
    - Always reads from in-memory storm_state
    - NEVER queries the database
    - Strips heavy fields (raw_json, description, instruction)
    """
    state = get_serializable_state()

    logger.info(
        "state_served_api active=%d primary=%s",
        state["polygon_count"],
        state["primary_id"] or "none",
    )

    return JSONResponse(
        content=state,
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Storm-State-Version": "1",
        },
    )


@router.get("/primary")
async def get_primary_target():
    """Return just the primary target ID and basic info.

    Lightweight endpoint for modules that only need primary selection.
    """
    primary_id = storm_state["primary_id"]
    primary_alert = storm_state["alerts"].get(primary_id) if primary_id else None

    result = {
        "primary_id": primary_id,
        "event": primary_alert.get("event") if primary_alert else None,
        "polygon": primary_alert.get("polygon") if primary_alert else None,
        "active_count": len(storm_state["active_ids"]),
        "timestamp": storm_state["last_update_ts"],
    }

    return JSONResponse(content=result)
