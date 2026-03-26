"""
Storm Tracker — Storm State Demo Fixtures

Inject synthetic severe alerts through the real storm_state pipeline
for deterministic verification of:
  - TOR/SVR/FFW primary selection priority
  - Multi-polygon cluster rendering
  - Moving storm with heading/speed
  - Camera follow_primary activation
  - Audio arbitration triggers
  - Clean return to idle

All fixtures route through storm_state.update_from_ingest() — the same
path as real NWS data. No shortcuts.

Usage: GET /api/storm/demo/{scenario}
       GET /api/storm/demo/clear
"""

import time
import json
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter
from fastapi.responses import JSONResponse

try:
    from logging_config import get_logger
    logger = get_logger("storm_demo")
except ImportError:
    import logging
    logger = logging.getLogger("storm_demo")

from services.storm_state import update_from_ingest, clear as clear_state, get_serializable_state

router = APIRouter(prefix="/api/storm/demo", tags=["storm_demo"])

# ── Helpers ──────────────────────────────────────────────────────

def _make_polygon(lat, lon, size_deg=0.25):
    """Create a simple square polygon GeoJSON string."""
    half = size_deg / 2
    geo = {
        "type": "Polygon",
        "coordinates": [[
            [lon - half, lat - half],
            [lon + half, lat - half],
            [lon + half, lat + half],
            [lon - half, lat + half],
            [lon - half, lat - half],
        ]],
    }
    return json.dumps(geo)


def _make_alert(alert_id, event, lat, lon, size_deg=0.25, severity="Severe",
                description="", headline="", priority_score=50):
    """Create a synthetic alert dict matching the DB row schema."""
    now = datetime.now(timezone.utc)
    return {
        "id": f"demo-{alert_id}",
        "event": event,
        "severity": severity,
        "urgency": "Immediate",
        "certainty": "Observed",
        "category": "primary",
        "headline": headline or f"Demo {event}",
        "description": description,
        "instruction": "",
        "polygon": _make_polygon(lat, lon, size_deg),
        "onset": now.isoformat(),
        "expires": (now + timedelta(hours=1)).isoformat(),
        "issued": now.isoformat(),
        "sender": "demo",
        "priority_score": priority_score,
        "county_fips": [],
        "fips_list": "",
    }


# ── Scenarios ────────────────────────────────────────────────────

SCENARIOS = {}


def _register(scenario_id, label, description):
    """Decorator to register a scenario."""
    def decorator(fn):
        SCENARIOS[scenario_id] = {
            "id": scenario_id,
            "label": label,
            "description": description,
            "fn": fn,
        }
        return fn
    return decorator


@_register("tor_over_svr", "TOR Primary Over SVR",
           "TOR + SVR active — verify TOR is always selected as primary")
def _tor_over_svr():
    return [
        _make_alert("svr-1", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3,
                     description="70 mph winds and 1.5 inch hail", priority_score=60),
        _make_alert("svr-2", "Severe Thunderstorm Warning", 39.6, -84.3, 0.25,
                     description="60 mph wind gusts", priority_score=55),
        _make_alert("tor-1", "Tornado Warning", 39.45, -84.45, 0.2,
                     severity="Extreme",
                     description="TORNADO WARNING confirmed tornado on the ground",
                     priority_score=90),
    ]


@_register("svr_over_watch", "SVR Primary Over Watch",
           "SVR + Wind Advisory — verify SVR selected over non-severe watch")
def _svr_over_watch():
    return [
        _make_alert("watch-1", "High Wind Watch", 39.5, -84.5, 0.4,
                     severity="Moderate", priority_score=20),
        _make_alert("watch-2", "Wind Advisory", 39.6, -84.3, 0.3,
                     severity="Minor", priority_score=15),
        _make_alert("svr-1", "Severe Thunderstorm Warning", 39.55, -84.45, 0.25,
                     description="80 mph destructive winds",
                     priority_score=65),
    ]


@_register("ffw_primary", "FFW Primary Selection",
           "FFW + advisories — verify FFW selected as primary over non-severe")
def _ffw_primary():
    return [
        _make_alert("adv-1", "Winter Weather Advisory", 39.7, -84.6, 0.3,
                     severity="Moderate", priority_score=15),
        _make_alert("ffw-1", "Flash Flood Warning", 39.5, -84.5, 0.3,
                     description="Flash flood emergency for downtown",
                     priority_score=70),
        _make_alert("adv-2", "Heat Advisory", 39.4, -84.3, 0.25,
                     severity="Minor", priority_score=10),
    ]


