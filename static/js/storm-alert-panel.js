/**
 * Storm Tracker — Storm Alert Panel
 * Displays active storm alerts from the detection engine.
 * Primary: WebSocket push (instant updates).
 * Fallback: HTTP polling every 30s.
 */
const StormAlertPanel = (function () {
    const POLL_INTERVAL = 30000;
    const WS_RECONNECT_BASE = 5000;
    const WS_RECONNECT_MAX = 30000;
    const ETA_CHANGE_THRESHOLD = 2;  // minutes — ignore smaller ETA changes
    let pollTimer = null;
    let ws = null;
    let wsReconnectDelay = WS_RECONNECT_BASE;
    let wsReconnectTimer = null;
    let lastAlertIds = "";
    let lastETAs = {};  // alertId → last displayed ETA

    function init() {
        fetchAndRender();
        pollTimer = setInterval(fetchAndRender, POLL_INTERVAL);
        connectWS();
        StormState.on("locationChanged", () => sendSubscribe());

        // Simulation controls
        const simSelect = document.getElementById("sim-scenario");
        if (simSelect) {
            simSelect.addEventListener("change", async () => {
                const scenario = simSelect.value;
                if (!scenario) return;
                const loc = StormState.state.location;
                const lat = loc.lat || 39.5;
                const lon = loc.lon || -84.5;
                await fetch(`/api/debug/simulate?scenario=${scenario}&lat=${lat}&lon=${lon}`);
                simSelect.value = "";
                fetchAndRender();
            });
        }
        const simReset = document.getElementById("btn-sim-reset");
        if (simReset) {
            simReset.addEventListener("click", async () => {
                await fetch("/api/debug/simulate/reset");
                fetchAndRender();
            });
        }
    }

    function sendSubscribe() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const loc = StormState.state.location;
        if (loc.lat != null && loc.lon != null) {
            ws.send(JSON.stringify({
                type: "subscribe",
                lat: loc.lat,
                lon: loc.lon,
            }));
        }
    }

    // --- WebSocket ---

    function connectWS() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/ws/storm-alerts`;

        try {
            ws = new WebSocket(url);
        } catch (e) {
            console.warn("WS connect failed:", e);
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            console.log("[StormAlerts] WS connected");
            wsReconnectDelay = WS_RECONNECT_BASE;
            updateWSIndicator(true);
            sendSubscribe();
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleWSMessage(msg);
            } catch (e) {
                console.warn("WS message parse error:", e);
            }
        };

        ws.onclose = () => {
            console.log("[StormAlerts] WS disconnected");
            updateWSIndicator(false);
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose will also fire
            updateWSIndicator(false);
        };
    }

    function handleWSMessage(msg) {
        switch (msg.type) {
            case "snapshot":
                render(msg.alerts || [], msg.primary_threat);
                updateLocationSource(msg.location_source);
                break;
            case "created":
            case "escalated":
                if (msg.alert) {
                    StormAudio.evaluate(msg.type, msg.alert);
                    StormNotify.evaluate(msg.type, msg.alert);
                }
                fetchAndRender();
                break;
            case "expired":
                fetchAndRender();
                break;
            case "pong":
                break;
            default:
                break;
        }
    }

    function scheduleReconnect() {
        if (wsReconnectTimer) return;
        wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_RECONNECT_MAX);
            connectWS();
        }, wsReconnectDelay);
    }

    function updateWSIndicator(connected) {
        const el = document.getElementById("ws-status");
        if (el) {
            el.classList.toggle("ws-connected", connected);
            el.classList.toggle("ws-disconnected", !connected);
            el.title = connected ? "Live updates active" : "Live updates disconnected";
        }
    }

    // --- HTTP Polling (fallback) ---

    async function fetchAndRender() {
        const loc = StormState.state.location;
        const params = new URLSearchParams();
        if (loc.lat != null) params.set("lat", loc.lat);
        if (loc.lon != null) params.set("lon", loc.lon);

        try {
            const resp = await fetch(`/api/storm-alerts?${params}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            render(data.alerts || [], data.primary_threat);
        } catch (e) {
            console.error("Storm alert fetch failed:", e);
            renderError();
        }
    }

    // --- Render ---

    function render(alerts, primaryThreat) {
        const container = document.getElementById("storm-alert-list");
        const badge = document.getElementById("storm-alert-count");
        if (!container) return;

        badge.textContent = alerts.length;
        badge.classList.toggle("badge-urgent", alerts.some(a => a.severity >= 3));

        // Stable refresh: skip rerender if alert set unchanged
        const primaryId = primaryThreat ? primaryThreat.alert_id : "";
        const newIds = alerts.map(a =>
            `${a.alert_id}:${a.severity}:${a.status}:${confTier(a.confidence)}:${a.impact || ''}`
        ).join(",") + "|" + primaryId;
        if (newIds === lastAlertIds) return;
        lastAlertIds = newIds;

        if (alerts.length === 0) {
            const wsOk = ws && ws.readyState === WebSocket.OPEN;
            container.innerHTML = `<div class="storm-alert-empty">
                <div class="sa-status-icon">&#9737;</div>
                <div>No active severe weather</div>
                <div class="sa-status-sub">System monitoring${wsOk ? " · Live" : ""}</div>
                <button class="sa-test-btn" onclick="StormAlertPanel.testAlert()">Test Alert</button>
            </div>`;
            document.getElementById("storm-alert-section").classList.remove("has-critical");
            return;
        }

        const hasCritical = alerts.some(a => a.severity >= 3);
        document.getElementById("storm-alert-section").classList.toggle("has-critical", hasCritical);

        const html = alerts.map((a, i) => {
            const isPrimary = primaryThreat && a.alert_id === primaryThreat.alert_id;
            return buildCard(a, isPrimary);
        }).join("");
        container.innerHTML = html;
        StormAudio.cleanup();
        StormNotify.cleanup();

        container.querySelectorAll(".storm-alert-card").forEach(card => {
            card.addEventListener("click", () => {
                const lat = parseFloat(card.dataset.lat);
                const lon = parseFloat(card.dataset.lon);
                if (!isNaN(lat) && !isNaN(lon)) {
                    const map = StormMap.getMap();
                    if (map) map.setView([lat, lon], 8);
                }
            });
        });
    }

    function buildCard(alert, isPrimary) {
        const sevClass = severityClass(alert.severity);
        const conf = alert.confidence || 0;
        const tier = confTier(conf);
        const confClass = `sa-conf-${tier}`;
        const primaryClass = isPrimary ? "sa-primary" : "";

        // Status badge
        let statusBadge = "";
        if (alert.status === "escalated") {
            statusBadge = '<span class="sa-badge sa-escalated">ESCALATED</span>';
        } else if (alert.status === "new") {
            statusBadge = '<span class="sa-badge sa-new">NEW</span>';
        } else if (isPrimary) {
            statusBadge = '<span class="sa-badge sa-primary-badge">PRIMARY</span>';
        } else if (tier === "low") {
            statusBadge = '<span class="sa-badge sa-developing">DEVELOPING</span>';
        }

        // Motion line: trend + direction + confidence qualifier
        const motionText = formatMotion(alert);

        // Distance + ETA
        const distText = alert.distance_mi != null ? `${Math.round(alert.distance_mi)} mi` : "";
        const etaText = stabilizeETA(alert);
        const metaParts = [distText, motionText, etaText].filter(Boolean).join(" · ");

        // Freshness
        const freshText = formatFreshness(alert.freshness);

        // Threat reason (primary only)
        const reasonLine = isPrimary && alert.threat_reason
            ? `<div class="sa-reason">${escapeHtml(alert.threat_reason)}</div>` : "";

        // Debug overlay (hidden by default, toggled with D key)
        const debugInfo = `<div class="sa-debug-info hidden">
            <span>threat:${alert.threat_score || '?'}</span>
            <span>impact:${alert.impact || '?'}</span>
            <span>sev:${alert.impact_severity_label || '?'}</span>
            <span>conf:${(alert.confidence || 0).toFixed(2)}</span>
            ${alert.time_to_cpa_min ? `<span>cpa:${Math.round(alert.time_to_cpa_min)}m</span>` : ''}
        </div>`;

        return `<div class="storm-alert-card ${sevClass} ${confClass} ${primaryClass}" data-lat="${alert.lat}" data-lon="${alert.lon}" data-alert-id="${alert.alert_id || ''}">
            <div class="sa-header">
                <span class="sa-title">${escapeHtml(alert.title)}</span>
                ${statusBadge}
            </div>
            <div class="sa-message">${escapeHtml(alert.message)}</div>
            ${metaParts ? `<div class="sa-meta">${metaParts}</div>` : ""}
            ${reasonLine}
            ${freshText ? `<div class="sa-freshness">${freshText}</div>` : ""}
            ${debugInfo}
        </div>`;
    }

    function confTier(confidence) {
        if (confidence >= 0.6) return "high";
        if (confidence >= 0.3) return "med";
        return "low";
    }

    function stabilizeETA(alert) {
        const id = alert.alert_id || alert.storm_id || "";
        const newETA = alert.eta_min;

        if (newETA == null || newETA <= 0) {
            // ETA disappeared — clear stored value, show nothing
            delete lastETAs[id];
            return "";
        }

        const prev = lastETAs[id];
        const rounded = Math.round(newETA);

        if (prev != null && Math.abs(rounded - prev) < ETA_CHANGE_THRESHOLD) {
            // Change too small — hold previous display
            return `ETA ~${prev}m`;
        }

        // Meaningful change — update
        lastETAs[id] = rounded;
        return `ETA ~${rounded}m`;
    }

    function formatMotion(alert) {
        // Impact-first wording when available
        const impact = alert.impact;
        const impactDesc = alert.impact_description;
        if (impact === "direct_hit" && impactDesc) return impactDesc;
        if (impact === "near_miss" && impactDesc) return impactDesc;
        if (impact === "passing" && impactDesc) return impactDesc;

        // Fallback to trend-based wording
        const trend = alert.trend || "unknown";
        const dir = alert.direction && alert.direction !== "unknown" ? alert.direction : "";
        const conf = alert.trend_confidence || 0;
        const speed = alert.speed_mph || 0;
        const speedText = speed >= 5 ? ` at ${Math.round(speed)} mph` : "";
        const intensity = alert.intensity_trend;

        let text = "";
        if (trend === "closing") {
            text = dir ? `Approaching from ${dir}${speedText}` : `Approaching${speedText}`;
            if (conf < 0.3) text += ", developing";
        } else if (trend === "departing") {
            text = `Moving away${speedText}`;
        } else {
            text = dir || "";
        }

        if (intensity === "strengthening") {
            text += text ? ", strengthening" : "Strengthening";
        } else if (intensity === "weakening") {
            text += text ? ", weakening" : "Weakening";
        }

        return text;
    }

    function formatFreshness(freshness) {
        if (freshness == null || freshness < 0) return "";
        if (freshness < 10) return "Updated just now";
        if (freshness < 60) return `Updated ${Math.round(freshness)}s ago`;
        if (freshness < 300) return `Updated ${Math.round(freshness / 60)}m ago`;
        return "Data may be stale";
    }

    function severityClass(sev) {
        switch (sev) {
            case 1: return "sa-sev-1";
            case 2: return "sa-sev-2";
            case 3: return "sa-sev-3";
            case 4: return "sa-sev-4";
            default: return "sa-sev-1";
        }
    }

    function updateLocationSource(source) {
        const el = document.getElementById("alert-location-source");
        if (el) {
            el.textContent = source === "client" ? "Your location" : "Default location";
        }
    }

    function renderError() {
        const container = document.getElementById("storm-alert-list");
        if (container) {
            container.innerHTML = '<div class="storm-alert-empty">Unable to check storm alerts</div>';
        }
    }

    function escapeHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // --- Test Alert ---
    async function testAlert() {
        try {
            const loc = StormState.state.location;
            const lat = loc.lat || 39.5;
            const lon = loc.lon || -84.5;
            await fetch(`/api/debug/simulate?scenario=direct_hit&lat=${lat}&lon=${lon}`);
            fetchAndRender();
        } catch (e) {
            console.warn("Test alert failed:", e);
        }
    }

    // --- Debug Overlay ---
    let debugVisible = false;

    function toggleDebug() {
        debugVisible = !debugVisible;
        document.querySelectorAll(".sa-debug-info").forEach(el => {
            el.classList.toggle("hidden", !debugVisible);
        });
    }

    // Keyboard shortcut: D key toggles debug
    document.addEventListener("keydown", (e) => {
        if (e.key === "d" && !e.ctrlKey && !e.metaKey && e.target.tagName !== "INPUT") {
            toggleDebug();
        }
    });

    return { init, fetchAndRender, testAlert, toggleDebug };
})();
