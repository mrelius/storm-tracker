"""Threat prioritization engine.

Ranks active alerts by a deterministic composite score.
Selects one primary threat plus ordered secondary threats.

Scoring formula (documented):
  threat_score =
    type_weight      × 0.40    (alert type severity, 0-100)
  + proximity_score  × 0.25    (distance + ETA bonus, 0-100)
  + trend_score      × 0.20    (closing/departing motion, 0-100)
  + confidence       × 0.15    (detection confidence, 0-1 → 0-100)

Anti-thrash: primary only changes if challenger exceeds current by HYSTERESIS points.
"""

# Type weights: relative urgency of each detection type
# debris_signature = confirmed tornado indicator = highest
# rotation = strong rotation = high
# strong_storm = significant storm = moderate
# storm_proximity = awareness = baseline
TYPE_WEIGHTS = {
    "debris_signature": 100,
    "rotation": 75,
    "strong_storm": 50,
    "storm_proximity": 40,
}
DEFAULT_TYPE_WEIGHT = 30

# Trend scores
TREND_SCORES = {
    "closing": 100,
    "departing": 0,
    "unknown": 30,
}

# Formula weights (must sum to 1.0)
W_TYPE = 0.40
W_PROXIMITY = 0.25
W_TREND = 0.20
W_CONFIDENCE = 0.15

# Anti-thrash: primary only changes if challenger exceeds by this margin
HYSTERESIS = 5.0


def compute_threat_score(alert: dict) -> float:
    """Compute composite threat score for an alert dict.

    Returns a score from 0-100. Higher = more urgent/relevant.
    All inputs are from the alert payload (dict with standard fields).
    """
    # Type weight
    alert_type = alert.get("type", "")
    type_score = TYPE_WEIGHTS.get(alert_type, DEFAULT_TYPE_WEIGHT)

    # Proximity score: closer = higher, with ETA bonus
    distance = alert.get("distance_mi", 999)
    prox = max(0, 100 - distance * 3)  # 0 mi = 100, 33 mi = 0

    eta = alert.get("eta_min")
    if eta is not None and eta > 0:
        eta_bonus = max(0, min(60, 30 - eta)) * 2  # <30 min = bonus, max 60 pts
        prox = min(100, prox + eta_bonus)

    # Trend score — uses explicit trend field, modulated by confidence
    trend = alert.get("trend", "unknown")
    trend_base = TREND_SCORES.get(trend, TREND_SCORES["unknown"])
    trend_conf = alert.get("trend_confidence", 0.5)
    # Scale trend influence by confidence (low confidence → weaker signal)
    trend_val = trend_base * max(0.3, trend_conf)  # floor at 30% to avoid zeroing out

    # Confidence (0-1 → 0-100)
    confidence = alert.get("confidence", 0.5)
    conf_score = confidence * 100

    # Impact modifier
    impact = alert.get("impact", "uncertain")
    impact_mod = {
        "direct_hit": 1.2,
        "near_miss": 1.0,
        "passing": 0.7,
        "uncertain": 0.9,
    }.get(impact, 0.9)

    # Composite
    score = (
        type_score * W_TYPE
        + prox * W_PROXIMITY
        + trend_val * W_TREND
        + conf_score * W_CONFIDENCE
    ) * impact_mod

    return round(min(100, score), 1)


def explain_score(alert: dict, score: float) -> str:
    """Generate a concise human-readable explanation of why this alert ranks where it does."""
    parts = []

    alert_type = alert.get("type", "")
    if alert_type == "debris_signature":
        parts.append("Debris signature")
    elif alert_type == "rotation":
        parts.append("Rotation detected")
    elif alert_type == "strong_storm":
        parts.append("Strong storm")
    else:
        parts.append("Storm nearby")

    distance = alert.get("distance_mi", 999)
    if distance < 10:
        parts.append(f"{distance:.0f} mi")

    eta = alert.get("eta_min")
    if eta is not None and eta > 0:
        parts.append(f"~{int(eta)} min ETA")

    confidence = alert.get("confidence", 0)
    if confidence >= 0.6:
        parts.append("high confidence")
    elif confidence < 0.3:
        parts.append("developing")

    return ", ".join(parts)