@_register("multi_polygon_cluster", "Multi-Polygon Cluster",
           "8 mixed severe alerts — verify rendering, selection, polygon cap")
def _multi_polygon_cluster():
    return [
        _make_alert("mpc-tor1", "Tornado Warning", 39.5, -84.5, 0.25,
                     severity="Extreme", description="TORNADO WARNING PDS",
                     priority_score=95),
        _make_alert("mpc-tor2", "Tornado Warning", 39.55, -84.3, 0.2,
                     severity="Extreme", priority_score=90),
        _make_alert("mpc-svr1", "Severe Thunderstorm Warning", 39.6, -84.6, 0.3,
                     description="80 mph winds 2 inch hail", priority_score=65),
        _make_alert("mpc-svr2", "Severe Thunderstorm Warning", 39.4, -84.2, 0.25,
                     description="60 mph wind gusts", priority_score=55),
        _make_alert("mpc-svr3", "Severe Thunderstorm Warning", 39.7, -84.4, 0.2,
                     priority_score=50),
        _make_alert("mpc-ffw1", "Flash Flood Warning", 39.35, -84.7, 0.3,
                     priority_score=45),
        _make_alert("mpc-ffw2", "Flash Flood Warning", 39.65, -84.8, 0.25,
                     priority_score=40),
        _make_alert("mpc-sws1", "Special Weather Statement", 39.8, -84.5, 0.2,
                     severity="Minor", priority_score=10),
    ]


@_register("moving_storm", "Moving Storm",
           "Single TOR with motion vector — verify tracking data propagates")
def _moving_storm():
    return [
        _make_alert("mov-tor1", "Tornado Warning", 39.5, -84.5, 0.2,
                     severity="Extreme",
                     description="TORNADO WARNING moving northeast at 45 mph. "
                                 "Confirmed tornado near Hamilton at 2:15 PM.",
                     headline="Tornado Warning for Hamilton County",
                     priority_score=95),
    ]


@_register("audio_conflict", "Audio Arbitration Conflict",
           "TOR + SVR simultaneous — verify TOR audio takes priority")
def _audio_conflict():
    return [
        _make_alert("ac-svr1", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3,
                     description="70 mph winds", priority_score=60),
        _make_alert("ac-tor1", "Tornado Warning", 39.52, -84.48, 0.2,
                     severity="Extreme",
                     description="TORNADO WARNING immediate threat to life",
                     priority_score=95),
    ]


@_register("camera_follow", "Camera Follow Primary",
           "Single TOR with polygon — verify camera enters follow_primary mode")
def _camera_follow():
    return [
        _make_alert("cf-tor1", "Tornado Warning", 39.5, -84.5, 0.25,
                     severity="Extreme",
                     description="TORNADO WARNING for Butler County",
                     priority_score=95),
    ]


@_register("complex_polygon", "Complex Polygon Geometry",
           "Real-world polygon shapes — irregular, large, multi-vertex")
def _complex_polygon():
    """Irregular polygon shapes that stress the rendering engine."""
    now = datetime.now(timezone.utc)
    # Irregular TOR polygon (real-world-like wedge shape)
    tor_poly = {
        "type": "Polygon",
        "coordinates": [[
            [-84.55, 39.42], [-84.48, 39.44], [-84.40, 39.48],
            [-84.35, 39.52], [-84.33, 39.55], [-84.36, 39.56],
            [-84.42, 39.54], [-84.50, 39.50], [-84.56, 39.46],
            [-84.57, 39.43], [-84.55, 39.42],
        ]],
    }
    # Large SVR polygon covering wide area
    svr_poly = {
        "type": "Polygon",
        "coordinates": [[
            [-84.80, 39.30], [-84.60, 39.30], [-84.40, 39.35],
            [-84.20, 39.40], [-84.10, 39.50], [-84.15, 39.60],
            [-84.30, 39.65], [-84.50, 39.65], [-84.70, 39.60],
            [-84.85, 39.50], [-84.85, 39.40], [-84.80, 39.30],
        ]],
    }
    return [
        {
            "id": "demo-cpx-tor1",
            "event": "Tornado Warning",
            "severity": "Extreme",
            "urgency": "Immediate",
            "certainty": "Observed",
            "category": "primary",
            "headline": "Tornado Warning — irregular polygon",
            "description": "TORNADO WARNING confirmed wedge tornado",
            "instruction": "",
            "polygon": json.dumps(tor_poly),
            "onset": now.isoformat(),
            "expires": (now + timedelta(hours=1)).isoformat(),
            "issued": now.isoformat(),
            "sender": "demo",
            "priority_score": 95,
            "county_fips": [],
            "fips_list": "",
        },
        {
            "id": "demo-cpx-svr1",
            "event": "Severe Thunderstorm Warning",
            "severity": "Severe",
            "urgency": "Immediate",
            "certainty": "Observed",
            "category": "primary",
            "headline": "SVR — large area polygon",
            "description": "80 mph winds over wide area",
            "instruction": "",
            "polygon": json.dumps(svr_poly),
            "onset": now.isoformat(),
            "expires": (now + timedelta(hours=1)).isoformat(),
            "issued": now.isoformat(),
            "sender": "demo",
            "priority_score": 65,
            "county_fips": [],
            "fips_list": "",
        },
    ]


