/**
 * Storm Tracker — Radar Layer Manager (v2)
 * Preloads all animation frames as hidden tile layers for flicker-free playback.
 * Manages radar tile layers, animation, timestamp/age display, frame scrubbing.
 * Enforces max-2-layer and mode restrictions via StormState.
 */
const RadarManager = (function () {
    let map = null;

    // Frame management
    let frameMeta = [];         // RadarLayerInfo[] from API
    let frameLayers = [];       // L.tileLayer[] (preloaded, opacity 0)
    let currentFrameIdx = -1;
    let loadedCount = 0;
    let totalExpected = 0;

    // Animation state
    let animTimer = null;
    let dwellCount = 0;
    const DWELL_EXTRA = 2;     // extra ticks on last frame before looping

    // Overlay layers (SRV, CC — single frame, no animation)
    let overlayLayers = {};     // productId -> L.tileLayer
    let radarSite = null;       // current NEXRAD site for IEM products

    // Refresh
    let refreshTimer = null;
    const REFRESH_INTERVAL = 300000; // 5 minutes

    let manualSiteOverride = null;  // null = auto/nearest

    function init(leafletMap) {
        map = leafletMap;

        document.getElementById("btn-radar-toggle").addEventListener("click", toggleReflectivity);
        document.getElementById("btn-srv-toggle").addEventListener("click", toggleSRV);
        document.getElementById("btn-cc-toggle").addEventListener("click", toggleCC);
        document.getElementById("btn-anim-play").addEventListener("click", toggleAnimation);
        document.getElementById("anim-speed").addEventListener("input", onSpeedChange);
        document.getElementById("anim-scrubber").addEventListener("input", onScrub);
        document.getElementById("radar-site-selector").addEventListener("change", onSiteSelected);

        StormState.on("layerChanged", onLayerChanged);
        StormState.on("locationChanged", onLocationChanged);

        // REF hybrid: RainViewer at z≤8, IEM N0Q dual-site blend at z≥9
        map.on("zoomend", _checkRefSourceSwitch);
        map.on("moveend", _checkRefSourceSwitch);

        populateSiteSelector();
    }

    // --- Layer activation ---

    function toggleReflectivity() {
        const btn = document.getElementById("btn-radar-toggle");
        if (StormState.state.radar.activeLayers.includes("reflectivity")) {
            StormState.deactivateLayer("reflectivity");
            btn.classList.remove("active");
            showREFLegend(false);
            teardown();
        } else {
            const result = StormState.activateLayer("reflectivity");
            if (result.ok) {
                btn.classList.add("active");
                showREFLegend(true);
                loadAndPreload();
            }
        }
    }

    // --- SRV overlay ---

    async function toggleSRV() {
        const btn = document.getElementById("btn-srv-toggle");
        if (StormState.state.radar.activeLayers.includes("srv")) {
            // Deactivate CC first (CC requires SRV)
            if (StormState.state.radar.activeLayers.includes("cc")) {
                deactivateCC();
            }
            StormState.deactivateLayer("srv");
            btn.classList.remove("active");
            removeOverlay("srv");
            showSRVLegend(false);
            removeRangeCircle();
            updateSourceLabels();
        } else {
            const result = StormState.activateLayer("srv");
            if (!result.ok) {
                console.warn("Cannot activate SRV:", result.reason);
                return;
            }
            btn.classList.add("active");

            // Auto-pause REF animation — SRV is a single scan, temporal mismatch is misleading
            if (StormState.state.radar.animating) {
                stopAnimation();
                showAnimPausedNotice(true);
            }

            await loadOverlay("srv");
            showSRVLegend(true);
            showRangeCircle();
            updateSourceLabels();
        }
    }

    // --- CC overlay (requires SRV active) ---

    async function toggleCC() {
        const btn = document.getElementById("btn-cc-toggle");
        if (StormState.state.radar.activeLayers.includes("cc")) {
            deactivateCC();
        } else {
            // CC requires SRV to be active
            if (!StormState.state.radar.activeLayers.includes("srv")) {
                showRadarError(true, "CC requires SRV to be active first");
                setTimeout(() => showRadarError(false), 3000);
                return;
            }
            const result = StormState.activateLayer("cc");
            if (!result.ok) {
                console.warn("Cannot activate CC:", result.reason);
                return;
            }
            btn.classList.add("active");
            await loadOverlay("cc");
            showCCLegend(true);
            updateSourceLabels();
        }
    }

    function deactivateCC() {
        const btn = document.getElementById("btn-cc-toggle");
        StormState.deactivateLayer("cc");
        btn.classList.remove("active");
        removeOverlay("cc");
        showCCLegend(false);
        updateSourceLabels();
    }

    async function loadOverlay(productId) {
        // Ensure we have a radar site selected
        if (!radarSite) {
            await selectNearestRadar();
        }
        if (!radarSite) {
            disableOverlay(productId, "No radar site available");
            return;
        }

        // Select provider based on product
        const providerId = productId === "cc" ? "nexrad_cc" : "iem";

        try {
            const resp = await fetch(`/api/radar/frames/${productId}?provider_id=${providerId}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const frames = data.frames || [];

            if (frames.length === 0) {
                disableOverlay(productId, `${productId.toUpperCase()} unavailable for ${radarSite.site_id}`);
                return;
            }

            const frame = frames[frames.length - 1];
            const tileUrl = frame.tile_url_template;
            if (!tileUrl) {
                disableOverlay(productId, `${productId.toUpperCase()} has no tile URL`);
                return;
            }

            removeOverlay(productId);

            const overlayNativeMax = frame.max_native_zoom || frame.max_zoom || 10;
            const layer = L.tileLayer(tileUrl, {
                opacity: frame.opacity || 0.65,
                zIndex: 15,
                maxZoom: 18,
                maxNativeZoom: overlayNativeMax,
                errorTileUrl: "",
                className: "radar-crossfade",
            });

            layer.addTo(map);
            overlayLayers[productId] = layer;
            clearOverlayError(productId);
        } catch (e) {
            console.error(`Failed to load ${productId} overlay:`, e);
            disableOverlay(productId, `${productId.toUpperCase()} load failed`);
        }
    }

    function removeOverlay(productId) {
        if (overlayLayers[productId]) {
            map.removeLayer(overlayLayers[productId]);
            delete overlayLayers[productId];
        }
    }

    function disableOverlay(productId, msg) {
        /**Auto-deactivate overlay, clean up visuals, show error.**/
        removeOverlay(productId);
        StormState.deactivateLayer(productId);
        const btn = document.getElementById(`btn-${productId}-toggle`);
        if (btn) {
            btn.classList.remove("active");
            btn.classList.add("srv-error");
            btn.title = msg;
        }
        showSRVLegend(false);
        removeRangeCircle();
        updateSourceLabels();
        showRadarError(true, msg);
        console.warn(`Overlay disabled: ${msg}`);
    }

    function clearOverlayError(productId) {
        const btn = document.getElementById(`btn-${productId}-toggle`);
        if (btn) {
            btn.classList.remove("srv-error");
            btn.title = `Toggle ${productId.toUpperCase()}`;
        }
        showRadarError(false);
    }

    // --- Radar site management ---

    // --- Site selection ---

    async function populateSiteSelector() {
        const loc = StormState.state.location;
        const params = loc.lat && loc.lon ? `?lat=${loc.lat}&lon=${loc.lon}` : "";
        try {
            const resp = await fetch(`/api/radar/nexrad/all${params}`);
            const data = await resp.json();
            const select = document.getElementById("radar-site-selector");
            // Keep the "Auto" option, add all sites
            data.sites.forEach(s => {
                const opt = document.createElement("option");
                opt.value = s.site_id;
                const dist = s.distance_km ? ` (${Math.round(s.distance_km)}km)` : "";
                opt.textContent = `${s.site_id} — ${s.name}${dist}`;
                select.appendChild(opt);
            });
        } catch (e) {
            console.warn("Failed to load radar sites:", e);
        }
    }

    async function onSiteSelected() {
        const select = document.getElementById("radar-site-selector");
        const val = select.value;

        if (val === "auto") {
            manualSiteOverride = null;
            await selectNearestRadar();
        } else {
            manualSiteOverride = val;
            await switchToSite(val);
        }
    }

    async function switchToSite(siteId) {
        try {
            const resp = await fetch(`/api/radar/nexrad/select?site_id=${siteId}`, { method: "POST" });
            const data = await resp.json();
            radarSite = data.site;
            radarSite.distance_km = null; // manual selection, distance not relevant
            updateSourceLabels();

            // Reload active overlays for new site
            const layers = StormState.state.radar.activeLayers;
            if (layers.includes("srv")) {
                await loadOverlay("srv");
            }
            if (layers.includes("cc")) {
                await loadOverlay("cc");
            }
            if (layers.includes("srv") || layers.includes("cc")) {
                showRangeCircle();
            }
        } catch (e) {
            console.error("Failed to switch site:", e);
        }
    }

    async function selectNearestRadar() {
        if (manualSiteOverride) return;  // don't auto-switch if user chose manually

        const loc = StormState.state.location;
        if (!loc.lat || !loc.lon) return;

        try {
            const resp = await fetch(`/api/radar/nexrad/nearest?lat=${loc.lat}&lon=${loc.lon}&count=1`);
            const data = await resp.json();
            const sites = data.sites || [];
            if (sites.length > 0) {
                radarSite = sites[0];
                await fetch(`/api/radar/nexrad/select?site_id=${radarSite.site_id}`, { method: "POST" });
                // Update selector to reflect auto choice
                const select = document.getElementById("radar-site-selector");
                if (select) select.value = "auto";
                updateSourceLabels();
            }
        } catch (e) {
            console.error("Failed to select radar site:", e);
        }
    }

    async function onLocationChanged() {
        const hadSite = radarSite;
        await selectNearestRadar();
        if (hadSite && radarSite && hadSite.site_id !== radarSite.site_id) {
            const layers = StormState.state.radar.activeLayers;
            if (layers.includes("srv")) {
                await loadOverlay("srv");
                showRangeCircle();
            }
            if (layers.includes("cc")) {
                await loadOverlay("cc");
            }
        }
    }

    // --- Layer changed handler ---

    function onLayerChanged(radarState) {
        if (!radarState.activeLayers.includes("reflectivity")) {
            teardown();
        }
        // Clean up deactivated overlays
        for (const pid of Object.keys(overlayLayers)) {
            if (!radarState.activeLayers.includes(pid)) {
                removeOverlay(pid);
                const btn = document.getElementById(`btn-${pid}-toggle`);
                if (btn) btn.classList.remove("active");
            }
        }
        if (!radarState.activeLayers.includes("srv")) {
            showSRVLegend(false);
            removeRangeCircle();
        }
        if (!radarState.activeLayers.includes("cc")) {
            showCCLegend(false);
        }
    }

    function teardown() {
        stopAnimation();
        clearPreloaded();
        hideAnimControls();
        updateTimestampDisplay(null);
        updateSourceLabels();
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }

    // --- Frame loading ---

    async function loadAndPreload() {
        showLoading(true);
        showRadarError(false);
        try {
            const resp = await fetch("/api/radar/frames/reflectivity");
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            frameMeta = data.frames || [];

            if (frameMeta.length === 0) {
                showLoading(false);
                showRadarError(true, "No radar data available");
                updateTimestampDisplay(null);
                return;
            }

            await preloadFrames();
            showAnimControls();

            if (!refreshTimer) {
                refreshTimer = setInterval(refreshFrames, REFRESH_INTERVAL);
            }
        } catch (e) {
            console.error("Failed to load radar frames:", e);
            showLoading(false);
            showRadarError(true, "Radar unavailable");
            updateTimestampDisplay(null);
        }
    }

    function preloadFrames() {
        // Clear old tile layers but preserve frameMeta (set by loadAndPreload)
        frameLayers.forEach(layer => { if (layer) map.removeLayer(layer); });
        frameLayers = [];
        currentFrameIdx = -1;
        totalExpected = frameMeta.length;
        loadedCount = 0;

        frameMeta.forEach((frame) => {
            if (!frame.tile_url_template) {
                frameLayers.push(null);
                return;
            }

            const isRef = frame.product_id === "reflectivity" || !frame.product_id;
            const nativeMax = frame.max_native_zoom || frame.max_zoom || 12;
            const layer = L.tileLayer(frame.tile_url_template, {
                opacity: 0,
                zIndex: 10,
                maxZoom: 18,
                maxNativeZoom: nativeMax,
                className: isRef ? "ref-tile-layer" : "",
            });

            layer.addTo(map);
            frameLayers.push(layer);
        });

        // Show latest frame immediately (tiles render as they load)
        showLoading(false);
        const lastIdx = frameLayers.length - 1;
        if (lastIdx >= 0) {
            showFrame(lastIdx);
        }
        setupScrubber();

        return Promise.resolve();
    }

    function clearPreloaded() {
        frameLayers.forEach(layer => {
            if (layer) map.removeLayer(layer);
        });
        frameLayers = [];
        frameMeta = [];
        currentFrameIdx = -1;
        loadedCount = 0;
        totalExpected = 0;
    }

    // --- Frame display (flicker-free) ---

    function showFrame(idx) {
        if (idx < 0 || idx >= frameLayers.length) return;

        // Hide current frame
        if (currentFrameIdx >= 0 && currentFrameIdx < frameLayers.length && frameLayers[currentFrameIdx]) {
            frameLayers[currentFrameIdx].setOpacity(0);
        }

        // Show new frame — REF uses attenuated opacity, overlays use metadata
        if (frameLayers[idx]) {
            const meta = frameMeta[idx];
            const baseOpacity = meta?.opacity || 0.75;
            frameLayers[idx].setOpacity(baseOpacity);
        }

        currentFrameIdx = idx;
        StormState.state.radar.currentFrameIndex = idx;

        updateTimestampDisplay(frameMeta[idx] || null);
        updateFrameCounter();
        updateScrubberPosition();
    }

    // --- Animation ---

    function toggleAnimation() {
        if (StormState.state.radar.animating) {
            stopAnimation();
        } else {
            startAnimation();
        }
    }

    function startAnimation() {
        if (frameLayers.length < 2) return;

        StormState.state.radar.animating = true;
        document.getElementById("btn-anim-play").innerHTML = "&#9646;&#9646;";
        showAnimPausedNotice(false);
        dwellCount = 0;

        // Start from beginning if at end
        if (currentFrameIdx >= frameLayers.length - 1) {
            showFrame(0);
        }

        scheduleNextFrame();
    }

    function scheduleNextFrame() {
        if (!StormState.state.radar.animating) return;

        const speedMs = getSpeedMs();
        animTimer = setTimeout(() => {
            if (!StormState.state.radar.animating) return;

            const isLastFrame = currentFrameIdx >= frameLayers.length - 1;

            if (isLastFrame) {
                dwellCount++;
                if (dwellCount >= DWELL_EXTRA) {
                    // Loop back to start
                    dwellCount = 0;
                    showFrame(0);
                }
                // else dwell on last frame (don't advance)
            } else {
                showFrame(currentFrameIdx + 1);
            }

            scheduleNextFrame();
        }, speedMs);
    }

    function stopAnimation() {
        StormState.state.radar.animating = false;
        document.getElementById("btn-anim-play").innerHTML = "&#9654;";
        dwellCount = 0;
        if (animTimer) {
            clearTimeout(animTimer);
            animTimer = null;
        }
    }

    function onSpeedChange() {
        const val = parseInt(document.getElementById("anim-speed").value);
        StormState.state.radar.speed = val;
        // No need to restart — setTimeout-based animation reads speed each tick
    }

    function getSpeedMs() {
        const val = StormState.state.radar.speed || 2;
        return Math.max(150, 1200 - val * 200);
    }

    // --- Scrubber ---

    function setupScrubber() {
        const scrubber = document.getElementById("anim-scrubber");
        scrubber.min = 0;
        scrubber.max = Math.max(0, frameLayers.length - 1);
        scrubber.value = currentFrameIdx;
    }

    function onScrub() {
        const idx = parseInt(document.getElementById("anim-scrubber").value);
        if (StormState.state.radar.animating) {
            stopAnimation();
        }
        showFrame(idx);
    }

    function updateScrubberPosition() {
        const scrubber = document.getElementById("anim-scrubber");
        if (scrubber) scrubber.value = currentFrameIdx;
    }

    // --- Frame refresh ---

    async function refreshFrames() {
        if (StormState.state.radar.animating) return; // don't refresh during playback
        try {
            const resp = await fetch("/api/radar/frames/reflectivity");
            const data = await resp.json();
            const newMeta = data.frames || [];
            if (newMeta.length === 0) return;

            // Check if frames actually changed (compare latest timestamp)
            const oldLatest = frameMeta.length > 0 ? frameMeta[frameMeta.length - 1].timestamp : null;
            const newLatest = newMeta[newMeta.length - 1].timestamp;
            if (oldLatest === newLatest) return;

            // Frames changed — reload
            frameMeta = newMeta;
            await preloadFrames();
        } catch (e) {
            console.warn("Radar refresh failed:", e);
        }
    }

    // --- UI helpers ---

    function showAnimControls() {
        document.getElementById("animation-controls").classList.remove("hidden");
    }

    function hideAnimControls() {
        document.getElementById("animation-controls").classList.add("hidden");
        stopAnimation();
    }

    function showLoading(show) {
        const el = document.getElementById("radar-loading");
        if (el) el.classList.toggle("hidden", !show);
    }

    function updateLoadProgress() {
        const el = document.getElementById("radar-loading");
        if (el && totalExpected > 0) {
            el.textContent = `Loading radar ${loadedCount}/${totalExpected}...`;
        }
    }

    function updateTimestampDisplay(frame) {
        const tsEl = document.getElementById("radar-timestamp");
        const ageEl = document.getElementById("radar-age");

        if (!frame) {
            tsEl.textContent = "Radar: --";
            ageEl.textContent = "";
            return;
        }

        // IEM/SRV frames have no timestamp — be honest
        if (!frame.timestamp) {
            tsEl.textContent = "SRV: latest scan";
            ageEl.textContent = "";
            return;
        }

        // RainViewer/REF frames have real timestamps
        const ts = new Date(frame.timestamp);
        tsEl.textContent = "REF: " + ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        const ageMs = Date.now() - ts.getTime();
        const ageSec = Math.max(0, Math.floor(ageMs / 1000));
        if (ageSec < 120) {
            ageEl.textContent = `${ageSec}s ago`;
        } else {
            ageEl.textContent = `${Math.floor(ageSec / 60)}m ago`;
        }
    }

    function updateSourceLabels() {
        const el = document.getElementById("source-labels");
        if (!el) return;

        const parts = [];
        if (StormState.state.radar.activeLayers.includes("reflectivity")) {
            parts.push("REF: composite");
        }
        if (StormState.state.radar.activeLayers.includes("srv") && radarSite) {
            parts.push(`SRV: ${radarSite.site_id}`);
        }
        if (StormState.state.radar.activeLayers.includes("cc") && radarSite) {
            parts.push(`CC: ${radarSite.site_id} (site radar)`);
        }

        if (parts.length > 0) {
            el.textContent = parts.join(" | ");
            el.classList.remove("hidden");
        } else {
            el.classList.add("hidden");
        }
    }

    function showAnimPausedNotice(show) {
        const el = document.getElementById("anim-paused-notice");
        if (el) el.classList.toggle("hidden", !show);
    }

    function showRadarError(show, msg) {
        const el = document.getElementById("radar-error");
        if (!el) return;
        if (show) {
            el.querySelector(".radar-error-msg").textContent = msg || "Radar unavailable";
            el.classList.remove("hidden");
        } else {
            el.classList.add("hidden");
        }
    }

    function updateFrameCounter() {
        const el = document.getElementById("anim-frame-info");
        if (frameLayers.length > 0) {
            el.textContent = `${currentFrameIdx + 1}/${frameLayers.length}`;
        } else {
            el.textContent = "--/--";
        }
    }

    // --- SRV Legend ---

    function showSRVLegend(show) {
        const el = document.getElementById("srv-legend");
        if (el) el.classList.toggle("hidden", !show);
    }

    function showCCLegend(show) {
        const el = document.getElementById("cc-legend");
        if (el) el.classList.toggle("hidden", !show);
    }

    function showREFLegend(show) {
        const el = document.getElementById("ref-legend");
        if (el) el.classList.toggle("hidden", !show);
    }

    // --- Radar Range Circle ---

    let rangeCircle = null;
    const VELOCITY_RANGE_KM = 230;

    function showRangeCircle() {
        removeRangeCircle();
        if (!radarSite || !map) return;

        rangeCircle = L.circle([radarSite.lat, radarSite.lon], {
            radius: VELOCITY_RANGE_KM * 1000,
            color: "#64748b",
            weight: 1,
            dashArray: "6,4",
            fill: false,
            opacity: 0.5,
            interactive: false,
        }).addTo(map);
    }

    function removeRangeCircle() {
        if (rangeCircle) {
            map.removeLayer(rangeCircle);
            rangeCircle = null;
        }
    }

    function retryRadar() {
        if (StormState.state.radar.activeLayers.includes("reflectivity")) {
            loadAndPreload();
        }
    }

    // --- Programmatic control for AutoTrack ---

    /**
     * Switch radar site without setting manualSiteOverride.
     * Used by autotrack interrogation — does not block future auto-selection.
     */
    async function setSiteForAutoTrack(siteId) {
        if (!siteId) return false;
        try {
            const resp = await fetch(`/api/radar/nexrad/select?site_id=${siteId}`, { method: "POST" });
            if (!resp.ok) return false;
            const data = await resp.json();
            radarSite = data.site;
            updateSourceLabels();

            // Reload active overlays for new site
            const layers = StormState.state.radar.activeLayers;
            if (layers.includes("srv")) await loadOverlay("srv");
            if (layers.includes("cc")) await loadOverlay("cc");
            if (layers.includes("srv") || layers.includes("cc")) showRangeCircle();

            // Update selector display without triggering change handler
            const select = document.getElementById("radar-site-selector");
            if (select) select.value = siteId;

            return true;
        } catch (e) {
            console.error("[AutoTrack] Failed to switch radar site:", e);
            return false;
        }
    }

    /**
     * Enable SRV programmatically (for autotrack interrogation).
     * Returns true if SRV is now active.
     */
    async function enableSRV() {
        if (StormState.state.radar.activeLayers.includes("srv")) return true;
        const result = StormState.activateLayer("srv");
        if (!result.ok) return false;
        const btn = document.getElementById("btn-srv-toggle");
        if (btn) btn.classList.add("active");
        if (StormState.state.radar.animating) {
            stopAnimation();
            showAnimPausedNotice(true);
        }
        await loadOverlay("srv");
        // Check if overlay survived loading (disableOverlay removes it on failure)
        if (!StormState.state.radar.activeLayers.includes("srv")) return false;
        showSRVLegend(true);
        showRangeCircle();
        updateSourceLabels();
        return true;
    }

    /**
     * Enable CC programmatically (for autotrack interrogation).
     * Requires SRV to be active first.
     * Returns true if CC is now active.
     */
    async function enableCC() {
        if (StormState.state.radar.activeLayers.includes("cc")) return true;
        if (!StormState.state.radar.activeLayers.includes("srv")) return false;
        const result = StormState.activateLayer("cc");
        if (!result.ok) return false;
        const btn = document.getElementById("btn-cc-toggle");
        if (btn) btn.classList.add("active");
        await loadOverlay("cc");
        // Check if overlay survived loading (disableOverlay removes it on failure)
        if (!StormState.state.radar.activeLayers.includes("cc")) return false;
        showCCLegend(true);
        updateSourceLabels();
        return true;
    }

    /**
     * Disable layers that were auto-added by autotrack.
     * Only removes layers listed in layerIds. Never touches user-enabled layers.
     */
    function disableLayers(layerIds) {
        for (const pid of layerIds) {
            if (!StormState.state.radar.activeLayers.includes(pid)) continue;
            StormState.deactivateLayer(pid);
            removeOverlay(pid);
            const btn = document.getElementById(`btn-${pid}-toggle`);
            if (btn) btn.classList.remove("active");
            if (pid === "srv") {
                showSRVLegend(false);
                removeRangeCircle();
            }
            if (pid === "cc") showCCLegend(false);
        }
        updateSourceLabels();
    }

    function getRadarSite() {
        return radarSite;
    }

    function getManualSiteOverride() {
        return manualSiteOverride;
    }

    function getOverlayLayer(productId) { return overlayLayers[productId] || null; }

    // ── HYBRID REF — Dual-Site Blended Hi-Res ──────────────────
    // z≤8: RainViewer composite (global, animated)
    // z≥9: IEM N0Q per-site — primary (1.0) + secondary (0.35)
    //       Two nearest NEXRAD sites blended for edge coverage

    const REF_HIRES_SWITCH_ZOOM = 9;
    const REF_SECONDARY_OPACITY = 0.35;
    const REF_CROSSFADE_MS = 250;
    const REF_SITE_DEBOUNCE_MS = 400;

    // Regional radar provider state (TWC primary, RainViewer fallback)
    let regionalState = {
        provider: "rainviewer",  // "twc" | "rainviewer"
        active: false,
        twcLayer: null,          // L.tileLayer for TWC
        twcMeta: null,           // { tile_url, ts, fts, attribution, ... }
        twcLastFetch: 0,
        twcRefreshInterval: 300000, // 5 min
    };

    let refHiresState = {
        active: false,
        primarySite: null,
        secondarySite: null,
        zoom: 0,
    };
    let refPrimaryLayer = null;
    let refSecondaryLayer = null;
    let refSiteDebounceTimer = null;
    let refLastSiteKey = "";

    function _checkRefSourceSwitch() {
        if (!map) return;
        const zoom = map.getZoom();
        const refActive = StormState.state.radar.activeLayers.includes("reflectivity");

        if (!refActive) {
            _removeRefHires();
            _removeTwcRegional();
            return;
        }

        if (zoom >= REF_HIRES_SWITCH_ZOOM) {
            // z≥9: IEM hi-res inspection
            _removeTwcRegional();
            if (refSiteDebounceTimer) clearTimeout(refSiteDebounceTimer);
            refSiteDebounceTimer = setTimeout(() => {
                _updateRefHires(zoom);
            }, refHiresState.active ? REF_SITE_DEBOUNCE_MS : 50);
        } else {
            // z≤8: regional radar (TWC primary, RainViewer fallback)
            _removeRefHires();
            _enableRegionalRadar();
        }
    }

    // ── TWC Regional Radar ───────────────────────────────
    async function _enableRegionalRadar() {
        // Check if TWC is available
        const now = Date.now();
        if (now - regionalState.twcLastFetch < regionalState.twcRefreshInterval && regionalState.twcMeta) {
            // Use cached TWC metadata
            if (!regionalState.active || regionalState.provider !== "twc") {
                _applyTwcLayer(regionalState.twcMeta);
            }
            return;
        }

        try {
            const resp = await fetch("/api/radar/twc-regional");
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            regionalState.twcLastFetch = now;

            if (data.fallback) {
                // TWC not available — use RainViewer (already active as animation frames)
                regionalState.provider = "rainviewer";
                regionalState.active = true;
                _removeTwcLayer();
                // Restore RainViewer opacity
                if (currentFrameIdx >= 0 && frameLayers[currentFrameIdx]) {
                    frameLayers[currentFrameIdx].setOpacity(frameMeta[currentFrameIdx]?.opacity || 1.0);
                }

                const log = typeof STLogger !== "undefined" ? STLogger.for("ref_regional") : null;
                if (log) log.info("regional_radar_fallback", {
                    from: "twc", to: "rainviewer", reason: data.reason,
                });
                return;
            }

            // TWC available — use it
            regionalState.twcMeta = data;
            _applyTwcLayer(data);
        } catch (e) {
            // Fetch failed — stick with RainViewer
            regionalState.provider = "rainviewer";
            regionalState.active = true;
        }
    }

    function _applyTwcLayer(meta) {
        if (!meta || !meta.tile_url) return;

        // Remove RainViewer animation frames' visibility (TWC replaces them)
        if (currentFrameIdx >= 0 && frameLayers[currentFrameIdx]) {
            frameLayers[currentFrameIdx].setOpacity(0);
        }

        // Remove old TWC layer if exists
        if (regionalState.twcLayer) {
            map.removeLayer(regionalState.twcLayer);
        }

        regionalState.twcLayer = L.tileLayer(meta.tile_url, {
            opacity: 0,
            zIndex: 10,
            maxZoom: 18,
            maxNativeZoom: meta.max_native_zoom || 6,
            attribution: meta.attribution || "The Weather Company",
            errorTileUrl: "",
        });

        regionalState.twcLayer.addTo(map);
        setTimeout(() => {
            if (regionalState.twcLayer) regionalState.twcLayer.setOpacity(1.0);
        }, 100);

        regionalState.provider = "twc";
        regionalState.active = true;

        console.log("[REF] TWC regional active:", meta.layer, "ts:", meta.ts);
    }

    function _removeTwcRegional() {
        _removeTwcLayer();
        regionalState.active = false;
    }

    function _removeTwcLayer() {
        if (regionalState.twcLayer) {
            map.removeLayer(regionalState.twcLayer);
            regionalState.twcLayer = null;
        }
        // Restore RainViewer if we were hiding it
        if (currentFrameIdx >= 0 && frameLayers[currentFrameIdx]) {
            const meta = frameMeta[currentFrameIdx];
            frameLayers[currentFrameIdx].setOpacity(meta?.opacity || 1.0);
        }
    }

    // Tile occupancy threshold — tiles smaller than this are considered empty/sparse
    const REF_EMPTY_TILE_BYTES = 400;
    const REF_SPARSE_TILE_BYTES = 800;
    const REF_SCAN_STALE_MIN = 5;
    const REF_SCAN_SUPPRESS_MIN = 10;

    async function _updateRefHires(zoom) {
        const center = map.getCenter();
        const bounds = map.getBounds();
        let sites;
        try {
            const resp = await fetch(`/api/radar/nexrad/nearest?lat=${center.lat}&lon=${center.lng}&count=4`);
            if (!resp.ok) return;
            const data = await resp.json();
            sites = data.sites || [];
        } catch (e) { return; }

        if (sites.length === 0) return;

        // ── Site Scoring ─────────────────────────────────
        const RADAR_RANGE_KM = 230;
        const scored = sites.map(s => {
            const invDist = 1 / Math.max(1, s.distance_km);
            const inBounds = bounds.contains(L.latLng(s.lat, s.lon)) ? 1.0 : 0.5;
            const rangeCover = Math.min(1, RADAR_RANGE_KM / Math.max(1, s.distance_km));
            const coverageScore = inBounds * rangeCover;
            const finalScore = (0.5 * invDist * 100) + (0.5 * coverageScore);
            return { ...s, coverageScore, finalScore };
        });
        scored.sort((a, b) => b.finalScore - a.finalScore);

        const primarySite = scored[0];
        const secondarySite = scored.length > 1 ? scored[1] : null;
        const siteKey = primarySite.site_id + (secondarySite ? "+" + secondarySite.site_id : "");

        if (siteKey === refLastSiteKey && refHiresState.active) {
            refHiresState.zoom = zoom;
            return;
        }
        refLastSiteKey = siteKey;

        // ── Probe secondary tile for occupancy + timestamp ──
        let secondaryOpacity = 0;
        let useSecondary = false;
        let timestampDeltaMin = null;
        let occupancyScore = null;
        let suppressReason = null;

        if (secondarySite) {
            // Distance-based base opacity
            const distRatio = secondarySite.distance_km / Math.max(1, primarySite.distance_km);
            if (distRatio <= 1.5) secondaryOpacity = 0.30;
            else if (distRatio <= 2.5) secondaryOpacity = 0.20;
            else secondaryOpacity = 0.12;

            if (secondarySite.distance_km > 300) {
                secondaryOpacity = 0;
                suppressReason = "too_far";
            }

            // Probe: fetch one tile from each site at current zoom to check occupancy + freshness
            if (secondaryOpacity > 0) {
                try {
                    const probeZ = Math.min(zoom, 10);
                    const n = Math.pow(2, probeZ);
                    const px = Math.floor((center.lng + 180) / 360 * n);
                    const py = Math.floor((1 - Math.log(Math.tan(center.lat * Math.PI / 180) + 1 / Math.cos(center.lat * Math.PI / 180)) / Math.PI) / 2 * n);

                    const [priProbe, secProbe] = await Promise.all([
                        fetch(`/proxy/iem/ridge::${primarySite.site_id}-N0Q-0/${probeZ}/${px}/${py}.png`),
                        fetch(`/proxy/iem/ridge::${secondarySite.site_id}-N0Q-0/${probeZ}/${px}/${py}.png`),
                    ]);

                    const priSize = parseInt(priProbe.headers.get("content-length") || "0") || (await priProbe.clone().blob()).size;
                    const secSize = parseInt(secProbe.headers.get("content-length") || "0") || (await secProbe.clone().blob()).size;

                    // Occupancy: ratio of secondary tile data to primary
                    occupancyScore = priSize > REF_EMPTY_TILE_BYTES ? secSize / priSize : (secSize > REF_EMPTY_TILE_BYTES ? 0.5 : 0);

                    // Suppress if secondary tile is nearly empty
                    if (secSize <= REF_EMPTY_TILE_BYTES) {
                        secondaryOpacity = 0;
                        suppressReason = "empty_tiles";
                    } else if (secSize <= REF_SPARSE_TILE_BYTES) {
                        secondaryOpacity *= 0.5;
                        suppressReason = "sparse_tiles";
                    }

                    // Timestamp: use Date headers for scan freshness estimate
                    const priDate = priProbe.headers.get("date");
                    const secDate = secProbe.headers.get("date");
                    if (priDate && secDate) {
                        const delta = Math.abs(new Date(priDate).getTime() - new Date(secDate).getTime());
                        timestampDeltaMin = Math.round(delta / 60000);
                        // Apply scan-time mismatch reduction
                        if (timestampDeltaMin > REF_SCAN_SUPPRESS_MIN) {
                            secondaryOpacity = 0;
                            suppressReason = "stale_scan";
                        } else if (timestampDeltaMin > REF_SCAN_STALE_MIN) {
                            secondaryOpacity *= 0.5;
                            suppressReason = suppressReason || "stale_scan_reduced";
                        }
                    }
                } catch (e) {
                    // Probe failed — use distance-only opacity
                }
            }

            useSecondary = secondaryOpacity > 0.05;
        }

        // ── Build Layers ─────────────────────────────────
        const primaryUrl = `/proxy/iem/ridge::${primarySite.site_id}-N0Q-0/{z}/{x}/{y}.png`;
        const newPrimary = L.tileLayer(primaryUrl, {
            opacity: 0, zIndex: 12, maxZoom: 18, maxNativeZoom: 10, errorTileUrl: "",
        });

        let newSecondary = null;
        if (useSecondary) {
            const secondaryUrl = `/proxy/iem/ridge::${secondarySite.site_id}-N0Q-0/{z}/{x}/{y}.png`;
            newSecondary = L.tileLayer(secondaryUrl, {
                opacity: 0, zIndex: 11, maxZoom: 18, maxNativeZoom: 10, errorTileUrl: "",
            });
        }

        // ── Crossfade ────────────────────────────────────
        newPrimary.addTo(map);
        if (newSecondary) newSecondary.addTo(map);

        setTimeout(() => {
            if (newPrimary) newPrimary.setOpacity(1.0);
            if (newSecondary) newSecondary.setOpacity(secondaryOpacity);
            setTimeout(() => {
                if (refPrimaryLayer) map.removeLayer(refPrimaryLayer);
                if (refSecondaryLayer) map.removeLayer(refSecondaryLayer);
                refPrimaryLayer = newPrimary;
                refSecondaryLayer = newSecondary;
            }, REF_CROSSFADE_MS);
        }, 50);

        if (currentFrameIdx >= 0 && frameLayers[currentFrameIdx]) {
            frameLayers[currentFrameIdx].setOpacity(0.2);
        }

        refHiresState = {
            active: true,
            primarySite: primarySite.site_id,
            secondarySite: useSecondary ? secondarySite.site_id : null,
            primaryOpacity: 1.0,
            secondaryOpacity: useSecondary ? Math.round(secondaryOpacity * 100) / 100 : 0,
            primaryTimestamp: null,
            secondaryTimestamp: null,
            timestampDeltaMin: timestampDeltaMin,
            zoom: zoom,
        };

        showRadarError(false);

        const log = typeof STLogger !== "undefined" ? STLogger.for("ref_hybrid") : null;
        if (log) log.info("ref_secondary_decision", {
            primarySite: primarySite.site_id,
            secondarySite: secondarySite ? secondarySite.site_id : null,
            timestampDeltaMin: timestampDeltaMin,
            occupancyScore: occupancyScore != null ? Math.round(occupancyScore * 100) / 100 : null,
            finalSecondaryOpacity: useSecondary ? Math.round(secondaryOpacity * 100) / 100 : 0,
            suppressed: !useSecondary,
            reason: suppressReason || (useSecondary ? "normal" : "no_secondary"),
        });
    }

    function _removeRefHires() {
        if (!refHiresState.active && !refPrimaryLayer && !refSecondaryLayer) return;

        if (refPrimaryLayer) { map.removeLayer(refPrimaryLayer); refPrimaryLayer = null; }
        if (refSecondaryLayer) { map.removeLayer(refSecondaryLayer); refSecondaryLayer = null; }

        // Restore RainViewer
        if (currentFrameIdx >= 0 && frameLayers[currentFrameIdx]) {
            const meta = frameMeta[currentFrameIdx];
            frameLayers[currentFrameIdx].setOpacity(meta?.opacity || 1.0);
        }

        refHiresState = { active: false, primarySite: null, secondarySite: null, zoom: 0 };
        refLastSiteKey = "";
    }

    // ── REF Adaptive Filter (smooth interpolation) ─────────────
    // Continuous interpolation across zoom range — no threshold jumps.
    // z5 → wide (low contrast, reduced noise)
    // z12 → tight (high contrast, core emphasis)

    const REF_RANGE = {
        contrast:   { min: 1.18, max: 1.48 },
        brightness: { min: 0.83, max: 0.97 },
        saturate:   { min: 0.95, max: 1.25 },
    };
    const REF_ZOOM_MIN = 5;
    const REF_ZOOM_MAX = 12;

    let lastRefFilterStr = "";

    function _lerp(a, b, t) { return a + (b - a) * t; }
    function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    function _updateRefFilter() {
        if (!map) return;
        const zoom = map.getZoom();
        const t = _clamp01((zoom - REF_ZOOM_MIN) / (REF_ZOOM_MAX - REF_ZOOM_MIN));

        const c = Math.round(_lerp(REF_RANGE.contrast.min, REF_RANGE.contrast.max, t) * 100) / 100;
        const b = Math.round(_lerp(REF_RANGE.brightness.min, REF_RANGE.brightness.max, t) * 100) / 100;
        const s = Math.round(_lerp(REF_RANGE.saturate.min, REF_RANGE.saturate.max, t) * 100) / 100;

        const filterVal = `contrast(${c}) brightness(${b}) saturate(${s})`;
        if (filterVal === lastRefFilterStr) return;
        lastRefFilterStr = filterVal;

        const app = document.getElementById("app");
        if (app) app.style.setProperty("--ref-filter", filterVal);
    }

    return {
        init, loadReflectivity: loadAndPreload, toggleReflectivity, retryRadar,
        // Programmatic control for AutoTrack
        setSiteForAutoTrack, enableSRV, enableCC, disableLayers,
        getRadarSite, getManualSiteOverride, getOverlayLayer,
        getRefHiresState: () => ({ ...refHiresState }),
    };
})();
