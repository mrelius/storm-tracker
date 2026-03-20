from fastapi import APIRouter, Query
from models import LocationOut, LocationSource
from config import get_settings

router = APIRouter(prefix="/api/location", tags=["location"])


@router.get("/default", response_model=LocationOut)
async def get_default_location():
    """Return the default fallback location (Ohio Valley)."""
    settings = get_settings()
    return LocationOut(
        lat=settings.default_lat,
        lon=settings.default_lon,
        source=LocationSource.default,
        name=settings.default_location_name,
    )


@router.get("/resolve", response_model=LocationOut)
async def resolve_location(
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    source: LocationSource = Query(LocationSource.default),
    name: str | None = Query(None),
):
    """Resolve a location from coordinates. Used by frontend after GPS/manual selection."""
    settings = get_settings()
    if lat is not None and lon is not None:
        return LocationOut(lat=lat, lon=lon, source=source, name=name)
    return LocationOut(
        lat=settings.default_lat,
        lon=settings.default_lon,
        source=LocationSource.default,
        name=settings.default_location_name,
    )
