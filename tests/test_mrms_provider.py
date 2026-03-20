import pytest
import asyncio
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from services.radar.base import RadarProvider
from services.radar.mrms import MRMSRadarProvider, TILE_DIR, METADATA_FILE
from services.radar.registry import register, get_provider, get_providers_for_product, clear


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def clean_registry():
    clear()
    yield
    clear()


def test_mrms_implements_abc():
    provider = MRMSRadarProvider()
    assert isinstance(provider, RadarProvider)


def test_mrms_provider_id():
    provider = MRMSRadarProvider()
    assert provider.provider_id == "mrms"


def test_mrms_supported_products():
    provider = MRMSRadarProvider()
    assert provider.supported_products() == ["cc"]


def test_mrms_unsupported_products():
    async def check():
        provider = MRMSRadarProvider()
        assert await provider.get_available_frames("reflectivity") == []
        assert await provider.get_available_frames("srv") == []
    run(check())


def test_mrms_no_metadata_returns_empty():
    async def check():
        provider = MRMSRadarProvider()
        # Metadata file won't exist in test env
        frames = await provider.get_available_frames("cc")
        assert frames == []
    run(check())


def test_mrms_register():
    provider = MRMSRadarProvider()
    register(provider)
    assert get_provider("mrms") is provider
    assert len(get_providers_for_product("cc")) == 1


def test_mrms_tile_url_format():
    """CC tiles must use single-brace Leaflet format."""
    async def check():
        # Mock metadata existence
        with tempfile.TemporaryDirectory() as tmpdir:
            meta_path = Path(tmpdir) / "metadata.json"
            meta_path.write_text(json.dumps({
                "frame_id": "20260320T201538Z",
                "timestamp": "20260320T201538Z",
            }))
            latest = Path(tmpdir) / "latest"
            latest.mkdir()

            with patch("services.radar.mrms.METADATA_FILE", meta_path), \
                 patch("services.radar.mrms.TILE_DIR", Path(tmpdir)):
                provider = MRMSRadarProvider()
                frames = await provider.get_available_frames("cc")
                assert len(frames) == 1
                url = frames[0].tile_url_template
                assert "/{z}/{x}/{y}.png" in url
                assert "{{" not in url
                assert frames[0].opacity == 0.55
                assert frames[0].overlay_eligible is True
    run(check())
