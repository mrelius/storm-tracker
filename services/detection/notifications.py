"""Notification intelligence — controls WHEN the system notifies.

Delivery-agnostic: produces notification decisions and payloads.
Actual delivery (browser push, Telegram, etc.) handled elsewhere.

Trigger events:
  A) New significant alert (action_state >= be_ready OR debris)
  B) Escalation (action_state increased)
  C) Critical change (debris appears, ETA < 10 min)
  D) Resolution (alert expires after being active — optional, low noise)

Suppression:
  - Per-alert cooldown (5 min default, escalation bypasses)
  - Primary-only (secondary alerts suppressed unless independently critical)
  - Low confidence suppressed (unless debris)
  - Quiet hours (only take_action/debris allowed)
"""
import logging
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

# Cooldown per alert_id
COOLDOWN_SEC = 300  # 5 minutes

# Action state ranking for escalation detection
_ACTION_RANK = {"monitor": 0, "be_ready": 1, "take_action": 2}

# ETA critical threshold (minutes)
ETA_CRITICAL_MIN = 10


@dataclass
class NotificationDecision:
    """Result of notification evaluation."""
    notify: bool
    event_type: str       # "new", "escalation", "critical", "resolution", "suppressed"
    reason: str           # human-readable reason for decision
    payload: Optional[dict] = None  # notification content if notify=True


