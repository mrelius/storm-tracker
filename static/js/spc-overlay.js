/**
 * Storm Tracker — SPC Map Overlays + Regional Risk Card + Flyout Menu
 *
 * Renders:
 * - Day 1/2/3 outlook risk areas (via SPCMultiDay auto/manual selection)
 * - Active watch polygons (hatched outlines)
 * - Mesoscale discussion areas
 * - Regional Risk card showing composite risk level
 * - SPC day flyout menu (hover-expand, same pattern as camera modes)
 *
 * All SPC data labeled as "SPC outlook / watch guidance."
 * Polls GET /api/spc/risk every 60s for risk card.
 */
const SPCOverlay = (function () {

    const RISK_POLL_MS = 60000;
    const CARD_VISIBLE_MS = 120000;

    let outlookLayer = null;
    let watchesLayer = null;
    let riskTimer = null;
    let cardHideTimer = null;
    let lastRiskSignature = "";
    let outlookVisible = false;
    let watchesVisible = true;
    let log = null;

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

    // ── Flyout collapse timer ──────────────────────────────────────
    let _collapseTimer = null;

    let _modeGated = false;  // true = SPC forced hidden by idle/local mode

    function _isSPCAllowed() {
        // Check camera policy submode — SPC hidden in idle/local news
        if (typeof CameraPolicy !== "undefined") {
            const ps = CameraPolicy.getState();
            if (ps.automaticSubmode === "IDLE_AWARENESS") {
                const at = StormState.state.autotrack;
                if (!at.enabled || !at.targetAlertId) return false;
            }
        }
        return true;
    }

    function _onModeChanged() {
        const allowed = _isSPCAllowed();
        if (!allowed && !_modeGated) {
            // Entering idle — tear down SPC
            _modeGated = true;
            _teardownSPC();
            if (log) log.info("spc_forced_disabled_by_mode", { reason: "idle_or_local" });
        } else if (allowed && _modeGated) {
            // Leaving idle — restore if was visible
            _modeGated = false;
            if (outlookVisible) loadOutlook();
            loadWatches();
        }
    }

    function _teardownSPC() {
        const map = StormMap.getMap();
        if (outlookLayer && map) { map.removeLayer(outlookLayer); }
        if (watchesLayer && map) { map.removeLayer(watchesLayer); }
        const card = document.getElementById("spc-risk-card");
        if (card) card.classList.add("hidden");
        const legend = document.getElementById("spc-legend");
        if (legend) legend.classList.add("hidden");
        const badge = document.getElementById("spc-day-badge");
        if (badge) badge.classList.add("hidden");
    }

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("spc_overlay");

        // Start risk card polling
        riskTimer = setInterval(fetchRisk, RISK_POLL_MS);
        fetchRisk();

        // Restore SPC state from localStorage
        const savedSPC = localStorage.getItem("spc_outlook_visible");
        if (savedSPC === "true") {
            outlookVisible = true;
        }

        // Initialize flyout menu
        _initFlyout();

        // Mode gating — listen for mode changes
        StormState.on("cameraModeChanged", _onModeChanged);
        StormState.on("autotrackChanged", _onModeChanged);

        // Listen for SPC state changes from SPCMultiDay
        StormState.on("spcStateChanged", _syncFlyoutUI);

        // Load only if mode allows
        if (_isSPCAllowed()) {
            loadWatches();
            if (outlookVisible) loadOutlook();
        } else {
            _modeGated = true;
        }
    }

    // ── Flyout Menu (reuses cam-group pattern) ─────────────────────

    function _initFlyout() {
        const group = document.getElementById("spc-tool-group");
        const btn = document.getElementById("btn-spc-toggle");
        if (!group || !btn) return;

        // Main button: toggle menu on click (works for both desktop + touch)
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = group.classList.contains("cam-open");

            if (isOpen) {
                _closeFlyout("button_toggle");
            } else {
                _openFlyout("click");
            }
        });

        // Menu option clicks
        group.querySelectorAll(".spc-opt").forEach(opt => {
            opt.addEventListener("click", (e) => {
                e.stopPropagation();

                // Guard: don't select disabled options
                if (opt.classList.contains("spc-opt-disabled")) return;

                const mode = opt.dataset.spcMode;
                const day = opt.dataset.spcDay ? parseInt(opt.dataset.spcDay, 10) : null;

                _handleSelection(mode, day);
                _closeFlyout("selection");
            });
        });

        // Hover-out debounce (150ms)
        group.addEventListener("mouseleave", () => {
            _collapseTimer = setTimeout(() => _closeFlyout("mouseleave"), 150);
        });
        group.addEventListener("mouseenter", () => {
            if (_collapseTimer) { clearTimeout(_collapseTimer); _collapseTimer = null; }
        });

        // Click outside closes
        document.addEventListener("click", (e) => {
            if (group.contains(e.target)) return;
            _closeFlyout("outside_click");
        });

        // Escape key closes
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && group.classList.contains("cam-open")) {
                _closeFlyout("escape");
            }
        });

        // Initial UI sync
        _syncFlyoutUI();
    }

    function _openFlyout(inputMode) {
        const group = document.getElementById("spc-tool-group");
        const btn = document.getElementById("btn-spc-toggle");
        if (!group) return;

        group.classList.add("cam-open");
        if (btn) btn.setAttribute("aria-expanded", "true");

        const flyout = group.querySelector(".spc-expand");
        if (flyout) flyout.setAttribute("aria-hidden", "false");

        // Sync availability before showing
        _syncAvailability();

        if (log) log.info("spc_menu_opened", { input_mode: inputMode });
    }

    function _closeFlyout(reason) {
        const group = document.getElementById("spc-tool-group");
        const btn = document.getElementById("btn-spc-toggle");
        if (!group || !group.classList.contains("cam-open")) return;

        group.classList.remove("cam-open");
        if (btn) btn.setAttribute("aria-expanded", "false");

        const flyout = group.querySelector(".spc-expand");
        if (flyout) flyout.setAttribute("aria-hidden", "true");

        if (_collapseTimer) { clearTimeout(_collapseTimer); _collapseTimer = null; }

        if (log) log.info("spc_menu_closed", { reason });
    }

    function _handleSelection(mode, day) {
        const hasSPCMultiDay = typeof SPCMultiDay !== "undefined";

        if (mode === "auto") {
            // Switch to auto mode
            if (hasSPCMultiDay) {
                SPCMultiDay.setMode("auto");
            }
            StormState.state.userPrefs.spcMode = "auto_most_severe";
            StormState.state.userPrefs.spcManualDay = null;

            // Ensure outlook is visible
            if (!outlookVisible) {
                outlookVisible = true;
                localStorage.setItem("spc_outlook_visible", "true");
            }

            if (log) log.info("spc_mode_selected", {
                mode: "auto",
                day: null,
                previous_authority: StormState.state.spcAuto.authority,
                next_authority: "auto_track",
            });

        } else if (day) {
            // Manual day selection
            if (hasSPCMultiDay) {
                // Check availability
                const avail = SPCMultiDay.getAvailability();
                if (!avail[day]) {
                    if (log) log.info("spc_manual_day_unavailable", { requested_day: day });
                    return;
                }
                SPCMultiDay.setMode("manual");
                SPCMultiDay.setManualDay(day);
            }
            StormState.state.userPrefs.spcMode = "manual";
            StormState.state.userPrefs.spcManualDay = day;

            // Ensure outlook is visible
            if (!outlookVisible) {
                outlookVisible = true;
                localStorage.setItem("spc_outlook_visible", "true");
            }

            if (log) log.info("spc_mode_selected", {
                mode: "manual",
                day,
                previous_authority: StormState.state.spcAuto.authority,
                next_authority: "user_manual",
            });
        }

        _syncFlyoutUI();
    }

    /**
     * Sync flyout menu active states and button appearance.
     */
    function _syncFlyoutUI() {
        const group = document.getElementById("spc-tool-group");
        const btn = document.getElementById("btn-spc-toggle");
        if (!group) return;

        const prefs = StormState.state.userPrefs;
        const isManual = prefs.spcMode === "manual";
        const manualDay = prefs.spcManualDay;

        // Highlight active option
        group.querySelectorAll(".spc-opt").forEach(opt => {
            const isAuto = opt.dataset.spcMode === "auto";
            const optDay = opt.dataset.spcDay ? parseInt(opt.dataset.spcDay, 10) : null;

            let active = false;
            if (isAuto && !isManual) {
                active = true;
            } else if (optDay && isManual && optDay === manualDay) {
                active = true;
            }

            opt.classList.toggle("spc-opt-active", active);
            opt.classList.toggle("cam-opt-active", active);
            opt.setAttribute("aria-checked", active ? "true" : "false");
        });

        // Button state
        if (btn) {
            btn.classList.remove("spc-active", "spc-manual");
            if (outlookVisible) {
                btn.classList.add(isManual ? "spc-manual" : "spc-active");
            }
        }

        // Sync availability
        _syncAvailability();
    }

    /**
     * Update disabled state of day options based on data availability.
     */
    function _syncAvailability() {
        if (typeof SPCMultiDay === "undefined") return;

        const avail = SPCMultiDay.getAvailability();
        const group = document.getElementById("spc-tool-group");
        if (!group) return;

        group.querySelectorAll(".spc-opt").forEach(opt => {
            const day = opt.dataset.spcDay ? parseInt(opt.dataset.spcDay, 10) : null;
            if (day) {
                const isAvail = avail[day];
                opt.classList.toggle("spc-opt-disabled", !isAvail);
                opt.disabled = !isAvail;
                opt.title = isAvail ? `SPC Day ${day}` : `Day ${day} (no data)`;
            }
        });
    }

    // ── Risk Card ───────────────────────────────────────────────────

    async function fetchRisk() {
        if (_modeGated) return;
        const loc = StormState.state.location;
        const lat = loc.lat || 39.5;
        const lon = loc.lon || -84.5;

        let stormParams = "";
        const at = StormState.state.autotrack;
        if (at.mode !== "off" && at.targetAlertId) {
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

        if (!data.regional || data.regional.level === "none") {
            card.classList.add("hidden");
            return;
        }

        const sig = (data.risk?.category || "") + "|" + (data.watch?.status || "") + "|" + (data.regional?.level || "");
        const isNew = sig !== lastRiskSignature;
        lastRiskSignature = sig;

        if (isNew) {
            card.classList.remove("hidden");
            if (cardHideTimer) clearTimeout(cardHideTimer);
            cardHideTimer = setTimeout(() => {
                card.classList.add("hidden");
                cardHideTimer = null;
            }, CARD_VISIBLE_MS);
        } else if (card.classList.contains("hidden")) {
            return;
        }

        const risk = data.risk;
        const watch = data.watch;
        const md = data.mesoscale;
        const regional = data.regional;
        const fresh = data.freshness || {};
        const messages = data.context_messages || [];
        const stormCtx = data.storm_context;

        const levelClass = {
            none: "spc-level-none",
            monitor: "spc-level-monitor",
            elevated: "spc-level-elevated",
            high_concern: "spc-level-high",
        }[regional.level] || "spc-level-none";

        const outlookAge = _formatAge(fresh.outlook_age_sec);

        let riskHtml = "";
        if (risk.category !== "none") {
            riskHtml = `<div class="spc-row">
                <span class="spc-label">Outlook</span>
                <span class="spc-val" style="color:${risk.color}">${risk.label}</span>
                <span class="spc-age">${outlookAge}</span>
            </div>`;
        }

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

        let mdHtml = "";
        if (md.nearby) {
            mdHtml = `<div class="spc-row">
                <span class="spc-label">MD</span>
                <span class="spc-val">${md.nearby.headline.slice(0, 60)}</span>
            </div>`;
        }

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

        let msgHtml = "";
        if (messages.length > 0) {
            msgHtml = `<div class="spc-messages">${messages.map(m =>
                `<div class="spc-msg">${m}</div>`
            ).join("")}</div>`;
        }

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

            // Blended field style: soft fill, faint stroke, blur via CSS
            outlookLayer = L.geoJSON(geojson, {
                style: function (feature) {
                    const label = feature.properties?.LABEL || "";
                    const style = RISK_FILL[label] || { color: "#888", opacity: 0.05 };
                    return {
                        fillColor: style.color,
                        fillOpacity: style.opacity,
                        weight: 0.5,
                        color: style.color,
                        opacity: 0.15,
                        interactive: false,
                        className: "spc-field",
                    };
                },
            });

            if (outlookVisible) outlookLayer.addTo(map);

            // Feed features to intersection engine
            if (typeof PolygonVisuals !== "undefined") {
                PolygonVisuals.setSpcFeatures(geojson.features || []);
            }
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

        const legend = document.getElementById("spc-legend");
        if (legend) legend.classList.toggle("hidden", !outlookVisible);

        localStorage.setItem("spc_outlook_visible", outlookVisible);
        _syncFlyoutUI();
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

    function isOutlookVisible() {
        return outlookVisible;
    }

    function setOutlookVisible(visible) {
        if (visible === outlookVisible) return;
        toggleOutlook();
    }

    return { init, toggleOutlook, toggleWatches, loadWatches, isOutlookVisible, setOutlookVisible };
})();