@_register("overlapping_alerts", "Overlapping Alert Polygons",
           "Multiple alerts covering the same geographic area — verify correct stacking")
def _overlapping_alerts():
    """3 alerts with overlapping polygons at the same location."""
    return [
        _make_alert("olap-tor1", "Tornado Warning", 39.5, -84.5, 0.3,
                     severity="Extreme",
                     description="TORNADO WARNING confirmed tornado",
                     priority_score=95),
        _make_alert("olap-svr1", "Severe Thunderstorm Warning", 39.5, -84.5, 0.4,
                     description="80 mph winds — overlaps TOR polygon",
                     priority_score=65),
        _make_alert("olap-ffw1", "Flash Flood Warning", 39.52, -84.48, 0.35,
                     description="Flash flooding — overlaps both TOR and SVR",
                     priority_score=50),
    ]


@_register("watch_to_warning", "Watch → Warning Upgrade",
           "Start with watch, upgrade to warning — verify primary switches")
def _watch_to_warning():
    """Simulates a watch being upgraded to a warning.
    Returns the 'after' state (warning present).
    For the full upgrade test, call with watch-only first, then this.
    """
    return [
        _make_alert("w2w-watch1", "Tornado Watch", 39.5, -84.5, 0.5,
                     severity="Moderate",
                     description="Tornado Watch for tri-state area",
                     priority_score=30),
        _make_alert("w2w-warn1", "Tornado Warning", 39.48, -84.48, 0.2,
                     severity="Extreme",
                     description="TORNADO WARNING inside existing watch area",
                     priority_score=95),
        _make_alert("w2w-svr1", "Severe Thunderstorm Warning", 39.55, -84.55, 0.25,
                     description="SVR also active in watch area",
                     priority_score=65),
    ]


# ── Endpoints ────────────────────────────────────────────────────

@router.get("/list")
async def list_scenarios():
    """List available demo scenarios."""
    return {
        "scenarios": [
            {"id": s["id"], "label": s["label"], "description": s["description"]}
            for s in SCENARIOS.values()
        ]
    }


@router.get("/run/{scenario_id}")
async def run_scenario(scenario_id: str):
    """Inject a demo scenario through the real storm_state pipeline."""
    if scenario_id not in SCENARIOS:
        return JSONResponse(
            status_code=404,
            content={"error": f"Unknown scenario: {scenario_id}",
                     "available": list(SCENARIOS.keys())},
        )

    scenario = SCENARIOS[scenario_id]
    alerts = scenario["fn"]()

    result = await update_from_ingest(alerts)

    logger.info("demo_scenario_injected",
                scenario=scenario_id,
                alert_count=len(alerts),
                primary_id=result["primary_id"],
                cycle_ms=result["cycle_ms"])

    state = get_serializable_state()

    return {
        "scenario": scenario_id,
        "label": scenario["label"],
        "injected": len(alerts),
        "result": result,
        "state": {
            "primary_id": state["primary_id"],
            "primary_event": state["alerts"].get(state["primary_id"], {}).get("event") if state["primary_id"] else None,
            "active_count": state["polygon_count"],
            "active_ids": state["active_ids"],
        },
    }


@router.get("/clear")
async def clear_demo():
    """Clear all demo data — restore storm_state to empty.

    Note: Next ingest cycle (60s) will repopulate with real NWS data.
    """
    clear_state()
    logger.info("demo_cleared")
    return {"status": "cleared", "message": "Storm state cleared. Real data returns on next ingest cycle."}


