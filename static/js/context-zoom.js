/**
 * Storm Tracker — Contextual Auto Zoom-Out (v3 — SPC escalation + visual differentiation)
 *
 * Two zoom modes:
 *   normal_context — local cluster framing (existing behavior)
 *   spc_context    — wider framing to include SPC outlook when severity crosses threshold
 *
 * Cluster-aware selection: prefer alerts that expand spatial coverage.
 * Bounding sanity: reject if expanded area > limits.
 * Directional spread: require alerts in different directions from tracked.
 * Anti-flap: debounce enter/exit, cooldown, manual suppression, mode hold.
 *
 * Only applies in AUTO_TRACK mode.
 */
const ContextZoom = (function () {

    // ── Thresholds ───────────────────────────────────────────────
    const TRACKED_CLOSE_MILES = 30;
    const NEARBY_ALERT_RADIUS = 25;
    const MIN_ALERT_COUNT = 2;
    const ZOOM_OUT_MIN = 1;
    const ZOOM_OUT_MAX = 2;
    const BOUNDS_EXPANSION_LIMIT = 3.0; // max 3x tracked polygon area (normal_context)
    const MIN_ANGULAR_SPREAD = 30;      // degrees — min spread between candidates

    // ── SPC Context Thresholds ──────────────────────────────────
    const CONTEXT_ZOOM_MIN = 6;
    const CONTEXT_ZOOM_MAX = 10;
    const SPC_CONTEXT_ZOOM_MIN = 5;
    const SPC_CONTEXT_MAX_AREA_MULTIPLIER = 12;
    const SPC_ESCALATION_MIN_TIER = "significant";

    // ── Timing ───────────────────────────────────────────────────
    const ENTER_DEBOUNCE_MS = 4000;
    const EXIT_DEBOUNCE_MS = 10000;
    const COOLDOWN_MS = 12000;
    const MANUAL_SUPPRESS_MS = 25000;
    const EVAL_INTERVAL_MS = 15000;
    const EDGE_HYSTERESIS_MI = 3;
    const CONTEXT_MODE_MIN_HOLD_MS = 12000;
    const CONTEXT_MODE_REEVAL_DEBOUNCE_MS = 3000;

    // ── Important Event Filter ───────────────────────────────────
    const IMPORTANT_EVENTS = new Set([
        "Tornado Warning",
        "Severe Thunderstorm Warning",
        "Flash Flood Warning",
    ]);

    // ── State ────────────────────────────────────────────────────
    let state = {
        active: false,
        enteredAt: null,
        lastTransitionAt: null,
        suppressedUntil: null,
        causeAlertIds: [],
        baseZoom: null,
        targetZoom: null,
        zoomMode: null,             // "normal_context" | "spc_context" | null
        lastModeChangeAt: null,
    };

    let enterTimer = null;
    let exitTimer = null;
    let evalTimer = null;
    let log = null;
    let lastCandidateHash = "";

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("ctx_zoom");

        StormState.on("alertsUpdated", _scheduleEval);
        StormState.on("autotrackTargetChanged", _scheduleEval);
        StormState.on("userMapInteraction", _onManualInteraction);

        evalTimer = setInterval(_evaluate, EVAL_INTERVAL_MS);
    }

    function _scheduleEval() {
        setTimeout(_evaluate, 500);
    }

    // ── Core Evaluation ──────────────────────────────────────────

    function _evaluate() {
        const at = StormState.state.autotrack;
        if (!at.enabled || !at.targetAlertId) {
            if (state.active) _exit("autotrack_off");
            return;
        }

        const now = Date.now();
        if (state.suppressedUntil && now < state.suppressedUntil) return;

        const alerts = StormState.state.alerts.data || [];
        const tracked = alerts.find(a => a.id === at.targetAlertId);
        if (!tracked) {
            if (state.active) _exit("tracked_lost");
            return;
        }

        // Tracked must be close — with hysteresis
        const effectiveThreshold = state.active
            ? TRACKED_CLOSE_MILES + EDGE_HYSTERESIS_MI
            : TRACKED_CLOSE_MILES;

        if (tracked.distance_mi == null || tracked.distance_mi > effectiveThreshold) {
            if (state.active) _scheduleExit("tracked_far");
            return;
        }

        // Find nearby important alerts
        const candidates = [];
        for (const a of alerts) {
            if (a.id === at.targetAlertId) continue;
            if (!IMPORTANT_EVENTS.has(a.event)) continue;
            if (!a.polygon) continue;
            if (a.distance_mi == null || a.distance_mi > NEARBY_ALERT_RADIUS) continue;
            candidates.push(a);
        }

        if (candidates.length < MIN_ALERT_COUNT) {
            if (state.active) _scheduleExit("insufficient_alerts");
            return;
        }

        // Cluster-aware selection: prefer spatial spread
        const selected = _selectForCoverage(tracked, candidates);

        if (selected.length < MIN_ALERT_COUNT) {
            if (state.active) _scheduleExit("no_spread");
            return;
        }

        // Anti-flap: check if candidate set changed
        const hash = [tracked.id, ...selected.map(a => a.id)].sort().join(",");
        if (hash === lastCandidateHash && state.active) {
            // Same cluster — check if zoom mode should change
            _evaluateZoomMode(tracked, selected);
            return;
        }
        lastCandidateHash = hash;

        if (!state.active) {
            _scheduleEnter(tracked, selected);
        } else {
            state.causeAlertIds = [tracked.id, ...selected.map(a => a.id)];
            // Update polygon visuals for changed cluster
            _updatePolygonVisuals(tracked, selected);
            _evaluateZoomMode(tracked, selected);
        }
    }

    // ── Zoom Mode Determination ──────────────────────────────────

    function _evaluateZoomMode(tracked, nearbySelected) {
        const allAlerts = [tracked, ...nearbySelected];
        const clusterSeverity = typeof SeverityModel !== "undefined"
            ? SeverityModel.deriveClusterSeverity(allAlerts)
            : "low";

        // Check SPC escalation
        const spcCandidate = typeof SPCMultiDay !== "undefined"
            ? SPCMultiDay.selectMostSevereSpcDay({
                trackedAlert: tracked,
                nearbyAlerts: nearbySelected,
                viewportBounds: _getViewportBounds(),
                spcFeaturesByDay: _getSpcFeaturesByDay(),
            })
            : null;

        const newMode = determineContextZoomMode({
            trackedAlert: tracked,
            nearbyAlerts: nearbySelected,
            clusterSeverity,
            spcCandidate,
        });

        // Anti-flap: don't switch modes too quickly
        const now = Date.now();
        if (newMode !== state.zoomMode) {
            if (state.lastModeChangeAt && now - state.lastModeChangeAt < CONTEXT_MODE_MIN_HOLD_MS) {
                return; // Hold current mode
            }

            const prevMode = state.zoomMode;
            state.zoomMode = newMode;
            state.lastModeChangeAt = now;

            // Update shared state
            const czr = StormState.state.contextZoomRuntime;
            czr.zoomMode = newMode;
            czr.reason = newMode === "spc_context" ? "severity_spc" : "multi_alert";

            if (log) {
                log.info("context_zoom_mode_changed", {
                    previous_mode: prevMode,
                    next_mode: newMode,
                    reason: newMode === "spc_context" ? "severity_escalation" : "normal_cluster",
                    cluster_severity: clusterSeverity,
                    tracked_event_id: (tracked.id || "").slice(-12),
                });
            }

            // If escalated to SPC, apply wider framing
            if (newMode === "spc_context" && spcCandidate) {
                _applySpcContextZoom(tracked, spcCandidate);
            }
        }
    }

    /**
     * Determine context zoom mode based on severity and SPC availability.
     */
    function determineContextZoomMode({ trackedAlert, nearbyAlerts, clusterSeverity, spcCandidate }) {
        if (!trackedAlert) return "normal_context";

        const prefs = StormState.state.userPrefs;
        if (!prefs.spcEscalationEnabled) return "normal_context";

        if (shouldEscalateContextToSpc({ trackedAlert, clusterSeverity, spcCandidate })) {
            return "spc_context";
        }

        return "normal_context";
    }

    /**
     * Authoritative SPC escalation decision.
     */
    function shouldEscalateContextToSpc({ trackedAlert, clusterSeverity, spcCandidate }) {
        if (!trackedAlert) return false;
        if (!spcCandidate) return false;
        if (typeof SeverityModel === "undefined") return false;
        if (!SeverityModel.tierGte(clusterSeverity, SPC_ESCALATION_MIN_TIER)) return false;
        if (!spcCandidate.intersectsTrackedArea && !spcCandidate.intersectsViewport) return false;
        return true;
    }

    // ── SPC Context Zoom ─────────────────────────────────────────

    function _applySpcContextZoom(tracked, spcCandidate) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        const trackedBounds = _getAlertBounds(tracked);
        if (!trackedBounds) return;

        // Use ContextZoomResolver if available for full SPC + reference framing
        if (typeof ContextZoomResolver !== "undefined") {
            const spcFeatures = _collectSpcFeatures(spcCandidate);
            const safeArea = _computeSafeAreaInsets();

            const resolved = ContextZoomResolver.resolveContextZoomBounds({
                highlightedPolygonBounds: trackedBounds,
                highlightedPolygonId: tracked.id,
                spcReports: spcFeatures,
                spcOutlookBounds: spcCandidate.bounds || null,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                safeAreaInsets: safeArea,
                map: map,
            });

            if (resolved) {
                state.targetZoom = resolved.zoom;
                Camera.move({
                    source: "autotrack",
                    center: [resolved.center.lat, resolved.center.lon],
                    zoom: resolved.zoom,
                    flyOptions: { duration: 1.2, easeLinearity: 0.2 },
                    reason: "context_zoom_spc",
                });

                if (typeof SPCMultiDay !== "undefined") {
                    SPCMultiDay.applyAutoSelectedSpcDay(spcCandidate.day);
                }
                return;
            }
        }

        // Fallback: original bounds computation
        const spcBounds = spcCandidate.bounds;
        const result = computeSpcContextBounds({
            trackedBounds,
            spcBounds,
            maxAreaMultiplier: SPC_CONTEXT_MAX_AREA_MULTIPLIER,
        });

        if (!result) return;

        const targetZoom = Math.max(SPC_CONTEXT_ZOOM_MIN, Math.min(CONTEXT_ZOOM_MAX,
            map.getBoundsZoom(result.pad(0.1))
        ));

        state.targetZoom = targetZoom;

        const center = result.getCenter();
        Camera.move({
            source: "autotrack",
            center: [center.lat, center.lng],
            zoom: targetZoom,
            flyOptions: { duration: 1.2, easeLinearity: 0.2 },
            reason: "context_zoom_spc",
        });

        // Auto-enable SPC day overlay
        if (typeof SPCMultiDay !== "undefined") {
            SPCMultiDay.applyAutoSelectedSpcDay(spcCandidate.day);
        }
    }

    function _collectSpcFeatures(spcCandidate) {
        // Gather SPC features from SPCMultiDay if available
        if (typeof SPCMultiDay === "undefined") return [];
        try {
            const reg = SPCMultiDay.getRegistry();
            const dayKey = `day${spcCandidate.day}_convective`;
            const entry = reg[dayKey];
            if (entry && entry.features) return entry.features;
        } catch (e) { /* ok */ }
        return [];
    }

    function _computeSafeAreaInsets() {
        // Pass null to let ContextZoomResolver measure dynamically from DOM
        return null;
    }

    /**
     * Compute SPC context bounds — union of tracked + SPC, clamped by multiplier.
     */
    function computeSpcContextBounds({ trackedBounds, spcBounds, maxAreaMultiplier }) {
        if (!trackedBounds) return null;
        if (!spcBounds) return trackedBounds;

        const union = L.latLngBounds(trackedBounds.getSouthWest(), trackedBounds.getNorthEast());
        union.extend(spcBounds);

        // Reject if too large
        const trackedArea = _boundsArea(trackedBounds);
        const unionArea = _boundsArea(union);
        if (trackedArea > 0 && unionArea / trackedArea > maxAreaMultiplier) {
            if (log) {
                log.info("spc_context_bounds_rejected", {
                    reason: "area_multiplier_exceeded",
                    area_multiplier: Math.round(unionArea / trackedArea * 10) / 10,
                });
            }
            return null;
        }

        return union;
    }

    // ── Polygon Visual Integration ───────────────────────────────

    function _updatePolygonVisuals(tracked, nearbySelected) {
        if (typeof PolygonVisuals === "undefined" || typeof SeverityModel === "undefined") return;

        const allAlerts = [tracked, ...nearbySelected];
        const clusterSeverity = SeverityModel.deriveClusterSeverity(allAlerts);
        const prefs = StormState.state.userPrefs;

        PolygonVisuals.updateContextPolygonVisuals({
            clusterEvents: allAlerts,
            primaryEventId: tracked.id,
            clusterSeverity,
            flashingEnabled: prefs.flashPolygons,
        });

        // Trigger re-render of alert polygons
        if (typeof AlertRenderer !== "undefined") {
            AlertRenderer.renderPolygons();
        }
    }

    // ── Cluster-Aware Selection ──────────────────────────────────

    function _selectForCoverage(tracked, candidates) {
        if (candidates.length <= 2) return candidates;

        const trackedCenter = _getAlertCenter(tracked);
        if (!trackedCenter) return candidates.slice(0, 2);

        const withBearing = candidates.map(a => {
            const center = _getAlertCenter(a);
            if (!center) return null;
            const bearing = _bearing(trackedCenter.lat, trackedCenter.lon, center.lat, center.lon);
            return { alert: a, bearing, distance: a.distance_mi || 9999 };
        }).filter(Boolean);

        if (withBearing.length < 2) return candidates.slice(0, 2);

        withBearing.sort((a, b) => {
            const scoreA = _importanceScore(a.alert) / (a.distance + 1);
            const scoreB = _importanceScore(b.alert) / (b.distance + 1);
            return scoreB - scoreA;
        });

        const first = withBearing[0];
        let bestSecond = null;
        let bestSpread = 0;

        for (let i = 1; i < withBearing.length; i++) {
            const spread = _angularDistance(first.bearing, withBearing[i].bearing);
            if (spread > bestSpread) {
                bestSpread = spread;
                bestSecond = withBearing[i];
            }
        }

        if (!bestSecond || bestSpread < MIN_ANGULAR_SPREAD) {
            return [first.alert];
        }

        return [first.alert, bestSecond.alert];
    }

    function _importanceScore(alert) {
        const evt = (alert.event || "").toLowerCase();
        if (evt.includes("tornado") && evt.includes("warning")) return 100;
        if (evt.includes("severe") && evt.includes("thunderstorm")) return 70;
        if (evt.includes("flash flood")) return 40;
        return 10;
    }

    function _angularDistance(a, b) {
        let diff = Math.abs(a - b) % 360;
        if (diff > 180) diff = 360 - diff;
        return diff;
    }

    // ── Enter / Exit ─────────────────────────────────────────────

    function _scheduleEnter(tracked, nearby) {
        if (enterTimer) return;
        enterTimer = setTimeout(() => {
            enterTimer = null;
            _enter(tracked, nearby);
        }, ENTER_DEBOUNCE_MS);
    }

    function _enter(tracked, nearby) {
        if (state.active) return;

        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        const currentZoom = map.getZoom();

        const trackedBounds = _getAlertBounds(tracked);
        if (!trackedBounds) return;

        const allAlerts = [tracked, ...nearby];
        let combinedBounds = L.latLngBounds(trackedBounds.getSouthWest(), trackedBounds.getNorthEast());
        for (const a of nearby) {
            const ab = _getAlertBounds(a);
            if (ab) combinedBounds.extend(ab);
        }

        if (!combinedBounds.isValid()) return;

        const trackedArea = _boundsArea(trackedBounds);
        const combinedArea = _boundsArea(combinedBounds);
        if (trackedArea > 0 && combinedArea / trackedArea > BOUNDS_EXPANSION_LIMIT) {
            if (log) log.info("context_zoom_suppressed_bounds", {
                trackedArea: Math.round(trackedArea * 1000) / 1000,
                combinedArea: Math.round(combinedArea * 1000) / 1000,
                ratio: Math.round(combinedArea / trackedArea * 10) / 10,
            });
            return;
        }

        const fitZoom = map.getBoundsZoom(combinedBounds.pad(0.15));
        const delta = Math.max(ZOOM_OUT_MIN, Math.min(ZOOM_OUT_MAX, currentZoom - fitZoom));
        const targetZoom = Math.max(7, currentZoom - delta);

        if (currentZoom - targetZoom < 0.5) return;

        state.active = true;
        state.enteredAt = Date.now();
        state.lastTransitionAt = Date.now();
        state.baseZoom = currentZoom;
        state.targetZoom = targetZoom;
        state.causeAlertIds = [tracked.id, ...nearby.map(a => a.id)];
        state.zoomMode = "normal_context";
        state.lastModeChangeAt = Date.now();

        // Update shared state
        const czr = StormState.state.contextZoomRuntime;
        czr.active = true;
        czr.reason = "multi_alert";
        czr.enteredAt = state.enteredAt;
        czr.currentClusterId = state.causeAlertIds.sort().join(",").slice(0, 40);
        czr.zoomMode = "normal_context";

        // Apply polygon visuals
        _updatePolygonVisuals(tracked, nearby);

        if (log) log.info("context_zoom_entered", {
            trackedAlertId: tracked.id.slice(-12),
            candidateAlertIds: nearby.map(a => a.id.slice(-12)),
            baseZoom: currentZoom,
            targetZoom: targetZoom,
            distanceMiles: Math.round(tracked.distance_mi || 0),
            reason: "multiple_close_important_alerts",
            zoomMode: "normal_context",
        });

        const center = combinedBounds.getCenter();
        Camera.move({
            source: "autotrack",
            center: [center.lat, center.lng],
            zoom: targetZoom,
            flyOptions: { duration: 1.0, easeLinearity: 0.25 },
            reason: "context_zoom_in",
        });

        // Evaluate if SPC escalation should happen
        _evaluateZoomMode(tracked, nearby);
    }

    function _scheduleExit(reason) {
        if (exitTimer) return;
        exitTimer = setTimeout(() => {
            exitTimer = null;
            _exit(reason);
        }, EXIT_DEBOUNCE_MS);
    }

    function _exit(reason) {
        if (!state.active) return;

        if (log) log.info("context_zoom_exited", {
            reason: reason,
            duration_s: state.enteredAt ? Math.round((Date.now() - state.enteredAt) / 1000) : 0,
            zoomMode: state.zoomMode,
        });

        state.active = false;
        state.enteredAt = null;
        state.lastTransitionAt = Date.now();
        state.causeAlertIds = [];
        state.baseZoom = null;
        state.targetZoom = null;
        state.zoomMode = null;
        state.lastModeChangeAt = null;
        lastCandidateHash = "";

        state.suppressedUntil = Date.now() + COOLDOWN_MS;

        // Clear shared state
        const czr = StormState.state.contextZoomRuntime;
        czr.active = false;
        czr.reason = null;
        czr.enteredAt = null;
        czr.currentClusterId = null;
        czr.zoomMode = null;

        // Clear polygon visuals
        if (typeof PolygonVisuals !== "undefined") {
            PolygonVisuals.updateContextPolygonVisuals({
                clusterEvents: [],
                primaryEventId: null,
                clusterSeverity: "low",
                flashingEnabled: false,
            });
            if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
        }

        if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
        if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    }

    function _onManualInteraction() {
        if (state.active) {
            if (log) log.info("context_zoom_suppressed_manual", {});
            _exit("manual_override");
            state.suppressedUntil = Date.now() + MANUAL_SUPPRESS_MS;
        }
        if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
    }

    // ── Helpers ──────────────────────────────────────────────────

    function _getViewportBounds() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        return map ? map.getBounds() : null;
    }

    function _getSpcFeaturesByDay() {
        if (typeof SPCMultiDay === "undefined") return { 1: [], 2: [], 3: [] };
        const reg = SPCMultiDay.getRegistry();
        return {
            1: reg.day1_convective ? [] : [],  // Features are internal to SPCMultiDay
            2: [],
            3: [],
        };
        // Note: SPCMultiDay.selectMostSevereSpcDay handles its own feature access
    }

    // ── Geometry Helpers ─────────────────────────────────────────

    function _getAlertCenter(alert) {
        if (!alert || !alert.polygon) return null;
        try {
            const geo = JSON.parse(alert.polygon);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            const c = b.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) { return null; }
    }

    function _getAlertBounds(alert) {
        if (!alert || !alert.polygon) return null;
        try {
            const geo = JSON.parse(alert.polygon);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            return b.isValid() ? b : null;
        } catch (e) { return null; }
    }

    function _boundsArea(bounds) {
        if (!bounds || !bounds.isValid()) return 0;
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        return Math.abs(ne.lat - sw.lat) * Math.abs(ne.lng - sw.lng);
    }

    function _bearing(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
                - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    // ── Debug ────────────────────────────────────────────────────

    function getState() {
        return { ...state };
    }

    return {
        init,
        getState,
        determineContextZoomMode,
        shouldEscalateContextToSpc,
        computeSpcContextBounds,
    };
})();
