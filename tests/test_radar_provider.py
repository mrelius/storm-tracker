import pytest
import asyncio
from datetime import datetime, timezone
from services.radar.base import RadarProvider
from services.radar.registry import register, get_provider, get_providers_for_product, clear
from services.radar.rainviewer import RainViewerProvider
from models import RadarLayerInfo


class FakeProvider(RadarProvider):
    """Test provider that returns canned data."""

    @property
    def provider_id(self) -> str:
        return "fake"

    def supported_products(self) -> list[str]:
        return ["reflectivity", "srv"]

    async def get_available_frames(self, product_id: str) -> list[RadarLayerInfo]:
        if product_id not in self.supported_products():
            return []
        return [RadarLayerInfo(
            product_id=product_id,
            provider_id="fake",
            display_name=f"Fake {product_id}",
            opacity=1.0,
            timestamp=datetime.now(timezone.utc),
            data_age_seconds=60,
            tile_url_template="https://fake/{z}/{x}/{y}.png",
            available=True,
        )]

    async def get_latest_frame(self, product_id: str) -> RadarLayerInfo | None:
        frames = await self.get_available_frames(product_id)
        return frames[0] if frames else None


class IncompleteProvider(RadarProvider):
    """Provider that doesn't implement all methods — should fail."""
    pass


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def clean_registry():
    clear()
    yield
    clear()


def test_abc_enforcement():
    """AC-7: Cannot instantiate provider without implementing all methods."""
    with pytest.raises(TypeError):
        IncompleteProvider()


def test_register_and_retrieve():
    """Provider can be registered and retrieved."""
    provider = FakeProvider()
    register(provider)
    assert get_provider("fake") is provider
    assert get_provider("nonexistent") is None


def test_providers_for_product():
    """get_providers_for_product returns correct providers."""
    provider = FakeProvider()
    register(provider)
    assert len(get_providers_for_product("reflectivity")) == 1
    assert len(get_providers_for_product("srv")) == 1
    assert len(get_providers_for_product("cc")) == 0


def test_fake_provider_returns_frames():
    """Concrete provider returns valid RadarLayerInfo."""
    async def check():
        provider = FakeProvider()
        frames = await provider.get_available_frames("reflectivity")
        assert len(frames) == 1
        assert frames[0].product_id == "reflectivity"
        assert frames[0].provider_id == "fake"
        assert frames[0].available is True

        latest = await provider.get_latest_frame("reflectivity")
        assert latest is not None
        assert latest.product_id == "reflectivity"
    run(check())


def test_unsupported_product_returns_empty():
    """Provider returns empty for unsupported products."""
    async def check():
        provider = FakeProvider()
        frames = await provider.get_available_frames("cc")
        assert frames == []
        latest = await provider.get_latest_frame("cc")
        assert latest is None
    run(check())


def test_rainviewer_supported_products():
    """AC-7: RainViewer only supports reflectivity."""
    provider = RainViewerProvider()
    assert provider.supported_products() == ["reflectivity"]
    assert provider.provider_id == "rainviewer"


def test_rainviewer_unsupported():
    """RainViewer returns empty for SRV/CC."""
    async def check():
        provider = RainViewerProvider()
        assert await provider.get_available_frames("srv") == []
        assert await provider.get_available_frames("cc") == []
        assert await provider.get_latest_frame("srv") is None
    run(check())
