"""
Storm Tracker — Environmental Context (Model/Observation Layer)

Ingests surface observations from NWS stations to derive basic
environmental context for severe convection assessment.

Derives simple categories:
- favorable: warm, moist, unstable environment
- neutral: mixed signals
- unfavorable: stable, dry, or cold environment

Uses surface obs only (no GRIB2 parsing). This is a rough proxy,
NOT a substitute for actual CAPE/CIN/SRH from model output.

Signals considered:
- Temperature-dewpoint spread (moisture proxy)
- Surface temperature (instability proxy)
- Pressure tendency (if available)
- Wind speed (shear proxy at surface only)

NOT an official forecast or model output.
"""

import asyncio
import time
import math
import logging
import httpx
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

NWS_OBS_URL = "https://api.weather.gov/stations/{station}/observations/latest"
USER_AGENT = "StormTracker/3.0 (storm.mrelius.com)"
FETCH_TIMEOUT = 10
POLL_INTERVAL = 300  # 5 minutes

# Stations by region (Ohio Valley focus)
DEFAULT_STATIONS = ["KILN", "KIND", "KCVG", "KDAY", "KSDF"]

# ── Environmental thresholds ─────────────────────────────────────
# These are rough proxies, not scientifically rigorous
MOIST_SPREAD_C = 6.0       # T-Td < 6°C = moist
DRY_SPREAD_C = 15.0        # T-Td > 15°C = dry
WARM_TEMP_C = 20.0          # surface temp > 20°C = warm enough for convection
COLD_TEMP_C = 10.0          # surface temp < 10°C = too cold
WINDY_MS = 10.0             # surface wind > 10 m/s = some shear signal


@dataclass
class EnvironmentObs:
    """Single station observation."""
    station: str = ""
    temp_c: Optional[float] = None
    dewpoint_c: Optional[float] = None
    wind_speed_ms: Optional[float] = None
    wind_dir_deg: Optional[float] = None
    pressure_pa: Optional[float] = None
    timestamp: str = ""


@dataclass
class EnvironmentContext:
    """Environmental assessment derived from surface observations."""
    category: str = "unknown"         # favorable, neutral, unfavorable, unknown
    confidence: float = 0.0           # 0-1
    signals: list[str] = field(default_factory=list)
    explanation: str = ""
    stations_used: int = 0
    data_age_sec: float = 0
    suppressed: bool = False
    suppress_reason: str = ""

    # Modifier for confidence engine
    confidence_modifier: float = 0.0  # -0.15 to +0.15


# ── In-memory store ──────────────────────────────────────────────
_env_data = {
    "observations": [],       # list of EnvironmentObs dicts
    "context": None,          # EnvironmentContext
    "updated": 0,
}

_running = True


def get_environment_context() -> Optional[dict]:
    """Return current environment context as a dict."""
    ctx = _env_data.get("context")
    if not ctx:
        return None
    return {
        "category": ctx.category,
        "confidence": ctx.confidence,
        "signals": ctx.signals,
        "explanation": ctx.explanation,
        "stations_used": ctx.stations_used,
        "data_age_sec": round(time.time() - _env_data["updated"]) if _env_data["updated"] else 0,
        "confidence_modifier": ctx.confidence_modifier,
        "suppressed": ctx.suppressed,
        "suppress_reason": ctx.suppress_reason,
    }


