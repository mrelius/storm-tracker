import httpx
import logging
from datetime import datetime, timezone
from services.radar.base import RadarProvider
from models import RadarLayerInfo
from config import LAYER_RULES

logger = logging.getLogger(__name__)

RAINVIEWER_MAP_URL = "https://api.rainviewer.com/public/weather-maps.json"


class RainViewerProvider(RadarProvider):
    """RainViewer radar provider — Phase 1 bootstrap for reflectivity only.

    RainViewer provides free global composite reflectivity tiles.
    It does NOT support SRV or CC products — those require different providers.
    """

    _cached_maps: dict | None = None
    _cached_at: datetime | None = None
    _cache_ttl: int = 300  # 5 minutes

    @property
    def provider_id(self) -> str:
        return "rainviewer"

    def supported_products(self) -> list[str]:
        return ["reflectivity"]

    async def _fetch_maps(self) -> dict | None:
        """Fetch weather maps JSON from RainViewer, with in-memory caching."""
        now = datetime.now(timezone.utc)
        if (self._cached_maps and self._cached_at
                and (now - self._cached_at).total_seconds() < self._cache_ttl):
            return self._cached_maps

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(RAINVIEWER_MAP_URL)
                resp.raise_for_status()
                data = resp.json()
                self._cached_maps = data
                self._cached_at = now
                return data
        except Exception as e:
            logger.error(f"RainViewer fetch failed: {e}")
            return self._cached_maps  # return stale if available

    def _build_layer(self, timestamp: int, path: str) -> RadarLayerInfo:
        """Build a RadarLayerInfo from a RainViewer frame entry."""
        now = datetime.now(timezone.utc)
        frame_time = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        rules = LAYER_RULES["reflectivity"]

        tile_url = f"https://tilecache.rainviewer.com{path}/256/{{z}}/{{x}}/{{y}}/2/1_1.png"

        return RadarLayerInfo(
            product_id="reflectivity",
            provider_id="rainviewer",
            display_name=rules["display_name"],
            opacity=rules["opacity"],
            timestamp=frame_time,
            data_age_seconds=int((now - frame_time).total_seconds()),
            tile_url_template=tile_url,
            available=True,
            overlay_eligible=rules["overlay_eligible"],
            requires_advanced=rules["requires_advanced"],
            min_zoom=3,
            max_zoom=12,
        )

    async def get_available_frames(self, product_id: str) -> list[RadarLayerInfo]:
        if product_id != "reflectivity":
            return []

        data = await self._fetch_maps()
        if not data or "radar" not in data:
            return []

        frames = []
        radar = data["radar"]
        for entry in radar.get("past", []):
            frames.append(self._build_layer(entry["time"], entry["path"]))
        for entry in radar.get("nowcast", []):
            frames.append(self._build_layer(entry["time"], entry["path"]))

        return frames

    async def get_latest_frame(self, product_id: str) -> RadarLayerInfo | None:
        frames = await self.get_available_frames(product_id)
        if not frames:
            return None
        # Last past frame (before nowcast) is the most recent actual data
        past_frames = [f for f in frames if f.data_age_seconds >= 0]
        return past_frames[-1] if past_frames else frames[-1]
