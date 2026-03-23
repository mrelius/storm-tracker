"""
Storm Tracker — Severity Trend Projection

Classifies current severity trend and projects forward.
Uses intensity_trend, motion confidence, and NWS severity
to produce a human-readable severity outlook.

NOT an official forecast.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class SeverityTrend:
    """Severity trend analysis result."""
    state: str = "unknown"        # weakening, steady, intensifying, rapidly_intensifying
    confidence: float = 0.0
    signals: list[str] = None     # human-readable signals
    projected_state_15m: str = "unknown"
    projected_state_30m: str = "unknown"
    projected_state_60m: str = "unknown"
    explanation: str = ""
    suppressed: bool = False
    suppress_reason: str = ""

    def __post_init__(self):
        if self.signals is None:
            self.signals = []


# NWS event severity ranking
EVENT_SEVERITY = {
    "Tornado Warning": 5,
    "Severe Thunderstorm Warning": 4,
    "Tornado Watch": 3,
    "Flash Flood Warning": 3,
    "Flood Warning": 2,
    "Winter Storm Warning": 2,
    "Special Weather Statement": 1,
}

# Trend states ordered by severity
TREND_ORDER = ["weakening", "steady", "intensifying", "rapidly_intensifying"]


def analyze_severity_trend(
    intensity_trend: str,
    nws_event: str,
    nws_severity: str,
    speed_mph: float,
    motion_confidence: float,
    track_confidence: float,
    cpa_distance_mi: Optional[float] = None,
    impact: str = "uncertain",
) -> SeverityTrend:
    """Analyze current severity trend and project forward.

    Combines radar-derived intensity trend with NWS severity context
    and proximity data to produce a human-readable trend assessment.
    """
    result = SeverityTrend()

    # Gate
    if track_confidence < 0.2:
        result.suppressed = True
        result.suppress_reason = "track_confidence too low"
        result.explanation = "Insufficient track history for trend analysis."
        return result

    signals = []

    # Map intensity_trend to state
    if intensity_trend == "strengthening":
        result.state = "intensifying"
        signals.append("Radar intensity increasing")
    elif intensity_trend == "weakening":
        result.state = "weakening"
        signals.append("Radar intensity decreasing")
    elif intensity_trend == "stable":
        result.state = "steady"
        signals.append("Radar intensity stable")
    else:
        result.state = "unknown"

    # NWS event context
    event_sev = EVENT_SEVERITY.get(nws_event, 0)
    if event_sev >= 5:
        signals.append(f"Active {nws_event}")
        if result.state in ("intensifying", "steady"):
            result.state = "rapidly_intensifying" if result.state == "intensifying" else "intensifying"
    elif event_sev >= 4:
        signals.append(f"Active {nws_event}")

    # Proximity amplifies concern
    if cpa_distance_mi is not None and cpa_distance_mi < 10 and impact in ("direct_hit", "near_miss"):
        signals.append(f"Approaching within {cpa_distance_mi:.0f} mi")
        if result.state == "intensifying":
            result.state = "rapidly_intensifying"

    # Speed context
    if speed_mph >= 50:
        signals.append(f"Fast-moving ({speed_mph:.0f} mph)")

    result.signals = signals

    # Forward projection (simple persistence with decay toward steady)
    if result.state == "rapidly_intensifying":
        result.projected_state_15m = "rapidly_intensifying"
        result.projected_state_30m = "intensifying"
        result.projected_state_60m = "steady"
    elif result.state == "intensifying":
        result.projected_state_15m = "intensifying"
        result.projected_state_30m = "intensifying"
        result.projected_state_60m = "steady"
    elif result.state == "weakening":
        result.projected_state_15m = "weakening"
        result.projected_state_30m = "weakening"
        result.projected_state_60m = "weakening"
    elif result.state == "steady":
        result.projected_state_15m = "steady"
        result.projected_state_30m = "steady"
        result.projected_state_60m = "steady"
    else:
        result.projected_state_15m = "unknown"
        result.projected_state_30m = "unknown"
        result.projected_state_60m = "unknown"

    # Confidence
    result.confidence = round(min(track_confidence, motion_confidence) * 0.8 + 0.1, 3)

    # Explanation
    signal_text = "; ".join(signals) if signals else "No clear signals"
    result.explanation = (
        f"Trend: {result.state}. {signal_text}. "
        f"App analysis based on current data — not an official NWS assessment."
    )

    return result
