/**
 * Storm Tracker — Application State
 * Central state store with mode enforcement.
 */
const StormState = (function () {
    const LAYER_RULES = {
        reflectivity: { opacity: 1.0, overlayEligible: false, requiresAdvanced: false },
        srv:          { opacity: 0.65, overlayEligible: true,  requiresAdvanced: false },
        cc:           { opacity: 0.55, overlayEligible: true,  requiresAdvanced: false },
    };
    const ADVANCED_ONLY_COMBOS = [];
    const MAX_ACTIVE_LAYERS = 2;

    const EVENT_COLORS = {
        "Tornado Warning":              "#ff0000",
        "Severe Thunderstorm Warning":  "#ffd700",
        "Tornado Watch":                "#ff8c00",
        "Flood Warning":                "#00ff7f",
        "Flash Flood Warning":          "#00ff7f",
        "Winter Storm Warning":         "#87ceeb",
        "Winter Weather Advisory":      "#87ceeb",
        "Special Weather Statement":    "#4a90d9",
    };
    const DEFAULT_EVENT_COLOR = "#4a90d9";

    // Auto-track mode: "off" | "track" | "interrogate"
    const AUTOTRACK_MODES = ["off", "track", "interrogate"];

    const state = {
        mode: "basic",
        location: {
            source: null,
            lat: null,
            lon: null,
            name: null,
        },
        camera: {
            owner: "idle",          // "idle" | "gps" | "autotrack" (pulse is transient, not a top-level mode)
            lastOwner: "idle",
            since: 0,
            reason: "init",
            // Pulse camera lifecycle (all transient — never persisted)
            contextPulseActive: false,
            contextPulsePhase: "idle",      // "idle" | "zooming_out" | "holding" | "zooming_back"
            contextPulseSessionId: null,
            contextPulseStartedAt: null,
            contextPulseCooldownUntil: null,
            prePulseCameraSnapshot: null,   // { centerLat, centerLon, zoom }
            pulseTargetCameraSnapshot: null, // { centerLat, centerLon, zoom }
            // System camera motion guard
            systemCameraMotionActive: false,
            systemCameraMotionSource: null,  // "pulse" | "autotrack" | null
        },
        gpsFollow: {
            active: false,       // GPS follow mode owns the map camera
            lat: null,
            lon: null,
            accuracy: null,      // meters, if available
            paused: false,       // paused by manual pan
            lastUpdate: 0,
        },
        radar: {
            activeLayers: [],
            animating: false,
            speed: 2,
            currentFrameIndex: 0,
            frames: [],
        },
        alerts: {
            sortBy: "severity",
            sortOrder: "desc",
            category: null,
            showMarine: false,
            warningsOnly: false,
            data: [],
            panelOpen: false,
        },
        autotrack: {
            mode: "off",               // legacy: "off" | "track" | "interrogate" (kept for compat)
            enabled: false,            // normalized: is AT on?
            profile: "track",          // normalized: "track" | "interrogate"
            targetAlertId: null,
            targetEvent: null,
            targetScore: 0,
            radarSite: null,
            followPaused: false,
            radarPaused: false,
            autoAddedLayers: [],
            targetPolicy: "severity",  // "severity" | "distance" — decoupled from alert list sort
        },
        switchSound: {
            enabled: true,              // user toggle — default on
            lastSoundTime: 0,           // epoch of last played sound
            lastSwitchFromId: null,     // previous target id
            lastSwitchToId: null,       // current target id
            suppressed: false,          // true if last switch was suppressed by cooldown
            suppressReason: null,       // "cooldown" | "first_acquisition" | null
        },
        audioFollow: {
            enabled: false,             // master toggle (Off = enabled:false, not a source mode)
            policy: "noaa_preferred",   // "noaa_preferred" | "spotter_preferred" | "scanner_only"
            owner: null,                // "manual" | "auto-follow" | null
            currentSource: null,        // "noaa" | "spotter" | "scanner" | null
            targetEvent: null,
            status: "idle",             // "idle" | "live" | "pending" | "unavailable" | "grace"
            manualOverride: false,
            pendingSwitch: null,
            debounceUntil: null,
            stabilityUntil: null,
            graceUntil: null,
            cooldownUntil: null,
            lastDecision: null,
        },
        context: {
            rankingPolicy: "hybrid",        // "hybrid" | "distance" | "severity" — for pulse ranking only
        },
        pulse: {
            primaryInViewEventId: null,     // alert ID of top-ranked in-frame event during pulse
            inViewCount: 0,                 // number of alert polygons intersecting viewport during pulse
            inViewEventIds: [],             // all in-frame event IDs, ranked order (frozen per session)
            newlyInViewEventIds: [],        // IDs not seen in the previous completed pulse
            newlyInViewCapturedAt: null,    // timestamp when newlyInView was captured (for decay)
            lastPulseInViewEventIds: [],    // baseline from last completed pulse (for newness diff)
        },
    };

    const listeners = {};

    function on(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
    }

    function emit(event, data) {
        (listeners[event] || []).forEach(fn => fn(data));
    }

    function setMode(mode) {
        state.mode = mode;
        emit("modeChanged", mode);
    }

    function setLocation(lat, lon, source, name) {
        state.location = { lat, lon, source, name };
        emit("locationChanged", state.location);
    }

    function canActivateLayer(productId) {
        const proposed = [...state.radar.activeLayers, productId];
        if (proposed.length > MAX_ACTIVE_LAYERS) return { ok: false, reason: "Max 2 layers" };
        if (!LAYER_RULES[productId]) return { ok: false, reason: "Unknown product" };

        const activeSet = new Set(proposed);
        if (state.mode === "basic") {
            for (const combo of ADVANCED_ONLY_COMBOS) {
                let match = true;
                for (const item of combo) {
                    if (!activeSet.has(item)) { match = false; break; }
                }
                if (match) return { ok: false, reason: "SRV + CC requires advanced mode" };
            }
        }
        return { ok: true };
    }

    function activateLayer(productId) {
        const check = canActivateLayer(productId);
        if (!check.ok) return check;
        if (state.radar.activeLayers.includes(productId)) return { ok: true };
        state.radar.activeLayers.push(productId);
        emit("layerChanged", state.radar);
        return { ok: true };
    }

    function deactivateLayer(productId) {
        state.radar.activeLayers = state.radar.activeLayers.filter(l => l !== productId);
        emit("layerChanged", state.radar);
    }

    function setAlertSort(field, order) {
        state.alerts.sortBy = field;
        state.alerts.sortOrder = order || state.alerts.sortOrder;
        emit("sortChanged", state.alerts);
    }

    function setAlertCategory(category) {
        state.alerts.category = category;
        emit("filterChanged", state.alerts);
    }

    function setAlerts(data) {
        state.alerts.data = data;
        emit("alertsUpdated", data);

        // TFE shadow evaluation on every alert refresh
        if (typeof ThreatFocusEngine !== "undefined") {
            const at = state.autotrack;
            ThreatFocusEngine.evaluate(data, {
                trackedEvent: at.targetEvent,
                trackedAlertId: at.targetAlertId,
            });
        }
    }

    function togglePanel() {
        state.alerts.panelOpen = !state.alerts.panelOpen;
        emit("panelToggled", state.alerts.panelOpen);
    }

    function getEventColor(event) {
        return EVENT_COLORS[event] || DEFAULT_EVENT_COLOR;
    }

    function cycleAutoTrack() {
        const idx = AUTOTRACK_MODES.indexOf(state.autotrack.mode);
        const next = AUTOTRACK_MODES[(idx + 1) % AUTOTRACK_MODES.length];
        setAutoTrackMode(next);
    }

    function setAutoTrackMode(mode) {
        if (!AUTOTRACK_MODES.includes(mode)) return;
        const prev = state.autotrack.mode;
        state.autotrack.mode = mode;

        // Sync normalized fields
        state.autotrack.enabled = mode !== "off";
        if (mode === "track" || mode === "interrogate") {
            state.autotrack.profile = mode;
        }

        if (mode === "off") {
            state.autotrack.targetAlertId = null;
            state.autotrack.targetEvent = null;
            state.autotrack.targetScore = 0;
            state.autotrack.radarSite = null;
            state.autotrack.followPaused = false;
            state.autotrack.radarPaused = false;
            // Terminate context pulse if active
            state.camera.contextPulseActive = false;
            state.camera.contextPulsePhase = "idle";
            state.camera.contextPulseSessionId = null;
            state.camera.contextPulseStartedAt = null;
            state.camera.prePulseCameraSnapshot = null;
            state.camera.pulseTargetCameraSnapshot = null;
            state.camera.systemCameraMotionActive = false;
            state.camera.systemCameraMotionSource = null;
            state.pulse.primaryInViewEventId = null;
            state.pulse.inViewCount = 0;
            state.pulse.inViewEventIds = [];
            state.pulse.newlyInViewEventIds = [];
        }
        emit("autotrackChanged", { mode, prev });
    }

    return {
        state, on, emit,
        setMode, setLocation,
        canActivateLayer, activateLayer, deactivateLayer,
        setAlertSort, setAlertCategory, setAlerts,
        togglePanel, getEventColor,
        cycleAutoTrack, setAutoTrackMode,
        LAYER_RULES, MAX_ACTIVE_LAYERS, AUTOTRACK_MODES,
    };
})();
