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

    const state = {
        mode: "basic",
        location: {
            source: null,
            lat: null,
            lon: null,
            name: null,
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
            panelOpen: true,
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
    }

    function togglePanel() {
        state.alerts.panelOpen = !state.alerts.panelOpen;
        emit("panelToggled", state.alerts.panelOpen);
    }

    function getEventColor(event) {
        return EVENT_COLORS[event] || DEFAULT_EVENT_COLOR;
    }

    return {
        state, on, emit,
        setMode, setLocation,
        canActivateLayer, activateLayer, deactivateLayer,
        setAlertSort, setAlertCategory, setAlerts,
        togglePanel, getEventColor,
        LAYER_RULES, MAX_ACTIVE_LAYERS,
    };
})();
