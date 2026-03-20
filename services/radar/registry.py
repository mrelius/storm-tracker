import logging
from services.radar.base import RadarProvider
from models import RadarLayerInfo

logger = logging.getLogger(__name__)

_providers: dict[str, RadarProvider] = {}


def register(provider: RadarProvider):
    """Register a radar provider instance."""
    _providers[provider.provider_id] = provider
    logger.info(f"Registered radar provider: {provider.provider_id} "
                f"(products: {provider.supported_products()})")


def get_provider(provider_id: str) -> RadarProvider | None:
    return _providers.get(provider_id)


def get_all_providers() -> dict[str, RadarProvider]:
    return dict(_providers)


def get_providers_for_product(product_id: str) -> list[RadarProvider]:
    """Return all providers that support a given product."""
    return [p for p in _providers.values() if product_id in p.supported_products()]


async def get_best_frame(product_id: str) -> RadarLayerInfo | None:
    """Get the latest frame from the first available provider for a product."""
    for provider in get_providers_for_product(product_id):
        frame = await provider.get_latest_frame(product_id)
        if frame and frame.available:
            return frame
    return None


async def get_all_frames(product_id: str, provider_id: str | None = None) -> list[RadarLayerInfo]:
    """Get all animation frames for a product from a specific or first-available provider."""
    if provider_id:
        provider = get_provider(provider_id)
        if provider and product_id in provider.supported_products():
            return await provider.get_available_frames(product_id)
        return []

    for provider in get_providers_for_product(product_id):
        frames = await provider.get_available_frames(product_id)
        if frames:
            return frames
    return []


def clear():
    """Clear all registered providers (used by tests)."""
    _providers.clear()
