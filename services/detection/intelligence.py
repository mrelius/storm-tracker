"""Alert intelligence — filtering, state-change detection, notification gating.

Reduces noise by:
- Suppressing low-value alerts when high-value ones exist
- Detecting meaningful state changes (impact upgrades, severity shifts)
- Gating notifications to trigger only on significant events
"""
import time

# Filtering limits
MAX_NEAR_MISS = 2
MAX_ALERTS_TOTAL = 5
NOTIFICATION_COOLDOWN = 300  # 5 minutes per alert_id


def filter_alerts(alerts: list[dict]) -> list[dict]:
    """Filter alert list to reduce noise while preserving critical information.

    Rules:
    - Never hide severity ≥ 3
    - If direct_hit exists → suppress passing, limit near_miss to MAX_NEAR_MISS
    - Otherwise → limit near_miss to 3, suppress uncertain
    - Total cap at MAX_ALERTS_TOTAL
    """
    if not alerts:
        return []

    # Separate by importance
    critical = [a for a in alerts if a.get("severity", 0) >= 3]
    direct = [a for a in alerts if a.get("impact") == "direct_hit" and a not in critical]
    near = [a for a in alerts if a.get("impact") == "near_miss" and a not in critical and a not in direct]
    passing = [a for a in alerts if a.get("impact") == "passing" and a not in critical]
    uncertain = [a for a in alerts if a.get("impact") == "uncertain" and a not in critical]

    has_direct = len(direct) > 0 or any(a.get("impact") == "direct_hit" for a in critical)

    result = list(critical)
    result.extend(direct)

    if has_direct:
        result.extend(near[:MAX_NEAR_MISS])
        # Suppress passing when direct_hit exists
    else:
        result.extend(near[:MAX_NEAR_MISS + 1])
        result.extend(passing[:1])

    # Cap total
    return result[:MAX_ALERTS_TOTAL]


class StateTracker:
    """Tracks previous alert state to detect meaningful changes.

    Stores per alert_id: {impact, severity, impact_severity_label}
    """

    def __init__(self):
        self._prev_states: dict[str, dict] = {}

    def detect_changes(self, alerts: list[dict]) -> dict[str, list[str]]:
        """Compare current alerts to previous state. Return changes per alert_id.

        Returns: {alert_id: [list of change descriptions]}
        """
        changes = {}
        current_ids = set()

        for alert in alerts:
            aid = alert.get("alert_id", "")
            current_ids.add(aid)
            prev = self._prev_states.get(aid)

            if prev is None:
                changes[aid] = ["new"]
                self._prev_states[aid] = _extract_state(alert)
                continue

            alert_changes = []
            curr = _extract_state(alert)

            # Impact upgrade
            impact_rank = {"uncertain": 0, "passing": 1, "near_miss": 2, "direct_hit": 3}
            if impact_rank.get(curr["impact"], 0) > impact_rank.get(prev["impact"], 0):
                alert_changes.append(f"impact_{prev['impact']}_to_{curr['impact']}")

            # Severity increase
            if curr["severity"] > prev["severity"]:
                alert_changes.append("severity_increased")

            # Impact severity upgrade
            sev_rank = {"low": 0, "moderate": 1, "high": 2, "critical": 3}
            if sev_rank.get(curr["impact_severity"], 0) > sev_rank.get(prev["impact_severity"], 0):
                alert_changes.append("impact_severity_upgraded")

            if alert_changes:
                changes[aid] = alert_changes

            self._prev_states[aid] = curr

        # Clean up departed alerts
        departed = set(self._prev_states.keys()) - current_ids
        for aid in departed:
            del self._prev_states[aid]

        return changes

    def clear(self):
        self._prev_states.clear()


def _extract_state(alert: dict) -> dict:
    return {
        "impact": alert.get("impact", "uncertain"),
        "severity": alert.get("severity", 0),
        "impact_severity": alert.get("impact_severity_label", "unknown"),
    }


class NotificationGate:
    """Controls which alerts deserve a notification push.

    Only triggers for meaningful events with per-alert cooldown.
    """

    def __init__(self):
        self._last_notified: dict[str, float] = {}

    def should_notify(self, alert: dict, changes: list[str] | None = None) -> bool:
        """Determine if this alert warrants a notification.

        Triggers on:
        - New direct_hit
        - Impact upgrade to direct_hit
        - Severity ≥ 3
        - Impact severity upgraded to critical/high

        Suppresses:
        - Passing/uncertain alerts
        - Repeated notifications within cooldown
        - Minor changes (small ETA shifts, wording updates)
        """
        aid = alert.get("alert_id", "")
        impact = alert.get("impact", "uncertain")
        severity = alert.get("severity", 0)

        # Never notify for passing/uncertain
        if impact in ("passing", "uncertain"):
            return False

        # Check cooldown
        now = time.time()
        last = self._last_notified.get(aid, 0)
        if now - last < NOTIFICATION_COOLDOWN:
            # Allow escalation to bypass cooldown
            if changes and any("direct_hit" in c or "severity_increased" in c for c in changes):
                pass  # bypass cooldown
            else:
                return False

        # Trigger conditions
        should = False

        if changes:
            if "new" in changes and impact == "direct_hit":
                should = True
            if any("direct_hit" in c for c in changes):
                should = True
            if "severity_increased" in changes and severity >= 3:
                should = True
            if "impact_severity_upgraded" in changes:
                should = True

        # Always notify for new severity ≥ 3
        if changes and "new" in changes and severity >= 3:
            should = True

        if should:
            self._last_notified[aid] = now

        return should

    def clear(self):
        self._last_notified.clear()
