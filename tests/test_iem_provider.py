import pytest
import asyncio
from services.radar.base import RadarProvider
from services.radar.iem import IEMRadarProvider
from services.radar.nexrad_sites import find_nearest, get_site, NEXRAD_SITES
from services.radar.registry import register, get_provider, clear


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def clean_registry():
    clear()
    yield
    clear()


# --- NEXRAD site lookup ---

def test_find_nearest_columbus():
    """Columbus OH (39.96, -82.99) → ILN (Wilmington OH) should be closest."""
    sites = find_nearest(39.96, -82.99, count=3)
    assert len(sites) == 3
    assert sites[0]["site_id"] == "ILN"
    assert sites[0]["distance_km"] < 100


def test_find_nearest_chicago():
    """Chicago → LOT should be closest."""
    sites = find_nearest(41.88, -87.63, count=1)
    assert sites[0]["site_id"] == "LOT"


def test_find_nearest_okc():
    """Oklahoma City → TLX."""
    sites = find_nearest(35.47, -97.52, count=1)
    assert sites[0]["site_id"] == "TLX"


def test_get_site_exists():
    site = get_site("ILN")
    assert site is not None
    assert site["site_id"] == "ILN"
    assert site["lat"] == pytest.approx(39.4203, abs=0.01)


def test_get_site_case_insensitive():
    assert get_site("iln") is not None
    assert get_site("ILN") is not None


def test_get_site_nonexistent():
    assert get_site("ZZZZZ") is None


def test_nexrad_sites_not_empty():
    assert len(NEXRAD_SITES) > 30


# --- IEM Provider contract ---

def test_iem_implements_abc():
    """IEMRadarProvider correctly implements RadarProvider ABC."""
    provider = IEMRadarProvider(site_id="ILN")
    assert isinstance(provider, RadarProvider)


def test_iem_provider_id():
    provider = IEMRadarProvider()
    assert provider.provider_id == "iem"


def test_iem_supported_products():
    provider = IEMRadarProvider()
    products = provider.supported_products()
    assert "srv" in products
    assert "cc" not in products
    assert "reflectivity" not in products


def test_iem_unsupported_product():
    """Requesting unsupported product returns empty."""
    async def check():
        provider = IEMRadarProvider()
        frames = await provider.get_available_frames("cc")
        assert frames == []
        frames = await provider.get_available_frames("reflectivity")
        assert frames == []
    run(check())


def test_iem_site_switch():
    provider = IEMRadarProvider(site_id="ILN")
    assert provider.site_id == "ILN"
    provider.set_site("LOT")
    assert provider.site_id == "LOT"


def test_iem_register():
    provider = IEMRadarProvider()
    register(provider)
    assert get_provider("iem") is provider


def test_iem_tile_url_pattern():
    """Verify tile URL contains correct site and product code with single braces."""
    provider = IEMRadarProvider(site_id="LOT")
    url = provider._build_tile_url("N0S")
    assert "LOT-N0S-0" in url
    assert "/{z}/{x}/{y}.png" in url
    # Must NOT have double braces (Leaflet can't parse them)
    assert "{{" not in url
    assert "}}" not in url
