/**
 * Storm Tracker — Camera + Storm Visualization Coupling (Hardened)
 *
 * Drives smart camera framing from the tracked storm polygon:
 *   - Centers on polygon centroid
 *   - Leads slightly in motion direction when valid
 *   - Zoom adapts based on polygon size + intensity
 *   - Anti-jitter: material-change threshold + hold window
 *   - Single active transition guarantee
 *   - Stale motion protection
 *   - Fail-safe reset on mode change / target loss
 *
 * Only active when AT is tracking and mode allows.
 */
const StormCamera = (function () {

    // ── State ──────────────────────────────────────────────────────
    const camState = {
        enabled: true,
        trackedEventId: null,
        centroid: null,
        leadPoint: null,
        motionUsed: false,
        targetZoom: null,
        lastCameraApplyAt: 0,
        lastCameraTargetKey: null,
        holdUntil: 0,
    };

    const MIN_APPLY_INTERVAL_MS = 1500;
    const HOLD_MS = 3000;
    const DISTANCE_THRESHOLD_M = 2500;  // 2.5km — ignore smaller movements
    const ZOOM_THRESHOLD = 0.3;
    const UPDATE_INTERVAL_MS = 3000;
    const STALE_MOTION_MS = 120000;     // 2 min max event age for lead
    const DEG_PER_MI = 1 / 69.0;
    const MI_PER_KM = 0.621371;

    // ── Single Active Transition ───────────────────────────────────
    let _activeTransitionId = 0;        // monotonic counter, not a timer ref

    // ── Zoom Mapping Table ─────────────────────────────────────────
    const ZOOM_TABLE = {
        tiny:   { advisory: 10.8, elevated: 10.8, severe: 11.2, tornado: 11.6, critical: 11.6 },
        small:  { advisory: 10.3, elevated: 10.3, severe: 10.8, tornado: 11.1, critical: 11.1 },
        medium: { advisory: 9.7,  elevated: 9.7,  severe: 10.1, tornado: 10.5, critical: 10.5 },
        large:  { advisory: 9.0,  elevated: 9.0,  severe: 9.5,  tornado: 9.9,  critical: 9.9 },
        huge:   { advisory: 8.3,  elevated: 8.3,  severe: 8.8,  tornado: 9.2,  critical: 9.2 },
    };

    // ── Transition Durations ───────────────────────────────────────
    const TRANSITION_MS = {
        advisory: 1400, elevated: 1400,
        severe: 1100,
        tornado: 850, critical: 850,
        none: 1400,
    };

    // ── Lead Distance (km) by intensity ────────────────────────────
    const LEAD_KM = {
        advisory: 0.8, elevated: 1.0,
        severe: 1.5,
        tornado: 3.0, critical: 4.0,
        none: 0,
    };

    // ── Intensity priority for hold bypass ─────────────────────────
    const INTENSITY_PRIORITY = {
        none: 0, advisory: 1, elevated: 2, severe: 3, tornado: 4, critical: 5,
    };

    let _updateTimer = null;
    let log = null;

    // ── Init ───────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("storm_cam");

        StormState.on("autotrackTargetChanged", _scheduleUpdate);
        StormState.on("alertsUpdated", _scheduleUpdate);
        StormState.on("cameraModeChanged", _onModeChanged);
        StormState.on("autotrackChanged", _onModeChanged);

        _updateTimer = setInterval(_update, UPDATE_INTERVAL_MS);
    }

    function _scheduleUpdate() {
        requestAnimationFrame(_update);
    }

    function _onModeChanged() {
        if (!_isAllowed()) {
            _clearState();
        } else {
            _update();
        }
    }

    // ── Fail-Safe Reset ────────────────────────────────────────────

    function _clearState() {
        camState.trackedEventId = null;
        camState.centroid = null;
        camState.leadPoint = null;
        camState.motionUsed = false;
        camState.targetZoom = null;
        camState.lastCameraTargetKey = null;
        _activeTransitionId++;  // invalidate any in-flight transition
        if (log) log.info("storm_camera_cleared", { reason: "mode_or_target_lost" });
    }

    // ── Mode Gating ────────────────────────────────────────────────

    function _isAllowed() {
        const at = StormState.state.autotrack;
        if (!at.enabled || !at.targetAlertId) return false;
        if (at.followPaused) return false;

        if (typeof CameraPolicy !== "undefined") {
            const ps = CameraPolicy.getState();
            if (ps.automaticSubmode === "IDLE_AWARENESS") {
                if (!at.enabled || !at.targetAlertId) return false;
            }
        }
        return true;
    }

    // ── Main Update ────────────────────────────────────────────────

    function _update() {
        if (!_isAllowed()) {
            if (camState.trackedEventId) _clearState();
            return;
        }

        const at = StormState.state.autotrack;
        const alerts = StormState.state.alerts.data || [];
        const tracked = alerts.find(a => a.id === at.targetAlertId);

        if (!tracked || !tracked.polygon) {
            if (camState.trackedEventId) _clearState();
            return;
        }

        // Get storm viz state
        const vizState = typeof StormViz !== "undefined" ? StormViz.getState() : {};
        const intensity = vizState.intensity || "none";
        const motion = vizState.motion || { enabled: false };

        // Compute geometry
        const geometry = _parseGeoJSON(tracked.polygon);
        if (!geometry) return;

        const centroid = _computeCentroid(geometry);
        if (!centroid) return;

        const bounds = _computeBounds(geometry);
        const sizeCategory = _computeSizeCategory(bounds);

        // Compute lead point — with stale motion protection
        let leadPoint = null;
        let motionUsed = false;
        const eventAge = _getEventAge(tracked);
        if (eventAge <= STALE_MOTION_MS && isStormLeadAllowed(motion, eventAge)) {
            leadPoint = computeStormLeadPoint(centroid, motion.headingDeg, motion.speedMph, intensity);
            motionUsed = true;
        }

        // Normalize target for stable comparison
        const rawTarget = leadPoint || centroid;
        const targetZoom = _computeZoom(sizeCategory, intensity);
        const target = _normalizeTarget(rawTarget, targetZoom);

        // Check if material change
        const targetKey = _makeTargetKey(tracked.id, target.zoom, target);
        const now = Date.now();

        if (!_hasMaterialChange(tracked.id, target, targetKey, now, intensity)) {
            return;
        }

        // Update state
        camState.trackedEventId = tracked.id;
        camState.centroid = centroid;
        camState.leadPoint = leadPoint;
        camState.motionUsed = motionUsed;
        camState.targetZoom = target.zoom;
        camState.lastCameraTargetKey = targetKey;

        // Apply — single transition guarantee
        _applyCamera(target, intensity, tracked.id);
    }

    // ── Target Normalization ───────────────────────────────────────

    function _normalizeTarget(point, zoom) {
        return {
            lat: Number(point.lat.toFixed(4)),
            lon: Number(point.lon.toFixed(4)),
            zoom: Number(zoom.toFixed(1)),
        };
    }

    // ── Lead Point ─────────────────────────────────────────────────

    function isStormLeadAllowed(motion, eventAgeMs) {
        return Boolean(
            motion &&
            motion.enabled &&
            Number.isFinite(motion.headingDeg) &&
            Number.isFinite(motion.speedMph) &&
            motion.confidence !== "low" &&
            eventAgeMs <= STALE_MOTION_MS &&
            motion.speedMph >= 10 &&
            motion.speedMph <= 90
        );
    }

    function computeStormLeadPoint(centroid, headingDeg, speedMph, intensity) {
        const leadKm = LEAD_KM[intensity] || 1.0;
        const leadMi = leadKm * MI_PER_KM;
        const bearingRad = headingDeg * Math.PI / 180;
        const cosLat = Math.max(Math.cos(centroid.lat * Math.PI / 180), 0.01);

        return {
            lat: centroid.lat + leadMi * Math.cos(bearingRad) * DEG_PER_MI,
            lon: centroid.lon + leadMi * Math.sin(bearingRad) * DEG_PER_MI / cosLat,
        };
    }

    // ── Zoom ───────────────────────────────────────────────────────

    function _computeZoom(sizeCategory, intensity) {
        const row = ZOOM_TABLE[sizeCategory] || ZOOM_TABLE.medium;
        const bucket = (intensity === "none" || intensity === "advisory") ? "advisory" : intensity;
        return row[bucket] || 10.0;
    }

    function _computeSizeCategory(bounds) {
        if (!bounds) return "medium";
        const spanLat = bounds.north - bounds.south;
        const spanLon = bounds.east - bounds.west;
        const maxSpan = Math.max(spanLat, spanLon);

        if (maxSpan < 0.15) return "tiny";
        if (maxSpan < 0.35) return "small";
        if (maxSpan < 0.7) return "medium";
        if (maxSpan < 1.5) return "large";
        return "huge";
    }

    // ── Anti-Jitter (Hardened) ─────────────────────────────────────

    function _hasMaterialChange(eventId, target, targetKey, now, intensity) {
        // Same key = identical normalized target = skip
        if (targetKey === camState.lastCameraTargetKey) return false;

        // Event changed = always retarget (bypasses hold)
        if (eventId !== camState.trackedEventId) return true;

        // Hold window — only bypass for higher-priority intensity
        if (now < camState.holdUntil) {
            // Allow if new intensity is strictly higher priority
            const vizState = typeof StormViz !== "undefined" ? StormViz.getState() : {};
            const currentIntensity = vizState.intensity || "none";
            if ((INTENSITY_PRIORITY[intensity] || 0) <= (INTENSITY_PRIORITY[currentIntensity] || 0)) {
                return false;
            }
        }

        // Min interval
        if (now - camState.lastCameraApplyAt < MIN_APPLY_INTERVAL_MS) return false;

        // Distance check (2.5km threshold)
        const prevTarget = camState.leadPoint || camState.centroid;
        if (prevTarget) {
            const dist = _distanceMeters(prevTarget, target);
            if (dist < DISTANCE_THRESHOLD_M) {
                // Also check zoom
                if (camState.targetZoom != null && Math.abs(target.zoom - camState.targetZoom) < ZOOM_THRESHOLD) {
                    if (log) log.info("storm_camera_skipped", {
                        reason: "below_threshold",
                        distance_m: Math.round(dist),
                        zoom_delta: Math.abs(target.zoom - camState.targetZoom).toFixed(2),
                    });
                    return false;
                }
            }
        }

        return true;
    }

    function _makeTargetKey(eventId, zoom, point) {
        return `${eventId}:${zoom.toFixed(1)}:${point.lat.toFixed(4)}:${point.lon.toFixed(4)}`;
    }

    // ── Apply (Single Active Transition) ───────────────────────────

    function _applyCamera(target, intensity, eventId) {
        // Increment transition ID — any prior in-flight transition is now stale
        _activeTransitionId++;
        const myTransitionId = _activeTransitionId;

        const duration = (TRANSITION_MS[intensity] || 1400) / 1000;

        const moved = Camera.move({
            source: "autotrack",
            center: [target.lat, target.lon],
            zoom: Math.min(target.zoom, 10),  // SRV tile limit
            flyOptions: {
                duration,
                easeLinearity: 0.25,
            },
            reason: "storm_camera_coupling",
        });

        if (moved) {
            const now = Date.now();
            camState.lastCameraApplyAt = now;
            camState.holdUntil = now + HOLD_MS;

            if (log) log.info("storm_camera_applied", {
                trackedEventId: (eventId || "").slice(-12),
                intensity,
                motionUsed: camState.motionUsed,
                targetZoom: target.zoom.toFixed(1),
                transitionId: myTransitionId,
            });
        }
    }

    // ── Geometry Helpers ───────────────────────────────────────────

    function _parseGeoJSON(polygonStr) {
        try { return JSON.parse(polygonStr); } catch (e) { return null; }
    }

    function _computeCentroid(geo) {
        try {
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            const c = b.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) { return null; }
    }

    function _computeBounds(geo) {
        try {
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            const ne = b.getNorthEast();
            const sw = b.getSouthWest();
            return { north: ne.lat, south: sw.lat, east: ne.lng, west: sw.lng };
        } catch (e) { return null; }
    }

    function _getEventAge(alert) {
        if (!alert.issued) return 999999;
        return Date.now() - new Date(alert.issued).getTime();
    }

    function _distanceMeters(a, b) {
        const R = 6371000;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLon = (b.lon - a.lon) * Math.PI / 180;
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }

    // ── Public API ─────────────────────────────────────────────────

    function getState() { return { ...camState }; }

    return {
        init,
        getState,
        isStormLeadAllowed,
        computeStormLeadPoint,
    };
})();