async def _fetch_station_obs(client: httpx.AsyncClient, station: str) -> Optional[EnvironmentObs]:
    """Fetch latest observation from a NWS station."""
    try:
        resp = await client.get(
            NWS_OBS_URL.format(station=station),
            timeout=FETCH_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        props = data.get("properties", {})

        return EnvironmentObs(
            station=station,
            temp_c=_safe_val(props, "temperature"),
            dewpoint_c=_safe_val(props, "dewpoint"),
            wind_speed_ms=_safe_val(props, "windSpeed"),
            wind_dir_deg=_safe_val(props, "windDirection"),
            pressure_pa=_safe_val(props, "barometricPressure"),
            timestamp=props.get("timestamp", ""),
        )
    except Exception as e:
        logger.debug(f"Station {station} obs failed: {e}")
        return None


def _safe_val(props: dict, key: str) -> Optional[float]:
    """Extract numeric value from NWS observation property."""
    obj = props.get(key, {})
    if isinstance(obj, dict):
        v = obj.get("value")
        return float(v) if v is not None else None
    return None


def _assess_environment(observations: list[EnvironmentObs]) -> EnvironmentContext:
    """Derive environmental category from aggregated surface observations."""
    ctx = EnvironmentContext()

    valid = [o for o in observations if o.temp_c is not None and o.dewpoint_c is not None]
    if not valid:
        ctx.suppressed = True
        ctx.suppress_reason = "no_valid_observations"
        ctx.explanation = "No surface observations available."
        return ctx

    ctx.stations_used = len(valid)

    # Average key parameters
    avg_temp = sum(o.temp_c for o in valid) / len(valid)
    avg_dew = sum(o.dewpoint_c for o in valid) / len(valid)
    avg_spread = avg_temp - avg_dew
    winds = [o.wind_speed_ms for o in valid if o.wind_speed_ms is not None]
    avg_wind = sum(winds) / len(winds) if winds else 0

    signals = []
    score = 0  # -3 to +3 range

    # Moisture
    if avg_spread < MOIST_SPREAD_C:
        signals.append(f"Moist air (spread {avg_spread:.0f}°C)")
        score += 1
    elif avg_spread > DRY_SPREAD_C:
        signals.append(f"Dry air (spread {avg_spread:.0f}°C)")
        score -= 1
    else:
        signals.append(f"Moderate moisture (spread {avg_spread:.0f}°C)")

    # Temperature
    if avg_temp > WARM_TEMP_C:
        signals.append(f"Warm surface ({avg_temp:.0f}°C)")
        score += 1
    elif avg_temp < COLD_TEMP_C:
        signals.append(f"Cool surface ({avg_temp:.0f}°C)")
        score -= 1
    else:
        signals.append(f"Moderate temps ({avg_temp:.0f}°C)")

    # Wind (shear proxy)
    if avg_wind > WINDY_MS:
        signals.append(f"Breezy ({avg_wind:.0f} m/s)")
        score += 0.5

    # Category
    if score >= 1.5:
        ctx.category = "favorable"
        ctx.confidence_modifier = 0.1
    elif score <= -1:
        ctx.category = "unfavorable"
        ctx.confidence_modifier = -0.1
    else:
        ctx.category = "neutral"
        ctx.confidence_modifier = 0.0

    ctx.signals = signals
    ctx.confidence = min(1.0, 0.3 + len(valid) * 0.15)  # more stations = higher trust
    ctx.explanation = (
        f"Environment: {ctx.category}. {'; '.join(signals)}. "
        f"Based on {len(valid)} surface stations. Proxy analysis, not model output."
    )

    return ctx


async def poll_environment():
    """Fetch observations from all configured stations and assess."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json"}
    async with httpx.AsyncClient(headers=headers) as client:
        tasks = [_fetch_station_obs(client, s) for s in DEFAULT_STATIONS]
        results = await asyncio.gather(*tasks)

    observations = [r for r in results if r is not None]
    _env_data["observations"] = observations
    _env_data["context"] = _assess_environment(observations)
    _env_data["updated"] = time.time()
    logger.info(f"Environment: {_env_data['context'].category} ({len(observations)} stations)")


async def run_environment_loop():
    """Background loop for environment polling."""
    global _running
    _running = True
    logger.info(f"Environment context loop starting (interval: {POLL_INTERVAL}s)")

    try:
        await poll_environment()
    except Exception as e:
        logger.error(f"Environment initial fetch failed: {e}")

    while _running:
        await asyncio.sleep(POLL_INTERVAL)
        try:
            await poll_environment()
        except Exception as e:
            logger.error(f"Environment poll error: {e}")


def stop_environment():
    global _running
    _running = False
