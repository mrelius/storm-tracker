"""
Storm Tracker — Unified Confidence Engine

Combines motion confidence, data freshness, and prediction horizon
into a single trust score. Provides staleness decay and quality flags.

Confidence should DECREASE when:
- Data is stale (radar age > thresholds)
- Motion confidence is low
- Prediction horizon is longer
- Track is short (few positions)

Confidence should INCREASE when:
- Radar data is fresh
- Motion confidence is high
- Track has many consistent positions
"""

import time
from dataclasses import dataclass


@dataclass
class ConfidenceResult:
    """Unified confidence assessment."""
    score: float = 0.0            # 0-1 overall trust
    grade: str = "unknown"        # high, moderate, low, very_low, suppressed
    radar_fresh: bool = True
    radar_age_sec: float = 0.0
    source_health: str = "ok"     # ok, degraded, unavailable
    staleness_penalty: float = 0.0
    explanation: str = ""


# Staleness thresholds
FRESH_SEC = 120       # <2 min = fresh
AGING_SEC = 300       # <5 min = aging (small penalty)
STALE_SEC = 600       # <10 min = stale (large penalty)
DEAD_SEC = 900        # >15 min = suppress predictions


def compute_confidence(
    motion_confidence: float,
    track_confidence: float,
    data_timestamp: float,      # unix timestamp of most recent radar/alert data
    prediction_horizon_min: float = 0,
    source_available: bool = True,
) -> ConfidenceResult:
    """Compute unified confidence score with staleness decay.

    Args:
        motion_confidence: 0-1 from tracker
        track_confidence: 0-1 from tracker
        data_timestamp: when the underlying data was captured
        prediction_horizon_min: how far ahead we're predicting (0=current)
        source_available: whether radar/alert source is reachable
    """
    now = time.time()
    age_sec = max(0, now - data_timestamp) if data_timestamp > 0 else DEAD_SEC

    result = ConfidenceResult()
    result.radar_age_sec = round(age_sec, 1)

    # Source health
    if not source_available:
        result.source_health = "unavailable"
        result.score = 0.0
        result.grade = "suppressed"
        result.explanation = "Data source unavailable."
        return result

    # Staleness penalty
    if age_sec < FRESH_SEC:
        result.radar_fresh = True
        result.staleness_penalty = 0.0
    elif age_sec < AGING_SEC:
        result.radar_fresh = True
        result.staleness_penalty = 0.1
    elif age_sec < STALE_SEC:
        result.radar_fresh = False
        result.staleness_penalty = 0.3
        result.source_health = "degraded"
    elif age_sec < DEAD_SEC:
        result.radar_fresh = False
        result.staleness_penalty = 0.6
        result.source_health = "degraded"
    else:
        result.radar_fresh = False
        result.staleness_penalty = 1.0
        result.source_health = "unavailable"
        result.score = 0.0
        result.grade = "suppressed"
        result.explanation = f"Data is {age_sec/60:.0f} min old. Predictions suppressed."
        return result

    # Base confidence from tracker
    base = (motion_confidence * 0.6 + track_confidence * 0.4)

    # Horizon decay: longer predictions = lower confidence
    horizon_decay = max(0.1, 1.0 - (prediction_horizon_min / 90.0))

    # Combined score
    score = base * horizon_decay * (1.0 - result.staleness_penalty)
    result.score = round(max(0, min(1, score)), 3)

    # Grade
    if result.score >= 0.7:
        result.grade = "high"
    elif result.score >= 0.4:
        result.grade = "moderate"
    elif result.score >= 0.2:
        result.grade = "low"
    else:
        result.grade = "very_low"

    # Explanation
    parts = []
    if result.radar_fresh:
        parts.append("fresh data")
    else:
        parts.append(f"data {age_sec/60:.0f}min old")
    if motion_confidence >= 0.7:
        parts.append("strong motion track")
    elif motion_confidence >= 0.4:
        parts.append("moderate motion track")
    else:
        parts.append("weak motion track")
    if prediction_horizon_min > 0:
        parts.append(f"{prediction_horizon_min:.0f}min horizon")
    result.explanation = f"Confidence: {result.grade} ({', '.join(parts)})"

    return result
