/**
 * Storm Tracker — Context Ranking Engine (v4 — adaptive stability)
 *
 * Hybrid scoring: severity + distance (linear decay) + context penalty + tracked bonus
 *
 * Stability features:
 *   - Adaptive hysteresis: max(15, currentScore * 0.15)
 *   - Phase-aware tracked bonus: +20 early hold, +10 late hold, +0 return
 *   - Far-distance dampening: >50mi → ×0.85
 *   - Scaled cross-class penalty
 *   - Zoom-aware pulse context radius
 *   - NEW IN VIEW decay after 1 cycle or 10s
 */
const ContextRanking = (function () {

    // ── Constants ────────────────────────────────────────────────
    const MIN_HYSTERESIS = 15;
    const HYSTERESIS_RATIO = 0.15;
    const TRACKED_BONUS_EARLY = 20;     // zooming_out + early hold
    const TRACKED_BONUS_LATE = 10;      // late hold
    const TRACKED_BONUS_RETURN = 0;     // zooming_back
    const FAR_DISTANCE_THRESHOLD = 50;
    const FAR_DISTANCE_DAMPENING = 0.85;
    const TIER2_THRESHOLD = 30;
    const MAX_SECONDARY_DISPLAY = 3;
    const NEW_IN_VIEW_DECAY_MS = 10000; // 10s

    // Zoom-aware pulse radius
    const ZOOM_RADIUS = [
        { minZoom: 9,  radius: 20 },
        { minZoom: 7,  radius: 30 },
        { minZoom: 0,  radius: 45 },
    ];

    // ── Severity Scores ──────────────────────────────────────────

    const SEVERITY_SCORES = {
        "tornado warning": 100,
        "severe thunderstorm warning": 70,
        "flash flood warning": 40,
        "flood warning": 40,
        "tornado watch": 25,
        "severe thunderstorm watch": 25,
        "winter storm warning": 20,
        "winter weather advisory": 15,
    };
    const DEFAULT_SEVERITY_SCORE = 10;

    // ── Hazard Classification ────────────────────────────────────

    const HAZARD_CLASS = {
        "tornado warning": "convective",
        "severe thunderstorm warning": "convective",
        "tornado watch": "convective",
        "severe thunderstorm watch": "convective",
        "flash flood warning": "hydrological",
        "flood warning": "hydrological",
        "flood watch": "hydrological",
        "flood advisory": "hydrological",
        "winter storm warning": "other",
        "winter weather advisory": "other",
        "red flag warning": "fire",
        "fire weather watch": "fire",
    };

    function _getHazardClass(event) {
        return HAZARD_CLASS[(event || "").toLowerCase()] || "other";
    }

    // ── Scoring Components ───────────────────────────────────────

    function _distanceScore(distanceMi) {
        if (distanceMi == null) return 0;
        return Math.max(0, 60 - (distanceMi * 1.2));
    }

    function _severityScore(event) {
        const key = (event || "").toLowerCase();
        return SEVERITY_SCORES[key] || DEFAULT_SEVERITY_SCORE;
    }

    function _contextPenalty(alertEvent, alertDistanceMi, trackedContext) {
        if (!trackedContext || !trackedContext.trackedEvent) return 0;

        const alertClass = _getHazardClass(alertEvent);
        const trackedClass = _getHazardClass(trackedContext.trackedEvent);
        if (trackedClass === alertClass) return 0;

        if (trackedClass === "convective" && alertClass === "fire") {
            const ds = _distanceScore(alertDistanceMi);
            return -(30 + ds * 0.5);
        }
        if (trackedClass === "fire" && alertClass === "convective") {
            const ds = _distanceScore(alertDistanceMi);
            return -(20 + ds * 0.3);
        }

        return 0;
    }

    // Phase-aware tracked bonus
    function _trackedBonus(alert, context) {
        if (!context || !context.trackedAlertId || alert.id !== context.trackedAlertId) return 0;
        const phase = context.pulsePhase || "holding";
        if (phase === "zooming_out" || phase === "holding") {
            // Check if we're in late hold (>700ms into 1400ms hold)
            if (phase === "holding" && context.holdElapsedMs != null && context.holdElapsedMs > 700) {
                return TRACKED_BONUS_LATE;
            }
            return TRACKED_BONUS_EARLY;
        }
        if (phase === "zooming_back") return TRACKED_BONUS_RETURN;
        return TRACKED_BONUS_EARLY; // default for safety
    }

    // ── Public API ───────────────────────────────────────────────

    function computeHybridScore(alert, context) {
        const sev = _severityScore(alert.event);
        const dist = _distanceScore(alert.distance_mi);
        let base = sev + dist;

        if (alert.distance_mi != null && alert.distance_mi > FAR_DISTANCE_THRESHOLD) {
            base *= FAR_DISTANCE_DAMPENING;
        }

        const penalty = _contextPenalty(alert.event, alert.distance_mi, context);
        const bonus = _trackedBonus(alert, context);

        return Math.round((base + penalty + bonus) * 10) / 10;
    }

    function rankContextEvents(events, policy, context) {
        const sorted = [...events];

        if (policy === "distance") {
            sorted.sort((a, b) => (a.distance_mi || 9999) - (b.distance_mi || 9999));
        } else if (policy === "severity") {
            sorted.sort((a, b) => _severityScore(b.event) - _severityScore(a.event));
        } else {
            sorted.sort((a, b) => computeHybridScore(b, context) - computeHybridScore(a, context));
        }

        return sorted;
    }

    // Adaptive hysteresis: threshold scales with current score
    function shouldSwitchPrimary(newScore, currentScore) {
        const threshold = Math.max(MIN_HYSTERESIS, currentScore * HYSTERESIS_RATIO);
        return newScore > currentScore + threshold;
    }

    function filterSecondaryCards(rankedAlerts, primaryScore, context) {
        const tier2 = [];
        const tier3 = [];

        for (const alert of rankedAlerts) {
            const score = computeHybridScore(alert, context);
            if (primaryScore - score <= TIER2_THRESHOLD) {
                tier2.push(alert.id);
            } else {
                tier3.push(alert.id);
            }
        }

        return [...tier2, ...tier3].slice(0, MAX_SECONDARY_DISPLAY);
    }

    // Zoom-aware pulse context radius
    function getPulseRadiusForZoom(zoom) {
        for (const entry of ZOOM_RADIUS) {
            if (zoom >= entry.minZoom) return entry.radius;
        }
        return 30; // default
    }

    // NEW IN VIEW decay check
    function isNewInViewExpired(capturedAtMs) {
        if (!capturedAtMs) return true;
        return Date.now() - capturedAtMs > NEW_IN_VIEW_DECAY_MS;
    }

    function getHazardClass(event) {
        return _getHazardClass(event);
    }

    // ── Elevated Card Eligibility ────────────────────────────────
    // Adaptive admission: secondary cards shown only when they add material value.

    const MIN_PROXIMITY_GAP = 20;
    const PROXIMITY_RATIO = 0.12;
    const SEVERE_SEVERITY_THRESHOLD = 40;  // flood+ level
    const CROSS_CLASS_MAX_DISTANCE = 40;   // mi
    const NEW_IN_VIEW_MAX_DISTANCE = 30;   // mi
    const NEW_IN_VIEW_SCORE_GAP = 35;
    const THIRD_CARD_MAX_GAP = 30;
    const HIGH_VALUE_CLASSES = new Set(["convective", "hydrological"]);

    /**
     * Check if a secondary alert merits an additional pulse card.
     * @returns {boolean}
     */
    function meetsElevatedCriteria(secondary, secondaryScore, primary, primaryScore, isNew, context) {
        // 1. Adaptive score proximity: max(20, primaryScore * 0.12)
        const proximityThreshold = Math.max(MIN_PROXIMITY_GAP, primaryScore * PROXIMITY_RATIO);
        if (primaryScore - secondaryScore <= proximityThreshold) return true;

        // 2. Cross-class: different hazard class + severe + within 40mi
        const primaryClass = _getHazardClass(primary.event);
        const secondaryClass = _getHazardClass(secondary.event);
        if (secondaryClass !== primaryClass && HIGH_VALUE_CLASSES.has(secondaryClass)) {
            if (_severityScore(secondary.event) >= SEVERE_SEVERITY_THRESHOLD) {
                if (secondary.distance_mi == null || secondary.distance_mi <= CROSS_CLASS_MAX_DISTANCE) {
                    return true;
                }
            }
        }

        // 3. NEW IN VIEW: severe + (within 30mi OR score within 35 of primary)
        if (isNew && _severityScore(secondary.event) >= SEVERE_SEVERITY_THRESHOLD) {
            const closeEnough = secondary.distance_mi != null && secondary.distance_mi <= NEW_IN_VIEW_MAX_DISTANCE;
            const scoreClose = primaryScore - secondaryScore <= NEW_IN_VIEW_SCORE_GAP;
            if (closeEnough || scoreClose) return true;
        }

        return false;
    }

    /**
     * Check if a third card is allowed. Stricter than second card.
     * All three must be severe (≥40) and within 30 points of primary.
     */
    function meetsThirdCardCriteria(alert, score, primaryScore) {
        if (_severityScore(alert.event) < SEVERE_SEVERITY_THRESHOLD) return false;
        if (primaryScore - score > THIRD_CARD_MAX_GAP) return false;
        return true;
    }

    return {
        rankContextEvents,
        computeHybridScore,
        shouldSwitchPrimary,
        filterSecondaryCards,
        meetsElevatedCriteria,
        meetsThirdCardCriteria,
        getPulseRadiusForZoom,
        isNewInViewExpired,
        getHazardClass,
        TIER2_THRESHOLD,
        NEW_IN_VIEW_DECAY_MS,
    };
})();
