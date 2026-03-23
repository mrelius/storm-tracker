/**
 * Storm Tracker — Pulse Card UI Layer (v3 — tracked pinning)
 *
 * During pulse hold: renders up to 3 cards from in-frame events.
 *   - If tracked event is in frame: pinned first with [TRACKING] + full detail
 *   - Remaining slots filled from ranked in-frame events with [IN VIEW]
 *   - If tracked not in frame: top ranked gets full detail
 *   - NEW IN VIEW badges on eligible non-tracked cards
 *   - TRACKING label takes precedence over NEW IN VIEW
 *
 * Outside pulse: renders single tracked-alert card.
 * No events in frame: empty feedback.
 */
const PulseCards = (function () {

    const MAX_CARDS = 3;

    let cardTimer = null;

    function init() {
        StormState.on("autotrackTargetChanged", update);
        StormState.on("autotrackChanged", (data) => {
            if (data.mode === "off") _clear();
            else update();
        });
        StormState.on("alertsUpdated", update);
        cardTimer = setInterval(update, 5000);
    }

    // ── Update ───────────────────────────────────────────────────

    function update() {
        // TFE-driven path: when feature flag is on, cards are pure renderer
        if (typeof ThreatFocusEngine !== "undefined" && ThreatFocusEngine.useThreatFocusEngine()) {
            _updateFromTFE();
            return;
        }

        // Legacy path
        _updateLegacy();
    }

    function _updateFromTFE() {
        const cam = StormState.state.camera;
        const alerts = StormState.state.alerts.data || [];
        const outputs = ThreatFocusEngine.getDerivedOutputs();

        // During zoom animations: clear
        if (cam.contextPulseActive && (cam.contextPulsePhase === "zooming_out" || cam.contextPulsePhase === "zooming_back")) {
            _clear();
            return;
        }

        if (!outputs.visibleCardEventIds || outputs.visibleCardEventIds.length === 0) {
            if (cam.contextPulseActive && cam.contextPulsePhase === "holding") {
                _renderEmptyPulse();
            } else {
                _clear();
            }
            return;
        }

        const trackedId = StormState.state.autotrack.targetAlertId;
        const entries = [];
        for (let i = 0; i < outputs.visibleCardEventIds.length; i++) {
            const id = outputs.visibleCardEventIds[i];
            const alert = alerts.find(a => a.id === id);
            if (!alert) continue;
            const isTracked = id === trackedId;
            entries.push({
                alert,
                tag: isTracked ? "TRACKING" : (cam.contextPulseActive ? "IN VIEW" : "TRACKING"),
                isPrimary: i === 0,
                isTertiary: i >= 2,
                isNew: false, // TFE doesn't track newness yet — preserve for future
            });
        }

        if (entries.length === 0) { _clear(); return; }
        _renderStack(entries);
    }

    function _updateLegacy() {
        const cam = StormState.state.camera;
        const at = StormState.state.autotrack;
        const alerts = StormState.state.alerts.data || [];
        const p = StormState.state.pulse;

        if (cam.contextPulseActive && cam.contextPulsePhase === "holding") {
            _renderPulseStack(alerts, p);
        } else if (cam.contextPulseActive && (cam.contextPulsePhase === "zooming_out" || cam.contextPulsePhase === "zooming_back")) {
            _clear();
        } else if (at.enabled && at.targetAlertId) {
            const alert = alerts.find(a => a.id === at.targetAlertId);
            if (alert) {
                _renderStack([{ alert, tag: "TRACKING", isPrimary: true, isNew: false }]);
            } else {
                _clear();
            }
        } else {
            _clear();
        }
    }

    function updatePrimary() { update(); }

    // ── Pulse Stack Builder ──────────────────────────────────────

    function _renderPulseStack(alerts, p) {
        if (!p.inViewEventIds || p.inViewEventIds.length === 0) {
            _renderEmptyPulse();
            return;
        }

        const at = StormState.state.autotrack;
        const trackedId = at.enabled ? at.targetAlertId : null;
        const trackedInFrame = trackedId && p.inViewEventIds.includes(trackedId);

        const newSet = new Set(p.newlyInViewEventIds || []);
        const capturedAt = p.newlyInViewCapturedAt;
        const newExpired = typeof ContextRanking !== "undefined"
            ? ContextRanking.isNewInViewExpired(capturedAt)
            : true;

        const entries = [];
        const usedIds = new Set();

        // Slot 1: If tracked is in frame, pin it first with TRACKING label + full detail
        if (trackedInFrame) {
            const trackedAlert = alerts.find(a => a.id === trackedId);
            if (trackedAlert) {
                entries.push({
                    alert: trackedAlert,
                    tag: "TRACKING",
                    isPrimary: true,
                    isNew: false, // TRACKING takes precedence over NEW IN VIEW
                });
                usedIds.add(trackedId);
            }
        }

        // Remaining slots: fill from ranked in-frame events, excluding already-used IDs
        const remaining = p.inViewEventIds.filter(id => !usedIds.has(id));
        for (const id of remaining) {
            if (entries.length >= MAX_CARDS) break;
            const alert = alerts.find(a => a.id === id);
            if (!alert) continue;

            const isFirst = entries.length === 0; // first card gets full detail if tracked wasn't in frame
            const isNew = !newExpired && newSet.has(id);

            entries.push({
                alert,
                tag: "IN VIEW",
                isPrimary: isFirst,
                isTertiary: entries.length >= 2,
                isNew,
            });
        }

        if (entries.length === 0) {
            _renderEmptyPulse();
            return;
        }

        _renderStack(entries);
    }

    // ── Render ───────────────────────────────────────────────────

    function _renderStack(entries) {
        let container = document.getElementById("pulse-card-stack");
        if (!container) {
            container = document.createElement("div");
            container.id = "pulse-card-stack";
            container.className = "pulse-card-stack";
            document.getElementById("app").appendChild(container);
        }

        let html = "";
        for (let i = 0; i < entries.length; i++) {
            const { alert, tag, isPrimary, isNew } = entries[i];
            const color = StormState.getEventColor ? StormState.getEventColor(alert.event) : "#4a90d9";
            const shortEvt = _shortEvt(alert.event);
            const headline = (alert.headline || "").slice(0, 80);
            const dist = alert.distance_mi != null ? `${Math.round(alert.distance_mi)} mi` : "";
            const isTertiary = entries[i].isTertiary;
            const isTracked = tag === "TRACKING";
            const cardClass = isPrimary
                ? `pcs-card pcs-primary${isTracked ? " pcs-tracked" : ""}`
                : isTertiary ? "pcs-card pcs-tertiary" : "pcs-card pcs-secondary";

            let countdown = "--";
            let barPct = 0;
            let barClass = "";
            if (alert.expires) {
                try {
                    const remain = new Date(alert.expires).getTime() - Date.now();
                    if (remain > 0) {
                        const m = Math.ceil(remain / 60000);
                        countdown = m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m left`;
                        barPct = Math.min(100, Math.max(2, (remain / (60 * 60000)) * 100));
                        barClass = remain < 300000 ? "pcs-bar-urgent" : remain < 900000 ? "pcs-bar-warn" : "";
                    } else { countdown = "EXPIRED"; }
                } catch (e) {}
            }

            if (isPrimary) {
                const hazardDetail = _extractHazardDetail(alert);

                html += `<div class="${cardClass}" style="border-left-color:${color}">
                    <div class="pcs-header">
                        <span class="pcs-event" style="color:${color}">${shortEvt}</span>
                        <span class="pcs-tag">${_esc(tag)}</span>
                        ${isNew ? '<span class="pcs-new-badge">NEW</span>' : ''}
                        <span class="pcs-countdown">${countdown}</span>
                    </div>
                    <div class="pcs-headline">${_esc(headline)}</div>
                    ${hazardDetail ? `<div class="pcs-hazard">${hazardDetail}</div>` : ''}
                    ${dist ? `<div class="pcs-dist">${dist}</div>` : ''}
                    <div class="pcs-bar"><div class="pcs-bar-fill ${barClass}" style="width:${barPct}%"></div></div>
                </div>`;
            } else {
                html += `<div class="${cardClass}" style="border-left-color:${color}">
                    <div class="pcs-header">
                        <span class="pcs-event" style="color:${color}">${shortEvt}</span>
                        <span class="pcs-tag">${_esc(tag)}</span>
                        ${isNew ? '<span class="pcs-new-badge">NEW</span>' : ''}
                        <span class="pcs-countdown">${countdown}</span>
                    </div>
                    ${dist ? `<div class="pcs-dist">${dist}</div>` : ''}
                </div>`;
            }
        }

        container.innerHTML = html;
        void container.offsetWidth;
        container.classList.add("pcs-visible");
    }

    function _renderEmptyPulse() {
        let container = document.getElementById("pulse-card-stack");
        if (!container) {
            container = document.createElement("div");
            container.id = "pulse-card-stack";
            container.className = "pulse-card-stack";
            document.getElementById("app").appendChild(container);
        }
        container.innerHTML = '<div class="pcs-empty">No alerts in view</div>';
        void container.offsetWidth;
        container.classList.add("pcs-visible");
    }

    function _clear() {
        const container = document.getElementById("pulse-card-stack");
        if (container) { container.classList.remove("pcs-visible"); container.innerHTML = ""; }
        const old1 = document.getElementById("pulse-alert-card");
        if (old1) { old1.classList.remove("pulse-card-visible"); old1.innerHTML = ""; }
        const old2 = document.getElementById("pulse-secondary-cards");
        if (old2) { old2.classList.remove("psc-visible"); old2.innerHTML = ""; }
    }

    // ── Helpers ──────────────────────────────────────────────────

    function _extractHazardDetail(alert) {
        if (!alert || !alert.description) return "";
        const desc = alert.description;
        const parts = [];

        try {
            if (/tornado/i.test(desc) && /radar\s*(indicated|confirmed)/i.test(desc)) {
                parts.push("Radar-indicated tornado");
            } else if (/confirmed\s*tornado/i.test(desc)) {
                parts.push("Confirmed tornado");
            } else if (/rotating|rotation|mesocyclone/i.test(desc)) {
                parts.push("Rotation detected");
            }

            const hail = desc.match(/(\d[\d.]*)\s*inch\s*hail/i);
            if (hail) parts.push(`${hail[1]}" hail`);

            const wind = desc.match(/(\d+)\s*mph\s*wind/i);
            if (wind) parts.push(`${wind[1]} mph wind`);

            const motion = desc.match(/moving\s+(north|south|east|west|northeast|northwest|southeast|southwest)\w*\s+at\s+(\d+)\s*mph/i);
            if (motion) parts.push(`${motion[1]} ${motion[2]} mph`);
        } catch (e) {}

        if (parts.length === 0) return "";
        return parts.join(" · ");
    }

    function _shortEvt(event) {
        const m = {
            "Tornado Warning": "TOR WRN", "Severe Thunderstorm Warning": "SVR TSW",
            "Tornado Watch": "TOR WCH", "Flash Flood Warning": "FFW",
            "Flood Warning": "FLW", "Winter Storm Warning": "WSW",
        };
        return m[event] || (event || "").slice(0, 12);
    }

    function _esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init, update, updatePrimary };
})();
