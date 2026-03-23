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
    let prevAlertSet = {};  // alertId → last alert data (for expired transition)
    let expiredAlerts = {};  // alertId → {alert, renderCount}

    function init() {
        fetchAndRender();
        pollTimer = setInterval(fetchAndRender, POLL_INTERVAL);
        connectWS();
        StormState.on("locationChanged", () => sendSubscribe());
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
                    // Backend is source of truth — pass notification payload if present
                    StormNotify.evaluate(msg.type, msg.alert, msg.notification);
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

        // Show/hide entire storm alert section based on count
        const section = document.getElementById("storm-alert-section");
        if (section) section.classList.toggle("hidden", alerts.length === 0);

        // Update divider + empty state visibility
        const nwsSection = document.getElementById("nws-alert-section");
        const nwsHasData = nwsSection && !nwsSection.classList.contains("hidden");
        const divider = document.getElementById("panel-section-divider");
        if (divider) divider.classList.toggle("hidden", !(alerts.length > 0 && nwsHasData));
        const emptyState = document.getElementById("panel-empty-state");
        if (emptyState) emptyState.classList.toggle("hidden", alerts.length > 0 || nwsHasData);

        // Detect disappeared alerts → show brief expired transition
        const currentIds = new Set(alerts.map(a => a.alert_id));
        for (const id of Object.keys(prevAlertSet)) {
            if (!currentIds.has(id) && !expiredAlerts[id]) {
                expiredAlerts[id] = { alert: prevAlertSet[id], renderCount: 0 };
            }
        }
        // Age out expired cards after 1 render cycle
        for (const id of Object.keys(expiredAlerts)) {
            expiredAlerts[id].renderCount++;
            if (expiredAlerts[id].renderCount > 1) {
                delete expiredAlerts[id];
            }
        }
        // Update previous alert set
        prevAlertSet = {};
        for (const a of alerts) {
            prevAlertSet[a.alert_id] = a;
        }

        // Stable refresh: skip rerender if alert set unchanged
        const primaryId = primaryThreat ? primaryThreat.alert_id : "";
        const expiredIds = Object.keys(expiredAlerts).sort().join(",");
        const newIds = alerts.map(a =>
            `${a.alert_id}:${a.severity}:${a.status}:${confTier(a.confidence)}:${a.impact || ''}:${a.action_state || ''}:${a.lifecycle_state || ''}`
        ).join(",") + "|" + primaryId + "|" + expiredIds;
        if (newIds === lastAlertIds) return;
        lastAlertIds = newIds;

        const hasExpired = Object.keys(expiredAlerts).length > 0;

        if (alerts.length === 0 && !hasExpired) {
            const wsOk = ws && ws.readyState === WebSocket.OPEN;
            container.innerHTML = `<div class="storm-alert-empty">
                <div class="sa-status-icon">&#9737;</div>
                <div>No active severe weather</div>
                <div class="sa-status-sub">System monitoring${wsOk ? " · Live" : ""}</div>
            </div>`;
            document.getElementById("storm-alert-section").classList.remove("has-critical");
            return;
        }

        const hasCritical = alerts.some(a => a.severity >= 3);
        document.getElementById("storm-alert-section").classList.toggle("has-critical", hasCritical);

        // Build live cards
        let html = alerts.map((a, i) => {
            const isPrimary = primaryThreat && a.alert_id === primaryThreat.alert_id;
            return buildCard(a, isPrimary);
        }).join("");

        // Append brief expired transition cards
        for (const id of Object.keys(expiredAlerts)) {
            const ea = expiredAlerts[id].alert;
            html += buildExpiredCard(ea);
        }

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
        // Debris overrides low-confidence visual treatment (dashed border, reduced opacity)
        const confClass = (alert.type === "debris_signature" && tier === "low") ? "sa-conf-med" : `sa-conf-${tier}`;
        const primaryClass = isPrimary ? "sa-primary" : "";

        // Status badge — lifecycle-driven, with escalated/new override
        const lifecycle = alert.lifecycle_state || "active";
        let statusBadge = "";
        if (alert.status === "escalated") {
            statusBadge = '<span class="sa-badge sa-escalated">ESCALATED</span>';
        } else if (alert.status === "new") {
            statusBadge = '<span class="sa-badge sa-new">NEW</span>';
        } else if (lifecycle === "forming") {
            statusBadge = '<span class="sa-badge sa-developing">DEVELOPING</span>';
        } else if (lifecycle === "weakening") {
            statusBadge = '<span class="sa-badge sa-weakening">WEAKENING</span>';
        } else if (isPrimary) {
            statusBadge = '<span class="sa-badge sa-primary-badge">PRIMARY</span>';
        }

        // FIX 1: Message fallback — "Trajectory uncertain" is not actionable
        const impactDesc = alert.impact_description || "";
        const useImpactMsg = impactDesc && impactDesc !== "Trajectory uncertain";

        // Motion summary — compact, avoids duplicating primary message
        const motionText = formatMotion(alert, useImpactMsg);

        // Action state pill — hide "Monitoring" (default state, adds noise)
        const actionState = alert.action_state || "monitor";
        const actionPill = actionState !== "monitor" ? formatActionPill(actionState) : "";

        // Distance + ETA
        const distText = alert.distance_mi != null ? `${Math.round(alert.distance_mi)} mi` : "";
        const confLevel = alert.confidence_level || "low";
        // FIX 2: Suppress ETA from meta when already embedded in message text
        const msgForEta = useImpactMsg ? impactDesc : (alert.message || "");
        const etaInMessage = /\d+\s*min/.test(msgForEta);
        let etaText = "";
        if (confLevel !== "low" && !etaInMessage) {
            etaText = stabilizeETA(alert);
        }

        // Primary meta: action + distance + ETA (the urgent scan line)
        const primaryMeta = [actionPill, distText, etaText].filter(Boolean).join(" · ");

        // FIX 3: Debris confidence reframing — override low confidence for debris
        const confReason = alert.confidence_reason || "";
        const isDebris = alert.type === "debris_signature";
        let confText = "";
        if (isDebris) {
            confText = "Debris confirmed";
        } else if (confLevel !== "low") {
            const cap = confLevel.charAt(0).toUpperCase() + confLevel.slice(1);
            confText = confReason ? `${cap} · ${confReason}` : cap;
        }
        const secondaryMeta = [motionText, confText].filter(Boolean).join(" · ");

        // Freshness — only show when stale (>60s)
        const freshText = alert.freshness > 60 ? formatFreshness(alert.freshness) : "";

        // Ranking context — primary reason or secondary contrast
        let reasonLine = "";
        if (isPrimary && alert.primary_reason) {
            reasonLine = `<div class="sa-reason">${escapeHtml(alert.primary_reason)}</div>`;
        } else if (!isPrimary && alert.secondary_context) {
            reasonLine = `<div class="sa-secondary-context">${escapeHtml(alert.secondary_context)}</div>`;
        }

        // Debug overlay (hidden by default, toggled with D key)
        const debugInfo = `<div class="sa-debug-info hidden">
            <span>#${alert.rank_position || '?'}</span>
            <span>threat:${alert.threat_score || '?'}</span>
            <span>impact:${alert.impact || '?'}</span>
            <span>conf:${alert.confidence_level || '?'}[${alert.confidence_reason || '-'}]</span>
            <span>tc:${(alert.track_confidence || 0).toFixed(2)} mc:${(alert.motion_confidence || 0).toFixed(2)}</span>
            <span>rank:${alert.primary_reason || alert.secondary_context || '-'}</span>
            <span>lifecycle:${alert.lifecycle_state || '?'}</span>
            <span>action:${alert.action_state || '?'}[${alert.action_trigger || ''}]</span>
            ${alert.eta_min ? `<span>eta:${Math.round(alert.eta_min)}m</span>` : ''}
            <span>dist:${alert.distance_mi || '?'} trend:${alert.trend || '?'}</span>
        </div>`;

        // Primary message: use impact_description when meaningful, else base message
        const primaryMsg = useImpactMsg ? impactDesc : (alert.message || "");

        return `<div class="storm-alert-card ${sevClass} ${confClass} ${primaryClass}" data-lat="${alert.lat}" data-lon="${alert.lon}" data-alert-id="${alert.alert_id || ''}">
            <div class="sa-header">
                <span class="sa-title">${escapeHtml(alert.title)}</span>
                ${statusBadge}
            </div>
            <div class="sa-message">${escapeHtml(primaryMsg)}</div>
            ${reasonLine}
            ${primaryMeta ? `<div class="sa-meta">${primaryMeta}</div>` : ""}
            ${secondaryMeta ? `<div class="sa-meta sa-meta-secondary">${secondaryMeta}</div>` : ""}
            ${freshText ? `<div class="sa-freshness">${freshText}</div>` : ""}
            ${debugInfo}
        </div>`;
    }

    function buildExpiredCard(alert) {
        const sevClass = severityClass(alert.severity);
        return `<div class="storm-alert-card ${sevClass} sa-expired">
            <div class="sa-header">
                <span class="sa-title">${escapeHtml(alert.title)}</span>
                <span class="sa-badge sa-expired-badge">EXPIRED</span>
            </div>
            <div class="sa-message">No longer detected</div>
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

    function formatActionPill(actionState) {
        switch (actionState) {
            case "take_action":
                return '<span class="sa-action sa-action-act">Take action</span>';
            case "be_ready":
                return '<span class="sa-action sa-action-ready">Be ready</span>';
            default:
                return '<span class="sa-action sa-action-monitor">Monitoring</span>';
        }
    }

    function formatMotion(alert, isPrimaryMsg) {
        // If impact_description is already shown as primary message, use compact motion instead
        const impact = alert.impact;
        const impactDesc = alert.impact_description;
        if (!isPrimaryMsg && impactDesc && (impact === "direct_hit" || impact === "near_miss" || impact === "passing")) {
            return impactDesc;
        }

        // Compact trend-based motion summary
        const trend = alert.trend || "unknown";
        const dir = alert.direction && alert.direction !== "unknown" ? alert.direction : "";
        const speed = alert.speed_mph || 0;
        const speedText = speed >= 5 ? ` ${Math.round(speed)} mph` : "";
        const intensity = alert.intensity_trend;

        let text = "";
        if (trend === "closing") {
            text = dir ? `${dir}${speedText}` : `Approaching${speedText}`;
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

    return { init, fetchAndRender, toggleDebug };
})();