@router.get("/burst/{count}")
async def burst_updates(count: int = 50):
    """Fire rapid state updates for stress testing.

    Injects {count} sequential updates through the real pipeline.
    Each update modifies the alert set slightly to force a state change.

    Use to verify:
    - sequence_id strictly incrementing
    - no dropped WS broadcasts
    - frontend stability under load
    """
    if count < 1 or count > 100:
        return JSONResponse(status_code=400, content={"error": "count must be 1-100"})

    import asyncio
    results = []

    for i in range(count):
        lat_jitter = 39.5 + (i % 10) * 0.01
        lon_jitter = -84.5 + (i % 7) * 0.01

        alerts = [
            _make_alert(f"burst-tor-{i}", "Tornado Warning",
                        lat_jitter, lon_jitter, 0.2,
                        severity="Extreme",
                        description=f"TORNADO WARNING burst update {i+1}/{count}",
                        priority_score=95),
            _make_alert(f"burst-svr-{i}", "Severe Thunderstorm Warning",
                        lat_jitter + 0.1, lon_jitter - 0.1, 0.25,
                        description=f"SVR burst {i+1}",
                        priority_score=60),
        ]

        result = await update_from_ingest(alerts)
        results.append({
            "step": i + 1,
            "sequence_id": result.get("cycle_ms"),
            "primary_id": result["primary_id"],
        })

        # Small yield to allow WS broadcasts to fire
        await asyncio.sleep(0.01)

    final_state = get_serializable_state()

    logger.info("burst_test_completed",
                count=count,
                final_sequence=final_state.get("sequence_id", 0),
                final_primary=final_state.get("primary_id"))

    return {
        "test": "burst",
        "updates_fired": count,
        "final_sequence_id": final_state.get("sequence_id", 0),
        "final_primary_id": final_state.get("primary_id"),
        "final_active_count": final_state.get("polygon_count", 0),
    }


@router.get("/verify/{scenario_id}")
async def verify_scenario(scenario_id: str):
    """Run a scenario and return verification results."""
    if scenario_id not in SCENARIOS:
        return JSONResponse(status_code=404, content={"error": f"Unknown scenario: {scenario_id}"})

    scenario = SCENARIOS[scenario_id]
    alerts = scenario["fn"]()
    result = await update_from_ingest(alerts)
    state = get_serializable_state()

    # Build verification checks
    checks = []
    primary_id = state["primary_id"]
    primary_alert = state["alerts"].get(primary_id, {}) if primary_id else {}
    primary_event = primary_alert.get("event", "")

    # Check: primary selected
    checks.append({
        "check": "primary_selected",
        "pass": primary_id is not None,
        "detail": f"primary={primary_id}, event={primary_event}",
    })

    # Check: TOR is primary if any TOR exists
    has_tor = any("Tornado" in a.get("event", "") for a in state["alerts"].values())
    if has_tor:
        tor_is_primary = "Tornado" in primary_event
        checks.append({
            "check": "tor_is_primary",
            "pass": tor_is_primary,
            "detail": f"primary_event={primary_event}, expected=Tornado Warning",
        })

    # Check: SVR over non-severe if no TOR
    has_svr = any("Severe Thunderstorm" in a.get("event", "") for a in state["alerts"].values())
    if has_svr and not has_tor:
        svr_is_primary = "Severe Thunderstorm" in primary_event
        checks.append({
            "check": "svr_is_primary",
            "pass": svr_is_primary,
            "detail": f"primary_event={primary_event}, expected=Severe Thunderstorm Warning",
        })

    # Check: FFW over non-severe if no TOR/SVR
    has_ffw = any("Flash Flood" in a.get("event", "") for a in state["alerts"].values())
    if has_ffw and not has_tor and not has_svr:
        ffw_is_primary = "Flash Flood" in primary_event
        checks.append({
            "check": "ffw_is_primary",
            "pass": ffw_is_primary,
            "detail": f"primary_event={primary_event}, expected=Flash Flood Warning",
        })

    # Check: polygon count matches
    checks.append({
        "check": "polygon_count",
        "pass": state["polygon_count"] == len(alerts),
        "detail": f"expected={len(alerts)}, actual={state['polygon_count']}",
    })

    # Check: all alerts have polygons
    all_have_polygon = all(a.get("polygon") for a in state["alerts"].values())
    checks.append({
        "check": "all_polygons_present",
        "pass": all_have_polygon,
        "detail": f"with_polygon={sum(1 for a in state['alerts'].values() if a.get('polygon'))}/{len(state['alerts'])}",
    })

    all_pass = all(c["pass"] for c in checks)

    # Clear after verification
    clear_state()

    return {
        "scenario": scenario_id,
        "verdict": "PASS" if all_pass else "FAIL",
        "checks": checks,
    }
