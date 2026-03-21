from pydantic import BaseModel
from datetime import datetime
from enum import Enum


class AlertCategory(str, Enum):
    primary = "primary"
    secondary = "secondary"
    informational = "informational"


class AlertSortField(str, Enum):
    severity = "severity"
    distance = "distance"
    issued = "issued"
    expiration = "expiration"


class SortOrder(str, Enum):
    asc = "asc"
    desc = "desc"


class AppMode(str, Enum):
    basic = "basic"
    advanced = "advanced"


class AlertOut(BaseModel):
    id: str
    event: str
    severity: str
    urgency: str
    certainty: str
    category: str
    headline: str | None = None
    description: str | None = None
    instruction: str | None = None
    polygon: str | None = None
    onset: str
    expires: str
    issued: str
    sender: str | None = None
    priority_score: int
    county_fips: list[str] = []
    distance_mi: float | None = None


class AlertCountyMap(BaseModel):
    """Maps county FIPS to highest-priority event for that county."""
    counties: dict[str, str]  # {fips: event_name}


class CountyOut(BaseModel):
    fips: str
    name: str
    state: str
    centroid_lat: float
    centroid_lon: float


class RadarLayerInfo(BaseModel):
    product_id: str
    provider_id: str
    display_name: str
    opacity: float
    timestamp: datetime | None = None
    data_age_seconds: int | None = None
    tile_url_template: str | None = None
    available: bool = False
    overlay_eligible: bool = False
    requires_advanced: bool = False
    min_zoom: int = 3
    max_zoom: int = 12


class RadarFrameSet(BaseModel):
    product_id: str
    provider_id: str
    frames: list[RadarLayerInfo] = []


class LocationSource(str, Enum):
    gps = "gps"
    saved = "saved"
    manual = "manual"
    default = "default"


class LocationOut(BaseModel):
    lat: float
    lon: float
    source: LocationSource
    name: str | None = None


class HealthOut(BaseModel):
    status: str
    db: str
    cache: str
    nws_last_poll: str | None = None
    alert_count: int = 0
    cache_stats: dict | None = None
