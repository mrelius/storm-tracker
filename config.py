from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    nws_user_agent: str = "StormTracker/1.0 (storm.mrelius.com contact@mrelius.com)"
    nws_api_base: str = "https://api.weather.gov"
    nws_poll_interval: int = 60

    redis_url: str = "redis://localhost:6379/0"
    redis_cache_ttl: int = 120

    sqlite_db_path: str = "./data/storm_tracker.db"

    default_lat: float = 39.5
    default_lon: float = -84.5
    default_location_name: str = "Ohio Valley"

    alert_poll_interval: int = 60
    alert_history_capacity: int = 100

    debug_mode: bool = True             # enables simulation endpoints

    log_level: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


# Priority scores for alert events (higher = more severe)
ALERT_PRIORITY = {
    "Tornado Warning": 100,
    "Severe Thunderstorm Warning": 80,
    "Tornado Watch": 60,
    "Flood Warning": 40,
    "Winter Storm Warning": 35,
    "Special Weather Statement": 20,
}
ALERT_PRIORITY_DEFAULT = 10

# Alert category classification
ALERT_CATEGORIES = {
    "primary": {"Tornado Warning", "Severe Thunderstorm Warning", "Tornado Watch"},
    "secondary": {"Flood Warning", "Flash Flood Warning", "Winter Storm Warning",
                   "Winter Weather Advisory", "Special Weather Statement"},
    "informational": set(),  # MDDs, PDS tags handled separately
}

# Radar layer rules
LAYER_RULES = {
    "reflectivity": {
        "opacity": 1.0,
        "overlay_eligible": False,
        "requires_advanced": False,
        "display_name": "Reflectivity",
    },
    "srv": {
        "opacity": 0.65,
        "overlay_eligible": True,
        "requires_advanced": False,
        "display_name": "Storm Relative Velocity",
    },
    "cc": {
        "opacity": 0.55,
        "overlay_eligible": True,
        "requires_advanced": False,
        "display_name": "Correlation Coefficient",
    },
}

# No combos restricted to advanced mode — SRV + CC are designed to work together
ADVANCED_ONLY_COMBOS = []

MAX_ACTIVE_LAYERS = 2

# Memory budget for radar tile layers (frontend policy, documented here for reference)
# These limits are enforced in radar-manager.js
RADAR_MEMORY_BUDGET = {
    "max_preloaded_products": 2,       # max products with preloaded frames
    "max_frames_per_product": 15,      # max animation frames per product
    "max_tile_layers": 30,             # absolute max L.tileLayer instances
    "frames_budget": {
        "reflectivity": 15,            # 13 typical + 2 buffer (animated)
        "srv": 1,                      # single latest frame (no animation)
        "cc": 1,                       # single latest frame (future)
    },
}

# Product availability status
PRODUCT_AVAILABILITY = {
    "reflectivity": "available",       # RainViewer composite
    "srv": "available",                # IEM per-site (N0S)
    "cc": "unavailable",              # No free tile source exists
}


def get_settings() -> Settings:
    return Settings()
