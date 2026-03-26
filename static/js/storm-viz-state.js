/**
 * Storm Tracker — Storm Visualization State Model
 *
 * Centralized state for the storm visualization engine.
 * Single source of truth for active target, intensity, and flash state.
 *
 * Derived from: autotrack (target) + severity-model (intensity)
 * Feature-flagged: controlled by StormState.vizEnabled
 *
 * Emits:
 *   viz_target_changed  — when active target changes
 *   viz_intensity_changed — when intensity level changes
 *   viz_enabled_changed — when feature flag toggles
 *   viz_degrade_changed — when performance degrade activates/deactivates
 */
const StormVizState = (function () {

    // ── State Shape ─────────────────────────────────────────────────
    const state = {
        activeTargetId: null,
        intensityLevel: "low",      // "low" | "moderate" | "high" | "extreme"
        isFlashing: false,
        lastUpdateTs: 0,
        degraded: false,            // true when polygon count exceeds safe threshold
    };

    // ── Mapping: SeverityModel tier → viz intensity ─────────────────
    const TIER_TO_INTENSITY = {
        "low":          "low",
        "elevated":     "moderate",
        "severe":       "high",
        "significant":  "high",
        "critical":     "extreme",
    };

    // ── Performance Config ──────────────────────────────────────────
    const SAFE_POLYGON_THRESHOLD = 12;
    const UPDATE_THROTTLE_MS = 500;

    let _lastEvalAt = 0;
    let log = null;

    // ── Init ────────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("viz_state");

        StormState.on("autotrackTargetChanged", _evaluate);
        StormState.on("autotrackChanged", _onModeChanged);
        StormState.on("alertsUpdated", _evaluate);
        StormState.on("cameraModeChanged", _onModeChanged);

        if (log) log.info("viz_state_init", { enabled: isEnabled() });
    }

    // ── Feature Flag ────────────────────────────────────────────────

    function isEnabled() {
        return StormState.state.vizEnabled !== false;
    }

    function setEnabled(val) {
        const prev = isEnabled();
        StormState.state.vizEnabled = !!val;
        if (prev !== !!val) {
            if (log) log.info("viz_enabled_changed", { enabled: !!val });
            StormState.emit("vizEnabledChanged", { enabled: !!val });
            if (!val) _reset();
            else _evaluate();
        }
    }

    // ── Evaluation ──────────────────────────────────────────────────

    function _evaluate() {
        if (!isEnabled()) return;

        const now = Date.now();
        if (now - _lastEvalAt < UPDATE_THROTTLE_MS) return;
        _lastEvalAt = now;

        const at = StormState.state.autotrack;
        const alerts = StormState.state.alerts.data || [];

        // Performance check
        const prevDegraded = state.degraded;
        state.degraded = alerts.length > SAFE_POLYGON_THRESHOLD;
        if (state.degraded !== prevDegraded) {
            if (log) log.info("viz_degrade_changed", { degraded: state.degraded, alertCount: alerts.length });
            StormState.emit("vizDegradeChanged", { degraded: state.degraded });
        }

        // No active target
        if (!at.enabled || !at.targetAlertId) {
            if (state.activeTargetId !== null) {
                _setTarget(null, "low", false);
            }
            return;
        }

        const tracked = alerts.find(a => a.id === at.targetAlertId);
        if (!tracked) {
            if (state.activeTargetId !== null) {
                _setTarget(null, "low", false);
            }
            return;
        }

        // Derive intensity from severity model
        const tier = typeof SeverityModel !== "undefined"
            ? SeverityModel.deriveSeverityTierForAlert(tracked)
            : "low";
        const intensity = TIER_TO_INTENSITY[tier] || "low";

        // Flash: enabled for high+ intensity
        const isFlashing = intensity === "high" || intensity === "extreme";

        // Check for changes
        const targetChanged = tracked.id !== state.activeTargetId;
        const intensityChanged = intensity !== state.intensityLevel;

        if (targetChanged || intensityChanged) {
            _setTarget(tracked.id, intensity, isFlashing);
        }

        state.lastUpdateTs = now;
    }

    function _setTarget(targetId, intensity, flashing) {
        const prevTarget = state.activeTargetId;
        const prevIntensity = state.intensityLevel;

        state.activeTargetId = targetId;
        state.intensityLevel = intensity;
        state.isFlashing = flashing;
        state.lastUpdateTs = Date.now();

        if (targetId !== prevTarget) {
            if (log) log.info("viz_target_changed", {
                prev: prevTarget ? prevTarget.slice(-12) : null,
                current: targetId ? targetId.slice(-12) : null,
                intensity,
            });
            StormState.emit("vizTargetChanged", { prevTarget, currentTarget: targetId, intensity });
        }

        if (intensity !== prevIntensity) {
            if (log) log.info("viz_intensity_changed", {
                prev: prevIntensity,
                current: intensity,
                targetId: targetId ? targetId.slice(-12) : null,
            });
            StormState.emit("vizIntensityChanged", { prevIntensity, currentIntensity: intensity, targetId });
        }
    }

    // ── Mode Change / Reset ─────────────────────────────────────────

    function _onModeChanged() {
        const at = StormState.state.autotrack;
        if (!at.enabled) {
            _reset();
        } else {
            _evaluate();
        }
    }

    function _reset() {
        if (state.activeTargetId !== null || state.intensityLevel !== "low") {
            _setTarget(null, "low", false);
        }
        if (log) log.info("viz_state_reset", {});
    }

    // ── Public API ──────────────────────────────────────────────────

    function getState() { return { ...state }; }

    return {
        init,
        getState,
        isEnabled,
        setEnabled,
        SAFE_POLYGON_THRESHOLD,
    };
})();
