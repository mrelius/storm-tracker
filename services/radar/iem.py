"""IEM (Iowa Environmental Mesonet) Radar Provider.

Serves per-radar-site NEXRAD Level-III products as TMS tiles:
- N0U: Base Velocity
- N0S: Storm Relative Velocity
- N0Q: Base Reflectivity (backup — RainViewer is primary for reflectivity)

Tiles are 256x256 RGBA PNGs with transparent backgrounds.
URL pattern: https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::{SITE}-{PRODUCT}-0/{z}/{x}/{y}.png

Key difference from RainViewer: IEM serves single-frame per-site data, not
CONUS composites or animation frame sets. Each tile URL always returns the
latest available data for that radar site.
"""
import httpx
import logging
from datetime import datetime, timezone
from services.radar.base import RadarProvider
from models import RadarLayerInfo
from config import LAYER_RULES

logger = logging.getLogger(__name__)

IEM_TILE_BASE = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0"

# IEM product codes mapped to our product IDs
IEM_PRODUCTS = {
    "srv": "N0S",   # Storm Relative Velocity
}

# Products this provider does NOT support
UNSUPPORTED = {"cc"}  # No tile source for correlation coefficient


class IEMRadarProvider(RadarProvider):
    """IEM TMS tile provider for per-site velocity products."""

    def __init__(self, site_id: str = "ILN"):
        self._site_id = site_id.upper()

    @property
    def provider_id(self) -> str:
        return "iem"

    @property
    def site_id(self) -> str:
        return self._site_id

    def set_site(self, site_id: str):
        """Change the active radar site."""
        self._site_id = site_id.upper()
        logger.info(f"IEM provider switched to radar site: {self._site_id}")

    def supported_products(self) -> list[str]:
        return ["srv"]

    def _build_tile_url(self, iem_product: str) -> str:
        """Build tile URL through LXC 119 proxy (browser can't do cross-origin reliably)."""
        return (f"/proxy/iem/ridge::{self._site_id}-{iem_product}-0"
                "/{z}/{x}/{y}.png")

    async def _check_availability(self, iem_product: str) -> bool:
        """Check if tiles are available for this site+product by fetching one tile."""
        url = (f"{IEM_TILE_BASE}/ridge::{self._site_id}-{iem_product}-0"
               "/6/17/24.png")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.head(url)
                return resp.status_code == 200
        except Exception as e:
            logger.warning(f"IEM availability check failed for {self._site_id}/{iem_product}: {e}")
            return False

    async def get_available_frames(self, product_id: str) -> list[RadarLayerInfo]:
        """IEM serves single-frame latest data, not animation sets.

        Returns a list of 1 frame (latest) if available, empty if not.
        """
        if product_id not in IEM_PRODUCTS:
            return []

        iem_code = IEM_PRODUCTS[product_id]
        available = await self._check_availability(iem_code)

        if not available:
            return []

        rules = LAYER_RULES.get(product_id, {})
        tile_url = self._build_tile_url(iem_code)

        return [RadarLayerInfo(
            product_id=product_id,
            provider_id="iem",
            display_name=f"{rules.get('display_name', product_id)} ({self._site_id})",
            opacity=rules.get("opacity", 0.65),
            timestamp=None,             # unknown — IEM serves latest scan without timestamp
            data_age_seconds=None,      # unknown — do not fabricate
            tile_url_template=tile_url,
            available=True,
            overlay_eligible=rules.get("overlay_eligible", True),
            requires_advanced=rules.get("requires_advanced", False),
            min_zoom=4,
            max_zoom=10,
        )]

    async def get_latest_frame(self, product_id: str) -> RadarLayerInfo | None:
        frames = await self.get_available_frames(product_id)
        return frames[0] if frames else None
