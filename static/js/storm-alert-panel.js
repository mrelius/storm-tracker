/**
 * Storm Tracker — Storm Alert Panel
 * Displays active storm alerts from the detection engine.
 * Polls GET /api/storm-alerts on interval, renders severity-ranked cards.
 */
const StormAlertPanel = (function () {
    const POLL_INTERVAL = 30000;
    let pollTimer = null;
    let lastAlertIds = "";  // track for stable refresh

    function init() {
        fetchAndRender();
        pollTimer = setInterval(fetchAndRender, POLL_INTERVAL);
    }

    async function fetchAndRender() {
        const loc = StormState.state.location;
        const params = new URLSearchParams();
        if (loc.lat != null) params.set("lat", loc.lat);
        if (loc.lon != null) params.set("lon", loc.lon);

        try {
            const resp = await fetch(`/api/storm-alerts?${params}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            render(data.alerts || []);
        } catch (e) {
            console.error("Storm alert fetch failed:", e);
            renderError();
        }
    }

    function render(alerts) {
        const container = document.getElementById("storm-alert-list");
        const badge = document.getElementById("storm-alert-count");
        if (!container) return;

        badge.textContent = alerts.length;
        badge.classList.toggle("badge-urgent", alerts.some(a => a.severity >= 3));

        // Stable refresh: skip rerender if alert set unchanged
        const newIds = alerts.map(a => `${a.alert_id}:${a.severity}:${a.status}`).join(",");
        if (newIds === lastAlertIds) return;
        lastAlertIds = newIds;

        if (alerts.length === 0) {
            container.innerHTML = '<div class="storm-alert-empty">No active storm alerts</div>';
            document.getElementById("storm-alert-section").classList.remove("has-critical");
            return;
        }

        const hasCritical = alerts.some(a => a.severity >= 3);
        document.getElementById("storm-alert-section").classList.toggle("has-critical", hasCritical);

        container.innerHTML = alerts.map(buildCard).join("");

        // Wire click handlers
        container.querySelectorAll(".storm-alert-card").forEach(card => {
            card.addEventListener("click", () => {
                const lat = parseFloat(card.dataset.lat);
                const lon = parseFloat(card.dataset.lon);
                if (!isNaN(lat) && !isNaN(lon)) {
                    StormMap.focusOnAlert({ polygon: null, county_fips: [], lat, lon });
                    // Direct map zoom since focusOnAlert expects alert shape
                    const map = StormMap.getMap();
                    if (map) map.setView([lat, lon], 8);
                }
            });
        });
    }

    function buildCard(alert) {
        const sevClass = severityClass(alert.severity);
        const statusBadge = alert.status === "escalated"
            ? '<span class="sa-badge sa-escalated">ESCALATED</span>'
            : alert.status === "new"
            ? '<span class="sa-badge sa-new">NEW</span>'
            : "";

        const distText = alert.distance_mi != null ? `${Math.round(alert.distance_mi)} mi` : "";
        const etaText = alert.eta_min != null && alert.eta_min > 0 ? `ETA ${Math.round(alert.eta_min)}m` : "";
        const metaParts = [distText, alert.direction !== "unknown" ? alert.direction : "", etaText]
            .filter(Boolean).join(" · ");

        return `<div class="storm-alert-card ${sevClass}" data-lat="${alert.lat}" data-lon="${alert.lon}">
            <div class="sa-header">
                <span class="sa-title">${escapeHtml(alert.title)}</span>
                ${statusBadge}
            </div>
            <div class="sa-message">${escapeHtml(alert.message)}</div>
            ${metaParts ? `<div class="sa-meta">${metaParts}</div>` : ""}
        </div>`;
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

    return { init, fetchAndRender };
})();
