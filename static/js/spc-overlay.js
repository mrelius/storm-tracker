/**
 * Storm Tracker — SPC Map Overlays + Regional Risk Card
 *
 * Renders:
 * - Day 1 outlook risk areas (color-shaded polygons)
 * - Active watch polygons (hatched outlines)
 * - Mesoscale discussion areas
 * - Regional Risk card showing composite risk level
 *
 * All SPC data labeled as "SPC outlook / watch guidance."
 * Toggleable via settings or map controls.
 *
 * Polls GET /api/spc/risk every 60s for risk card.
 * Loads overlay GeoJSON on demand.
 */
const SPCOverlay = (function () {

    const RISK_POLL_MS = 60000;
    const CARD_VISIBLE_MS = 120000;  // show SPC card for 2 min then auto-hide

    let outlookLayer = null;
    let watchesLayer = null;
    let riskTimer = null;
    let cardHideTimer = null;
    let lastRiskSignature = "";  // track data changes
    let outlookVisible = false;
    let watchesVisible = true;

    // Risk colors matching SPC
    const RISK_FILL = {
        "TSTM": { color: "#55BB55", opacity: 0.08 },
        "MRGL": { color: "#005500", opacity: 0.12 },
        "SLGT": { color: "#DDAA00", opacity: 0.15 },
        "ENH":  { color: "#FF6600", opacity: 0.18 },
        "MDT":  { color: "#FF0000", opacity: 0.20 },
        "HIGH": { color: "#FF00FF", opacity: 0.25 },
    };

    const WATCH_STYLE = {
        "Tornado Watch":              { color: "#ff0000", weight: 2, dashArray: "8,4", fillOpacity: 0.05 },
        "Severe Thunderstorm Watch":  { color: "#ffd700", weight: 2, dashArray: "8,4", fillOpacity: 0.04 },
    };

    function init() {
        // Start risk card polling
        riskTimer = setInterval(fetchRisk, RISK_POLL_MS);
        fetchRisk();

        // Restore SPC state from localStorage
        const savedSPC = localStorage.getItem("spc_outlook_visible");
        if (savedSPC === "true") {
            outlookVisible = false;  // toggleOutlook will flip to true
            toggleOutlook();
        }

        // SPC toggle button
        const spcBtn = document.getElementById("btn-spc-toggle");
        if (spcBtn) {
            // Sync initial button state
            spcBtn.classList.toggle("active", outlookVisible);
            spcBtn.addEventListener("click", () => {
                toggleOutlook();
                spcBtn.classList.toggle("active", outlookVisible);
                localStorage.setItem("spc_outlook_visible", outlookVisible);
            });
        }

        // Load watches (always on by default)
        loadWatches();
    }

    // ── Risk Card ───────────────────────────────────────────────────

    async function fetchRisk() {
        const loc = StormState.state.location;
        const lat = loc.lat || 39.5;
        const lon = loc.lon || -84.5;

        // Include tracked storm position if available
        let stormParams = "";
        const at = StormState.state.autotrack;
        if (at.mode !== "off" && at.targetAlertId) {
            // Get storm position from alert data
            const alert = StormState.state.alerts.data.find(a => a.id === at.targetAlertId);
            if (alert && alert.polygon) {
                try {
                    const geo = JSON.parse(alert.polygon);
                    const layer = L.geoJSON(geo);
                    const c = layer.getBounds().getCenter();
                    stormParams = `&storm_lat=${c.lat.toFixed(4)}&storm_lon=${c.lng.toFixed(4)}`;
                } catch (e) { /* no storm coords */ }
            }
        }

        try {
            const resp = await fetch(`/api/spc/risk?lat=${lat}&lon=${lon}${stormParams}`);
            if (!resp.ok) return;
            const data = await resp.json();
            renderRiskCard(data);
        } catch (e) { /* silent */ }
    }

    function renderRiskCard(data) {
        const card = document.getElementById("spc-risk-card");
        if (!card) return;

        if (!data.data_available) {
            card.classList.add("hidden");
            return;
        }

        // Hide if regional level is none (no relevant SPC signals)
        if (!data.regional || data.regional.level === "none") {
            card.classList.add("hidden");
            return;
        }

        // Detect if data actually changed — only re-show on change
        const sig = (data.risk?.category || "") + "|" + (data.watch?.status || "") + "|" + (data.regional?.level || "");
        const isNew = sig !== lastRiskSignature;
        lastRiskSignature = sig;

        if (isNew) {
            // New data — show card and start auto-hide timer
            card.classList.remove("hidden");
            if (cardHideTimer) clearTimeout(cardHideTimer);
            cardHideTimer = setTimeout(() => {
                card.classList.add("hidden");
                cardHideTimer = null;
            }, CARD_VISIBLE_MS);
        } else if (card.classList.contains("hidden")) {
            // Same data, already hidden — keep hidden
            return;
        }

        const risk = data.risk;
        const watch = data.watch;
        const md = data.mesoscale;
        const regional = data.regional;
        const fresh = data.freshness || {};
        const messages = data.context_messages || [];
        const stormCtx = data.storm_context;

        // Regional level badge
        const levelClass = {
            none: "spc-level-none",
            monitor: "spc-level-monitor",
            elevated: "spc-level-elevated",
            high_concern: "spc-level-high",
        }[regional.level] || "spc-level-none";

        // Freshness label
        const outlookAge = _formatAge(fresh.outlook_age_sec);

        // Risk category
        let riskHtml = "";
        if (risk.category !== "none") {
            riskHtml = `<div class="spc-row">
                <span class="spc-label">Outlook</span>
                <span class="spc-val" style="color:${risk.color}">${risk.label}</span>
                <span class="spc-age">${outlookAge}</span>
            </div>`;
        }

        // Watch status
        let watchHtml = "";
        if (watch.status !== "none") {
            const statusText = watch.status === "in_watch" ? "INSIDE WATCH" : "Near watch";
            const watchList = watch.watches.map(w => w.event).join(", ");
            watchHtml = `<div class="spc-row">
                <span class="spc-label">Watch</span>
                <span class="spc-val spc-watch-${watch.status}">${statusText}</span>
            </div>
            <div class="spc-detail">${watchList}</div>`;
        }

        // Mesoscale discussion
        let mdHtml = "";
        if (md.nearby) {
            mdHtml = `<div class="spc-row">
                <span class="spc-label">MD</span>
                <span class="spc-val">${md.nearby.headline.slice(0, 60)}</span>
            </div>`;
        }

        // Storm context linking
        let stormHtml = "";
        if (stormCtx) {
            const badges = [];
            if (stormCtx.storm_in_outlook) badges.push(`<span class="spc-storm-badge">in ${stormCtx.storm_in_outlook} risk</span>`);
            if (stormCtx.storm_in_watch) badges.push(`<span class="spc-storm-badge spc-storm-watch">in watch</span>`);
            if (stormCtx.storm_near_md) badges.push(`<span class="spc-storm-badge">near MD</span>`);
            if (badges.length > 0) {
                stormHtml = `<div class="spc-storm-ctx">Storm: ${badges.join(" ")}</div>`;
            }
        }

        // Context messages
        let msgHtml = "";
        if (messages.length > 0) {
            msgHtml = `<div class="spc-messages">${messages.map(m =>
                `<div class="spc-msg">${m}</div>`
            ).join("")}</div>`;
        }

        // Drivers
        const driversHtml = regional.drivers.length > 0
            ? `<div class="spc-drivers">${regional.drivers.join(" · ")}</div>`
            : "";

        card.innerHTML = `
            <div class="spc-header">
                <span class="spc-title">SPC GUIDANCE</span>
                <span class="spc-level ${levelClass}">${regional.level.replace("_", " ")}</span>
            </div>
            <div class="spc-body">
                ${riskHtml}
                ${watchHtml}
                ${mdHtml}
                ${stormHtml}
                ${driversHtml}
                ${msgHtml}
            </div>
            <div class="spc-footer">NOAA/SPC data — not app prediction</div>
        `;
    }

    function _formatAge(sec) {
        if (!sec || sec <= 0) return "";
        if (sec < 120) return `${Math.round(sec)}s ago`;
        if (sec < 7200) return `${Math.round(sec / 60)}m ago`;
        return `${Math.round(sec / 3600)}h ago`;
    }

    // ── Outlook Overlay ─────────────────────────────────────────────

    async function loadOutlook() {
        const map = StormMap.getMap();
        if (!map) return;

        try {
            const resp = await fetch("/api/spc/outlook");
            if (!resp.ok) return;
            const geojson = await resp.json();

            if (outlookLayer) { map.removeLayer(outlookLayer); outlookLayer = null; }

            outlookLayer = L.geoJSON(geojson, {
                style: function (feature) {
                    const label = feature.properties?.LABEL || "";
                    const style = RISK_FILL[label] || { color: "#888", opacity: 0.05 };
                    return {
                        color: style.color,
                        weight: 1,
                        opacity: 0.4,
                        fillColor: style.color,
                        fillOpacity: style.opacity,
                        interactive: false,
                    };
                },
            });

            if (outlookVisible) outlookLayer.addTo(map);
        } catch (e) { /* silent */ }
    }

    function toggleOutlook() {
        const map = StormMap.getMap();
        if (!map) return;

        outlookVisible = !outlookVisible;
        if (outlookVisible) {
            if (!outlookLayer) {
                loadOutlook();
            } else {
                outlookLayer.addTo(map);
            }
        } else if (outlookLayer) {
            map.removeLayer(outlookLayer);
        }

        // Show/hide legend
        const legend = document.getElementById("spc-legend");
        if (legend) legend.classList.toggle("hidden", !outlookVisible);
    }

    // ── Watch Overlay ───────────────────────────────────────────────

    async function loadWatches() {
        const map = StormMap.getMap();
        if (!map) return;

        try {
            const resp = await fetch("/api/spc/watches");
            if (!resp.ok) return;
            const geojson = await resp.json();

            if (watchesLayer) { map.removeLayer(watchesLayer); watchesLayer = null; }

            if (geojson.features.length === 0) return;

            watchesLayer = L.geoJSON(geojson, {
                style: function (feature) {
                    const event = feature.properties?.event || "";
                    const style = WATCH_STYLE[event] || { color: "#888", weight: 1, dashArray: "", fillOpacity: 0.03 };
                    return {
                        color: style.color,
                        weight: style.weight,
                        opacity: 0.6,
                        fillColor: style.color,
                        fillOpacity: style.fillOpacity,
                        dashArray: style.dashArray,
                        interactive: false,
                    };
                },
            });

            if (watchesVisible) watchesLayer.addTo(map);
        } catch (e) { /* silent */ }
    }

    function toggleWatches() {
        const map = StormMap.getMap();
        if (!map) return;

        watchesVisible = !watchesVisible;
        if (watchesVisible) {
            if (!watchesLayer) {
                loadWatches();
            } else {
                watchesLayer.addTo(map);
            }
        } else if (watchesLayer) {
            map.removeLayer(watchesLayer);
        }
    }

    return { init, toggleOutlook, toggleWatches, loadWatches };
})();
