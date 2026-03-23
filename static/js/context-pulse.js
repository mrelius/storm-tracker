/**
 * Storm Tracker — Context Pulse (v3 — periodic, GPS+AT, newness diff)
 *
 * Periodically zooms map out for geographic context during Auto Track or
 * GPS Follow mode. No alert target required. Deterministic session lifecycle
 * with strict session ID validation on every async callback.
 *
 * Lifecycle: startPulse → zooming_out → holding → zooming_back → idle
 *
 * Ownership:
 *   - Only this module computes/publishes pulse viewport state
 *   - Card rendering is handled by PulseCards module (separate)
 *   - This module does NOT depend on ClarityLayer or ContextSelector
 *
 * State split:
 *   camera namespace = pulse camera lifecycle/runtime
 *   pulse namespace  = viewport-derived alert context only
 */
const ContextPulse = (function () {

    // ── Timing Constants ─────────────────────────────────────────
    const PULSE_INTERVAL_MS           = 120000;  // 2 minutes
    const PULSE_ZOOM_OUT_DURATION_MS  = 900;
    const PULSE_HOLD_DEFAULT_MS       = 5000;
    const PULSE_HOLD_TOR_MS           = 6000;
    const PULSE_HOLD_MULTI_HIGH_MS    = 5500;
    const PULSE_ZOOM_BACK_DURATION_MS = 900;
    const PULSE_COOLDOWN_MS           = 3000;
    const PULSE_MIN_ZOOM_DELTA        = 0.8;
    // PULSE_CONTEXT_RADIUS_MI now computed dynamically via ContextRanking.getPulseRadiusForZoom()
    const MIN_ZOOM_FOR_PULSE          = 7;
    const STABILITY_REQUIRED_MS       = 25000;
    const SUPPRESS_AFTER_INTERACTION_MS = 90000;

    // High-priority events that suppress pulse entirely
    const HIGH_PRIORITY_EVENTS = new Set(["Tornado Warning"]);

    // ── Local runtime (not in shared state) ──────────────────────
    let pulseEnabled = true;
    let lastManualInteractionAt = 0;
    let lastTargetChangeAt = 0;
    let lastSuppressReason = null;
    let intervalTimer = null;
    let holdTimer = null;
    let sessionCounter = 0;
    let schedulerNextRun = null;

    let log = null;

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") {
            log = STLogger.for("context_pulse");
        }

        const btn = document.getElementById("btn-context-pulse-toggle");
        if (btn) {
            btn.addEventListener("click", toggleEnabled);
            _updateToggleUI();
        }

        const saved = localStorage.getItem("context_pulse_enabled");
        if (saved === "false") {
            pulseEnabled = false;
            _updateToggleUI();
        }

        StormState.on("autotrackChanged", _onAutotrackChanged);
        StormState.on("autotrackTargetChanged", _onTargetChanged);
        StormState.on("userMapInteraction", _onUserInteraction);

        // Start scheduler if already in an eligible mode
        _evaluateScheduler();
    }

    function toggleEnabled() {
        pulseEnabled = !pulseEnabled;
        localStorage.setItem("context_pulse_enabled", pulseEnabled);
        _updateToggleUI();

        if (!pulseEnabled) {
            _stop();
            _log("pulse_toggle", { enabled: false });
        } else {
            _evaluateScheduler();
            _log("pulse_toggle", { enabled: true });
        }
    }

    function _updateToggleUI() {
        const btn = document.getElementById("btn-context-pulse-toggle");
        if (!btn) return;
        btn.classList.toggle("cp-on", pulseEnabled);
        btn.classList.toggle("cp-off", !pulseEnabled);
        btn.title = pulseEnabled ? "Context Pulse: ON" : "Context Pulse: OFF";
    }

    // ── Scheduler ────────────────────────────────────────────────

    function _getActiveCameraMode() {
        const cam = StormState.state.camera;
        if (cam.owner === "autotrack") return "autotrack";
        if (cam.owner === "gps") return "gps";
        return null;
    }

    function _isSchedulerEligible() {
        if (!pulseEnabled) return false;
        const mode = _getActiveCameraMode();
        return mode === "autotrack" || mode === "gps";
    }

    function _evaluateScheduler() {
        if (_isSchedulerEligible()) {
            _startScheduler();
        } else {
            _stopScheduler();
        }
    }

    function _startScheduler() {
        if (intervalTimer) return; // Already running
        schedulerNextRun = Date.now() + PULSE_INTERVAL_MS;
        intervalTimer = setInterval(_tryPulse, PULSE_INTERVAL_MS);
        _log("pulse_scheduler_started", { camera_mode: _getActiveCameraMode() });
    }

    function _stopScheduler() {
        if (!intervalTimer) return;
        clearInterval(intervalTimer);
        intervalTimer = null;
        schedulerNextRun = null;
        _log("pulse_scheduler_stopped", { camera_mode: _getActiveCameraMode() });
    }

    function _stop() {
        cancelPulse("stopped");
        _stopScheduler();
    }

    // ── Event Handlers ───────────────────────────────────────────

    function _onAutotrackChanged(data) {
        if (data.mode === "off") {
            cancelPulse("autotrack_disabled");
        }
        _evaluateScheduler();
    }

    function _onTargetChanged(targetId) {
        lastTargetChangeAt = Date.now();

        const cam = StormState.state.camera;
        if (cam.contextPulseActive && cam.contextPulsePhase !== "holding") {
            cancelPulse("target_lost");
        }
    }

    function _onUserInteraction() {
        lastManualInteractionAt = Date.now();

        const cam = StormState.state.camera;
        if (cam.systemCameraMotionActive && cam.systemCameraMotionSource === "pulse") {
            return;
        }

        if (cam.contextPulseActive) {
            cancelPulse("manual_camera_override");
        }
    }

    // ── Pulse Guards ─────────────────────────────────────────────

    function _tryPulse() {
        if (!pulseEnabled) return;

        const cam = StormState.state.camera;
        const cameraMode = _getActiveCameraMode();

        // Must be in eligible mode
        if (!cameraMode) { lastSuppressReason = "ineligible_mode"; return; }

        // No overlapping sessions
        if (cam.contextPulseActive) return;

        const now = Date.now();
        schedulerNextRun = now + PULSE_INTERVAL_MS;

        // Cooldown
        if (cam.contextPulseCooldownUntil && now < cam.contextPulseCooldownUntil) {
            lastSuppressReason = "cooldown"; return;
        }

        // Severity suppression (autotrack only)
        if (cameraMode === "autotrack") {
            const at = StormState.state.autotrack;
            const targetEvent = at.targetEvent || "";
            if (HIGH_PRIORITY_EVENTS.has(targetEvent)) {
                lastSuppressReason = "high_priority_event"; return;
            }
            const af = StormState.state.audioFollow;
            if (af && af.targetEvent === "tornado_warning") {
                lastSuppressReason = "tornado_audio_follow"; return;
            }
            if (at.followPaused) { lastSuppressReason = "follow_paused"; return; }
        }

        // Stability
        if (now - lastManualInteractionAt < STABILITY_REQUIRED_MS) { lastSuppressReason = "recent_interaction"; return; }
        if (cameraMode === "autotrack" && now - lastTargetChangeAt < STABILITY_REQUIRED_MS) {
            lastSuppressReason = "recent_target_change"; return;
        }
        if (now - lastManualInteractionAt < SUPPRESS_AFTER_INTERACTION_MS) { lastSuppressReason = "interaction_suppress"; return; }

        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { lastSuppressReason = "map_unavailable"; return; }
        if (map._animatingZoom) { lastSuppressReason = "animation_active"; return; }

        const currentZoom = map.getZoom();
        if (currentZoom <= MIN_ZOOM_FOR_PULSE) { lastSuppressReason = "already_wide"; return; }

        lastSuppressReason = null;
        startPulse(map, cameraMode);
    }

    // ── Pulse Lifecycle ──────────────────────────────────────────

    function startPulse(map, cameraMode) {
        if (!map) return;

        const cam = StormState.state.camera;
        if (cam.contextPulseActive) return;

        const center = map.getCenter();
        const currentZoom = map.getZoom();

        const prePulse = {
            centerLat: center.lat,
            centerLon: center.lng,
            zoom: currentZoom,
        };

        const pulseTarget = computePulseTargetCamera(map, currentZoom);
        if (!pulseTarget) return;

        sessionCounter++;
        const sessionId = "ps_" + sessionCounter + "_" + Date.now();

        cam.contextPulseActive = true;
        cam.contextPulsePhase = "zooming_out";
        cam.contextPulseSessionId = sessionId;
        cam.contextPulseStartedAt = Date.now();
        cam.prePulseCameraSnapshot = prePulse;
        cam.pulseTargetCameraSnapshot = pulseTarget;
        cam.systemCameraMotionActive = true;
        cam.systemCameraMotionSource = "pulse";

        _log("pulse_session_started", {
            session_id: sessionId,
            phase: "zooming_out",
            camera_mode: cameraMode,
            source_event_id: _currentEventIdShort(),
            pre_pulse_zoom: prePulse.zoom,
            pulse_zoom: pulseTarget.zoom,
        });

        _showPulseLabel(true);

        Camera.move({
            source: "pulse",
            center: L.latLng(pulseTarget.centerLat, pulseTarget.centerLon),
            zoom: pulseTarget.zoom,
            flyOptions: { duration: PULSE_ZOOM_OUT_DURATION_MS / 1000, easeLinearity: 0.15 },
            reason: "pulse_zoom_out",
        });

        // Card animation sync: enter cards at ~70% of zoom-out progress
        setTimeout(function () {
            if (StormState.state.camera.contextPulseSessionId !== sessionId) return;
            _captureVisibleSet(sessionId);
            if (typeof PulseCards !== "undefined") PulseCards.updatePrimary();
        }, Math.round(PULSE_ZOOM_OUT_DURATION_MS * 0.7));

        setTimeout(function () {
            onPulseZoomOutComplete(sessionId);
        }, PULSE_ZOOM_OUT_DURATION_MS + 100);
    }

    function computePulseTargetCamera(map, currentZoom) {
        const alerts = StormState.state.alerts.data || [];
        const center = map.getCenter();
        const loc = StormState.state.location;
        const at = StormState.state.autotrack;
        const gps = StormState.state.gpsFollow;

        // ── Step 1: Determine anchor (camera stays centered here) ──
        let anchor = null;

        if (at.enabled && at.targetAlertId) {
            // AT mode: anchor to tracked alert geometry center
            const tracked = alerts.find(a => a.id === at.targetAlertId);
            if (tracked && tracked.polygon) {
                try {
                    const geo = JSON.parse(tracked.polygon);
                    const layer = L.geoJSON(geo);
                    const b = layer.getBounds();
                    if (b.isValid()) {
                        const c = b.getCenter();
                        anchor = { lat: c.lat, lon: c.lng };
                    }
                } catch (e) { /* fall through */ }
            }
            // Fallback: current camera center (already tracking the target)
            if (!anchor) anchor = { lat: center.lat, lon: center.lng };
        } else if (gps.active && gps.lat && gps.lon) {
            // GPS mode: anchor to GPS position
            anchor = { lat: gps.lat, lon: gps.lon };
        } else {
            // Idle/other: anchor to current camera center
            anchor = { lat: center.lat, lon: center.lng };
        }

        // ── Step 2: Compute zoom-out extent from nearby context ──
        // Zoom-aware context radius: tighter at high zoom, wider at low zoom
        const contextRadius = typeof ContextRanking !== "undefined"
            ? ContextRanking.getPulseRadiusForZoom(currentZoom)
            : 30;

        // Anchor center remains FIXED — nearby context only affects zoom level
        let contextZoom = null;

        const nearbyAlerts = [];
        for (const alert of alerts) {
            if (!alert.polygon) continue;
            if (alert.distance_mi != null && alert.distance_mi > contextRadius) continue;
            try {
                const geo = JSON.parse(alert.polygon);
                const layer = L.geoJSON(geo);
                const ab = layer.getBounds();
                if (ab.isValid()) {
                    const pc = ab.getCenter();
                    const distFromAnchor = _haversineMi(anchor.lat, anchor.lon, pc.lat, pc.lng);
                    if (distFromAnchor <= contextRadius) {
                        nearbyAlerts.push({ alert, bounds: ab });
                    }
                }
            } catch (e) { /* skip */ }
        }

        if (nearbyAlerts.length > 0) {
            let contextBounds = L.latLngBounds(L.latLng(anchor.lat, anchor.lon), L.latLng(anchor.lat, anchor.lon));
            for (const na of nearbyAlerts) {
                contextBounds.extend(na.bounds);
            }
            if (loc.lat && loc.lon) {
                const userDist = _haversineMi(anchor.lat, anchor.lon, loc.lat, loc.lon);
                if (userDist <= contextRadius) {
                    contextBounds.extend(L.latLng(loc.lat, loc.lon));
                }
            }

            try {
                const fitZoom = map.getBoundsZoom(contextBounds.pad(0.15));
                contextZoom = Math.max(MIN_ZOOM_FOR_PULSE, Math.min(fitZoom, currentZoom - PULSE_MIN_ZOOM_DELTA));
            } catch (e) { /* fall through */ }
        }

        // ── Step 3: Apply zoom or fallback ──
        // Anchor center is always preserved
        let targetZoom;
        if (contextZoom != null && currentZoom - contextZoom >= PULSE_MIN_ZOOM_DELTA * 0.5) {
            targetZoom = contextZoom;
        } else {
            // No-geometry fallback: enforce visible zoom-out from anchor
            targetZoom = Math.max(MIN_ZOOM_FOR_PULSE, currentZoom - 2);
            if (currentZoom - targetZoom < PULSE_MIN_ZOOM_DELTA * 0.5) return null;
        }

        return { centerLat: anchor.lat, centerLon: anchor.lon, zoom: targetZoom };
    }

    // ── Adaptive Hold Duration ─────────────────────────────────

    function _computeHoldDuration() {
        const p = StormState.state.pulse;
        const alerts = StormState.state.alerts.data || [];

        // TOR primary → longest hold
        if (p.primaryInViewEventId) {
            const primary = alerts.find(a => a.id === p.primaryInViewEventId);
            if (primary) {
                const evt = (primary.event || "").toLowerCase();
                if (evt.includes("tornado") && evt.includes("warning")) {
                    return PULSE_HOLD_TOR_MS;
                }
            }
        }

        // Multiple high-scoring events → slightly extended hold
        if (p.inViewEventIds && p.inViewEventIds.length >= 2 && typeof ContextRanking !== "undefined") {
            const at = StormState.state.autotrack;
            const rankCtx = at.enabled ? { trackedEvent: at.targetEvent, trackedAlertId: at.targetAlertId } : null;
            let highCount = 0;
            for (const id of p.inViewEventIds.slice(0, 4)) {
                const alert = alerts.find(a => a.id === id);
                if (alert && ContextRanking.computeHybridScore(alert, rankCtx) >= 60) highCount++;
            }
            if (highCount >= 2) return PULSE_HOLD_MULTI_HIGH_MS;
        }

        return PULSE_HOLD_DEFAULT_MS;
    }

    // Haversine for anchor distance checks (miles)
    function _haversineMi(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function onPulseZoomOutComplete(sessionId) {
        const cam = StormState.state.camera;
        if (cam.contextPulseSessionId !== sessionId) return;
        if (!cam.contextPulseActive) return;

        cam.contextPulsePhase = "holding";
        cam.systemCameraMotionActive = false;
        cam.systemCameraMotionSource = null;

        // Cards already entered at 70% of zoom-out; refresh if needed
        if (StormState.state.pulse.inViewEventIds.length === 0) {
            _captureVisibleSet(sessionId);
            if (typeof PulseCards !== "undefined") PulseCards.updatePrimary();
        }

        // Adaptive hold duration
        const holdMs = _computeHoldDuration();

        holdTimer = setTimeout(function () {
            holdTimer = null;
            onPulseHoldComplete(sessionId);
        }, holdMs);
    }

    function onPulseHoldComplete(sessionId) {
        const cam = StormState.state.camera;
        if (cam.contextPulseSessionId !== sessionId) return;
        if (!cam.contextPulseActive) return;

        _log("pulse_hold_complete", {
            session_id: sessionId,
            phase: "zooming_back",
            source_event_id: _currentEventIdShort(),
        });

        const returnTarget = _resolveReturnTarget();
        if (!returnTarget) {
            cancelPulse("no_return_target");
            return;
        }

        cam.contextPulsePhase = "zooming_back";
        cam.systemCameraMotionActive = true;
        cam.systemCameraMotionSource = "pulse";

        // Card animation sync: cards exit at zoom-back start
        if (typeof PulseCards !== "undefined") PulseCards.update();

        _log("pulse_return_started", {
            session_id: sessionId,
            phase: "zooming_back",
            return_zoom: returnTarget.zoom,
        });

        Camera.move({
            source: "pulse",
            center: L.latLng(returnTarget.centerLat, returnTarget.centerLon),
            zoom: returnTarget.zoom,
            flyOptions: { duration: PULSE_ZOOM_BACK_DURATION_MS / 1000, easeLinearity: 0.25 },
            reason: "pulse_return",
        });

        setTimeout(function () {
            onPulseReturnComplete(sessionId);
        }, PULSE_ZOOM_BACK_DURATION_MS + 100);
    }

    function onPulseReturnComplete(sessionId) {
        const cam = StormState.state.camera;
        if (cam.contextPulseSessionId !== sessionId) return;
        if (!cam.contextPulseActive) return;

        _log("pulse_session_ended", {
            session_id: sessionId,
            phase: "idle",
            camera_mode: _getActiveCameraMode(),
            source_event_id: _currentEventIdShort(),
            pre_pulse_zoom: cam.prePulseCameraSnapshot ? cam.prePulseCameraSnapshot.zoom : null,
        });

        // Commit baseline: only completed sessions update the diff baseline
        const p = StormState.state.pulse;
        p.lastPulseInViewEventIds = [...p.inViewEventIds];

        cam.contextPulseCooldownUntil = Date.now() + PULSE_COOLDOWN_MS;
        clearPulseRuntimeState();

        if (typeof PulseCards !== "undefined") PulseCards.updatePrimary();
    }

    function _resolveReturnTarget() {
        const cam = StormState.state.camera;
        const cameraMode = _getActiveCameraMode() || (cam.prePulseCameraSnapshot ? "fallback" : null);

        // GPS mode: return to GPS-follow position
        if (cameraMode === "gps") {
            const gps = StormState.state.gpsFollow;
            if (gps.active && gps.lat && gps.lon) {
                const preZoom = cam.prePulseCameraSnapshot ? cam.prePulseCameraSnapshot.zoom : 12;
                return { centerLat: gps.lat, centerLon: gps.lon, zoom: preZoom };
            }
        }

        // Autotrack mode: return to latest tracked target
        if (cameraMode === "autotrack") {
            const at = StormState.state.autotrack;
            const alerts = StormState.state.alerts.data || [];
            if (at.enabled && at.targetAlertId) {
                const tracked = alerts.find(a => a.id === at.targetAlertId);
                if (tracked && tracked.polygon) {
                    try {
                        const geo = JSON.parse(tracked.polygon);
                        const layer = L.geoJSON(geo);
                        const b = layer.getBounds();
                        if (b.isValid()) {
                            const c = b.getCenter();
                            const preZoom = cam.prePulseCameraSnapshot ? cam.prePulseCameraSnapshot.zoom : 10;
                            return { centerLat: c.lat, centerLon: c.lng, zoom: preZoom };
                        }
                    } catch (e) { /* fall through */ }
                }
            }
        }

        // Fallback: pre-pulse snapshot
        if (cam.prePulseCameraSnapshot) {
            return { ...cam.prePulseCameraSnapshot };
        }

        return null;
    }

    // ── Cancel / Clear ───────────────────────────────────────────

    function cancelPulse(reason) {
        const cam = StormState.state.camera;
        if (!cam.contextPulseActive) return;

        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }

        if (cam.prePulseCameraSnapshot) {
            Camera.move({
                source: "pulse",
                center: L.latLng(cam.prePulseCameraSnapshot.centerLat, cam.prePulseCameraSnapshot.centerLon),
                zoom: cam.prePulseCameraSnapshot.zoom,
                animate: false,
                reason: "pulse_cancel_snapback",
            });
        }

        _log("pulse_session_cancelled", {
            session_id: cam.contextPulseSessionId,
            phase: cam.contextPulsePhase,
            reason: reason,
            camera_mode: _getActiveCameraMode(),
            source_event_id: _currentEventIdShort(),
        });

        // Cancelled sessions do NOT overwrite lastPulseInViewEventIds baseline

        cam.contextPulseCooldownUntil = Date.now() + PULSE_COOLDOWN_MS;
        clearPulseRuntimeState();

        if (typeof PulseCards !== "undefined") PulseCards.updatePrimary();
    }

    function clearPulseRuntimeState() {
        const cam = StormState.state.camera;
        cam.contextPulseActive = false;
        cam.contextPulsePhase = "idle";
        cam.contextPulseSessionId = null;
        cam.contextPulseStartedAt = null;
        cam.prePulseCameraSnapshot = null;
        cam.pulseTargetCameraSnapshot = null;
        cam.systemCameraMotionActive = false;
        cam.systemCameraMotionSource = null;

        // Clear session-scoped viewport state (not the baseline)
        const p = StormState.state.pulse;
        p.primaryInViewEventId = null;
        p.inViewCount = 0;
        p.inViewEventIds = [];
        p.newlyInViewEventIds = [];
        p.newlyInViewCapturedAt = null;

        _showPulseLabel(false);
    }

    // ── Escalation Logic ──────────────────────────────────────────
    // Determines if a challenger alert can replace the tracked alert as primary.
    // Only explicit severity escalation is allowed — broad/low-priority alerts
    // like Red Flag Warnings cannot replace tracked convective warnings.

    const ESCALATION_RANK = {
        "tornado warning": 4,
        "severe thunderstorm warning": 3,
        "tornado watch": 2,
        "flash flood warning": 2,
        "severe thunderstorm watch": 1,
    };

    function _canEscalate(challenger, tracked) {
        const challengerRank = ESCALATION_RANK[(challenger.event || "").toLowerCase()] || 0;
        const trackedRank = ESCALATION_RANK[(tracked.event || "").toLowerCase()] || 0;
        // Challenger must strictly outrank tracked — equal rank does not escalate
        return challengerRank > trackedRank;
    }

    // ── Viewport Alert Capture (once per session during hold) ────

    function _captureVisibleSet(sessionId) {
        const p = StormState.state.pulse;

        // TFE-driven path: populate pulse state from TFE outputs
        if (typeof ThreatFocusEngine !== "undefined" && ThreatFocusEngine.useThreatFocusEngine()) {
            const outputs = ThreatFocusEngine.getDerivedOutputs();
            p.primaryInViewEventId = outputs.pulseTargetEventId;
            p.inViewEventIds = [...outputs.visibleCardEventIds];
            p.inViewCount = outputs.visibleCardEventIds.length;
            p.newlyInViewEventIds = [];
            p.newlyInViewCapturedAt = Date.now();
            _log("pulse_visible_set_captured", {
                session_id: sessionId,
                source: "tfe",
                in_view_count: p.inViewCount,
                primary_in_view_event_id: p.primaryInViewEventId ? p.primaryInViewEventId.slice(-12) : null,
            });
            return;
        }

        // Legacy path
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;

        if (!map) {
            p.primaryInViewEventId = null;
            p.inViewCount = 0;
            p.inViewEventIds = [];
            p.newlyInViewEventIds = [];
            return;
        }

        const bounds = map.getBounds();
        const alerts = StormState.state.alerts.data || [];
        const contextPolicy = StormState.state.context.rankingPolicy || "hybrid";

        const inFrame = [];
        for (const alert of alerts) {
            if (!alert.polygon) continue;
            try {
                const geo = JSON.parse(alert.polygon);
                const layer = L.geoJSON(geo);
                const ab = layer.getBounds();
                if (ab.isValid() && bounds.intersects(ab)) inFrame.push(alert);
            } catch (e) { /* skip */ }
        }

        // Build ranking context with tracked event info + pulse phase
        const at = StormState.state.autotrack;
        const cam = StormState.state.camera;
        const holdElapsedMs = cam.contextPulseStartedAt
            ? Date.now() - cam.contextPulseStartedAt - PULSE_ZOOM_OUT_DURATION_MS
            : 0;
        const rankCtx = at.enabled ? {
            trackedEvent: at.targetEvent || null,
            trackedAlertId: at.targetAlertId || null,
            pulsePhase: cam.contextPulsePhase || "holding",
            holdElapsedMs: Math.max(0, holdElapsedMs),
        } : null;

        // Rank using context ranking engine (independent from autotrack target policy)
        const ranked = typeof ContextRanking !== "undefined"
            ? ContextRanking.rankContextEvents(inFrame, contextPolicy, rankCtx)
            : inFrame;

        const rankedIds = ranked.map(a => a.id);
        const previousSet = new Set(p.lastPulseInViewEventIds || []);
        const newlyVisible = rankedIds.filter(id => !previousSet.has(id));

        // Determine primary with hysteresis + escalation
        let primaryId = rankedIds[0] || null;
        if (at.enabled && at.targetAlertId && rankedIds.includes(at.targetAlertId)) {
            const trackedAlert = inFrame.find(a => a.id === at.targetAlertId);
            const topRanked = ranked[0];
            if (trackedAlert && topRanked && topRanked.id !== at.targetAlertId) {
                const topScore = typeof ContextRanking !== "undefined" ? ContextRanking.computeHybridScore(topRanked, rankCtx) : 0;
                const trackedScore = typeof ContextRanking !== "undefined" ? ContextRanking.computeHybridScore(trackedAlert, rankCtx) : 0;

                // Must pass both escalation check AND hysteresis threshold
                if (_canEscalate(topRanked, trackedAlert) &&
                    (typeof ContextRanking !== "undefined" ? ContextRanking.shouldSwitchPrimary(topScore, trackedScore) : false)) {
                    primaryId = topRanked.id;
                } else {
                    primaryId = at.targetAlertId;
                }
            } else {
                primaryId = at.targetAlertId;
            }
        }

        // Publish
        p.inViewEventIds = rankedIds;
        p.primaryInViewEventId = primaryId;
        p.inViewCount = rankedIds.length;
        p.newlyInViewEventIds = newlyVisible;
        p.newlyInViewCapturedAt = Date.now();

        _log("pulse_visible_set_captured", {
            session_id: sessionId,
            camera_mode: _getActiveCameraMode(),
            in_view_count: rankedIds.length,
            primary_in_view_event_id: p.primaryInViewEventId ? p.primaryInViewEventId.slice(-12) : null,
            newly_in_view_count: newlyVisible.length,
        });
    }

    // ── UI Helpers ─────────────────────────────────────────────

    function _showPulseLabel(show) {
        const el = document.getElementById("pulse-context-label");
        if (!el) return;
        if (show) {
            el.textContent = "CONTEXT VIEW";
            el.classList.add("pulse-label-visible");
        } else {
            el.classList.remove("pulse-label-visible");
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

    function _currentEventIdShort() {
        const at = StormState.state.autotrack;
        return at.targetAlertId ? at.targetAlertId.slice(-12) : null;
    }

    function _getTopRankedScores(n) {
        const p = StormState.state.pulse;
        const alerts = StormState.state.alerts.data || [];
        if (!p.inViewEventIds || p.inViewEventIds.length === 0) return [];
        if (typeof ContextRanking === "undefined") return [];

        const at = StormState.state.autotrack;
        const rankCtx = at.enabled ? { trackedEvent: at.targetEvent, trackedAlertId: at.targetAlertId } : null;

        return p.inViewEventIds.slice(0, n).map(id => {
            const alert = alerts.find(a => a.id === id);
            if (!alert) return { id: id.slice(-12), score: 0 };
            return {
                id: id.slice(-12),
                event: (alert.event || "").slice(0, 16),
                score: ContextRanking.computeHybridScore(alert, rankCtx),
                hc: ContextRanking.getHazardClass(alert.event),
                dist: alert.distance_mi != null ? Math.round(alert.distance_mi) : null,
            };
        });
    }

    function _log(event, extra) {
        if (log) log.info(event, extra);
    }

    // ── Debug ────────────────────────────────────────────────────

    function getDebugState() {
        const cam = StormState.state.camera;
        const p = StormState.state.pulse;
        const now = Date.now();
        return {
            enabled: pulseEnabled,
            active: cam.contextPulseActive,
            phase: cam.contextPulsePhase,
            sessionId: cam.contextPulseSessionId,
            cameraMode: _getActiveCameraMode(),
            startedAt: cam.contextPulseStartedAt ? Math.round((now - cam.contextPulseStartedAt) / 1000) + "s ago" : null,
            cooldownRemaining: cam.contextPulseCooldownUntil ? Math.max(0, Math.round((cam.contextPulseCooldownUntil - now) / 1000)) : 0,
            prePulseZoom: cam.prePulseCameraSnapshot ? cam.prePulseCameraSnapshot.zoom : null,
            pulseTargetZoom: cam.pulseTargetCameraSnapshot ? cam.pulseTargetCameraSnapshot.zoom : null,
            systemMotionActive: cam.systemCameraMotionActive,
            systemMotionSource: cam.systemCameraMotionSource,
            schedulerNextRun: schedulerNextRun ? Math.max(0, Math.round((schedulerNextRun - now) / 1000)) + "s" : null,
            lastSuppressReason: lastSuppressReason,
            stabilityOk: (now - lastManualInteractionAt >= STABILITY_REQUIRED_MS) &&
                         (now - lastTargetChangeAt >= STABILITY_REQUIRED_MS),
            intervalRunning: !!intervalTimer,
            contextRankingPolicy: StormState.state.context.rankingPolicy,
            inViewEventIds: p.inViewEventIds,
            newlyInViewEventIds: p.newlyInViewEventIds,
            lastPulseInViewEventIds: p.lastPulseInViewEventIds,
            topRankedScores: _getTopRankedScores(3),
        };
    }

    return { init, getDebugState, toggleEnabled, cancelPulse, clearPulseRuntimeState };
})();
