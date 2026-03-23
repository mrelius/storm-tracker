"""
Storm Tracker — SPC Data API Router

GET /api/spc/data       → Raw SPC data (outlook, watches, MDs)
GET /api/spc/risk       → Regional risk assessment for user location
GET /api/spc/outlook    → Day 1 outlook GeoJSON (for map overlay)
GET /api/spc/watches    → Active watch polygons (for map overlay)

SPC data is sourced from NOAA/NWS/SPC public feeds.
Presented for situational awareness, not as app-generated forecasts.
"""

import time
import logging
from typing import Optional
from fastapi import APIRouter, Query

from services.prediction.spc_ingest import get_spc_data
from services.prediction.spc_parser import assess_risk

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/spc", tags=["spc"])


@router.get("/data")
async def spc_data():
    """Return raw SPC data snapshot (outlook, watches, MDs)."""
    data = get_spc_data()
    return {
        "outlook_features": len(data["outlook"]["features"]) if data.get("outlook") else 0,
        "watches": len(data.get("watches", [])),
        "mesoscale": len(data.get("mesoscale", [])),
        "last_poll": data.get("last_poll", 0),
        "errors": data.get("errors", []),
    }


@router.get("/risk")
async def spc_risk(
    lat: float = Query(39.5, description="User latitude"),
    lon: float = Query(-84.5, description="User longitude"),
    storm_lat: Optional[float] = Query(None, description="Tracked storm latitude"),
    storm_lon: Optional[float] = Query(None, description="Tracked storm longitude"),
):
    """Compute regional risk assessment from SPC data, optionally linked to tracked storm."""
    spc_data = get_spc_data()
    now = time.time()
    assessment = assess_risk(spc_data, lat, lon, now,
                             storm_lat=storm_lat, storm_lon=storm_lon)

    return {
        "risk": {
            "category": assessment.risk_category,
            "label": assessment.risk_label,
            "color": assessment.risk_color,
            "level": assessment.risk_level_num,
        },
        "watch": {
            "status": assessment.watch_status,
            "count": len(assessment.active_watches),
            "watches": [
                {
                    "event": w.get("event", ""),
                    "headline": w.get("headline", "")[:100],
                    "expires": w.get("expires", ""),
                }
                for w in assessment.active_watches[:3]
            ],
        },
        "mesoscale": {
            "count": assessment.md_count,
            "nearby": {
                "headline": assessment.nearby_md.get("headline", ""),
                "description": assessment.nearby_md.get("description", "")[:200],
            } if assessment.nearby_md else None,
        },
        "storm_context": {
            "storm_in_outlook": assessment.storm_in_outlook,
            "storm_in_watch": assessment.storm_in_watch,
            "storm_near_md": assessment.storm_near_md,
        } if storm_lat is not None else None,
        "regional": {
            "level": assessment.regional_level,
            "drivers": assessment.regional_drivers,
        },
        "context_messages": assessment.context_messages,
        "data_available": assessment.data_available,
        "freshness": {
            "outlook_age_sec": round(assessment.outlook_age_sec),
            "watches_age_sec": round(assessment.watches_age_sec),
            "md_age_sec": round(assessment.md_age_sec),
        },
        "attribution": "Data from NOAA/NWS Storm Prediction Center",
    }


@router.get("/outlook")
async def spc_outlook():
    """Return Day 1 outlook GeoJSON for direct map overlay."""
    data = get_spc_data()
    outlook = data.get("outlook")
    if not outlook:
        return {"type": "FeatureCollection", "features": []}
    return outlook


@router.get("/watches")
async def spc_watches():
    """Return active watch polygons as GeoJSON for map overlay."""
    data = get_spc_data()
    watches = data.get("watches", [])

    features = []
    for w in watches:
        if w.get("geometry"):
            features.append({
                "type": "Feature",
                "geometry": w["geometry"],
                "properties": {
                    "event": w.get("event", ""),
                    "headline": w.get("headline", ""),
                    "expires": w.get("expires", ""),
                },
            })

    return {"type": "FeatureCollection", "features": features}
