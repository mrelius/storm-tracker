import logging
from fastapi import APIRouter, Query, HTTPException
from models import RadarLayerInfo, RadarFrameSet, AppMode
from config import LAYER_RULES, ADVANCED_ONLY_COMBOS, MAX_ACTIVE_LAYERS
from services.radar import registry
from services.radar.nexrad_sites import find_nearest, get_site, NEXRAD_SITES
from services.radar.iem import IEMRadarProvider
from services.radar.nexrad_cc import NexradCCProvider
import cache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/radar", tags=["radar"])

RADAR_PRODUCTS_CACHE_TTL = 60  # seconds


@router.get("/products", response_model=list[RadarLayerInfo])
async def list_radar_products():
    """List all known radar products with their rules and current availability. Cached 60s."""
    cached = cache.get("radar:products")
    if cached is not None:
        return [RadarLayerInfo(**p) for p in cached]

    products = []
    for product_id, rules in LAYER_RULES.items():
        frame = await registry.get_best_frame(product_id)
        products.append(RadarLayerInfo(
            product_id=product_id,
            provider_id=frame.provider_id if frame else "none",
            display_name=rules["display_name"],
            opacity=rules["opacity"],
            timestamp=frame.timestamp if frame else None,
            data_age_seconds=frame.data_age_seconds if frame else None,
            tile_url_template=frame.tile_url_template if frame else None,
            available=frame.available if frame else False,
            overlay_eligible=rules["overlay_eligible"],
            requires_advanced=rules["requires_advanced"],
        ))

    cache.set("radar:products", [p.model_dump() for p in products], ttl=RADAR_PRODUCTS_CACHE_TTL)
    return products


@router.get("/frames/{product_id}", response_model=RadarFrameSet)
async def get_radar_frames(
    product_id: str,
    provider_id: str | None = Query(None),
):
    """Get all animation frames for a radar product."""
    if product_id not in LAYER_RULES:
        raise HTTPException(status_code=400, detail=f"Unknown product: {product_id}")

    frames = await registry.get_all_frames(product_id, provider_id)
    pid = provider_id or (frames[0].provider_id if frames else "none")
    return RadarFrameSet(product_id=product_id, provider_id=pid, frames=frames)


@router.post("/validate-layers")
async def validate_layer_selection(
    active_products: list[str],
    mode: AppMode = Query(AppMode.basic),
):
    """Validate whether a set of active layers is allowed.

    Returns {"valid": bool, "reason": str | None}
    """
    # Check max layers
    if len(active_products) > MAX_ACTIVE_LAYERS:
        return {"valid": False, "reason": f"Max {MAX_ACTIVE_LAYERS} active layers allowed"}

    # Check all products exist
    for pid in active_products:
        if pid not in LAYER_RULES:
            return {"valid": False, "reason": f"Unknown product: {pid}"}

    # Check advanced-only combos
    active_set = set(active_products)
    if mode == AppMode.basic:
        for combo in ADVANCED_ONLY_COMBOS:
            if combo.issubset(active_set):
                return {
                    "valid": False,
                    "reason": f"Combination {combo} requires advanced mode",
                }

    return {"valid": True, "reason": None}


@router.get("/nexrad/nearest")
async def nearest_radar(
    lat: float = Query(...),
    lon: float = Query(...),
    count: int = Query(3),
):
    """Find nearest NEXRAD radar site(s) to a given location."""
    sites = find_nearest(lat, lon, count=min(count, 10))
    return {"sites": sites}


@router.get("/nexrad/all")
async def list_all_radars(
    lat: float | None = Query(None),
    lon: float | None = Query(None),
):
    """List all NEXRAD sites, optionally sorted by distance from a point."""
    if lat is not None and lon is not None:
        return {"sites": find_nearest(lat, lon, count=len(NEXRAD_SITES))}
    return {"sites": [{"site_id": s[0], "name": s[1], "lat": s[2], "lon": s[3]}
                       for s in NEXRAD_SITES]}


@router.post("/nexrad/select")
async def select_radar_site(site_id: str = Query(...)):
    """Switch the IEM provider to a different radar site.

    Returns updated product availability for the new site.
    """
    site = get_site(site_id)
    if not site:
        raise HTTPException(status_code=404, detail=f"Unknown radar site: {site_id}")

    # Update IEM provider's active site
    iem = registry.get_provider("iem")
    if iem and isinstance(iem, IEMRadarProvider):
        iem.set_site(site_id)

    # Sync CC pipeline to same site
    cc = registry.get_provider("nexrad_cc")
    if cc and isinstance(cc, NexradCCProvider):
        await cc.set_site(site_id)

    cache.delete("radar:products")

    # Return availability for all products on this site
    availability = {}
    if iem:
        for pid in iem.supported_products():
            frame = await iem.get_latest_frame(pid)
            availability[pid] = frame.available if frame else False
    if cc:
        for pid in cc.supported_products():
            frame = await cc.get_latest_frame(pid)
            availability[pid] = frame.available if frame else False

    return {"site": site, "availability": availability}
