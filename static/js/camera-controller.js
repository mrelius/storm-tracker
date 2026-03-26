/**
 * Storm Tracker — CameraController
 *
 * Exclusive camera ownership layer. ALL automatic camera movement flows
 * through this module. No other module should call map.flyTo() directly;
 * CameraController delegates to Camera.move() which is the single
 * Leaflet-level gateway.
 *
 * Modes:
 *   idle            — no automatic camera movement
 *   follow_primary  — center on primary polygon centroid
 *   overview        — zoom out to fit all active alert bounds
 *
 * Invariants:
 * - _moveTo() is the ONLY function that triggers camera movement
 * - Minimum DEBOUNCE_MS between successive moves (suppresses rapid fire)
 * - Mode transitions are logged with from/to/reason
 * - Frequency guard: warns if >10 moves in 30s
 */
const CameraController = (function () {

    // ── Constants ──────────────────────────────────────────────────
    const DEBOUNCE_MS          = 2000;   // min 2s between camera moves
    const OVERVIEW_ZOOM        = 7;      // zoom level for overview mode
    const FOLLOW_TRANSITION_MS = 1200;   // fly animation duration (ms)
    const FREQ_WINDOW_MS       = 30000;  // frequency guard window
    const FREQ_LIMIT           = 10;     // max moves within window

    // ── State ──────────────────────────────────────────────────────
    const _state = {
        mode:            "idle",
        primaryId:       null,
        lastMoveTs:      0,
        moveCount:       0,
        suppressedCount: 0,
    };

    // Ring buffer for frequency guard
    const _moveTimestamps = [];

    let log = null;

    // ── Init ───────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") {
            log = STLogger.for("camera_ctrl");
        }

        StormState.on("alertsUpdated",            _onAlertsUpdated);
        StormState.on("autotrackTargetChanged",    _onTargetChanged);

        // React to backend-driven primary target changes (severe only)
        StormState.on("primary_target_changed", function (data) {
            if (!data || !data.primary_id) return;
            var ev = (data.event || "").toLowerCase();
            var isSevere = ev.includes("tornado") || ev.includes("severe thunderstorm") || ev.includes("flash flood");
            if (isSevere && _state.mode !== "idle") {
                _onPrimaryChanged(data);
            }
        });

        // React to unified state application
        StormState.on("frontend_state_applied", function (data) {
            if (data && data.active_count === 0 && _state.mode !== "idle") {
                _setModeInternal("idle", "all_alerts_cleared");
            }
        });

        if (log) log.info("camera_controller_init", { mode: _state.mode });
    }

    // ── Event Handlers ─────────────────────────────────────────────

    function _onAlertsUpdated() {
        const alerts = _getActiveAlerts();

        if (alerts.length === 0) {
            _setModeInternal("idle", "all_alerts_cleared");
            return;
        }

        // Only engage camera control for severe alerts (TOR/SVR/FFW)
        var severeAlerts = [];
        for (var i = 0; i < alerts.length; i++) {
            var ev = (alerts[i].event || "").toLowerCase();
            if (ev.includes("tornado") || ev.includes("severe thunderstorm") || ev.includes("flash flood")) {
                severeAlerts.push(alerts[i]);
            }
        }

        // No severe alerts = stay idle, let IdleAwareness handle camera
        if (severeAlerts.length === 0) {
            if (_state.mode !== "idle") {
                _setModeInternal("idle", "no_severe_alerts");
            }
            return;
        }

        // >3 severe alerts: switch to overview
        if (severeAlerts.length > 3) {
            _setModeInternal("overview", "severe_alerts_" + severeAlerts.length);
            _applyOverview(severeAlerts);
            return;
        }

        // If already following primary, re-center
        if (_state.mode === "follow_primary" && _state.primaryId) {
            _applyFollowPrimary();
        }
    }

    function _onTargetChanged(data) {
        const at = StormState.state.autotrack;

        // AT disabled or no target: go idle
        if (!at || !at.enabled || !at.targetAlertId) {
            _setModeInternal("idle", "at_disabled_or_no_target");
            return;
        }

        const alerts = _getActiveAlerts();

        // >3 alerts: overview takes priority
        if (alerts.length > 3) {
            _setModeInternal("overview", "multiple_alerts_" + alerts.length);
            _applyOverview(alerts);
            return;
        }

        // Follow primary target
        _state.primaryId = at.targetAlertId;
        _setModeInternal("follow_primary", "primary_target_set");
        _applyFollowPrimary();
    }

    function _onPrimaryChanged(data) {
        if (!data || !data.primary_id) return;

        // Find the alert to get its polygon centroid
        var alerts = StormState.state.alerts.data || [];
        var primary = null;
        for (var i = 0; i < alerts.length; i++) {
            if (alerts[i].id === data.primary_id) {
                primary = alerts[i];
                break;
            }
        }

        if (!primary || !primary.polygon) return;

        try {
            var geo = JSON.parse(primary.polygon);
            var layer = L.geoJSON(geo);
            var bounds = layer.getBounds();
            if (bounds.isValid()) {
                var center = bounds.getCenter();
                _moveTo(center.lat, center.lng, null, "primary_target_changed");
            }
        } catch (e) {
            // Invalid polygon — skip
        }
    }

    // ── Mode Transitions ───────────────────────────────────────────

    function _setModeInternal(newMode, reason) {
        if (_state.mode === newMode) return;

        const from = _state.mode;
        _state.mode = newMode;

        if (newMode === "idle") {
            _state.primaryId = null;
        }

        if (log) {
            log.info("camera_mode_changed", { from, to: newMode, reason });
        }
    }

    /**
     * Manual mode override (public API).
     * @param {string} mode - "idle" | "follow_primary" | "overview"
     */
    function setMode(mode) {
        const valid = ["idle", "follow_primary", "overview"];
        if (!valid.includes(mode)) {
            if (log) log.info("camera_mode_rejected", { requested: mode, reason: "invalid_mode" });
            return;
        }
        _setModeInternal(mode, "manual_override");
    }

    // ── Camera Move (exclusive gateway) ────────────────────────────

    /**
     * The ONLY function that triggers camera movement.
     * Enforces debounce and delegates to Camera.move().
     *
     * @param {number} lat
     * @param {number} lon
     * @param {number} zoom
     * @param {string} reason - human-readable reason for logs
     * @returns {boolean} true if move executed, false if suppressed
     */
    function _moveTo(lat, lon, zoom, reason) {
        const now = Date.now();
        const timeSinceLast = now - _state.lastMoveTs;

        // Debounce enforcement
        if (_state.lastMoveTs > 0 && timeSinceLast < DEBOUNCE_MS) {
            _state.suppressedCount++;
            if (log) {
                log.info("camera_move_suppressed", {
                    reason: "debounce",
                    time_since_last_ms: timeSinceLast,
                    suppressed_total: _state.suppressedCount,
                });
            }
            return false;
        }

        // Frequency guard
        _moveTimestamps.push(now);
        // Trim old entries
        while (_moveTimestamps.length > 0 && _moveTimestamps[0] < now - FREQ_WINDOW_MS) {
            _moveTimestamps.shift();
        }
        if (_moveTimestamps.length > FREQ_LIMIT) {
            if (log) {
                log.info("camera_move_frequency_warning", {
                    moves_in_window: _moveTimestamps.length,
                    window_ms: FREQ_WINDOW_MS,
                    limit: FREQ_LIMIT,
                });
            }
        }

        // Delegate to Camera.move()
        const moved = Camera.move({
            source: "autotrack",
            center: [lat, lon],
            zoom: zoom,
            flyOptions: {
                duration: FOLLOW_TRANSITION_MS / 1000,
                easeLinearity: 0.25,
            },
            reason: reason || "camera_controller",
        });

        if (moved) {
            _state.lastMoveTs = now;
            _state.moveCount++;

            if (log) {
                log.info("camera_move", {
                    mode: _state.mode,
                    target_id: _state.primaryId ? _state.primaryId.slice(-12) : null,
                    lat: Number(lat.toFixed(4)),
                    lon: Number(lon.toFixed(4)),
                    zoom: zoom,
                    reason: reason,
                    move_count: _state.moveCount,
                });
            }
        }

        return moved;
    }

    // ── Apply Behaviors ────────────────────────────────────────────

    function _applyFollowPrimary() {
        if (_state.mode !== "follow_primary" || !_state.primaryId) return;

        const alerts = StormState.state.alerts.data || [];
        const tracked = alerts.find(function (a) { return a.id === _state.primaryId; });

        if (!tracked || !tracked.polygon) {
            _setModeInternal("idle", "primary_target_lost");
            return;
        }

        var centroid = _computeCentroid(tracked.polygon);
        if (!centroid) return;

        // Determine zoom from current map or use a sensible default
        var map = StormMap.getMap();
        var currentZoom = map ? map.getZoom() : 10;
        var zoom = Math.max(currentZoom, 9);
        // Cap at tile limit
        zoom = Math.min(zoom, 10);

        _moveTo(centroid.lat, centroid.lon, zoom, "follow_primary_centroid");
    }

    function _applyOverview(alerts) {
        if (_state.mode !== "overview") return;
        if (!alerts || alerts.length === 0) return;

        // Compute combined bounds of all alert polygons
        var allBounds = null;

        for (var i = 0; i < alerts.length; i++) {
            var a = alerts[i];
            if (!a.polygon) continue;

            try {
                var geo = JSON.parse(a.polygon);
                var layer = L.geoJSON(geo);
                var b = layer.getBounds();
                if (b.isValid()) {
                    allBounds = allBounds ? allBounds.extend(b) : b;
                }
            } catch (e) {
                // skip invalid polygons
            }
        }

        if (!allBounds || !allBounds.isValid()) return;

        var center = allBounds.getCenter();
        _moveTo(center.lat, center.lng, OVERVIEW_ZOOM, "overview_fit_bounds");
    }

    // ── Public: requestMove ────────────────────────────────────────

    /**
     * External request for a camera move. Subject to debounce.
     * Other modules should use this instead of calling Camera.move() directly
     * for controlled, debounced camera movement.
     *
     * @param {number} lat
     * @param {number} lon
     * @param {number} zoom
     * @param {string} reason
     * @returns {boolean} true if move executed
     */
    function requestMove(lat, lon, zoom, reason) {
        return _moveTo(lat, lon, zoom, reason || "external_request");
    }

    // ── Helpers ────────────────────────────────────────────────────

    function _getActiveAlerts() {
        var alerts = StormState.state.alerts.data || [];
        return alerts.filter(function (a) { return a.polygon; });
    }

    function _computeCentroid(polygonStr) {
        try {
            var geo = JSON.parse(polygonStr);
            var layer = L.geoJSON(geo);
            var b = layer.getBounds();
            if (!b.isValid()) return null;
            var c = b.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) {
            return null;
        }
    }

    // ── Public API ─────────────────────────────────────────────────

    function getState() {
        return {
            mode:            _state.mode,
            primaryId:       _state.primaryId,
            lastMoveTs:      _state.lastMoveTs,
            moveCount:       _state.moveCount,
            suppressedCount: _state.suppressedCount,
        };
    }

    function getMode() {
        return _state.mode;
    }

    return {
        init:        init,
        getState:    getState,
        getMode:     getMode,
        requestMove: requestMove,
        setMode:     setMode,
    };

})();
