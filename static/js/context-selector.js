/**
 * Storm Tracker — Context Selector (shared)
 *
 * Single authoritative strict-context event selector consumed by:
 *   - ClarityLayer (banner, ETA, confidence, narrative)
 *   - Primary strict alert card
 *
 * Resolution rules:
 *   1. pulse active + primaryInViewEventId → resolve by ID from canonical store
 *   2. autotrack enabled + targetAlertId   → resolve by ID from canonical store
 *   3. else                                → null
 *
 * During active pulse, NO fallback to autotrack target.
 * Returns { event, context } or null.
 */
const ContextSelector = (function () {

    function getPrimaryContextEvent() {
        const s = StormState.state;
        const alerts = s.alerts.data || [];

        // Pulse path: resolve by ID from canonical store
        // No fallback to autotrack during active pulse
        if (s.camera.contextPulseActive) {
            if (!s.pulse.primaryInViewEventId) return null;
            const evt = alerts.find(a => a.id === s.pulse.primaryInViewEventId);
            return evt ? { event: evt, context: "pulse" } : null;
        }

        // Autotrack path: resolve by ID from canonical store
        if (s.autotrack.enabled && s.autotrack.targetAlertId) {
            const evt = alerts.find(a => a.id === s.autotrack.targetAlertId);
            return evt ? { event: evt, context: "tracking" } : null;
        }

        return null;
    }

    return { getPrimaryContextEvent };
})();
