import pytest
import asyncio
from services.radar.base import RadarProvider
from services.radar.nexrad_cc import NexradCCProvider
from services.radar.registry import register, get_provider, get_providers_for_product, clear


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def clean_registry():
    clear()
    yield
    clear()


def test_nexrad_cc_implements_abc():
    provider = NexradCCProvider()
    assert isinstance(provider, RadarProvider)


def test_nexrad_cc_provider_id():
    provider = NexradCCProvider()
    assert provider.provider_id == "nexrad_cc"


def test_nexrad_cc_supported_products():
    provider = NexradCCProvider()
    assert provider.supported_products() == ["cc"]


def test_nexrad_cc_unsupported():
    async def check():
        provider = NexradCCProvider()
        assert await provider.get_available_frames("srv") == []
        assert await provider.get_available_frames("reflectivity") == []
    run(check())


def test_nexrad_cc_register():
    provider = NexradCCProvider()
    register(provider)
    assert get_provider("nexrad_cc") is provider
    assert len(get_providers_for_product("cc")) == 1
