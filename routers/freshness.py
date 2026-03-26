"""
Storm Tracker — Freshness API Router

Exposes data freshness dashboard, per-source health, and stale event log.
"""

from fastapi import APIRouter, Query
from services.freshness import get_dashboard_data, get_feed_health, get_stale_log

router = APIRouter(prefix="/api/freshness", tags=["freshness"])


@router.get("")
async def freshness_dashboard():
    """Full freshness dashboard — all sources, health scores, recent drops."""
    return get_dashboard_data()


@router.get("/sources")
async def freshness_sources():
    """Per-source health status."""
    return get_feed_health()


@router.get("/source/{source_name}")
async def freshness_source(source_name: str):
    """Health status for a specific source."""
    return get_feed_health(source_name)


@router.get("/drops")
async def freshness_drops(limit: int = Query(default=50, le=100)):
    """Recent stale data drop events."""
    return get_stale_log(limit)
