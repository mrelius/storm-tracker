"""NEXRAD site-based CC (RHOHV) provider.

Consumes tiles from LXC 121 (cc-radar) which runs the Py-ART processing
pipeline. Tiles are accessed via HTTP — LXC 119 does not run Py-ART.

Temporal alignment: CC tiles come from the same NEXRAD volume scan as SRV,
so they match spatially and temporally.
"""
import httpx
import logging
from datetime import datetime, timezone
from services.radar.base import RadarProvider
from models import RadarLayerInfo
from config import LAYER_RULES

logger = logging.getLogger(__name__)

CC_RADAR_HOST = "http://10.206.8.121:8121"
STALE_THRESHOLD = 600  # 10 minutes


class NexradCCProvider(RadarProvider):
    """Site-based CC tiles from the cc-radar processing LXC."""

    def __init__(self):
        self._last_status: dict | None = None

    @property
    def provider_id(self) -> str:
        return "nexrad_cc"

    def supported_products(self) -> list[str]:
        return ["cc"]

    async def _fetch_status(self) -> dict | None:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{CC_RADAR_HOST}/api/status")
                if resp.status_code == 200:
                    self._last_status = resp.json()
                    return self._last_status
        except Exception as e:
            logger.warning(f"CC radar status check failed: {e}")
        return self._last_status  # return stale status as fallback

    async def set_site(self, site_id: str):
        """Tell the CC pipeline to switch radar site."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(f"{CC_RADAR_HOST}/api/set-site?site_id={site_id}")
                logger.info(f"CC pipeline site set to {site_id}")
        except Exception as e:
            logger.warning(f"Failed to set CC site: {e}")

    async def get_available_frames(self, product_id: str) -> list[RadarLayerInfo]:
        if product_id != "cc":
            return []

        status = await self._fetch_status()
        if not status or not status.get("available"):
            return []

        rules = LAYER_RULES.get("cc", {})
        site_id = status.get("site_id", "?")
        ts_str = status.get("timestamp", "")

        timestamp = None
        age = status.get("age_seconds")
        if ts_str:
            try:
                timestamp = datetime.strptime(ts_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            except ValueError:
                pass

        # Build tile URL through LXC 119 proxy (browser can't reach LXC 121 directly)
        tile_url = f"/proxy/cc/{site_id}/latest/{{z}}/{{x}}/{{y}}.png"

        return [RadarLayerInfo(
            product_id="cc",
            provider_id="nexrad_cc",
            display_name=f"CC ({site_id}, aligned with SRV)",
            opacity=rules.get("opacity", 0.55),
            timestamp=timestamp,
            data_age_seconds=age,
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
