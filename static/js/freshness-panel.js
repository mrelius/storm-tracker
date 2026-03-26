/**
 * Storm Tracker — Freshness Dashboard Panel
 *
 * Shows per-source data freshness, health scores, stale badges,
 * and recent drop events. Toggled from the status strip.
 *
 * HARD FAIL indicators: sources with "drop" policy show red
 * when stale — data is being actively blocked.
 */
const FreshnessPanel = (function () {

    const POLL_MS = 5000;  // refresh every 5s
    let pollTimer = null;
    let lastData = null;
    let visible = false;

    function init() {
        pollTimer = setInterval(_poll, POLL_MS);
        _poll();

        // Toggle panel from status strip badge
        const badge = document.getElementById("ss-freshness");
        if (badge) {
            badge.style.cursor = "pointer";
            badge.addEventListener("click", toggle);
        }
    }

    function toggle() {
        const panel = document.getElementById("freshness-panel");
        if (!panel) return;
        visible = !visible;
        panel.classList.toggle("hidden", !visible);
        if (visible) _render();
    }

    async function _poll() {
        try {
            const resp = await fetch("/api/freshness");
            if (resp.ok) {
                lastData = await resp.json();
                _updateBadge();
                if (visible) _render();
            }
        } catch (e) { /* silent */ }
    }

    function _updateBadge() {
        const badge = document.getElementById("ss-freshness");
        if (!badge || !lastData) return;

        const stale = lastData.stale_sources || [];
        const health = lastData.overall_health;

        if (stale.length > 0) {
            badge.textContent = `STALE (${stale.length})`;
            badge.className = "ss-badge ss-stale";
            badge.title = `Stale sources: ${stale.join(", ")}`;
        } else if (health < 80) {
            badge.textContent = "DEGRADED";
            badge.className = "ss-badge ss-stale";
            badge.title = `Health: ${health}%`;
        } else {
            badge.textContent = "FRESH";
            badge.className = "ss-badge ss-live";
            badge.title = `All feeds healthy (${health}%)`;
        }
    }

    function _render() {
        const panel = document.getElementById("freshness-panel");
        if (!panel || !lastData) return;

        let html = `<div class="fp-header">
            <span class="fp-title">DATA FRESHNESS</span>
            <span class="fp-health">Health: ${lastData.overall_health}%</span>
            <span class="fp-close" id="fp-close">&times;</span>
        </div>`;

        // Feed table
        html += `<div class="fp-feeds">`;
        const feeds = lastData.feeds || {};
        for (const [src, feed] of Object.entries(feeds)) {
            const statusClass = _statusClass(feed.status);
            const actionBadge = feed.stale_action === "drop"
                ? '<span class="fp-hard-fail">HARD FAIL</span>'
                : '';
            const age = feed.age_sec !== null ? `${Math.round(feed.age_sec)}s` : "---";
            const maxAge = feed.max_age_sec ? `${feed.max_age_sec}s` : "---";

            html += `<div class="fp-feed ${statusClass}">
                <div class="fp-feed-name">${_esc(feed.description)} ${actionBadge}</div>
                <div class="fp-feed-stats">
                    <span class="fp-age">Age: ${age} / ${maxAge}</span>
                    <span class="fp-score">Score: ${feed.health_score}%</span>
                </div>
                <div class="fp-feed-counts">
                    <span class="fp-fresh">${feed.stats.fresh} fresh</span>
                    <span class="fp-stale">${feed.stats.stale} stale</span>
                    <span class="fp-dropped">${feed.stats.dropped} dropped</span>
                </div>
            </div>`;
        }
        html += `</div>`;

        // Recent drops
        const drops = lastData.recent_drops || [];
        if (drops.length > 0) {
            html += `<div class="fp-drops-header">RECENT DROPS (${drops.length})</div>`;
            html += `<div class="fp-drops">`;
            for (const drop of drops.slice(-10).reverse()) {
                const ago = Math.round((Date.now() / 1000) - drop.ts);
                html += `<div class="fp-drop">
                    <span class="fp-drop-src">${_esc(drop.source)}</span>
                    <span class="fp-drop-reason">${_esc(drop.reason)}</span>
                    <span class="fp-drop-age">${drop.age_sec}s old</span>
                    <span class="fp-drop-ago">${ago}s ago</span>
                </div>`;
            }
            html += `</div>`;
        }

        panel.innerHTML = html;

        // Close button
        const closeBtn = document.getElementById("fp-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                toggle();
            });
        }
    }

    function _statusClass(status) {
        switch (status) {
            case "fresh": return "fp-status-fresh";
            case "warning": return "fp-status-warning";
            case "stale": return "fp-status-stale";
            case "no_data": return "fp-status-nodata";
            default: return "fp-status-unknown";
        }
    }

    function getLastData() {
        return lastData;
    }

    function _esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init, toggle, getLastData };
})();
