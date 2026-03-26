/**
 * Storm Tracker — Storm Visualization System
 *
 * Visual anchor centered on warning polygons, motion, and intensity.
 * Replaces radar as the primary visual experience.
 *
 * Renders:
 *   - Tracked polygon emphasis (border + pulse + halo)
 *   - Motion vector (direction arrow for tracked only)
 *   - Intensity-based styling (advisory → critical)
 *
 * Only renders in storm-relevant modes. Hidden in idle/local.
 */
const StormViz = (function () {

    // ── State ──────────────────────────────────────────────────────
    const state = {
        trackedEventId: null,
        mode: "idle",           // "idle" | "active"
        intensity: "none",      // "none" | "advisory" | "elevated" | "severe" | "tornado" | "critical"
        motion: {
            enabled: false,
            headingDeg: null,
            speedMph: null,
            confidence: "low",
        },
        lastTrackedChangeAt: 0,
    };

    const HOLD_MS = 3000;
    const UPDATE_INTERVAL_MS = 3000;

    // ── Intensity Colors ───────────────────────────────────────────
    const INTENSITY_STYLES = {
        none:     { border: "#4a90d9", fill: "rgba(74, 144, 217, 0.04)", halo: "none",                                  pulseMs: 0 },
        advisory: { border: "#d4a017", fill: "rgba(212, 160, 23, 0.05)", halo: "0 0 6px rgba(212, 160, 23, 0.2)",       pulseMs: 1500 },
        elevated: { border: "#f59e0b", fill: "rgba(245, 158, 11, 0.06)", halo: "0 0 8px rgba(245, 158, 11, 0.3)",       pulseMs: 1400 },
        severe:   { border: "#f97316", fill: "rgba(249, 115, 22, 0.08)", halo: "0 0 10px rgba(249, 115, 22, 0.35)",     pulseMs: 1300 },
        tornado:  { border: "#ef4444", fill: "rgba(239, 68, 68, 0.10)", halo: "0 0 14px rgba(239, 68, 68, 0.4)",       pulseMs: 1100 },
        critical: { border: "#dc2626", fill: "rgba(220, 38, 38, 0.12)", halo: "0 0 18px rgba(220, 38, 38, 0.5)",       pulseMs: 1000 },
    };

    let _vizLayer = null;
    let _motionLayer = null;
    let _updateTimer = null;
    let _map = null;
    let log = null;

    // ── Init ───────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("storm_viz");

        StormState.on("autotrackTargetChanged", _onTargetChanged);
        StormState.on("alertsUpdated", _scheduleUpdate);
        StormState.on("cameraModeChanged", _onModeChanged);
        StormState.on("autotrackChanged", _onModeChanged);
    }

    function start(leafletMap) {
        _map = leafletMap;
        _vizLayer = L.layerGroup().addTo(_map);
        _motionLayer = L.layerGroup().addTo(_map);
        _updateTimer = setInterval(_update, UPDATE_INTERVAL_MS);
    }

    function stop() {
        clearStormVisualization();
        if (_updateTimer) { clearInterval(_updateTimer); _updateTimer = null; }
    }

    // ── Mode Gating ────────────────────────────────────────────────

    function _isAllowed() {
        // Feature flag gate
        if (typeof StormVizState !== "undefined" && !StormVizState.isEnabled()) return false;

        if (typeof CameraPolicy !== "undefined") {
            const ps = CameraPolicy.getState();
            if (ps.automaticSubmode === "IDLE_AWARENESS") {
                const at = StormState.state.autotrack;
                if (!at.enabled || !at.targetAlertId) return false;
            }
        }
        return true;
    }

    function _onModeChanged() {
        if (!_isAllowed()) {
            clearStormVisualization();
            state.mode = "idle";
        } else {
            _update();
        }
    }

    function _onTargetChanged() {
        const now = Date.now();
        if (now - state.lastTrackedChangeAt < HOLD_MS && state.trackedEventId) return;
        state.lastTrackedChangeAt = now;
        _update();
    }

    function _scheduleUpdate() {
        requestAnimationFrame(_update);
    }

    // ── Intensity Derivation ───────────────────────────────────────

    function deriveStormIntensity(alert) {
        if (!alert || !alert.event) return "none";
        const evt = alert.event.toLowerCase();
        const desc = ((alert.description || "") + " " + (alert.headline || "")).toLowerCase();

        if (evt.includes("tornado") && evt.includes("warning")) {
            if (/particularly dangerous|pds|destructive|catastrophic/.test(desc)) return "critical";
            return "tornado";
        }
        if (evt.includes("severe") && evt.includes("thunderstorm") && evt.includes("warning")) {
            if (/destructive|considerable/.test(desc)) return "severe";
            return "elevated";
        }
        if (evt.includes("flash flood") && evt.includes("warning")) return "elevated";
        if (evt.includes("tornado") && evt.includes("watch")) return "advisory";
        if (evt.includes("warning")) return "advisory";
        return "none";
    }

    // ── Motion Derivation ──────────────────────────────────────────

    function deriveStormMotion(alertId) {
        const vectors = StormState.state.motion.vectors;
        const v = vectors[alertId];
        if (!v || v.speedMph < 2) return { enabled: false, headingDeg: null, speedMph: null, confidence: "low" };

        const conf = v.speedMph > 20 ? "high" : v.speedMph > 8 ? "medium" : "low";
        return { enabled: true, headingDeg: v.bearingDeg, speedMph: v.speedMph, confidence: conf };
    }

    function isMotionRenderable(motion) {
        return motion.enabled && motion.headingDeg != null && motion.speedMph != null && motion.confidence !== "low";
    }

    // ── Main Update ────────────────────────────────────────────────

    function _update() {
        if (!_map || !_vizLayer) return;
        if (!_isAllowed()) {
            clearStormVisualization();
            return;
        }

        const at = StormState.state.autotrack;
        if (!at.enabled || !at.targetAlertId) {
            clearStormVisualization();
            state.mode = "idle";
            return;
        }

        const alerts = StormState.state.alerts.data || [];
        const tracked = alerts.find(a => a.id === at.targetAlertId);
        if (!tracked || !tracked.polygon) {
            clearStormVisualization();
            state.mode = "idle";
            return;
        }

        // Derive
        const intensity = deriveStormIntensity(tracked);
        const motion = deriveStormMotion(tracked.id);

        // Check if anything changed
        const changed = tracked.id !== state.trackedEventId || intensity !== state.intensity;

        state.trackedEventId = tracked.id;
        state.mode = "active";
        state.intensity = intensity;
        state.motion = motion;

        if (changed) {
            renderStormVisualization(tracked, intensity, motion);
            if (log) log.info("storm_viz_target_changed", {
                event_id: tracked.id.slice(-12),
                intensity,
                motion_enabled: motion.enabled,
            });
        }
    }

    // ── Rendering ──────────────────────────────────────────────────

    function renderStormVisualization(alert, intensity, motion) {
        _vizLayer.clearLayers();
        _motionLayer.clearLayers();
        _clearTooltips();

        renderTrackedPolygonEmphasis(alert, intensity);
        if (isMotionRenderable(motion)) {
            renderTrackedMotionVector(alert, motion);
        }
    }

    function renderTrackedPolygonEmphasis(alert, intensity) {
        // Performance guard: skip heavy effects if degraded
        const degraded = typeof StormVizState !== "undefined" && StormVizState.getState().degraded;

        try {
            const geo = JSON.parse(alert.polygon);
            const style = INTENSITY_STYLES[intensity] || INTENSITY_STYLES.none;

            // Halo layer (behind main polygon) — skip in degraded mode
            if (style.halo !== "none" && !degraded) {
                const haloLayer = L.geoJSON(geo, {
                    style: {
                        color: style.border,
                        weight: 8,
                        opacity: 0.15,
                        fillColor: "transparent",
                        fillOpacity: 0,
                        interactive: false,
                        className: `storm-viz-halo storm-viz-halo--${intensity}`,
                    },
                });
                _vizLayer.addLayer(haloLayer);
            }

            // Main emphasized polygon with storm-active class
            const mainLayer = L.geoJSON(geo, {
                style: {
                    color: style.border,
                    weight: 3,
                    opacity: 1.0,
                    fillColor: style.border,
                    fillOpacity: parseFloat(style.fill.match(/[\d.]+(?=\))/)?.[0] || 0.06),
                    interactive: false,
                    className: `storm-viz-polygon storm-viz-polygon--${intensity} storm-active`,
                },
            });
            _vizLayer.addLayer(mainLayer);
        } catch (e) { /* skip */ }
    }

    function renderTrackedMotionVector(alert, motion) {
        try {
            const geo = JSON.parse(alert.polygon);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) return;
            const c = b.getCenter();
            const centroid = { lat: c.lat, lon: c.lng };

            const bearingRad = motion.headingDeg * Math.PI / 180;
            const cosLat = Math.max(Math.cos(centroid.lat * Math.PI / 180), 0.01);

            // Arrow length scales with speed bucket
            const arrowLen = motion.speedMph > 30 ? 0.05 : motion.speedMph > 15 ? 0.04 : 0.03;
            const endLat = centroid.lat + arrowLen * Math.cos(bearingRad);
            const endLon = centroid.lon + arrowLen * Math.sin(bearingRad) / cosLat;

            // Arrow shaft
            const shaft = L.polyline([[centroid.lat, centroid.lon], [endLat, endLon]], {
                color: "#ffffff",
                weight: 2,
                opacity: 0.85,
                interactive: false,
                className: "storm-viz-arrow",
            });
            _motionLayer.addLayer(shaft);

            // Arrowhead
            const headLen = 0.012;
            const headAngle = Math.PI / 6;
            const left = [
                endLat - headLen * Math.cos(bearingRad - headAngle),
                endLon - headLen * Math.sin(bearingRad - headAngle) / cosLat,
            ];
            const right = [
                endLat - headLen * Math.cos(bearingRad + headAngle),
                endLon - headLen * Math.sin(bearingRad + headAngle) / cosLat,
            ];
            const head = L.polygon([[endLat, endLon], left, right], {
                color: "#ffffff",
                fillColor: "#ffffff",
                fillOpacity: 0.85,
                weight: 1,
                interactive: false,
            });
            _motionLayer.addLayer(head);

            // Speed label
            const tt = L.tooltip({
                permanent: true, direction: "right",
                className: "storm-viz-speed-label",
                offset: [8, 0],
            }).setLatLng([centroid.lat, centroid.lon])
              .setContent(`${Math.round(motion.speedMph)} mph`);
            tt.addTo(_map);
            if (!_motionLayer._tooltips) _motionLayer._tooltips = [];
            _motionLayer._tooltips.push(tt);
        } catch (e) { /* skip */ }
    }

    function clearStormVisualization() {
        if (_vizLayer) _vizLayer.clearLayers();
        if (_motionLayer) _motionLayer.clearLayers();
        _clearTooltips();
        state.trackedEventId = null;
        state.mode = "idle";
        state.intensity = "none";
        state.motion = { enabled: false, headingDeg: null, speedMph: null, confidence: "low" };
    }

    function _clearTooltips() {
        if (_motionLayer && _motionLayer._tooltips) {
            for (const t of _motionLayer._tooltips) {
                if (_map) _map.removeLayer(t);
            }
            _motionLayer._tooltips = [];
        }
    }

    // ── Public API ─────────────────────────────────────────────────

    function getState() { return { ...state }; }

    return {
        init, start, stop,
        deriveStormIntensity,
        deriveStormMotion,
        isMotionRenderable,
        renderStormVisualization,
        clearStormVisualization,
        getState,
        INTENSITY_STYLES,
    };
})();
