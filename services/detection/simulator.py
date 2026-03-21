"""Storm simulation — generates synthetic candidates for testing the full pipeline.

Scenarios inject BaseStormCandidate objects into the real adapter,
which then flow through tracking → detection → alerts → WS/UI.
"""
import time
from services.detection.adapter import BaseStormCandidate

# Scenarios relative to a reference point
SCENARIOS = {
    "direct_hit": {
        "description": "Severe storm heading directly at user",
        "candidates": lambda lat, lon: [
            BaseStormCandidate(
                id="sim_direct_1", lat=lat - 0.15, lon=lon - 0.1,
                reflectivity_dbz=62, velocity_delta=45, cc_min=0.72,
                nws_event="Tornado Warning", nws_severity="Extreme",
                last_updated=time.time(),
            ),
        ],
    },
    "near_miss": {
        "description": "Strong storm passing nearby",
        "candidates": lambda lat, lon: [
            BaseStormCandidate(
                id="sim_near_1", lat=lat - 0.2, lon=lon + 0.15,
                reflectivity_dbz=56, velocity_delta=38, cc_min=None,
                nws_event="Severe Thunderstorm Warning", nws_severity="Severe",
                last_updated=time.time(),
            ),
        ],
    },
    "multi_storm": {
        "description": "Multiple storms at varying distances",
        "candidates": lambda lat, lon: [
            BaseStormCandidate(
                id="sim_multi_1", lat=lat - 0.1, lon=lon - 0.05,
                reflectivity_dbz=65, velocity_delta=50, cc_min=0.68,
                nws_event="Tornado Warning", nws_severity="Extreme",
                last_updated=time.time(),
            ),
            BaseStormCandidate(
                id="sim_multi_2", lat=lat + 0.3, lon=lon - 0.2,
                reflectivity_dbz=55, velocity_delta=35, cc_min=None,
                nws_event="Severe Thunderstorm Warning", nws_severity="Severe",
                last_updated=time.time(),
            ),
            BaseStormCandidate(
                id="sim_multi_3", lat=lat - 0.4, lon=lon + 0.3,
                reflectivity_dbz=48, velocity_delta=None, cc_min=None,
                nws_event="Tornado Watch", nws_severity="Moderate",
                last_updated=time.time(),
            ),
        ],
    },
    "escalation": {
        "description": "Storm that will escalate on second call",
        "candidates": lambda lat, lon: [
            BaseStormCandidate(
                id="sim_esc_1", lat=lat - 0.12, lon=lon - 0.05,
                reflectivity_dbz=58, velocity_delta=42, cc_min=0.74,
                nws_event="Tornado Warning", nws_severity="Extreme",
                last_updated=time.time(),
            ),
        ],
    },
}

# Track escalation state
_escalation_call_count = 0


def get_scenario_candidates(scenario: str, lat: float, lon: float) -> list[BaseStormCandidate]:
    """Generate synthetic candidates for a given scenario."""
    global _escalation_call_count

    if scenario not in SCENARIOS:
        return []

    candidates = SCENARIOS[scenario]["candidates"](lat, lon)

    # Escalation scenario: increase intensity on repeated calls
    if scenario == "escalation":
        _escalation_call_count += 1
        if _escalation_call_count >= 2:
            for c in candidates:
                c.reflectivity_dbz = 68
                c.velocity_delta = 55
                c.cc_min = 0.65

    return candidates


def reset_simulation():
    global _escalation_call_count
    _escalation_call_count = 0


def list_scenarios() -> dict:
    return {k: v["description"] for k, v in SCENARIOS.items()}
