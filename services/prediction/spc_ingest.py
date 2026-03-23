"""
Storm Tracker — SPC Data Ingestion

Fetches SPC products from public APIs:
- Day 1 categorical outlook (GeoJSON)
- Active watches via NWS API (Tornado Watch, Severe Thunderstorm Watch)
- Mesoscale discussions via NWS API

Runs on a configurable poll interval. Data stored in-memory
and exposed via get_spc_data().

NOT an official forecast product. SPC data is sourced from
NOAA/NWS/SPC public feeds for situational awareness.
"""

import asyncio
import time
import logging
import httpx
from typing import Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ── Endpoints ────────────────────────────────────────────────────
SPC_DAY1_URL = "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson"
NWS_WATCHES_URL = "https://api.weather.gov/alerts/active"
# Watches and MDs filtered client-side from the same broad query
_WATCH_EVENTS = {"Tornado Watch", "Severe Thunderstorm Watch"}
_MD_SENDERS = {"NWS Storm Prediction Center"}

# ── Configuration ────────────────────────────────────────────────
POLL_INTERVAL = 120  # 2 minutes
USER_AGENT = "StormTracker/3.0 (storm.mrelius.com)"
FETCH_TIMEOUT = 15  # seconds

# ── In-memory store ──────────────────────────────────────────────
_spc_data = {
    "outlook": None,          # GeoJSON FeatureCollection
    "outlook_updated": 0,
    "watches": [],            # list of watch dicts
    "watches_updated": 0,
    "mesoscale": [],          # list of MD dicts
    "mesoscale_updated": 0,
    "last_poll": 0,
    "errors": [],
}

_running = True


def get_spc_data() -> dict:
    """Return current SPC data snapshot."""
    return {
        "outlook": _spc_data["outlook"],
        "outlook_updated": _spc_data["outlook_updated"],
        "watches": _spc_data["watches"],
        "watches_updated": _spc_data["watches_updated"],
        "mesoscale": _spc_data["mesoscale"],
        "mesoscale_updated": _spc_data["mesoscale_updated"],
        "last_poll": _spc_data["last_poll"],
        "errors": _spc_data["errors"][-5:],  # keep last 5 errors
    }


async def _fetch_json(client: httpx.AsyncClient, url: str) -> Optional[dict]:
    """Fetch JSON from URL with error handling."""
    try:
        resp = await client.get(url, timeout=FETCH_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        _spc_data["errors"].append({
            "url": url.split("?")[0],
            "error": str(e)[:200],
            "time": time.time(),
        })
        logger.warning(f"SPC fetch failed: {url.split('?')[0]} — {e}")
        return None


async def _fetch_outlook(client: httpx.AsyncClient):
    """Fetch SPC Day 1 categorical outlook GeoJSON."""
    data = await _fetch_json(client, SPC_DAY1_URL)
    if data and data.get("type") == "FeatureCollection":
        _spc_data["outlook"] = data
        _spc_data["outlook_updated"] = time.time()
        count = len(data.get("features", []))
        logger.info(f"SPC Day 1 outlook: {count} risk areas")


async def _fetch_watches_and_mds(client: httpx.AsyncClient):
    """Fetch active alerts and filter to SPC watches + MDs."""
    data = await _fetch_json(client, NWS_WATCHES_URL)
    if not data or "features" not in data:
        return

    watches = []
    mds = []

    for feat in data["features"]:
        props = feat.get("properties", {})
        geo = feat.get("geometry")
        event = props.get("event", "")
        sender = props.get("senderName", "")

        # SPC watches
        if event in _WATCH_EVENTS:
            watches.append({
                "id": props.get("id", ""),
                "event": event,
                "headline": props.get("headline", ""),
                "description": (props.get("description") or "")[:500],
                "onset": props.get("effective", ""),
                "expires": props.get("expires", ""),
                "severity": props.get("severity", ""),
                "geometry": geo,
                "areas": props.get("areaDesc", ""),
            })

        # SPC mesoscale discussions (special weather statements from SPC)
        elif sender in _MD_SENDERS or "Storm Prediction Center" in sender:
            headline = props.get("headline", "")
            if headline:
                mds.append({
                    "id": props.get("id", ""),
                    "headline": headline[:200],
                    "description": (props.get("description") or "")[:500],
                    "onset": props.get("effective", ""),
                    "expires": props.get("expires", ""),
                    "geometry": geo,
                    "areas": props.get("areaDesc", ""),
                    "sender": sender,
                })

    _spc_data["watches"] = watches
    _spc_data["watches_updated"] = time.time()
    _spc_data["mesoscale"] = mds
    _spc_data["mesoscale_updated"] = time.time()
    logger.info(f"SPC watches: {len(watches)}, MDs: {len(mds)}")


async def poll_once():
    """Run one complete SPC data poll cycle."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json, application/json"}
    async with httpx.AsyncClient(headers=headers) as client:
        await asyncio.gather(
            _fetch_outlook(client),
            _fetch_watches_and_mds(client),
        )
    _spc_data["last_poll"] = time.time()


async def run_spc_loop():
    """Background loop for SPC data polling."""
    global _running
    _running = True
    logger.info(f"SPC ingest loop starting (interval: {POLL_INTERVAL}s)")

    # Initial fetch
    try:
        await poll_once()
    except Exception as e:
        logger.error(f"SPC initial fetch failed: {e}")

    while _running:
        await asyncio.sleep(POLL_INTERVAL)
        try:
            await poll_once()
        except Exception as e:
            logger.error(f"SPC poll error: {e}")


def stop_spc():
    """Stop the SPC polling loop."""
    global _running
    _running = False