def compute_primary_reason(alert: dict) -> str:
    """Pick the single most human-relevant reason this alert ranks highest.

    Priority-ordered selection from real signals — not raw math component max.
    Returns a short 2-4 word phrase.
    """
    alert_type = alert.get("type", "")
    impact = alert.get("impact", "uncertain")
    distance = alert.get("distance_mi", 999)
    trend = alert.get("trend", "unknown")
    severity = alert.get("severity", 0)

    # 1. Debris / strongest direct severe evidence
    if alert_type == "debris_signature":
        return "Debris detected"

    # 2. Direct path / impact trajectory
    if impact == "direct_hit":
        return "Direct path"

    # 3. Very close proximity
    if distance < 5:
        return "Very close"
    if distance < 10:
        return "Closest threat"

    # 4. Clearly closing / approaching
    if trend == "closing":
        return "Approaching"

    # 5. High severity / strongest signal
    if alert_type == "rotation":
        return "Rotation detected"
    if severity >= 3:
        return "High severity"

    # 6. Fallback
    return "Strongest signal"


def compute_secondary_context(alert: dict, primary: dict) -> str:
    """Return one short contrast reason versus the primary storm.

    Picks the single most salient difference.
    """
    p_dist = primary.get("distance_mi", 999)
    s_dist = alert.get("distance_mi", 999)
    p_trend = primary.get("trend", "unknown")
    s_trend = alert.get("trend", "unknown")
    p_sev = primary.get("severity", 0)
    s_sev = alert.get("severity", 0)
    p_conf = primary.get("confidence_level", "low")
    s_conf = alert.get("confidence_level", "low")

    # Pick single most relevant contrast
    if s_dist > p_dist + 5:
        return "Farther away"
    if s_sev < p_sev:
        return "Weaker"
    if p_trend == "closing" and s_trend != "closing":
        return "Not approaching"
    if p_conf in ("high", "medium") and s_conf == "low":
        return "Lower confidence"
    if s_dist > p_dist:
        return "Farther away"

    return ""


def rank_alerts(alerts: list[dict]) -> dict:
    """Rank alerts by threat score and select primary threat.

    Returns:
        {
            "primary_threat": dict | None,
            "alerts": [ranked dicts with threat_score + threat_reason],
            "count": int,
        }
    """
    if not alerts:
        return {"primary_threat": None, "alerts": [], "count": 0}

    # Score each alert
    scored = []
    for alert in alerts:
        score = compute_threat_score(alert)
        alert_copy = dict(alert)
        alert_copy["threat_score"] = score
        alert_copy["threat_reason"] = explain_score(alert, score)
        scored.append(alert_copy)

    # Sort by score descending, then severity descending as tie-break
    scored.sort(key=lambda a: (-a["threat_score"], -a.get("severity", 0)))

    # Add rank position + primary reason + secondary context
    primary = scored[0] if scored else None
    for i, a in enumerate(scored):
        a["rank_position"] = i + 1
        if i == 0:
            a["primary_reason"] = compute_primary_reason(a)
            a["secondary_context"] = ""
        else:
            a["primary_reason"] = ""
            a["secondary_context"] = compute_secondary_context(a, primary) if primary else ""

    return {
        "primary_threat": primary,
        "alerts": scored,
        "count": len(scored),
    }


class ThreatRanker:
    """Stateful threat ranker with anti-thrash hysteresis.

    Maintains the current primary threat ID and only changes
    if a challenger exceeds the current by HYSTERESIS points.
    """

    def __init__(self):
        self._current_primary_id: str | None = None

    def rank(self, alerts: list[dict]) -> dict:
        """Rank alerts with anti-thrash for primary selection."""
        result = rank_alerts(alerts)

        if not result["alerts"]:
            self._current_primary_id = None
            return result

        # Find current primary's score in the new ranking
        current_score = 0
        challenger = result["alerts"][0]
        challenger_id = challenger.get("alert_id", "")

        if self._current_primary_id:
            for a in result["alerts"]:
                if a.get("alert_id") == self._current_primary_id:
                    current_score = a["threat_score"]
                    break

        # Anti-thrash: keep current primary unless challenger wins by margin
        if (self._current_primary_id
                and self._current_primary_id != challenger_id
                and current_score > 0
                and challenger["threat_score"] - current_score < HYSTERESIS):
            # Keep current primary — find it and put it first
            for i, a in enumerate(result["alerts"]):
                if a.get("alert_id") == self._current_primary_id:
                    result["alerts"].insert(0, result["alerts"].pop(i))
                    result["primary_threat"] = result["alerts"][0]
                    break
        else:
            self._current_primary_id = challenger_id
            result["primary_threat"] = challenger

        return result

    def reset(self):
        self._current_primary_id = None
