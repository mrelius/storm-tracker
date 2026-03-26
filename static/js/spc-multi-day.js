/**
 * Storm Tracker — SPC Multi-Day Registry, Scoring & Auto-Selection
 *
 * Manages Day 1/2/3 SPC outlooks with auto-selection of the most severe day.
 * Single active day in auto mode. Manual override with timeout.
 *
 * Designed for extension: Day 4-8 can be added without schema rewrite.
 */
const SPCMultiDay = (function () {

    // ── SPC Category Scoring ───────────────────────────────────────
    const SPC_CATEGORY_SCORE = {
        "TSTM": 1,
        "MRGL": 2,
        "SLGT": 3,
        "ENH":  4,
        "MDT":  5,
        "HIGH": 6,
    };

    // ── SPC Day URLs (official SPC GeoJSON feeds) ──────────────────
    const SPC_DAY_URLS = {
        1: "/api/spc/outlook?day=1",
        2: "/api/spc/outlook?day=2",
        3: "/api/spc/outlook?day=3",
    };

    // ── Anti-flap Config ───────────────────────────────────────────
    const SPC_DAY_MIN_HOLD_MS = 30000;
    const SPC_DAY_SWITCH_SCORE_DELTA = 1;
    const SPC_MANUAL_OVERRIDE_MS = 25000;
    const SPC_EVAL_INTERVAL_MS = 60000;

    // ── State ──────────────────────────────────────────────────────

    /** @type {Record<string, {day: number, productType: string, available: boolean, fetchedAt: number|null, featureCount: number, features: GeoJSON.Feature[]}>} */
    let _registry = {
        "day1_convective": { day: 1, productType: "convective", available: false, fetchedAt: null, featureCount: 0, features: [] },
        "day2_convective": { day: 2, productType: "convective", available: false, fetchedAt: null, featureCount: 0, features: [] },
        "day3_convective": { day: 3, productType: "convective", available: false, fetchedAt: null, featureCount: 0, features: [] },
    };

    let _autoState = {
        activeDay: null,
        selectedCategory: null,
        selectedScore: 0,
        lastSelectionAt: null,
        authority: "auto_track",  // "auto_track" | "user_manual"
        manualDay: null,
        manualOverrideUntil: null,
    };

    let _layers = {};  // day -> L.geoJSON layer
    let _evalTimer = null;
    let log = null;

    // ── Init ───────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("spc_multi");

        // Initial data fetch for all days
        fetchAllDays();

        // Periodic re-evaluation
        _evalTimer = setInterval(_autoEvaluate, SPC_EVAL_INTERVAL_MS);

        // Listen for AT target changes to re-evaluate
        StormState.on("autotrackTargetChanged", () => setTimeout(_autoEvaluate, 1000));
        StormState.on("alertsUpdated", () => setTimeout(_autoEvaluate, 2000));
    }

    // ── Data Fetching ──────────────────────────────────────────────

    async function fetchAllDays() {
        await Promise.allSettled([
            _fetchDay(1),
            _fetchDay(2),
            _fetchDay(3),
        ]);
    }

    async function _fetchDay(day) {
        const key = `day${day}_convective`;
        try {
            const resp = await fetch(SPC_DAY_URLS[day]);
            if (!resp.ok) {
                _registry[key].available = false;
                return;
            }
            const geojson = await resp.json();
            const features = geojson.features || [];
            _registry[key].available = features.length > 0;
            _registry[key].fetchedAt = Date.now();
            _registry[key].featureCount = features.length;
            _registry[key].features = features;
        } catch (e) {
            _registry[key].available = false;
        }
    }

    // ── Auto-Selection Engine ──────────────────────────────────────

    function _autoEvaluate() {
        const at = StormState.state.autotrack;
        if (!at.enabled) return;

        // Respect manual override timeout
        if (_autoState.authority === "user_manual") {
            if (_autoState.manualOverrideUntil && Date.now() < _autoState.manualOverrideUntil) {
                return;
            }
            // Timeout expired — reclaim auto authority
            _setAuthority("auto_track", "manual_override_expired");
        }

        const alerts = StormState.state.alerts.data || [];
        const tracked = at.targetAlertId ? alerts.find(a => a.id === at.targetAlertId) : null;
        const nearby = _getNearbyAlerts(tracked, alerts);

        const result = selectMostSevereSpcDay({
            trackedAlert: tracked,
            nearbyAlerts: nearby,
            viewportBounds: _getViewportBounds(),
            spcFeaturesByDay: _getFeaturesByDay(),
        });

        if (!result) {
            if (_autoState.activeDay !== null) {
                clearAutoSelectedSpcLayers();
            }
            return;
        }

        // Anti-flap: check if switch is warranted
        const now = Date.now();
        const currentScore = _autoState.selectedScore;
        const holdElapsed = _autoState.lastSelectionAt
            ? now - _autoState.lastSelectionAt >= SPC_DAY_MIN_HOLD_MS
            : true;

        const scoreDelta = result.score - currentScore;
        const shouldSwitch =
            _autoState.activeDay === null
            || (result.day !== _autoState.activeDay && holdElapsed && scoreDelta >= SPC_DAY_SWITCH_SCORE_DELTA)
            || (result.day !== _autoState.activeDay && result.intersectsTrackedArea && scoreDelta >= SPC_DAY_SWITCH_SCORE_DELTA);

        if (!shouldSwitch) {
            if (result.day !== _autoState.activeDay && log) {
                log.info("spc_auto_selection_skipped", {
                    reason: !holdElapsed ? "min_hold_active" : "score_delta_insufficient",
                    candidate_day: result.day,
                    current_day: _autoState.activeDay,
                });
            }
            return;
        }

        const prevDay = _autoState.activeDay;
        _autoState.activeDay = result.day;
        _autoState.selectedCategory = result.category;
        _autoState.selectedScore = result.score;
        _autoState.lastSelectionAt = now;

        if (log) {
            log.info("spc_auto_selected_day", {
                previous_day: prevDay,
                next_day: result.day,
                category: result.category,
                score: result.score,
                intersects_tracked_area: result.intersectsTrackedArea,
            });
        }

        applyAutoSelectedSpcDay(result.day);
    }

    // ── Scoring Algorithm ──────────────────────────────────────────

    /**
     * Select the most severe SPC day for the current context.
     * @param {Object} args
     * @returns {Object|null} SpcSelectionResult
     */
    function selectMostSevereSpcDay({ trackedAlert, nearbyAlerts, viewportBounds, spcFeaturesByDay }) {
        let bestResult = null;
        let bestScore = -1;

        for (const day of [1, 2, 3]) {
            const features = spcFeaturesByDay[day] || [];
            if (features.length === 0) continue;

            const result = _scoreDayForContext(day, features, trackedAlert, nearbyAlerts, viewportBounds);
            if (!result) continue;

            // Prefer: higher score, then intersects tracked, then lower day number
            const isBetter =
                result.score > bestScore
                || (result.score === bestScore && result.intersectsTrackedArea && !(bestResult && bestResult.intersectsTrackedArea))
                || (result.score === bestScore && result.intersectsTrackedArea === (bestResult && bestResult.intersectsTrackedArea) && result.day < (bestResult ? bestResult.day : 99));

            if (isBetter) {
                bestResult = result;
                bestScore = result.score;
            }
        }

        return bestResult;
    }

    function _scoreDayForContext(day, features, trackedAlert, nearbyAlerts, viewportBounds) {
        let bestCategory = null;
        let bestScore = 0;
        let intersectsTracked = false;
        let intersectsViewport = false;
        let bestBounds = null;

        for (const feature of features) {
            const label = feature.properties?.LABEL || feature.properties?.LABEL2 || feature.properties?.dn || "";
            const category = _normalizeCategory(label);
            const score = SPC_CATEGORY_SCORE[category] || 0;

            if (score <= 0) continue;

            // Check intersection with tracked alert
            if (trackedAlert && trackedAlert.polygon) {
                try {
                    const trackedCenter = _getFeatureCenter(JSON.parse(trackedAlert.polygon));
                    if (trackedCenter && _pointInFeature(trackedCenter, feature)) {
                        intersectsTracked = true;
                    }
                } catch (e) { /* ignore */ }
            }

            // Check viewport intersection
            if (viewportBounds && feature.geometry) {
                try {
                    const featureBounds = _getGeometryBounds(feature.geometry);
                    if (featureBounds && viewportBounds.intersects(featureBounds)) {
                        intersectsViewport = true;
                    }
                    if (featureBounds && score > bestScore) {
                        bestBounds = featureBounds;
                    }
                } catch (e) { /* ignore */ }
            }

            if (score > bestScore) {
                bestScore = score;
                bestCategory = category;
            }
        }

        if (bestScore === 0) return null;

        return {
            day,
            category: bestCategory,
            score: bestScore,
            intersectsTrackedArea: intersectsTracked,
            intersectsViewport: intersectsViewport,
            bounds: bestBounds,
        };
    }

    function _normalizeCategory(label) {
        const upper = (label || "").toUpperCase().trim();
        // Handle numeric labels from some SPC products
        if (upper === "2" || upper === "0.02") return "TSTM";
        if (upper === "3" || upper === "0.05") return "MRGL";
        if (upper === "4" || upper === "0.10" || upper === "0.15") return "SLGT";
        if (upper === "5" || upper === "0.25" || upper === "0.30") return "ENH";
        if (upper === "6" || upper === "0.35" || upper === "0.45") return "MDT";
        if (upper === "8" || upper === "0.60") return "HIGH";
        // Direct label match
        if (SPC_CATEGORY_SCORE[upper] !== undefined) return upper;
        return upper;
    }

    // ── Layer Management ───────────────────────────────────────────

    /**
     * Show the specified SPC day on the map, hide all others.
     * @param {number} day - 1, 2, or 3
     */
    function applyAutoSelectedSpcDay(day) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        // Remove all SPC day layers
        for (const [d, layer] of Object.entries(_layers)) {
            if (layer) map.removeLayer(layer);
        }

        // Add selected day
        const key = `day${day}_convective`;
        const regEntry = _registry[key];
        if (!regEntry || !regEntry.available || regEntry.features.length === 0) return;

        const RISK_FILL = {
            "TSTM": { color: "#55BB55", opacity: 0.08 },
            "MRGL": { color: "#005500", opacity: 0.12 },
            "SLGT": { color: "#DDAA00", opacity: 0.15 },
            "ENH":  { color: "#FF6600", opacity: 0.18 },
            "MDT":  { color: "#FF0000", opacity: 0.20 },
            "HIGH": { color: "#FF00FF", opacity: 0.25 },
        };

        const geojson = { type: "FeatureCollection", features: regEntry.features };
        _layers[day] = L.geoJSON(geojson, {
            style: function (feature) {
                const label = _normalizeCategory(feature.properties?.LABEL || "");
                const style = RISK_FILL[label] || { color: "#888", opacity: 0.05 };
                return {
                    fillColor: style.color,
                    fillOpacity: style.opacity,
                    weight: 0.5,
                    color: style.color,
                    opacity: 0.15,
                    interactive: false,
                    className: "spc-field",
                };
            },
        }).addTo(map);

        // Feed features to intersection engine for polygon blending
        if (typeof PolygonVisuals !== "undefined") {
            PolygonVisuals.setSpcFeatures(regEntry.features);
        }

        // Update legend title
        const legend = document.getElementById("spc-legend");
        if (legend) {
            const titleEl = legend.querySelector(".spc-legend-title");
            if (titleEl) titleEl.textContent = `SPC Day ${day} Outlook`;
        }

        // Update SPC day badge
        _updateBadge();
    }

    function clearAutoSelectedSpcLayers() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        for (const [d, layer] of Object.entries(_layers)) {
            if (layer && map) map.removeLayer(layer);
        }
        _layers = {};
        _autoState.activeDay = null;
        _autoState.selectedCategory = null;
        _autoState.selectedScore = 0;
        _updateBadge();

        // Clear SPC features from intersection engine
        if (typeof PolygonVisuals !== "undefined") {
            PolygonVisuals.setSpcFeatures([]);
        }
    }

    // ── Manual Override ────────────────────────────────────────────

    /**
     * User manually selects an SPC day.
     * @param {number|null} day - 1, 2, 3, or null (disable)
     */
    function setManualDay(day) {
        _autoState.authority = "user_manual";
        _autoState.manualDay = day;
        _autoState.manualOverrideUntil = Date.now() + SPC_MANUAL_OVERRIDE_MS;

        if (log) {
            log.info("spc_authority_changed", {
                previous_authority: "auto_track",
                next_authority: "user_manual",
                reason: "user_manual_selection",
            });
        }

        if (day) {
            applyAutoSelectedSpcDay(day);
            _autoState.activeDay = day;
        } else {
            clearAutoSelectedSpcLayers();
        }
    }

    function _setAuthority(authority, reason) {
        const prev = _autoState.authority;
        if (prev === authority) return;
        _autoState.authority = authority;
        if (log) {
            log.info("spc_authority_changed", {
                previous_authority: prev,
                next_authority: authority,
                reason,
            });
        }
    }

    // ── SPC Day Badge ──────────────────────────────────────────────

    function _updateBadge() {
        const badge = document.getElementById("spc-day-badge");
        if (!badge) return;

        if (_autoState.activeDay && _autoState.selectedCategory) {
            badge.textContent = `SPC Day ${_autoState.activeDay} ${_autoState.selectedCategory}`;
            badge.classList.remove("hidden");
        } else {
            badge.textContent = "";
            badge.classList.add("hidden");
        }
    }

    // ── Geometry Helpers ───────────────────────────────────────────

    function _getFeatureCenter(geojson) {
        try {
            const layer = L.geoJSON(geojson);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            const c = b.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) { return null; }
    }

    function _pointInFeature(point, feature) {
        if (!feature.geometry) return false;
        const geo = feature.geometry;
        if (geo.type === "Polygon") {
            return _pointInPolygon(point, geo.coordinates[0]);
        }
        if (geo.type === "MultiPolygon") {
            for (const poly of geo.coordinates) {
                if (_pointInPolygon(point, poly[0])) return true;
            }
        }
        return false;
    }

    function _pointInPolygon(point, ring) {
        let inside = false;
        const x = point.lon, y = point.lat;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    function _getGeometryBounds(geometry) {
        try {
            const layer = L.geoJSON({ type: "Feature", geometry, properties: {} });
            const b = layer.getBounds();
            return b.isValid() ? b : null;
        } catch (e) { return null; }
    }

    function _getViewportBounds() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return null;
        return map.getBounds();
    }

    function _getNearbyAlerts(tracked, alerts) {
        if (!tracked) return [];
        return alerts.filter(a =>
            a.id !== tracked.id
            && a.distance_mi != null
            && a.distance_mi <= 50
            && a.polygon
        );
    }

    function _getFeaturesByDay() {
        return {
            1: _registry.day1_convective.features,
            2: _registry.day2_convective.features,
            3: _registry.day3_convective.features,
        };
    }

    // ── Public API ─────────────────────────────────────────────────

    function getAutoState() {
        return { ..._autoState };
    }

    function getRegistry() {
        const result = {};
        for (const [k, v] of Object.entries(_registry)) {
            result[k] = { day: v.day, productType: v.productType, available: v.available, fetchedAt: v.fetchedAt, featureCount: v.featureCount };
        }
        return result;
    }

    function getActiveDay() {
        return _autoState.activeDay;
    }

    function getActiveCategory() {
        return _autoState.selectedCategory;
    }

    // ── Mode API (for flyout menu integration) ─────────────────────

    /**
     * Set SPC mode to auto or manual.
     * @param {"auto"|"manual"} mode
     */
    function setMode(mode) {
        const prefs = StormState.state.userPrefs;
        if (mode === "auto") {
            prefs.spcMode = "auto_most_severe";
            prefs.spcManualDay = null;
            _autoState.manualDay = null;
            _autoState.manualOverrideUntil = null;
            _setAuthority("auto_track", "user_selected_auto");
            // Trigger immediate auto-evaluation
            _autoEvaluate();
        } else {
            prefs.spcMode = "manual";
        }
        localStorage.setItem("spc_mode", prefs.spcMode);
        _updateBadge();
    }

    /**
     * Clear manual override and return to auto mode.
     */
    function clearManualOverride() {
        setMode("auto");
    }

    /**
     * Get availability of each SPC day.
     * @returns {Record<number, boolean>}
     */
    function getAvailability() {
        return {
            1: _registry.day1_convective.available,
            2: _registry.day2_convective.available,
            3: _registry.day3_convective.available,
        };
    }

    /**
     * Get current mode/authority for UI display.
     * @returns {{ mode: string, authority: string, activeDay: number|null, manualDay: number|null, category: string|null }}
     */
    function getCurrentState() {
        const prefs = StormState.state.userPrefs;
        return {
            mode: prefs.spcMode,
            authority: _autoState.authority,
            activeDay: _autoState.activeDay,
            manualDay: _autoState.manualDay,
            category: _autoState.selectedCategory,
        };
    }

    // ── Badge (extended for manual mode) ───────────────────────────

    function _updateBadge() {
        const badge = document.getElementById("spc-day-badge");
        if (!badge) return;

        const prefs = StormState.state.userPrefs;

        if (prefs.spcMode === "manual" && _autoState.manualDay) {
            badge.textContent = `SPC Manual Day ${_autoState.manualDay}`;
            badge.classList.remove("hidden");
        } else if (_autoState.activeDay && _autoState.selectedCategory) {
            badge.textContent = `SPC Day ${_autoState.activeDay} ${_autoState.selectedCategory}`;
            badge.classList.remove("hidden");
        } else {
            badge.textContent = "";
            badge.classList.add("hidden");
        }

        // Also emit for SPC overlay UI sync
        if (typeof StormState !== "undefined") {
            StormState.emit("spcStateChanged", getCurrentState());
        }
    }

    return {
        init,
        fetchAllDays,
        selectMostSevereSpcDay,
        applyAutoSelectedSpcDay,
        clearAutoSelectedSpcLayers,
        setManualDay,
        setMode,
        clearManualOverride,
        getAutoState,
        getRegistry,
        getActiveDay,
        getActiveCategory,
        getAvailability,
        getCurrentState,
        SPC_CATEGORY_SCORE,
    };
})();
