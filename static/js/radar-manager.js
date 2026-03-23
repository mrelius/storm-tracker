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

        populateSiteSelector();
    }

    // --- Layer activation ---

    function toggleReflectivity() {
        const btn = document.getElementById("btn-radar-toggle");
        if (StormState.state.radar.activeLayers.includes("reflectivity")) {
            StormState.deactivateLayer("reflectivity");
            btn.classList.remove("active");
            teardown();
        } else {
            const result = StormState.activateLayer("reflectivity");
            if (result.ok) {
                btn.classList.add("active");
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

            const layer = L.tileLayer(tileUrl, {
                opacity: frame.opacity || 0.65,
                zIndex: 15,
                maxZoom: frame.max_zoom || 10,
                errorTileUrl: "",  // suppress broken tile images
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

            const layer = L.tileLayer(frame.tile_url_template, {
                opacity: 0,
                zIndex: 10,
                maxZoom: frame.max_zoom || 12,
                // No crossfade class — animation frames need instant opacity swap
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

        // Show new frame
        if (frameLayers[idx]) {
            const opacity = frameMeta[idx]?.opacity || 1.0;
            frameLayers[idx].setOpacity(opacity);
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

    return {
        init, loadReflectivity: loadAndPreload, toggleReflectivity, retryRadar,
        // Programmatic control for AutoTrack
        setSiteForAutoTrack, enableSRV, enableCC, disableLayers,
        getRadarSite, getManualSiteOverride, getOverlayLayer,
    };
})();
