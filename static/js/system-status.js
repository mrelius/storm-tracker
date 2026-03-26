/**
 * Storm Tracker — System Status Strip + Guidance Explainer
 *
 * Compact always-visible status showing: alert health, camera mode,
 * Auto Track, Audio Follow, last update age.
 *
 * Click guidance card → shows explainer with reasoning.
 * Click anywhere else → hides explainer.
 */
const SystemStatus = (function () {

    const UPDATE_MS = 2000;  // refresh every 2s
    let updateTimer = null;
    let lastGuidanceData = null;

    function init() {
        updateTimer = setInterval(update, UPDATE_MS);
        update();

        // Guidance explainer: click guidance card to show, click elsewhere to hide
        const guidCard = document.getElementById("guidance-card");
        if (guidCard) {
            guidCard.style.cursor = "pointer";
            guidCard.addEventListener("click", toggleExplainer);
        }

        document.addEventListener("click", (e) => {
            const expl = document.getElementById("guidance-explainer");
            const card = document.getElementById("guidance-card");
            if (expl && !expl.contains(e.target) && (!card || !card.contains(e.target))) {
                expl.classList.add("hidden");
            }
        });

        // Listen for guidance updates
        // The guidance card fetches data — we'll tap into it
        _pollGuidanceForExplainer();
    }

    function update() {
        _updateAlertStatus();
        _updateMode();
        _updateAT();
        _updateAudio();
        _updateAge();
        _updateFilters();
        _updateFreshness();
    }

    // ── Alert Status ────────────────────────────────────────────

    function _updateAlertStatus() {
        const el = document.getElementById("ss-alert-status");
        if (!el) return;

        // Use watchdog status if available from last deep health check
        const wd = _getWatchdogStatus();
        if (wd === "failed") {
            el.textContent = "Offline";
            el.className = "ss-badge ss-offline";
        } else if (wd === "stale" || wd === "degraded") {
            el.textContent = "Stale";
            el.className = "ss-badge ss-stale";
        } else {
            el.textContent = "Live";
            el.className = "ss-badge ss-live";
        }
    }

    function _getWatchdogStatus() {
        // Read from the app.js lastWatchdogStatus if accessible
        // Fallback: check if staleness banner is visible
        const banner = document.getElementById("staleness-banner");
        if (banner && !banner.classList.contains("hidden")) {
            if (banner.classList.contains("stale-critical")) return "failed";
            if (banner.classList.contains("stale-warn")) return "stale";
        }
        return "ok";
    }

    // ── Camera Mode ─────────────────────────────────────────────

    function _updateMode() {
        const el = document.getElementById("ss-mode");
        if (!el) return;

        const cam = StormState.state.camera;
        const gps = StormState.state.gpsFollow;

        if (gps && gps.active) {
            if (gps.paused) {
                el.textContent = "MANUAL";
                el.className = "ss-badge ss-mode-manual";
            } else {
                el.textContent = "GPS";
                el.className = "ss-badge ss-mode-gps";
            }
        } else if (cam.owner === "autotrack") {
            el.textContent = "AUTO TRACK";
            el.className = "ss-badge ss-mode-at";
        } else if (cam.owner === "pulse") {
            el.textContent = "CTX PULSE";
            el.className = "ss-badge ss-mode-at";
        } else {
            el.textContent = "MANUAL";
            el.className = "ss-badge ss-mode-idle";
        }
    }

    // ── Auto Track ──────────────────────────────────────────────

    function _updateAT() {
        const el = document.getElementById("ss-at");
        if (!el) return;

        const at = StormState.state.autotrack;
        if (at.mode === "off") {
            el.textContent = "AT OFF";
            el.className = "ss-badge ss-dim";
            el.title = "Auto Track: Off";
        } else {
            const target = at.targetEvent
                ? _shortEvent(at.targetEvent)
                : "---";
            // Include radar site for interrogation mode
            const site = (at.mode === "interrogate" && at.radarSite) ? ` ${at.radarSite}` : "";
            const paused = at.followPaused ? " ⏸" : "";
            el.textContent = `Tracking ${target}${site}${paused}`;
            el.className = "ss-badge ss-at-on";
            el.title = `Auto Track: ${at.targetEvent || "active"}${site ? " · Interrogating " + at.radarSite : ""}${at.followPaused ? " · Follow paused" : ""}`;
        }
    }

    function _shortEvent(evt) {
        if (!evt) return "---";
        if (evt.includes("Tornado") && evt.includes("Warning")) return "TOR";
        if (evt.includes("Severe") && evt.includes("Thunderstorm")) return "SVR";
        if (evt.includes("Tornado") && evt.includes("Watch")) return "TWC";
        if (evt.includes("Flood")) return "FLW";
        return evt.slice(0, 3).toUpperCase();
    }

    // ── Radar Layers ────────────────────────────────────────────

    function _updateRadar() {
        const el = document.getElementById("ss-radar");
        if (!el) return;

        const layers = StormState.state.radar.activeLayers;
        if (layers.length === 0) {
            el.textContent = "";
            el.className = "ss-badge ss-dim";
            el.style.display = "none";
            return;
        }

        el.style.display = "";
        const parts = [];
        if (layers.includes("reflectivity")) {
            const animating = StormState.state.radar.animating;
            const pres = StormState.state.radarPresentation;
            const futureTag = pres.futureEnabled ? " + Future" : "";
            parts.push(animating ? `Radar${futureTag} ▶` : "Radar");
        }
        if (layers.includes("srv")) parts.push("SRV");
        if (layers.includes("cc")) parts.push("CC");

        el.textContent = parts.join("+");
        el.className = "ss-badge ss-live";
        el.title = `Active layers: ${parts.join(", ")}`;
    }

    // ── Audio Follow ────────────────────────────────────────────

    function _updateAudio() {
        const el = document.getElementById("ss-audio");
        if (!el) return;

        // Use demo audio controller if available and demo active
        if (typeof AudioDemoController !== "undefined" && StormState.state.demoAudio.enabled) {
            const stripText = AudioDemoController.getStatusStripText();
            if (stripText) {
                el.textContent = stripText;
                // Determine CSS class from demo state
                const da = StormState.state.demoAudio;
                if (da.errorCode || da.playbackState === "error") {
                    el.className = "ss-badge ss-af-unavail";
                    el.title = "Audio Demo: " + (da.errorMessage || "error");
                } else if (da.playbackState === "playing") {
                    el.className = "ss-badge ss-af-live";
                    el.title = "Audio Demo: " + (da.streamTitle || "playing");
                } else if (da.playbackState === "loading") {
                    el.className = "ss-badge ss-af-pending";
                    el.title = "Audio Demo: loading";
                } else if (da.playbackState === "unavailable") {
                    el.className = "ss-badge ss-af-unavail";
                    el.title = "Audio Demo: unavailable";
                } else {
                    el.className = "ss-badge ss-dim";
                    el.title = "Audio Demo: " + da.playbackState;
                }
                return;
            }
        }

        const af = StormState.state.audioFollow;
        if (!af.enabled) {
            el.textContent = "AF OFF";
            el.className = "ss-badge ss-dim";
            el.title = "Audio Follow: disabled";
        } else if (af.status === "live" && af.currentSource) {
            const src = af.currentSource === "noaa" ? "NOAA" : af.currentSource === "scanner" ? "SCN" : af.currentSource.toUpperCase();
            el.textContent = `AF ${src} ●`;
            el.className = "ss-badge ss-af-live";
            el.title = `Audio: ${src} streaming (${af.owner || "auto"})`;
        } else if (af.status === "pending") {
            el.textContent = "AF ...";
            el.className = "ss-badge ss-af-pending";
            el.title = "Audio: connecting/stabilizing";
        } else if (af.status === "unavailable") {
            el.textContent = "AF ✕";
            el.className = "ss-badge ss-af-unavail";
            el.title = "Audio: stream unavailable";
        } else {
            el.textContent = "AF ---";
            el.className = "ss-badge ss-dim";
            el.title = "Audio Follow: idle";
        }
    }

    // ── Update Age ──────────────────────────────────────────────

    function _updateAge() {
        const el = document.getElementById("ss-age");
        if (!el) return;

        // Read nws_last_poll from the freshness indicator
        const freshEl = document.getElementById("data-freshness");
        if (freshEl) {
            el.textContent = freshEl.textContent.replace("Alerts: ", "");
        }
    }

    // ── Filter Indicators ────────────────────────────────────────

    function _updateFilters() {
        const el = document.getElementById("ss-filters");
        if (!el) return;

        // Read current settings — access via localStorage since Settings
        // module stores as JSON under "storm_tracker_settings"
        let settings;
        try {
            settings = JSON.parse(localStorage.getItem("storm_tracker_settings") || "{}");
        } catch (e) {
            return;
        }

        const badges = [];
        const labels = {
            showPrimary: "Primary",
            showSecondary: "Secondary",
            showWarnings: "Warnings",
        };

        for (const [key, label] of Object.entries(labels)) {
            // Default is true for these — only show badge when explicitly OFF
            if (settings[key] === false) {
                badges.push(`<span class="ss-filter-off" title="${label} alerts hidden — click gear to re-enable">${label} OFF</span>`);
            }
        }

        el.innerHTML = badges.join("");
    }

    // ── Freshness Status ───────────────────────────────────────

    function _updateFreshness() {
        // Freshness badge is updated by FreshnessPanel.init() polling
        // This is a no-op stub — the badge is self-updating from freshness-panel.js
        // But if FreshnessPanel hasn't loaded, show a default
        const el = document.getElementById("ss-freshness");
        if (!el) return;
        if (typeof FreshnessPanel === "undefined") {
            el.textContent = "---";
            el.className = "ss-badge ss-dim";
        }
    }

    // ── Guidance Explainer ──────────────────────────────────────

    function toggleExplainer(e) {
        e.stopPropagation();
        const expl = document.getElementById("guidance-explainer");
        if (!expl) return;

        if (expl.classList.contains("hidden")) {
            _renderExplainer();
            expl.classList.remove("hidden");
        } else {
            expl.classList.add("hidden");
        }
    }

    async function _pollGuidanceForExplainer() {
        // Fetch guidance data periodically for the explainer
        setInterval(async () => {
            try {
                const loc = StormState.state.location;
                const resp = await fetch(`/api/guidance?lat=${loc.lat || 39.5}&lon=${loc.lon || -84.5}`);
                if (resp.ok) {
                    const data = await resp.json();
                    lastGuidanceData = data;
                }
            } catch (e) { /* silent */ }
        }, 25000);  // 25s — slightly offset from guidance card poll
    }

    function _renderExplainer() {
        const expl = document.getElementById("guidance-explainer");
        if (!expl) return;

        const g = lastGuidanceData?.guidance;
        if (!g) {
            expl.innerHTML = `
                <div class="ge-title">GUIDANCE REASONING</div>
                <div class="ge-section">No guidance data available yet.</div>
            `;
            return;
        }

        let html = `<div class="ge-title">GUIDANCE REASONING</div>`;

        if (g.suppressed) {
            html += `<div class="ge-row"><span class="ge-label">Status</span><span class="ge-val">Suppressed</span></div>`;
            html += `<div class="ge-row"><span class="ge-label">Reason</span><span class="ge-val">${g.suppress_reason}</span></div>`;
            html += `<div class="ge-section">No active threat signals. The guidance card is hidden because no relevant storm or SPC data requires attention.</div>`;
        } else {
            html += `<div class="ge-row"><span class="ge-label">Priority</span><span class="ge-val">${g.priority} (score ${g.score || "?"})</span></div>`;
            html += `<div class="ge-row"><span class="ge-label">Headline</span><span class="ge-val">${_esc(g.headline)}</span></div>`;

            if (g.messages && g.messages.length > 0) {
                html += `<div class="ge-title" style="margin-top:4px">MESSAGES</div>`;
                for (const m of g.messages) {
                    html += `<div style="padding:1px 0;color:#94a3b8;">${_esc(m)}</div>`;
                }
            }

            if (g.reasoning && g.reasoning.length > 0) {
                html += `<div class="ge-title" style="margin-top:4px">REASONING</div>`;
                for (const r of g.reasoning) {
                    html += `<div style="padding:1px 0;color:#64748b;font-size:8px;">${_esc(r)}</div>`;
                }
            }
        }

        // Camera/mode context
        const cam = StormState.state.camera;
        const gps = StormState.state.gpsFollow;
        html += `<div class="ge-section">`;
        html += `Camera: ${cam.owner} (${cam.reason || "—"})`;
        if (gps && gps.active) html += ` · GPS ${gps.paused ? "paused" : "active"}`;
        html += `</div>`;

        expl.innerHTML = html;
    }

    function _esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init, update };
})();
