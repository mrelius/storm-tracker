/**
 * Storm Tracker — Floating Alert Cards
 *
 * When the right alert panel is collapsed, shows active alerts as
 * floating cards on the right side of the screen. Each card has a
 * live countdown timer. Cards auto-remove when alerts expire.
 *
 * Only visible when panel is closed. Hides when panel reopens.
 */
const AlertFloat = (function () {

    const MAX_CARDS = 1;
    const TIMER_MS = 5000;  // refresh countdowns every 5s
    let timerHandle = null;

    function init() {
        StormState.on("panelToggled", onPanelToggled);
        StormState.on("alertsUpdated", onAlertsUpdated);

        // Initial check
        if (!StormState.state.alerts.panelOpen) {
            show();
        }
    }

    function onPanelToggled(open) {
        if (open) {
            hide();
        } else {
            show();
        }
    }

    function onAlertsUpdated() {
        if (!StormState.state.alerts.panelOpen) {
            render();
        }
    }

    function show() {
        render();
        stopTimer();
        timerHandle = setInterval(render, TIMER_MS);
    }

    function hide() {
        stopTimer();
        const container = document.getElementById("alert-float-stack");
        if (container) container.classList.add("hidden");
    }

    function stopTimer() {
        if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    }

    function render() {
        const container = document.getElementById("alert-float-stack");
        if (!container) return;

        if (StormState.state.alerts.panelOpen) {
            container.classList.add("hidden");
            return;
        }

        const alerts = StormState.state.alerts.data;
        if (!alerts || alerts.length === 0) {
            container.classList.add("hidden");
            return;
        }

        container.classList.remove("hidden");

        const now = Date.now();
        const trackedId = StormState.state.autotrack.targetAlertId;

        // Take top alerts by priority, tracked first
        let ordered = [...alerts];
        if (trackedId) {
            const tracked = ordered.find(a => a.id === trackedId);
            if (tracked) {
                ordered = [tracked, ...ordered.filter(a => a.id !== trackedId)];
            }
        }

        const cards = ordered.slice(0, MAX_CARDS).map(alert => {
            const isTracked = trackedId && alert.id === trackedId;
            const color = _getEventColor(alert.event);
            const shortEvt = _shortEvent(alert.event);
            const countdown = _countdown(alert.expires, now);
            const dist = alert.distance_mi != null ? `${Math.round(alert.distance_mi)}mi` : "";

            // Per-card expiry bar
            let barPct = 0;
            let barClass = "";
            if (alert.expires) {
                try {
                    const remain = new Date(alert.expires).getTime() - now;
                    if (remain > 0) {
                        barPct = Math.min(100, Math.max(2, (remain / (60 * 60000)) * 100));
                        barClass = remain < 300000 ? "af-bar-urgent" : remain < 900000 ? "af-bar-warn" : "";
                    }
                } catch (e) {}
            }

            return `<div class="af-card ${isTracked ? 'af-card-tracked' : ''}" style="border-left-color:${color}">
                <div class="af-card-top">
                    <span class="af-card-event" style="color:${color}">${shortEvt}</span>
                    ${isTracked ? '<span class="af-card-tag">TRACKING</span>' : ''}
                    <span class="af-card-countdown">${countdown}</span>
                </div>
                <div class="af-card-headline">${_esc((alert.headline || "").slice(0, 60))}</div>
                ${dist ? `<span class="af-card-dist">${dist}</span>` : ''}
                <div class="af-card-bar"><div class="af-card-bar-fill ${barClass}" style="width:${barPct}%"></div></div>
            </div>`;
        }).join("");

        container.innerHTML = cards;
    }

    function _getEventColor(event) {
        return StormState.getEventColor ? StormState.getEventColor(event) : "#4a90d9";
    }

    function _shortEvent(event) {
        const m = {
            "Tornado Warning": "TOR WRN",
            "Severe Thunderstorm Warning": "SVR TSW",
            "Tornado Watch": "TOR WCH",
            "Flash Flood Warning": "FFW",
            "Flood Warning": "FLW",
            "Winter Storm Warning": "WSW",
        };
        return m[event] || event.slice(0, 12);
    }

    function _countdown(expires, now) {
        if (!expires) return "--";
        try {
            const remain = new Date(expires).getTime() - now;
            if (remain <= 0) return "EXP";
            const min = Math.ceil(remain / 60000);
            if (min >= 60) return `${Math.floor(min / 60)}h${min % 60}m`;
            return `${min}m`;
        } catch (e) { return "--"; }
    }

    function _esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init };
})();
