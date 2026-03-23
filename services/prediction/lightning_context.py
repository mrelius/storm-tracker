"""
Storm Tracker — Lightning Trend Context

Provides lightning flash-rate trend states as a supporting confidence
signal. Lightning is NEVER a primary warning source.

States:
- increasing: flash rate accelerating (often precedes severe development)
- steady: stable flash rate
- decreasing: flash rate declining
- unknown: insufficient data

Current implementation: uses storm intensity_trend as a proxy signal
since Blitzortung public API is not reliably available.

When a real lightning data source is connected, replace the proxy
with actual flash-rate computation.

NOT an official forecast or warning source.
"""

import time
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class LightningContext:
    """Lightning trend assessment."""
    state: str = "unknown"            # increasing, steady, decreasing, unknown
    confidence: float = 0.0
    signals: list[str] = field(default_factory=list)
    explanation: str = ""
    source: str = "proxy"             # "proxy" | "blitzortung" | "glm"
    data_age_sec: float = 0
    suppressed: bool = False
    suppress_reason: str = ""

    # Modifier for confidence engine
    confidence_modifier: float = 0.0  # -0.1 to +0.1


def assess_lightning(
    intensity_trend: str = "unknown",
    speed_mph: float = 0,
    motion_confidence: float = 0,
    nws_event: str = "",
) -> LightningContext:
    """Assess lightning trend from available proxy signals.

    Uses intensity_trend from the storm tracker as a proxy for flash-rate
    trends. This is an approximation — intensifying storms generally have
    increasing lightning, weakening storms have decreasing lightning.

    Args:
        intensity_trend: from tracker ("strengthening", "stable", "weakening", "unknown")
        speed_mph: storm speed (fast storms with high intensity = more concern)
        motion_confidence: how reliable the intensity_trend is
        nws_event: NWS event type (tornado warnings amplify signal)
    """
    ctx = LightningContext()

    if motion_confidence < 0.2:
        ctx.suppressed = True
        ctx.suppress_reason = "insufficient_track_data"
        ctx.explanation = "Insufficient data for lightning assessment."
        return ctx

    signals = []

    # Map intensity trend to lightning proxy
    if intensity_trend == "strengthening":
        ctx.state = "increasing"
        signals.append("Storm intensifying (radar proxy)")
        ctx.confidence_modifier = 0.05

        # Tornado warning + intensifying = strong signal
        if nws_event == "Tornado Warning":
            signals.append("Active tornado warning amplifies concern")
            ctx.confidence_modifier = 0.1

    elif intensity_trend == "weakening":
        ctx.state = "decreasing"
        signals.append("Storm weakening (radar proxy)")
        ctx.confidence_modifier = -0.05

    elif intensity_trend == "stable":
        ctx.state = "steady"
        signals.append("Storm intensity stable (radar proxy)")
        ctx.confidence_modifier = 0.0

    else:
        ctx.state = "unknown"
        signals.append("Intensity trend unavailable")

    ctx.signals = signals
    ctx.confidence = round(motion_confidence * 0.5, 3)  # half-weight since it's a proxy
    ctx.source = "proxy"
    ctx.explanation = (
        f"Lightning trend: {ctx.state} (radar-derived proxy). "
        f"{'; '.join(signals)}. "
        f"Proxy signal — not direct lightning observation."
    )

    return ctx


def get_lightning_stub() -> dict:
    """Return a stub lightning context when no data is available."""
    return {
        "state": "unknown",
        "confidence": 0.0,
        "signals": ["No lightning data source connected"],
        "explanation": "Lightning monitoring not yet available.",
        "source": "none",
        "confidence_modifier": 0.0,
        "suppressed": True,
        "suppress_reason": "no_data_source",
    }
