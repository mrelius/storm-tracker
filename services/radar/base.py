from abc import ABC, abstractmethod
from datetime import datetime
from models import RadarLayerInfo


class RadarProvider(ABC):
    """Abstract base class for all radar data providers.

    Every radar source (RainViewer, MRMS, custom) must implement this interface.
    The system uses this to swap providers without touching map or layer code.
    """

    @property
    @abstractmethod
    def provider_id(self) -> str:
        """Unique identifier for this provider (e.g., 'rainviewer', 'mrms')."""
        ...

    @abstractmethod
    async def get_available_frames(self, product_id: str) -> list[RadarLayerInfo]:
        """Return all available animation frames for a radar product.

        Args:
            product_id: One of 'reflectivity', 'srv', 'cc'

        Returns:
            List of RadarLayerInfo ordered oldest-to-newest.
            Empty list if product not supported or data unavailable.
        """
        ...

    @abstractmethod
    async def get_latest_frame(self, product_id: str) -> RadarLayerInfo | None:
        """Return the most recent frame for a radar product.

        Returns None if product not supported or data unavailable.
        """
        ...

    @abstractmethod
    def supported_products(self) -> list[str]:
        """Return list of product_ids this provider can serve."""
        ...
