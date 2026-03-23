"""
Storm Tracker — Predictive Guidance Engine

Read-only interpretation layer. Consumes prediction, SPC, and tracking
data to produce a single prioritized guidance output telling the user
what to pay attention to.

Rules are deterministic and explainable. Output is never presented as
an official forecast — it is app-generated situational awareness.

Priority levels:
  critical — immediate action warranted (tornado approaching)
  high     — significant threat developing
  elevated — conditions favorable, be aware
  low      — no immediate concern
  none     — no relevant signals, suppress card
"""

import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class GuidanceOutput:
    priority: str = "none"          # none, low, elevated, high, critical
    score: int = 0                  # raw priority score for logging/validation
    headline: str = ""
    messages: list[str] = field(default_factory=list)
    reasoning: list[str] = field(default_factory=list)
    suppressed: bool = False
    suppress_reason: str = ""
    generated_at: float = 0


# ── Event class severity ranking ─────────────────────────────────
EVENT_RANK = {
    "Tornado Warning": 5,
    "Severe Thunderstorm Warning": 4,
    "Tornado Watch": 3,
    "Flash Flood Warning": 2,
    "Flood Warning": 1,
}

# ── SPC risk ranking ─────────────────────────────────────────────
SPC_RANK = {
    "HIGH": 6, "MDT": 5, "ENH": 4, "SLGT": 3, "MRGL": 2, "TSTM": 1,
}


def generate_guidance(
    prediction: Optional[dict] = None,
    spc_risk: Optional[dict] = None,
    tracked_event: Optional[str] = None,
    user_lat: Optional[float] = None,
    user_lon: Optional[float] = None,
) -> GuidanceOutput:
    """Generate prioritized guidance from all available signals.

    Args:
        prediction: from /api/prediction/summary (may be None)
        spc_risk: from /api/spc/risk (may be None)
        tracked_event: NWS event type string (e.g. "Tornado Warning")
        user_lat/lon: user GPS location
    """
    out = GuidanceOutput(generated_at=time.time())
    signals = []       # (priority_score, headline, messages, reasoning)

    # ── 1. Prediction-based signals ──────────────────────────────
    if prediction and not prediction.get("suppressed"):
        eta = prediction.get("eta", {})
        sev = prediction.get("severity_trend", {})
        qual = prediction.get("quality", {})
        proj = prediction.get("projection", {})

        eta_min = eta.get("eta_minutes")
        impact = eta.get("impact_type", "uncertain")
        trend_state = sev.get("state", "unknown")
        confidence = qual.get("enriched_score", qual.get("confidence_score", 0))
        grade = qual.get("confidence_grade", "low")

        # Suppress if confidence is very low
        if grade == "suppressed" or confidence < 0.15:
            pass  # skip prediction signals
        else:
            event_rank = EVENT_RANK.get(tracked_event, 0)

            # Critical: tornado approaching user within 30 min
            if event_rank >= 5 and eta_min is not None and eta_min <= 30 and impact in ("direct_hit", "near_miss"):
                window = eta.get("eta_window", {})
                lo = window.get("min", eta_min)
                hi = window.get("max", eta_min)
                signals.append((100, "Tornado threat approaching",
                    [f"Storm expected near your location in ~{int(lo)}–{int(hi)} minutes",
                     f"Impact: {impact.replace('_', ' ')}"],
                    [f"Tornado Warning + ETA {int(eta_min)}min + {impact}",
                     f"Confidence: {grade} ({int(confidence*100)}%)"]))

            # High: tornado farther out or SVR approaching
            elif event_rank >= 5 and eta_min is not None and eta_min <= 60:
                signals.append((80, "Tornado warning active",
                    [f"Storm may approach in ~{int(eta_min)} minutes"],
                    [f"Tornado Warning + ETA {int(eta_min)}min"]))

            elif event_rank >= 4 and eta_min is not None and eta_min <= 30 and impact in ("direct_hit", "near_miss"):
                signals.append((70, "Severe storm approaching",
                    [f"Storm expected near your location in ~{int(eta_min)} minutes",
                     f"Impact: {impact.replace('_', ' ')}"],
                    [f"SVR Warning + ETA {int(eta_min)}min + {impact}"]))

            # Intensifying storm
            if trend_state == "rapidly_intensifying" and event_rank >= 4:
                signals.append((75, "Storm rapidly intensifying",
                    ["Radar shows increasing intensity"],
                    [f"Severity trend: {trend_state}"]))
            elif trend_state == "intensifying" and event_rank >= 4:
                signals.append((55, "Storm intensifying",
                    ["Radar shows increasing intensity"],
                    [f"Severity trend: {trend_state}"]))

            # Weakening / departing
            if trend_state == "weakening" or impact == "passing":
                signals.append((15, "Threat diminishing",
                    ["Storm is weakening or moving away"],
                    [f"Trend: {trend_state}, impact: {impact}"]))

    # ── 2. SPC-based signals ─────────────────────────────────────
    if spc_risk:
        risk_cat = spc_risk.get("risk", {}).get("category", "none")
        risk_label = spc_risk.get("risk", {}).get("label", "")
        watch_status = spc_risk.get("watch", {}).get("status", "none")
        regional_level = spc_risk.get("regional", {}).get("level", "none")
        messages_from_spc = spc_risk.get("context_messages", [])

        spc_rank = SPC_RANK.get(risk_cat, 0)

        # Watch + Enhanced/Moderate/High risk
        if watch_status == "in_watch":
            watch_events = [w.get("event", "") for w in spc_risk.get("watch", {}).get("watches", [])]
            if "Tornado Watch" in watch_events:
                signals.append((65, "Tornado Watch active",
                    ["You are inside an active Tornado Watch",
                     "Conditions favorable for tornado development"],
                    ["SPC Tornado Watch + user inside polygon"]))
            else:
                signals.append((50, "Severe Thunderstorm Watch active",
                    ["You are inside an active watch area"],
                    [f"SPC {', '.join(watch_events)}"]))

        elif spc_rank >= 4:  # ENH+
            signals.append((45, f"SPC {risk_label}",
                [f"Your area is in the SPC {risk_label} area",
                 "Environment favorable for severe storms"],
                [f"SPC Day 1: {risk_cat}"]))

        elif spc_rank >= 3:  # SLGT
            signals.append((25, f"SPC {risk_label}",
                [f"Your area is in the SPC {risk_label} area"],
                [f"SPC Day 1: {risk_cat}"]))

        elif spc_rank >= 2:  # MRGL
            signals.append((10, "Marginal severe risk",
                ["Low probability of severe weather nearby"],
                [f"SPC Day 1: {risk_cat}"]))

    # ── 3. No-signal case ────────────────────────────────────────
    if not signals:
        out.priority = "none"
        out.suppressed = True
        out.suppress_reason = "no_relevant_signals"
        return out

    # ── 4. Select highest-priority signal ────────────────────────
    signals.sort(key=lambda s: s[0], reverse=True)
    best = signals[0]
    score = best[0]

    if score >= 80:
        out.priority = "critical"
    elif score >= 50:
        out.priority = "high"
    elif score >= 25:
        out.priority = "elevated"
    elif score >= 5:
        out.priority = "low"
    else:
        out.priority = "none"
        out.suppressed = True
        out.suppress_reason = "score_too_low"
        return out

    out.score = score
    out.headline = best[1]
    out.messages = best[2]
    out.reasoning = best[3]

    # Add secondary signals as additional reasoning
    for sig in signals[1:3]:
        out.reasoning.append(f"Also: {sig[1]} (score {sig[0]})")

    return out
