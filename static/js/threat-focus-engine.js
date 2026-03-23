/**
 * Storm Tracker — ThreatFocusEngine (TFE)
 *
 * Single authoritative engine for threat selection across all consumers:
 *   - Cards: visibleCardEventIds
 *   - Pulse: pulseTargetEventId
 *   - Audio: audioTargetEventId
 *
 * Feature-flagged: useThreatFocusEngine() controls cutover.
 * Shadow mode: when flag=false, TFE evaluates in parallel and logs comparisons.
 *
 * No persistence of transient state. Recomputes from active alerts on every evaluate().
 * Clones arrays before storing. Does not mutate incoming alerts.
 */
const ThreatFocusEngine = (function () {

    // ── Configuration ────────────────────────────────────────────
    const DWELL_WINDOW_MS = 30000;
    const WEAK_SWITCH_SUPPRESS_MS = 10000;
    const TORNADO_OVERRIDE_THRESHOLD = 90; // severity score that bypasses dwell
    const SWITCH_SCORE_DELTA = 20;
    const MAX_VISIBLE_CARDS = 3;
    const SECONDARY_SCORE_GAP = 25;
    const CROSS_CLASS_SEVERE_THRESHOLD = 40;

    // ── Feature Flag ─────────────────────────────────────────────
    let _featureEnabled = false;

    function useThreatFocusEngine() {
        return _featureEnabled;
    }

    function setFeatureFlag(enabled) {
        _featureEnabled = !!enabled;
        if (log) log.info("tfe_feature_flag", { enabled: _featureEnabled });
    }

    // ── State ────────────────────────────────────────────────────
    let state = _emptyState();
    let listeners = [];
    let log = null;
    let lastEmittedOutputs = null;

    function _emptyState() {
        return {
            primaryEventId: null,
            primaryScore: 0,
            primarySelectedAt: 0,
            secondaryEventIds: [],
            focusMode: "idle",          // "idle" | "tracking" | "pulse"
            candidates: [],             // normalized + scored, ranked
            lastEvaluateAt: 0,
        };
    }

    // ── Derived Outputs (consumer-facing) ────────────────────────
    function getDerivedOutputs() {
        const primary = state.primaryEventId;
        const secondaries = [...state.secondaryEventIds];
        const visible = primary ? [primary, ...secondaries].slice(0, MAX_VISIBLE_CARDS) : [];

        return {
            visibleCardEventIds: visible,
            pulseTargetEventId: primary,
            audioTargetEventId: primary,
            focusMode: state.focusMode,
            primaryEventId: primary,
            primaryScore: state.primaryScore,
            secondaryEventIds: secondaries,
        };
    }

    function getState() {
        return { ...state, candidates: [...state.candidates] };
    }

    // ── Init / Destroy ───────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") {
            log = STLogger.for("tfe");
        }

        // Restore feature flag from localStorage
        const saved = localStorage.getItem("tfe_enabled");
        if (saved === "true") _featureEnabled = true;

        if (log) log.info("tfe_init", { featureEnabled: _featureEnabled });
    }

    function destroy() {
        state = _emptyState();
        listeners = [];
        lastEmittedOutputs = null;
    }

    // ── Subscribe ────────────────────────────────────────────────

    function subscribe(listener) {
        if (typeof listener === "function") listeners.push(listener);
    }

    function _notify() {
        const outputs = getDerivedOutputs();

        // Consistency guard: no redundant emits if outputs identical by value
        const key = JSON.stringify(outputs);
        if (key === lastEmittedOutputs) return;
        lastEmittedOutputs = key;

        for (const fn of listeners) {
            try { fn(outputs); } catch (e) { /* silent */ }
        }
    }

    // ── Core: evaluate() ─────────────────────────────────────────

    function evaluate(activeAlerts, options) {
        options = options || {};
        const now = Date.now();
        state.lastEvaluateAt = now;

        // Determine focus mode
        const cam = StormState.state.camera;
        const at = StormState.state.autotrack;
        if (cam.contextPulseActive) {
            state.focusMode = "pulse";
        } else if (at.enabled) {
            state.focusMode = "tracking";
        } else {
            state.focusMode = "idle";
        }

        // Normalize + score
        const candidates = (activeAlerts || [])
            .map(a => normalizeThreatCandidate(a, options))
            .filter(c => c !== null);

        // Rank
        const ranked = rankThreatCandidates(candidates, options);
        state.candidates = ranked;

        // Select primary with anti-flap
        const prevPrimary = state.primaryEventId;
        const prevScore = state.primaryScore;
        const nextPrimary = selectPrimaryCandidate(ranked);

        if (nextPrimary) {
            const reason = shouldSwitchPrimary(
                { id: prevPrimary, score: prevScore, selectedAt: state.primarySelectedAt },
                nextPrimary,
                now,
                options
            );

            if (reason) {
                state.primaryEventId = nextPrimary.id;
                state.primaryScore = nextPrimary.score;
                state.primarySelectedAt = now;

                if (log) log.info("tfe_primary_change", {
                    prev: prevPrimary ? prevPrimary.slice(-12) : null,
                    next: nextPrimary.id.slice(-12),
                    score: nextPrimary.score,
                    reason: reason,
                    focusMode: state.focusMode,
                });
            }
        } else {
            // No valid candidates
            if (state.primaryEventId !== null) {
                if (log) log.info("tfe_primary_cleared", {
                    prev: state.primaryEventId ? state.primaryEventId.slice(-12) : null,
                    reason: "no_valid_candidates",
                });
            }
            state.primaryEventId = null;
            state.primaryScore = 0;
            state.primarySelectedAt = 0;
        }

        // Validate primary still exists in candidates
        if (state.primaryEventId && !ranked.find(c => c.id === state.primaryEventId)) {
            if (log) log.info("tfe_primary_invalidated", {
                id: state.primaryEventId.slice(-12),
                reason: "stale_primary",
            });
            state.primaryEventId = null;
            state.primaryScore = 0;
            state.primarySelectedAt = 0;
        }

        // Select secondaries
        const primaryCandidate = ranked.find(c => c.id === state.primaryEventId) || null;
        state.secondaryEventIds = selectSecondaryCandidates(ranked, primaryCandidate);

        // Shadow comparison logging
        _logShadowComparison();

        // Notify subscribers
        _notify();
    }

    // ── Normalization ────────────────────────────────────────────

    function normalizeThreatCandidate(alert, options) {
        if (!alert || !alert.id) return null;

        const distance = (alert.distance_mi != null && isFinite(alert.distance_mi))
            ? alert.distance_mi
            : Infinity;

        const eventType = (alert.event || "").toLowerCase();
        const hazardClass = _getHazardClass(eventType);
        const severityBase = _severityScore(eventType);
        const distanceScore = _distanceScore(distance);

        let score = severityBase + distanceScore;

        // Far-distance dampening
        if (distance > 50) score *= 0.85;

        // Cross-class penalty
        const trackedEvent = options.trackedEvent || null;
        if (trackedEvent) {
            const trackedClass = _getHazardClass(trackedEvent.toLowerCase());
            if (trackedClass === "convective" && hazardClass === "fire") {
                score -= (30 + distanceScore * 0.5);
            } else if (trackedClass === "fire" && hazardClass === "convective") {
                score -= (20 + distanceScore * 0.3);
            }
        }

        // Tracked bonus
        if (options.trackedAlertId && alert.id === options.trackedAlertId) {
            score += 20;
        }

        return {
            id: alert.id,
            event: alert.event || "",
            eventType,
            hazardClass,
            distance,
            score: Math.round(score * 10) / 10,
            severityBase,
            expires: alert.expires || null,
            headline: alert.headline || "",
            description: alert.description || "",
            polygon: !!alert.polygon,
            _raw: alert, // reference only, not mutated
        };
    }

    // ── Ranking ──────────────────────────────────────────────────

    function rankThreatCandidates(candidates, options) {
        const sorted = [...candidates];
        sorted.sort((a, b) => b.score - a.score);
        return sorted;
    }

    // ── Primary Selection + Anti-Flap ────────────────────────────

    function selectPrimaryCandidate(ranked) {
        if (!ranked || ranked.length === 0) return null;
        return ranked[0];
    }

    function shouldSwitchPrimary(current, next, now, options) {
        // No current primary → always switch
        if (!current.id) return "initial_selection";

        // Same alert → no switch needed (score update only)
        if (current.id === next.id) return "same_target_update";

        // Tornado override: bypasses dwell
        if (next.severityBase >= TORNADO_OVERRIDE_THRESHOLD) {
            return "tornado_override";
        }

        // Dwell window: block switch if current primary was recently selected
        const dwellElapsed = now - current.selectedAt;
        if (dwellElapsed < DWELL_WINDOW_MS) {
            // Exception: large score delta forces switch
            if (next.score > current.score + SWITCH_SCORE_DELTA) {
                return "score_delta_override";
            }

            if (log) log.info("tfe_switch_suppressed", {
                current: current.id ? current.id.slice(-12) : null,
                next: next.id.slice(-12),
                dwell_remaining: Math.round((DWELL_WINDOW_MS - dwellElapsed) / 1000),
                score_delta: Math.round((next.score - current.score) * 10) / 10,
            });
            return null; // suppressed
        }

        // Weak-switch suppression: small score differences in recent window
        if (dwellElapsed < DWELL_WINDOW_MS + WEAK_SWITCH_SUPPRESS_MS) {
            if (next.score <= current.score + SWITCH_SCORE_DELTA) {
                return null; // weak switch suppressed
            }
        }

        // Normal switch
        if (next.score > current.score) {
            return "higher_score";
        }

        return null; // no improvement
    }

    // ── Secondary Selection ──────────────────────────────────────

    function selectSecondaryCandidates(ranked, primary) {
        if (!primary || ranked.length <= 1) return [];

        const secondaries = [];
        for (const c of ranked) {
            if (c.id === primary.id) continue;
            if (secondaries.length >= MAX_VISIBLE_CARDS - 1) break;

            // Must meet eligibility criteria
            const gap = primary.score - c.score;

            // Score proximity
            const proximityThreshold = Math.max(20, primary.score * 0.12);
            if (gap <= proximityThreshold) {
                secondaries.push(c.id);
                continue;
            }

            // Cross-class high-value
            if (c.hazardClass !== primary.hazardClass &&
                (c.hazardClass === "convective" || c.hazardClass === "hydrological") &&
                c.severityBase >= CROSS_CLASS_SEVERE_THRESHOLD &&
                c.distance <= 40) {
                secondaries.push(c.id);
                continue;
            }
        }

        return secondaries;
    }

    // ── Shadow Comparison Logging ────────────────────────────────

    function _logShadowComparison() {
        if (_featureEnabled) return; // only log in shadow mode
        if (!log) return;

        const outputs = getDerivedOutputs();

        // Legacy card primary
        const legacyCardPrimary = StormState.state.pulse.primaryInViewEventId
            || StormState.state.autotrack.targetAlertId
            || null;

        // Legacy pulse target
        const legacyPulseTarget = StormState.state.pulse.primaryInViewEventId || null;

        // Legacy audio target
        const legacyAudioTarget = StormState.state.autotrack.targetAlertId || null;

        const cardMatch = outputs.primaryEventId === legacyCardPrimary;
        const pulseMatch = outputs.pulseTargetEventId === legacyPulseTarget;
        const audioMatch = outputs.audioTargetEventId === legacyAudioTarget;

        if (!cardMatch || !pulseMatch || !audioMatch) {
            log.info("tfe_shadow_comparison", {
                tfe_primary: outputs.primaryEventId ? outputs.primaryEventId.slice(-12) : null,
                legacy_card_primary: legacyCardPrimary ? legacyCardPrimary.slice(-12) : null,
                card_match: cardMatch,
                legacy_pulse_target: legacyPulseTarget ? legacyPulseTarget.slice(-12) : null,
                pulse_match: pulseMatch,
                legacy_audio_target: legacyAudioTarget ? legacyAudioTarget.slice(-12) : null,
                audio_match: audioMatch,
                tfe_visible_count: outputs.visibleCardEventIds.length,
                focus_mode: outputs.focusMode,
            });
        }
    }

    // ── Scoring Helpers (mirror ContextRanking for self-containment) ──

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

    const HAZARD_CLASSES = {
        "tornado warning": "convective",
        "severe thunderstorm warning": "convective",
        "tornado watch": "convective",
        "severe thunderstorm watch": "convective",
        "flash flood warning": "hydrological",
        "flood warning": "hydrological",
        "flood watch": "hydrological",
        "flood advisory": "hydrological",
        "red flag warning": "fire",
        "fire weather watch": "fire",
    };

    function _severityScore(eventType) {
        return SEVERITY_SCORES[eventType] || 10;
    }

    function _distanceScore(distance) {
        if (distance == null || !isFinite(distance)) return 0;
        return Math.max(0, 60 - (distance * 1.2));
    }

    function _getHazardClass(eventType) {
        return HAZARD_CLASSES[eventType] || "other";
    }

    // ── Public API ───────────────────────────────────────────────

    return {
        init,
        evaluate,
        getState,
        getDerivedOutputs,
        subscribe,
        destroy,
        useThreatFocusEngine,
        setFeatureFlag,
    };
})();