class NotificationEngine:
    """Delivery-agnostic notification decision engine.

    Tracks per-alert state to detect escalations and enforce cooldown.
    """

    def __init__(self, quiet_start: int = -1, quiet_end: int = -1):
        """Initialize with optional quiet hours (24h format, -1 = disabled).

        Per-alert tracking (requirement: explainable in logs):
        - last_notified_time: epoch of last notification sent
        - last_notified_action: action_state when last notified
        - last_notified_event: event_type when last notified
        - last_eta_critical: whether ETA was below critical threshold
        """
        self._last_notified_time: dict[str, float] = {}
        self._last_notified_action: dict[str, str] = {}
        self._last_notified_event: dict[str, str] = {}
        self._last_eta_critical: dict[str, bool] = {}
        self._quiet_start = quiet_start
        self._quiet_end = quiet_end

    def evaluate(
        self,
        alert: dict,
        is_primary: bool,
        is_new: bool = False,
        is_expired: bool = False,
    ) -> NotificationDecision:
        """Evaluate whether this alert warrants a notification.

        Args:
            alert: full alert dict (from _alert_to_dict)
            is_primary: whether this is the top-ranked alert
            is_new: whether the alert just entered the system
            is_expired: whether the alert just expired

        Returns:
            NotificationDecision with notify flag, event type, reason, and payload
        """
        aid = alert.get("alert_id", "")
        action = alert.get("action_state", "monitor")
        conf_level = alert.get("confidence_level", "low")
        alert_type = alert.get("type", "")
        is_debris = alert_type == "debris_signature"
        eta = alert.get("eta_min")
        now = time.time()

        # --- Resolution (optional, low priority) ---
        if is_expired:
            prev_action = self._last_notified_action.get(aid, "monitor")
            self._cleanup_alert(aid)
            if _ACTION_RANK.get(prev_action, 0) >= 1:
                return NotificationDecision(
                    notify=True, event_type="resolution",
                    reason="alert resolved",
                    payload=_build_payload(alert, "Resolution", "Storm alert has cleared"),
                )
            return _suppress("expired, was low priority")

        # --- Confidence guard ---
        if conf_level == "low" and not is_debris:
            return _suppress("low confidence")

        # --- Primary-only filter ---
        if not is_primary and not is_debris:
            return _suppress("secondary alert")

        # --- Quiet hours check ---
        if self._in_quiet_hours(now) and action != "take_action" and not is_debris:
            return _suppress("quiet hours")

        # --- Detect escalation ---
        prev_action = self._last_notified_action.get(aid, "monitor")
        is_escalation = _ACTION_RANK.get(action, 0) > _ACTION_RANK.get(prev_action, 0)

        # --- Detect ETA critical crossing ---
        eta_now_critical = eta is not None and eta <= ETA_CRITICAL_MIN
        eta_was_critical = self._last_eta_critical.get(aid, False)
        eta_crossed = eta_now_critical and not eta_was_critical

        # Update state tracking
        self._last_notified_action[aid] = action
        self._last_eta_critical[aid] = eta_now_critical

        # --- Cooldown check ---
        # Only escalation and ETA critical crossing bypass cooldown
        # Debris bypasses confidence/primary filters but respects same-event cooldown
        last = self._last_notified_time.get(aid, 0)
        in_cooldown = (now - last) < COOLDOWN_SEC
        if in_cooldown and not is_escalation and not eta_crossed:
            return _suppress(f"cooldown ({int(COOLDOWN_SEC - (now - last))}s remaining)")

        # --- Trigger evaluation ---

        # A) Debris — bypasses confidence/primary filters (handled above)
        if is_debris:
            self._record_notification(aid, now, action, "critical")
            return NotificationDecision(
                notify=True, event_type="critical",
                reason="debris signature detected",
                payload=_build_payload(alert, "Take action", alert.get("title", "Debris Detected")),
            )

        # B) Escalation
        if is_escalation:
            action_label = "Take action" if action == "take_action" else "Be ready"
            self._record_notification(aid, now, action, "escalation")
            return NotificationDecision(
                notify=True, event_type="escalation",
                reason=f"escalated to {action}",
                payload=_build_payload(alert, action_label),
            )

        # C) ETA critical crossing
        if eta_crossed:
            self._record_notification(aid, now, action, "critical")
            return NotificationDecision(
                notify=True, event_type="critical",
                reason=f"ETA under {ETA_CRITICAL_MIN} min",
                payload=_build_payload(alert, f"ETA ~{int(eta)} min"),
            )

        # D) New significant alert
        if is_new and _ACTION_RANK.get(action, 0) >= 1:
            action_label = "Take action" if action == "take_action" else "Be ready"
            self._record_notification(aid, now, action, "new")
            return NotificationDecision(
                notify=True, event_type="new",
                reason=f"new alert, {action}",
                payload=_build_payload(alert, action_label),
            )

        return _suppress("no trigger condition met")

    def _in_quiet_hours(self, now: float) -> bool:
        """Check if current time falls within quiet hours window."""
        if self._quiet_start < 0 or self._quiet_end < 0:
            return False
        from datetime import datetime
        hour = datetime.fromtimestamp(now).hour
        if self._quiet_start <= self._quiet_end:
            return self._quiet_start <= hour < self._quiet_end
        else:
            # Wraps midnight (e.g. 22-6)
            return hour >= self._quiet_start or hour < self._quiet_end

    def _record_notification(self, aid: str, now: float, action: str, event_type: str):
        """Record that a notification was sent."""
        self._last_notified_time[aid] = now
        self._last_notified_action[aid] = action
        self._last_notified_event[aid] = event_type

    def _cleanup_alert(self, aid: str):
        """Remove tracking state for a departed alert."""
        self._last_notified_time.pop(aid, None)
        self._last_notified_action.pop(aid, None)
        self._last_notified_event.pop(aid, None)
        self._last_eta_critical.pop(aid, None)

    def clear(self):
        """Reset all state."""
        self._last_notified_time.clear()
        self._last_notified_action.clear()
        self._last_notified_event.clear()
        self._last_eta_critical.clear()


def _build_payload(alert: dict, action_label: str, body_override: str = "") -> dict:
    """Build delivery-agnostic notification payload."""
    title = alert.get("title", "Storm Alert")
    if body_override:
        body = body_override
    else:
        # Use impact_description if meaningful, else base message
        desc = alert.get("impact_description", "")
        body = desc if desc and desc != "Trajectory uncertain" else alert.get("message", "Storm alert")

    eta = alert.get("eta_min")
    eta_text = f" · ETA ~{int(eta)}m" if eta and eta > 0 else ""
    dist = alert.get("distance_mi")
    dist_text = f" · {int(dist)} mi" if dist else ""

    return {
        "title": f"{action_label}: {title}",
        "body": body,
        "summary": f"{action_label}{dist_text}{eta_text}",
        "alert_id": alert.get("alert_id", ""),
        "action_state": alert.get("action_state", "monitor"),
        "severity": alert.get("severity", 0),
        "lat": alert.get("lat"),
        "lon": alert.get("lon"),
    }


def _suppress(reason: str) -> NotificationDecision:
    """Helper to build a suppression decision."""
    return NotificationDecision(notify=False, event_type="suppressed", reason=reason)
