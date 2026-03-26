/**
 * Storm Tracker — Severity Model
 *
 * Single authoritative severity normalization for alerts and clusters.
 * Used by context zoom, polygon visuals, flash system, and SPC escalation.
 *
 * Tiers: low < elevated < severe < significant < critical
 */
const SeverityModel = (function () {

    /**
     * @typedef {"low"|"elevated"|"severe"|"significant"|"critical"} SeverityTier
     */

    const TIER_ORDER = { low: 0, elevated: 1, severe: 2, significant: 3, critical: 4 };

    // ── PDS / destructive tag detection ────────────────────────────

    const _PDS_RE = /particularly dangerous situation|pds/i;
    const _DESTRUCTIVE_RE = /destructive|catastrophic|considerable/i;
    const _EXTREME_HAIL_RE = /(?:tennis|baseball|softball|grapefruit|hail\s*(?:up\s*to\s*)?[3-9])/i;
    const _EXTREME_WIND_RE = /(?:wind[s]?\s*(?:up\s*to\s*)?(?:1[0-9]{2}|[8-9][0-9])\s*mph)/i;

    function _hasDestructiveTags(alert) {
        const desc = (alert.description || "") + " " + (alert.headline || "");
        return _DESTRUCTIVE_RE.test(desc) || _PDS_RE.test(desc);
    }

    function _hasExtremeThresholds(alert) {
        const desc = (alert.description || "") + " " + (alert.headline || "");
        return _EXTREME_HAIL_RE.test(desc) || _EXTREME_WIND_RE.test(desc);
    }

    // ── Alert → Tier ───────────────────────────────────────────────

    /**
     * Normalize a single alert to a severity tier.
     * @param {Object} alert - Alert object with .event, .severity, .description, .headline
     * @returns {SeverityTier}
     */
    function deriveSeverityTierForAlert(alert) {
        if (!alert || !alert.event) return "low";

        const evt = alert.event.toLowerCase();

        // Tornado Warning
        if (evt.includes("tornado") && evt.includes("warning")) {
            return _hasDestructiveTags(alert) ? "critical" : "significant";
        }

        // Severe Thunderstorm Warning
        if (evt.includes("severe") && evt.includes("thunderstorm") && evt.includes("warning")) {
            if (_hasDestructiveTags(alert) || _hasExtremeThresholds(alert)) return "significant";
            return "severe";
        }

        // Flash Flood Warning
        if (evt.includes("flash flood") && evt.includes("warning")) {
            if (_hasDestructiveTags(alert)) return "significant";
            return "severe";
        }

        // Tornado Watch
        if (evt.includes("tornado") && evt.includes("watch")) return "elevated";

        // Severe Thunderstorm Watch
        if (evt.includes("severe") && evt.includes("thunderstorm") && evt.includes("watch")) return "elevated";

        // Flood Warning
        if (evt.includes("flood") && evt.includes("warning")) return "elevated";

        // Winter warnings
        if (evt.includes("winter") && evt.includes("warning")) return "elevated";

        // Watches, advisories, statements
        if (evt.includes("watch") || evt.includes("advisory")) return "low";

        return "low";
    }

    // ── Cluster → Tier ─────────────────────────────────────────────

    /**
     * Derive the highest severity tier from a cluster of alerts.
     * @param {Object[]} alerts - Array of alert objects
     * @returns {SeverityTier}
     */
    function deriveClusterSeverity(alerts) {
        if (!alerts || alerts.length === 0) return "low";
        let maxOrd = 0;
        for (const a of alerts) {
            const tier = deriveSeverityTierForAlert(a);
            const ord = TIER_ORDER[tier] || 0;
            if (ord > maxOrd) maxOrd = ord;
        }
        return _ordToTier(maxOrd);
    }

    // ── Comparison helpers ──────────────────────────────────────────

    function tierOrdinal(tier) {
        return TIER_ORDER[tier] ?? 0;
    }

    function tierGte(a, b) {
        return tierOrdinal(a) >= tierOrdinal(b);
    }

    function maxTier(a, b) {
        return tierOrdinal(a) >= tierOrdinal(b) ? a : b;
    }

    function _ordToTier(ord) {
        for (const [k, v] of Object.entries(TIER_ORDER)) {
            if (v === ord) return k;
        }
        return "low";
    }

    return {
        deriveSeverityTierForAlert,
        deriveClusterSeverity,
        tierOrdinal,
        tierGte,
        maxTier,
        TIER_ORDER,
    };
})();
