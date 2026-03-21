"""Storm simulation — synthetic candidates for testing the full pipeline.

Instant scenarios: inject once, see results immediately.
Timed scenarios: evolve over multiple cycles to test tracking, ranking, decay.
"""
import asyncio
import math
import time
import logging
from services.detection.adapter import BaseStormCandidate

logger = logging.getLogger(__name__)

# --- Instant Scenarios ---

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
        "description": "Storm that escalates on repeated calls",
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

# --- Timed Scenarios ---

TIMED_SCENARIOS = {
    "slow_mover": {
        "description": "Drifting storm, ETA stability test (60s)",
        "steps": 8, "interval": 8,
    },
    "weakening_storm": {
        "description": "Strong storm weakens below threshold (48s)",
        "steps": 6, "interval": 8,
    },
    "priority_flip": {
        "description": "Storm B overtakes storm A in priority (48s)",
        "steps": 6, "interval": 8,
    },
    "tracked_storm": {
        "description": "Persistent storm with stable motion — produces real ETA (80s, 10 steps)",
        "steps": 10, "interval": 8,
    },
}

_escalation_count = 0
_active_task: asyncio.Task | None = None
_simulation_active = False


def is_simulation_active() -> bool:
    return _simulation_active


def set_simulation_active(val: bool):
    global _simulation_active
    _simulation_active = val


def get_scenario_candidates(scenario: str, lat: float, lon: float) -> list[BaseStormCandidate]:
    global _escalation_count
    if scenario not in SCENARIOS:
        return []
    candidates = SCENARIOS[scenario]["candidates"](lat, lon)
    if scenario == "escalation":
        _escalation_count += 1
        if _escalation_count >= 2:
            for c in candidates:
                c.reflectivity_dbz = 68
                c.velocity_delta = 55
                c.cc_min = 0.65
    return candidates


def _slow_mover_step(step, lat, lon):
    offset = step * 0.02
    dbz = 58 + math.sin(step * 0.8) * 4
    return [BaseStormCandidate(
        id="sim_slow_1", lat=lat - 0.15 + offset, lon=lon - 0.1 + offset * 0.5,
        reflectivity_dbz=round(dbz, 1), velocity_delta=40 + step % 3,
        cc_min=None, nws_event="Severe Thunderstorm Warning",
        nws_severity="Severe", last_updated=time.time(),
    )]


def _weakening_step(step, lat, lon):
    dbz = 62 - step * 5
    vel = max(0, 45 - step * 8)
    if dbz < 40:
        return []
    return [BaseStormCandidate(
        id="sim_weak_1", lat=lat - 0.1 + step * 0.015, lon=lon + step * 0.01,
        reflectivity_dbz=dbz, velocity_delta=vel if vel > 0 else None,
        cc_min=None, nws_event="Severe Thunderstorm Warning",
        nws_severity="Severe" if dbz >= 50 else "Moderate",
        last_updated=time.time(),
    )]


def _priority_flip_step(step, lat, lon):
    a_dbz = 60 - step * 3
    b_dbz = 45 + step * 5
    return [
        BaseStormCandidate(
            id="sim_flip_a", lat=lat - 0.1, lon=lon - 0.05,
            reflectivity_dbz=max(40, a_dbz), velocity_delta=max(0, 42 - step * 5),
            cc_min=None, nws_event="Severe Thunderstorm Warning",
            nws_severity="Severe" if a_dbz >= 55 else "Moderate",
            last_updated=time.time(),
        ),
        BaseStormCandidate(
            id="sim_flip_b", lat=lat + 0.15, lon=lon + 0.1,
            reflectivity_dbz=min(70, b_dbz), velocity_delta=min(55, 20 + step * 7),
            cc_min=0.75 if b_dbz >= 60 else None,
            nws_event="Tornado Warning" if b_dbz >= 55 else "Severe Thunderstorm Warning",
            nws_severity="Extreme" if b_dbz >= 60 else "Severe",
            last_updated=time.time(),
        ),
    ]


def _tracked_storm_step(step, lat, lon):
    """Persistent storm with consistent NE movement toward user.

    Moves ~0.03° per step (≈2mi), heading NE.
    Consistent high reflectivity to maintain detection.
    Designed to build tracking history → produce real ETA.
    """
    # Start 20mi SW of user, move NE consistently
    storm_lat = lat - 0.3 + step * 0.03
    storm_lon = lon - 0.3 + step * 0.03
    return [BaseStormCandidate(
        id="sim_tracked_1",
        lat=round(storm_lat, 4),
        lon=round(storm_lon, 4),
        reflectivity_dbz=60,
        velocity_delta=42,
        cc_min=None,
        nws_event="Severe Thunderstorm Warning",
        nws_severity="Extreme",
        last_updated=time.time(),
    )]


STEP_FUNCTIONS = {
    "slow_mover": _slow_mover_step,
    "weakening_storm": _weakening_step,
    "priority_flip": _priority_flip_step,
    "tracked_storm": _tracked_storm_step,
}


async def run_timed_scenario(scenario: str, lat: float, lon: float, inject_fn):
    """Run a timed scenario. inject_fn(candidates) pushes into pipeline."""
    global _simulation_active
    config = TIMED_SCENARIOS[scenario]
    step_fn = STEP_FUNCTIONS[scenario]
    _simulation_active = True

    logger.info(f"Timed sim '{scenario}' starting ({config['steps']} steps)")
    for step in range(config["steps"]):
        if not _simulation_active:
            break
        candidates = step_fn(step, lat, lon)
        await inject_fn(candidates)
        if step < config["steps"] - 1:
            await asyncio.sleep(config["interval"])
    logger.info(f"Timed sim '{scenario}' complete")


def reset_simulation():
    global _escalation_count, _simulation_active, _active_task
    _escalation_count = 0
    _simulation_active = False
    if _active_task and not _active_task.done():
        _active_task.cancel()
    _active_task = None


def set_active_task(task):
    global _active_task
    _active_task = task


def list_scenarios() -> dict:
    result = {k: v["description"] for k, v in SCENARIOS.items()}
    result.update({k: v["description"] for k, v in TIMED_SCENARIOS.items()})
    return result
