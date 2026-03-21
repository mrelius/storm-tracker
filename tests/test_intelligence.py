"""Tests for alert intelligence — filtering, state-change, notification gating (Phase 22)."""
import time
from unittest.mock import patch
from services.detection.intelligence import (
    filter_alerts, StateTracker, NotificationGate,
    MAX_NEAR_MISS, MAX_ALERTS_TOTAL, NOTIFICATION_COOLDOWN,
)


def _alert(alert_id="a1", impact="direct_hit", severity=2,
           impact_severity_label="moderate", **kwargs):
    return {
        "alert_id": alert_id,
        "impact": impact,
        "severity": severity,
        "impact_severity_label": impact_severity_label,
        "type": "strong_storm",
        **kwargs,
    }


# === Filtering ===

class TestFiltering:
    def test_keeps_direct_hits(self):
        alerts = [_alert(impact="direct_hit")]
        result = filter_alerts(alerts)
        assert len(result) == 1

    def test_suppresses_passing_when_direct_exists(self):
        alerts = [
            _alert("a1", impact="direct_hit", severity=2),
            _alert("a2", impact="passing", severity=1),
            _alert("a3", impact="passing", severity=1),
        ]
        result = filter_alerts(alerts)
        passing = [a for a in result if a["impact"] == "passing"]
        assert len(passing) == 0

    def test_limits_near_miss(self):
        alerts = [_alert(f"a{i}", impact="near_miss") for i in range(5)]
        result = filter_alerts(alerts)
        near = [a for a in result if a["impact"] == "near_miss"]
        assert len(near) <= MAX_NEAR_MISS + 1

    def test_never_hides_critical(self):
        alerts = [
            _alert("a1", impact="direct_hit", severity=4),
            _alert("a2", impact="passing", severity=3),  # critical
        ]
        result = filter_alerts(alerts)
        ids = {a["alert_id"] for a in result}
        assert "a2" in ids  # kept despite being "passing"

    def test_total_cap(self):
        alerts = [_alert(f"a{i}", impact="direct_hit") for i in range(10)]
        result = filter_alerts(alerts)
        assert len(result) <= MAX_ALERTS_TOTAL

    def test_empty_input(self):
        assert filter_alerts([]) == []


# === State Change Detection ===

class TestStateTracker:
    def test_new_alert(self):
        tracker = StateTracker()
        changes = tracker.detect_changes([_alert("a1")])
        assert "new" in changes.get("a1", [])

    def test_impact_upgrade(self):
        tracker = StateTracker()
        tracker.detect_changes([_alert("a1", impact="near_miss")])
        changes = tracker.detect_changes([_alert("a1", impact="direct_hit")])
        assert any("direct_hit" in c for c in changes.get("a1", []))

    def test_severity_increase(self):
        tracker = StateTracker()
        tracker.detect_changes([_alert("a1", severity=1)])
        changes = tracker.detect_changes([_alert("a1", severity=3)])
        assert "severity_increased" in changes.get("a1", [])

    def test_no_change(self):
        tracker = StateTracker()
        tracker.detect_changes([_alert("a1")])
        changes = tracker.detect_changes([_alert("a1")])
        assert "a1" not in changes

    def test_departed_cleaned_up(self):
        tracker = StateTracker()
        tracker.detect_changes([_alert("a1")])
        tracker.detect_changes([])  # a1 departed
        assert len(tracker._prev_states) == 0

    def test_impact_severity_upgrade(self):
        tracker = StateTracker()
        tracker.detect_changes([_alert("a1", impact_severity_label="moderate")])
        changes = tracker.detect_changes([_alert("a1", impact_severity_label="critical")])
        assert "impact_severity_upgraded" in changes.get("a1", [])


# === Notification Gating ===

class TestNotificationGate:
    def test_new_direct_hit_notifies(self):
        gate = NotificationGate()
        alert = _alert(impact="direct_hit")
        assert gate.should_notify(alert, ["new"]) is True

    def test_passing_never_notifies(self):
        gate = NotificationGate()
        alert = _alert(impact="passing")
        assert gate.should_notify(alert, ["new"]) is False

    def test_uncertain_never_notifies(self):
        gate = NotificationGate()
        alert = _alert(impact="uncertain")
        assert gate.should_notify(alert, ["new"]) is False

    def test_cooldown_blocks_repeat(self):
        gate = NotificationGate()
        alert = _alert(impact="direct_hit")
        assert gate.should_notify(alert, ["new"]) is True
        assert gate.should_notify(alert, []) is False  # within cooldown

    def test_escalation_bypasses_cooldown(self):
        gate = NotificationGate()
        alert = _alert(impact="direct_hit")
        gate.should_notify(alert, ["new"])
        assert gate.should_notify(alert, ["impact_near_miss_to_direct_hit"]) is True

    def test_severity_3_new_notifies(self):
        gate = NotificationGate()
        alert = _alert(impact="near_miss", severity=3)
        assert gate.should_notify(alert, ["new"]) is True

    def test_near_miss_low_severity_no_new_notification(self):
        gate = NotificationGate()
        alert = _alert(impact="near_miss", severity=1)
        # Near_miss severity 1, no meaningful change → no notification
        assert gate.should_notify(alert, []) is False

    def test_impact_severity_upgrade_notifies(self):
        gate = NotificationGate()
        alert = _alert(impact="direct_hit", severity=2)
        assert gate.should_notify(alert, ["impact_severity_upgraded"]) is True


# === End-to-End ===

class TestEndToEnd:
    def test_full_cycle(self):
        """Alerts → filter → state changes → notification decisions."""
        alerts = [
            _alert("a1", impact="direct_hit", severity=3),
            _alert("a2", impact="near_miss", severity=2),
            _alert("a3", impact="passing", severity=1),
            _alert("a4", impact="passing", severity=1),
        ]

        # Filter
        filtered = filter_alerts(alerts)
        assert len(filtered) < len(alerts)  # some passing suppressed

        # State changes
        tracker = StateTracker()
        changes = tracker.detect_changes(filtered)
        assert "a1" in changes  # new

        # Notification decisions
        gate = NotificationGate()
        a1 = filtered[0]
        assert gate.should_notify(a1, changes.get(a1["alert_id"], [])) is True
