/**
 * Storm Tracker — Speaking Alert State Model
 *
 * Manages cooldown, de-duplication, and priority for spoken alerts.
 * Does NOT generate messages or trigger speech — that's AlertEngine.
 *
 * Priority levels (higher = more urgent):
 *   1 = target_acquired
 *   2 = severity_escalation
 *   3 = impact_radius_entered
 *   4 = tornado_warning
 */
const AlertState = (function () {

    const PRIORITY = {
        target_acquired: 1,
        severity_escalation: 2,
        impact_radius_entered: 3,
        tornado_warning: 4,
    };

    const state = {
        lastSpokenEventId: null,
        lastSpokenTs: 0,
        lastSpokenPriority: 0,
        cooldownMs: 15000,
        enabled: true,
    };

    let log = null;

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("alert_state");
    }

    /**
     * Check if a spoken alert is allowed.
     * @param {string} eventKey — unique key for this specific event (e.g. "target:demo-tor-1")
     * @param {string} triggerType — one of the PRIORITY keys
     * @returns {{ allowed: boolean, reason: string }}
     */
    function canSpeak(eventKey, triggerType) {
        // Feature disabled
        if (!state.enabled) {
            return { allowed: false, reason: "disabled" };
        }

        // Audio globally disabled
        if (StormState.state.audioEnabled === false) {
            return { allowed: false, reason: "audio_disabled" };
        }

        const priority = PRIORITY[triggerType] || 0;
        const now = Date.now();
        const elapsed = now - state.lastSpokenTs;

        // Same event key within cooldown — always skip
        if (eventKey === state.lastSpokenEventId && elapsed < state.cooldownMs) {
            return { allowed: false, reason: "cooldown_same_event" };
        }

        // Different event within cooldown — allow only if escalation (higher priority)
        if (elapsed < state.cooldownMs && priority <= state.lastSpokenPriority) {
            return { allowed: false, reason: "cooldown_lower_priority" };
        }

        return { allowed: true, reason: "ok" };
    }

    /**
     * Record that a spoken alert was delivered.
     */
    function markSpoken(eventKey, triggerType) {
        state.lastSpokenEventId = eventKey;
        state.lastSpokenTs = Date.now();
        state.lastSpokenPriority = PRIORITY[triggerType] || 0;
    }

    function reset() {
        state.lastSpokenEventId = null;
        state.lastSpokenTs = 0;
        state.lastSpokenPriority = 0;
    }

    function setEnabled(val) {
        state.enabled = !!val;
        if (!val) reset();
    }

    function getState() { return { ...state }; }

    return { init, canSpeak, markSpoken, reset, setEnabled, getState, PRIORITY };
})();
