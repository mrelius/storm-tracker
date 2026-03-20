"""MRMS Radar Provider — serves locally-generated CC tiles.

Tiles are produced by cc_pipeline.py (GRIB2 → GeoTIFF → tiles).
Served via FastAPI static mount at /tiles/cc/latest/{z}/{x}/{y}.png.
"""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from services.radar.base import RadarProvider
from models import RadarLayerInfo
from config import LAYER_RULES

logger = logging.getLogger(__name__)

TILE_DIR = Path("/opt/storm-tracker/data/cc_tiles")
METADATA_FILE = TILE_DIR / "metadata.json"


class MRMSRadarProvider(RadarProvider):
    """Serves MRMS Correlation Coefficient tiles from local pipeline output."""

    @property
    def provider_id(self) -> str:
        return "mrms"

    def supported_products(self) -> list[str]:
        return ["cc"]

    def _read_metadata(self) -> dict | None:
        try:
            if METADATA_FILE.exists():
                return json.loads(METADATA_FILE.read_text())
        except Exception as e:
            logger.warning(f"Failed to read CC metadata: {e}")
        return None

    async def get_available_frames(self, product_id: str) -> list[RadarLayerInfo]:
        if product_id != "cc":
            return []

        meta = self._read_metadata()
        if not meta:
            return []

        latest_link = TILE_DIR / "latest"
        if not latest_link.exists():
            return []

        rules = LAYER_RULES.get("cc", {})
        ts_str = meta.get("timestamp", "")
        timestamp = None
        if ts_str:
            try:
                timestamp = datetime.strptime(ts_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            except ValueError:
                pass

        age = None
        if timestamp:
            age = int((datetime.now(timezone.utc) - timestamp).total_seconds())

        # Tile URL served by FastAPI static mount
        tile_url = "/tiles/cc/latest/{z}/{x}/{y}.png"

        return [RadarLayerInfo(
            product_id="cc",
            provider_id="mrms",
            display_name=rules.get("display_name", "Correlation Coefficient"),
            opacity=rules.get("opacity", 0.55),
            timestamp=timestamp,
            data_age_seconds=age,
            tile_url_template=tile_url,
            available=True,
            overlay_eligible=rules.get("overlay_eligible", True),
            requires_advanced=rules.get("requires_advanced", False),
            min_zoom=3,
            max_zoom=7,
        )]

    async def get_latest_frame(self, product_id: str) -> RadarLayerInfo | None:
        frames = await self.get_available_frames(product_id)
        return frames[0] if frames else None
