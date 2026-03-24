"""The Weather Company (TWC) Image Tile Server — Regional Radar Provider.

3-step flow:
1. Get inventory series (PPAcore product set) → available layers + timeslices
2. Select latest valid timeslice for the configured layer
3. Build XYZ tile URL with ts/fts/apiKey

Requires TWC_API_KEY in config. Falls back gracefully if unavailable.
"""
import httpx
import logging
import time
from datetime import datetime, timezone
from services.radar.base import RadarProvider
from models import RadarLayerInfo

logger = logging.getLogger(__name__)

# Configuration — loaded from environment/config
TWC_API_KEY = None  # Set via config.py or environment
TWC_BASE_URL = "https://api.weather.com/v3/TileServer"
TWC_PRODUCT_SET = "PPAcore"
TWC_REGIONAL_LAYER = "radarFcstv2"
TWC_INVENTORY_CACHE_TTL = 300  # 5 minutes per TWC docs

# Inventory cache
_inventory_cache = None
_inventory_cached_at = 0


def configure(api_key: str, layer: str = None):
    """Set TWC API key and optional layer override."""
    global TWC_API_KEY, TWC_REGIONAL_LAYER
    TWC_API_KEY = api_key
    if layer:
        TWC_REGIONAL_LAYER = layer
    logger.info(f"TWC configured: layer={TWC_REGIONAL_LAYER}, key={'set' if api_key else 'MISSING'}")


def is_configured() -> bool:
    return bool(TWC_API_KEY)


async def get_twc_inventory() -> dict | None:
    """Fetch TWC inventory series for PPAcore product set. Cached for 5 min."""
    global _inventory_cache, _inventory_cached_at

    if not TWC_API_KEY:
        return None

    now = time.time()
    if _inventory_cache and (now - _inventory_cached_at) < TWC_INVENTORY_CACHE_TTL:
        return _inventory_cache

    url = f"{TWC_BASE_URL}/series/{TWC_PRODUCT_SET}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params={"apiKey": TWC_API_KEY})
            resp.raise_for_status()
            data = resp.json()
            _inventory_cache = data
            _inventory_cached_at = now
            logger.info(f"TWC inventory fetched: {len(data.get('seriesInfo', {}))} layers")
            return data
    except Exception as e:
        logger.warning(f"TWC inventory fetch failed: {e}")
        return _inventory_cache  # return stale if available


def get_latest_twc_timeslice(inventory: dict, layer: str = None) -> dict | None:
    """Extract the latest valid timeslice for the configured layer."""
    layer = layer or TWC_REGIONAL_LAYER
    series = inventory.get("seriesInfo", {})
    layer_info = series.get(layer)

    if not layer_info:
        logger.warning(f"TWC layer '{layer}' not found in inventory. Available: {list(series.keys())[:10]}")
        return None

    # Get the most recent timeslice
    series_list = layer_info.get("series", [])
    if not series_list:
        return None

    # Sort by ts descending, pick latest
    latest = max(series_list, key=lambda s: s.get("ts", 0))

    return {
        "layer": layer,
        "ts": latest.get("ts"),
        "fts": latest.get("fts"),
        "nativeZoom": layer_info.get("nativeZoom"),
        "maxZoom": layer_info.get("maxZoom"),
        "attribution": layer_info.get("attribution", "The Weather Company"),
    }


def build_twc_tile_url(layer: str, ts: int, fts: int | None) -> str:
    """Build the TWC tile URL template for Leaflet."""
    base = f"{TWC_BASE_URL}/tile/{layer}"
    params = f"ts={ts}"
    if fts is not None:
        params += f"&fts={fts}"
    params += f"&xyz={{x}}:{{y}}:{{z}}&apiKey={TWC_API_KEY}"
    return f"{base}?{params}"


async def get_twc_regional_frame() -> dict | None:
    """Get the current TWC regional radar frame ready for frontend consumption."""
    if not is_configured():
        return None

    inventory = await get_twc_inventory()
    if not inventory:
        return None

    timeslice = get_latest_twc_timeslice(inventory)
    if not timeslice:
        return None

    tile_url = build_twc_tile_url(
        timeslice["layer"],
        timeslice["ts"],
        timeslice.get("fts"),
    )

    return {
        "provider": "twc",
        "layer": timeslice["layer"],
        "tile_url": tile_url,
        "ts": timeslice["ts"],
        "fts": timeslice.get("fts"),
        "max_zoom": timeslice.get("maxZoom", 11),
        "max_native_zoom": timeslice.get("nativeZoom", 6),
        "attribution": timeslice.get("attribution", "The Weather Company"),
        "expires_at": int(time.time()) + TWC_INVENTORY_CACHE_TTL,
    }


class TWCRadarProvider(RadarProvider):
    """TWC Image Tile Server provider for regional radar."""

    @property
    def provider_id(self) -> str:
        return "twc"

    def supported_products(self) -> list[str]:
        return ["twc_regional"] if is_configured() else []

    async def get_available_frames(self, product_id: str) -> list[RadarLayerInfo]:
        if product_id != "twc_regional" or not is_configured():
            return []

        frame = await get_twc_regional_frame()
        if not frame:
            return []

        return [RadarLayerInfo(
            product_id="twc_regional",
            provider_id="twc",
            display_name=f"Radar ({frame['layer']})",
            opacity=1.0,
            timestamp=datetime.fromtimestamp(frame["ts"], tz=timezone.utc) if frame.get("ts") else None,
            data_age_seconds=None,
            tile_url_template=frame["tile_url"],
            available=True,
            overlay_eligible=False,
            requires_advanced=False,
            min_zoom=1,
            max_zoom=frame.get("max_zoom", 11),
            max_native_zoom=frame.get("max_native_zoom", 6),
        )]

    async def get_latest_frame(self, product_id: str) -> RadarLayerInfo | None:
        frames = await self.get_available_frames(product_id)
        return frames[0] if frames else None
