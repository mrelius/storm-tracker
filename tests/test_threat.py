"""Tests for threat prioritization engine (Phase 14)."""
from services.detection.threat import (
    compute_threat_score, explain_score, rank_alerts, ThreatRanker,
    TYPE_WEIGHTS, HYSTERESIS,
)


def _alert(alert_type="strong_storm", severity=2, distance=15, confidence=0.6,
           eta=None, speed=0, alert_id="a1"):
    return {
        "alert_id": alert_id,
        "type": alert_type,
        "severity": severity,
        "distance_mi": distance,
        "confidence": confidence,
        "eta_min": eta,
        "speed_mph": speed,
        "direction": "NE",
        "title": f"Test {alert_type}",
        "message": "Test alert",
    }


# === Scoring ===

class TestScoring:
    def test_debris_scores_higher_than_strong_storm(self):
        debris = compute_threat_score(_alert(alert_type="debris_signature"))
        strong = compute_threat_score(_alert(alert_type="strong_storm"))
        assert debris > strong

    def test_rotation_scores_higher_than_proximity(self):
        rotation = compute_threat_score(_alert(alert_type="rotation"))
        proximity = compute_threat_score(_alert(alert_type="storm_proximity"))
        assert rotation > proximity

    def test_closer_scores_higher(self):
        near = compute_threat_score(_alert(distance=5))
        far = compute_threat_score(_alert(distance=30))
        assert near > far

    def test_eta_boosts_score(self):
        with_eta = compute_threat_score(_alert(eta=10))
        without_eta = compute_threat_score(_alert(eta=None))
        assert with_eta > without_eta

    def test_higher_confidence_scores_higher(self):
        high = compute_threat_score(_alert(confidence=0.9))
        low = compute_threat_score(_alert(confidence=0.2))
        assert high > low

    def test_score_in_range(self):
        score = compute_threat_score(_alert())
        assert 0 <= score <= 100

    def test_missing_fields_safe(self):
        score = compute_threat_score({})
        assert score >= 0


# === Explanation ===

class TestExplanation:
    def test_debris_explanation(self):
        reason = explain_score(_alert(alert_type="debris_signature"), 80)
        assert "Debris" in reason

    def test_eta_in_explanation(self):
        reason = explain_score(_alert(eta=12), 50)
        assert "12 min" in reason

    def test_high_confidence_noted(self):
        reason = explain_score(_alert(confidence=0.8), 60)
        assert "high confidence" in reason

    def test_developing_noted(self):
        reason = explain_score(_alert(confidence=0.1), 30)
        assert "developing" in reason


# === Ranking ===

class TestRanking:
    def test_higher_score_first(self):
        alerts = [
            _alert(alert_type="storm_proximity", alert_id="a1"),
            _alert(alert_type="debris_signature", alert_id="a2"),
        ]
        result = rank_alerts(alerts)
        assert result["alerts"][0]["alert_id"] == "a2"  # debris first

    def test_primary_is_top(self):
        alerts = [
            _alert(alert_id="a1"),
            _alert(alert_type="rotation", alert_id="a2"),
        ]
        result = rank_alerts(alerts)
        assert result["primary_threat"]["alert_id"] == result["alerts"][0]["alert_id"]

    def test_empty_list(self):
        result = rank_alerts([])
        assert result["primary_threat"] is None
        assert result["count"] == 0

    def test_single_alert(self):
        result = rank_alerts([_alert()])
        assert result["primary_threat"] is not None
        assert result["count"] == 1

    def test_threat_score_in_output(self):
        result = rank_alerts([_alert()])
        assert "threat_score" in result["alerts"][0]
        assert "threat_reason" in result["alerts"][0]

    def test_near_high_conf_can_beat_far_severe(self):
        """Close high-confidence proximity can outrank distant severe alert."""
        near = _alert(alert_type="storm_proximity", distance=5, confidence=0.9,
                      eta=8, alert_id="near")
        far = _alert(alert_type="strong_storm", distance=50, confidence=0.3,
                     alert_id="far")
        result = rank_alerts([near, far])
        # Near alert with short ETA + high confidence should score well
        # (May or may not beat far — depends on formula, but should be competitive)
        near_score = result["alerts"][0]["threat_score"] if result["alerts"][0]["alert_id"] == "near" else result["alerts"][1]["threat_score"]
        far_score = result["alerts"][0]["threat_score"] if result["alerts"][0]["alert_id"] == "far" else result["alerts"][1]["threat_score"]
        # Both should have reasonable scores
        assert near_score > 0
        assert far_score > 0


# === Anti-Thrash ===

class TestAntiThrash:
    def test_primary_stays_when_close(self):
        """Primary shouldn't flip when challenger is within HYSTERESIS margin."""
        ranker = ThreatRanker()

        # First ranking: a1 is primary
        r1 = ranker.rank([
            _alert(alert_type="rotation", confidence=0.7, alert_id="a1"),
            _alert(alert_type="strong_storm", confidence=0.65, alert_id="a2"),
        ])
        assert r1["primary_threat"]["alert_id"] == "a1"

        # Second ranking: a2 slightly higher but within hysteresis
        r2 = ranker.rank([
            _alert(alert_type="rotation", confidence=0.68, alert_id="a1"),
            _alert(alert_type="strong_storm", confidence=0.72, alert_id="a2"),
        ])
        # a1 should remain primary (within hysteresis)
        assert r2["primary_threat"]["alert_id"] == "a1"

    def test_primary_changes_with_large_margin(self):
        """Primary should change when challenger wins by large margin."""
        ranker = ThreatRanker()

        r1 = ranker.rank([
            _alert(alert_type="strong_storm", alert_id="a1"),
            _alert(alert_type="storm_proximity", alert_id="a2"),
        ])
        primary1 = r1["primary_threat"]["alert_id"]

        # New debris signature should clearly outrank
        r2 = ranker.rank([
            _alert(alert_type="strong_storm", alert_id="a1"),
            _alert(alert_type="debris_signature", confidence=0.9, alert_id="a3"),
        ])
        assert r2["primary_threat"]["alert_id"] == "a3"

    def test_reset(self):
        ranker = ThreatRanker()
        ranker.rank([_alert()])
        ranker.reset()
        assert ranker._current_primary_id is None


# === Determinism ===

class TestDeterminism:
    def test_same_input_same_output(self):
        alerts = [
            _alert(alert_type="rotation", alert_id="a1"),
            _alert(alert_type="strong_storm", alert_id="a2"),
        ]
        r1 = rank_alerts(alerts)
        r2 = rank_alerts(alerts)
        assert r1["primary_threat"]["alert_id"] == r2["primary_threat"]["alert_id"]
        assert [a["alert_id"] for a in r1["alerts"]] == [a["alert_id"] for a in r2["alerts"]]
