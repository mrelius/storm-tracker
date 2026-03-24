/**
 * Storm Tracker — Main Application Controller
 * Wires all modules together and bootstraps the app.
 * Manages data freshness, staleness warnings, and offline detection.
 */
(function () {
    const FRESHNESS_POLL_INTERVAL = 15000;  // check every 15s
    const STALE_WARN_SECONDS = 120;         // amber warning at 2 min
    const STALE_CRIT_SECONDS = 300;         // red warning at 5 min

    // ── Viewport Mode Layer ─────────────────────────────────────
    const MOBILE_BREAKPOINT = 768;
    let viewportMode = "desktop";

    function initViewportMode() {
        const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
        const appEl = document.getElementById("app");
        const log = typeof STLogger !== "undefined" ? STLogger.for("viewport") : null;

        function applyMode(mobile) {
            const prev = viewportMode;
            viewportMode = mobile ? "mobile" : "desktop";
            if (appEl) {
                appEl.classList.toggle("is-mobile", mobile);
                appEl.classList.toggle("is-desktop", !mobile);
            }
            if (prev !== viewportMode && log) {
                log.info("viewport_mode_changed", { mode: viewportMode, width: window.innerWidth });
            }
        }

        applyMode(mq.matches);
        mq.addEventListener("change", (e) => applyMode(e.matches));

        // Orientation change logging
        if (typeof screen !== "undefined" && screen.orientation) {
            screen.orientation.addEventListener("change", () => {
                if (log) log.info("orientation_changed", { type: screen.orientation.type, angle: screen.orientation.angle });
            });
        }
    }

    let lastPollTime = null;
    let freshnessTimer = null;
    let isOffline = false;

    document.addEventListener("DOMContentLoaded", async () => {
        initViewportMode();
        STLogger.init();
        const log = STLogger.for("app");
        log.info("app_init", { build: window.__ST_BUILD__ || "?", viewportMode });

        // 0. Restore persisted session state (before any init)
        const savedSession = SessionPersist.restore();

        // 1. Initialize map
        const map = StormMap.init();

        // 2. Initialize subsystems
        Camera.init();
        RadarManager.init(map);
        AlertRenderer.init(map);
        AlertPanel.init();
        StormAlertPanel.init();
        StormAudio.init();
        StormNotify.init();
        AutoTrack.init();
        AudioFollow.init();
        AudioAnnounce.init();
        // AlertFloat removed — replaced by pulse card
        ATPlaces.init();
        if (typeof ThreatFocusEngine !== "undefined") ThreatFocusEngine.init();
        ContextPulse.init();
        PulseCards.init();
        ATSwitchSound.init();
        ClarityLayer.init();
        SystemStatus.init();
        GuidanceCard.init();
        SPCOverlay.init();
        PredictionCard.init();
        PredictionOverlay.init();
        Settings.init();
        LogViewer.init();
        MobileGestures.init();
        if (typeof MobileEnhancements !== "undefined") MobileEnhancements.init();
        if (typeof OptionalEnhancements !== "undefined") OptionalEnhancements.init();
        if (typeof ContextZoom !== "undefined") ContextZoom.init();
        AutoTrackDebug.init();
        SessionPersist.init();
        Validation.init(map);
        Feedback.init();

        // 2b. Apply restored session state (after subsystems ready)
        SessionPersist.applyRestore(savedSession);

        // Header minimize/restore
        // SRV popup — move selector into popup, open on SRV click
        (function () {
            const srvBtn = document.getElementById("btn-srv-toggle");
            const popup = document.getElementById("srv-popup");
            const popupBody = document.getElementById("srv-popup-body");
            const closeBtn = document.getElementById("srv-popup-close");
            const selector = document.getElementById("radar-site-selector");

            if (srvBtn && popup && popupBody && selector) {
                // Move the selector into the popup body
                popupBody.appendChild(selector);
                selector.classList.remove("srv-popup-hidden");

                // SRV button: toggle SRV layer + open popup
                srvBtn.addEventListener("click", (e) => {
                    // Only show popup if SRV is being enabled (not disabled)
                    setTimeout(() => {
                        if (StormState.state.radar.activeLayers.includes("srv")) {
                            popup.classList.remove("hidden");
                        } else {
                            popup.classList.add("hidden");
                        }
                    }, 100);
                });

                closeBtn.addEventListener("click", () => popup.classList.add("hidden"));

                // Close on click outside
                document.addEventListener("click", (e) => {
                    if (!popup.contains(e.target) && e.target !== srvBtn && !srvBtn.contains(e.target)) {
                        popup.classList.add("hidden");
                    }
                });
            }
        })();

        // Header minimize removed in v133

        // Fullscreen toggle
        const fsBtn = document.getElementById("btn-fullscreen");
        if (fsBtn) fsBtn.addEventListener("click", () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
                fsBtn.textContent = "\u2716";  // X to exit
                fsBtn.title = "Exit fullscreen";
            } else {
                document.exitFullscreen().catch(() => {});
                fsBtn.textContent = "\u26F6";  // expand icon
                fsBtn.title = "Toggle fullscreen";
            }
        });
        document.addEventListener("fullscreenchange", () => {
            if (fsBtn) {
                fsBtn.textContent = document.fullscreenElement ? "\u2716" : "\u26F6";
                fsBtn.title = document.fullscreenElement ? "Exit fullscreen" : "Toggle fullscreen";
            }
        });

        // ── GPS Follow Mode ──────────────────────────────────────
        // Toggle GPS follow on/off. When on: map centered on GPS,
        // blue dot shown, AT recentering suppressed. Manual pan pauses
        // centering; auto-resumes after 12s inactivity.

        let gpsWatchId = null;
        let gpsMarker = null;
        let gpsCircle = null;
        let gpsInitDone = false;
        let gpsResumeTimer = null;
        const GPS_AUTO_RESUME_MS = 12000;

        const myLocBtn = document.getElementById("btn-my-location");
        if (myLocBtn) myLocBtn.addEventListener("click", toggleGPSFollow);

        // AT turns on → GPS yields with toast
        StormState.on("autotrackChanged", (data) => {
            if (data.mode !== "off" && StormState.state.gpsFollow.active) {
                deactivateGPSFollow();
                // Toast now triggered by cameraOwnerChanged event from AT's Camera.claim
            }
        });

        // Manual pan → pause GPS centering + start auto-resume timer
        StormState.on("userMapInteraction", () => {
            if (StormState.state.gpsFollow.active && !StormState.state.gpsFollow.paused) {
                StormState.state.gpsFollow.paused = true;
                _showGPSPaused(true);
                _updateGPSBtn();
            }
            // Reset auto-resume timer on every interaction
            if (StormState.state.gpsFollow.active) {
                _scheduleGPSResume();
            }
        });

        function toggleGPSFollow() {
            const gps = StormState.state.gpsFollow;
            if (gps.active) {
                if (gps.paused) {
                    // If paused, first click recenters
                    gps.paused = false;
                    _showGPSPaused(false);
                    _updateGPSBtn();
                    // Recenter immediately
                    if (gps.lat != null) {
                        const map = StormMap.getMap();
                        if (map) map.setView([gps.lat, gps.lon], map.getZoom(), { animate: true });
                    }
                } else {
                    // If active and not paused, deactivate
                    deactivateGPSFollow();
                }
            } else {
                activateGPSFollow();
            }
        }

        async function activateGPSFollow() {
            const btn = document.getElementById("btn-my-location");
            if (!navigator.geolocation) {
                if (btn) { btn.textContent = "!"; setTimeout(() => { btn.textContent = "\u2299"; }, 2000); }
                return;
            }
            if (btn) btn.textContent = "...";

            // Turn off AT — GPS takes camera priority
            if (StormState.state.autotrack.mode !== "off") {
                StormState.setAutoTrackMode("off");
            }

            const gps = StormState.state.gpsFollow;
            gps.active = true;
            gps.paused = false;
            gpsInitDone = false;

            Camera.claim("gps", "user activated GPS follow");
            // Toast now triggered by cameraOwnerChanged event

            gpsWatchId = navigator.geolocation.watchPosition(
                onGPSUpdate, onGPSError,
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
            );
            _showGPSPaused(false);
            _updateGPSBtn();
        }

        function deactivateGPSFollow() {
            const gps = StormState.state.gpsFollow;
            gps.active = false;
            gps.paused = false;

            if (gpsWatchId !== null) {
                navigator.geolocation.clearWatch(gpsWatchId);
                gpsWatchId = null;
            }
            if (gpsResumeTimer) { clearTimeout(gpsResumeTimer); gpsResumeTimer = null; }

            Camera.release("gps");

            const map = StormMap.getMap();
            if (map) {
                if (gpsMarker) { map.removeLayer(gpsMarker); gpsMarker = null; }
                if (gpsCircle) { map.removeLayer(gpsCircle); gpsCircle = null; }
            }

            _showGPSPaused(false);
            _updateGPSBtn();
        }

        async function onGPSUpdate(pos) {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            const acc = pos.coords.accuracy;

            const gps = StormState.state.gpsFollow;
            gps.lat = lat;
            gps.lon = lon;
            gps.accuracy = acc;
            gps.lastUpdate = Date.now();

            StormState.setLocation(lat, lon, "gps", `${lat.toFixed(4)}, ${lon.toFixed(4)}`);

            const map = StormMap.getMap();
            if (!map) return;

            // Blue dot
            if (!gpsMarker) {
                gpsMarker = L.circleMarker([lat, lon], {
                    radius: 7, color: "#3b82f6", fillColor: "#3b82f6",
                    fillOpacity: 0.9, weight: 2, opacity: 1, className: "gps-dot",
                }).addTo(map);
            } else {
                gpsMarker.setLatLng([lat, lon]);
            }

            // Accuracy circle
            if (acc && acc < 500) {
                if (!gpsCircle) {
                    gpsCircle = L.circle([lat, lon], {
                        radius: acc, color: "#3b82f6", fillColor: "#3b82f6",
                        fillOpacity: 0.06, weight: 1, opacity: 0.2, interactive: false,
                    }).addTo(map);
                } else {
                    gpsCircle.setLatLng([lat, lon]);
                    gpsCircle.setRadius(acc);
                }
            } else if (gpsCircle) {
                map.removeLayer(gpsCircle);
                gpsCircle = null;
            }

            // Center map unless paused or pulse active
            if (!gps.paused && !StormState.state.camera.contextPulseActive) {
                Camera.move({ source: "gps", center: [lat, lon], animate: false, reason: "gps_update" });
            }

            // First fix: enable layers
            if (!gpsInitDone) {
                gpsInitDone = true;
                await _enableGPSLayers(lat, lon);
            }

            _updateGPSBtn();
        }

        function onGPSError(err) {
            console.warn("[GPS] Error:", err.message);
            const btn = document.getElementById("btn-my-location");
            if (btn) {
                btn.textContent = "!";
                btn.title = "GPS error: " + err.message;
                setTimeout(() => _updateGPSBtn(), 3000);
            }
        }

        async function _enableGPSLayers(lat, lon) {
            if (!StormState.state.radar.activeLayers.includes("reflectivity")) {
                const refBtn = document.getElementById("btn-radar-toggle");
                if (refBtn && !refBtn.classList.contains("active")) refBtn.click();
            }
            try {
                const resp = await fetch(`/api/radar/nexrad/nearest?lat=${lat}&lon=${lon}&count=1`);
                if (resp.ok) {
                    const data = await resp.json();
                    const sites = data.sites || [];
                    if (sites.length > 0) {
                        await fetch(`/api/radar/nexrad/select?site_id=${sites[0].site_id}`, { method: "POST" });
                        const sel = document.getElementById("radar-site-selector");
                        if (sel) sel.value = sites[0].site_id;
                    }
                }
            } catch (e) { /* ok */ }
            await RadarManager.enableSRV();
            await RadarManager.enableCC();
            if (!StormState.state.audioFollow.enabled) AudioFollow.toggleEnabled();
            if (!StormState.state.switchSound.enabled) ATSwitchSound.toggleEnabled();
            SPCOverlay.loadWatches();
        }

        function _scheduleGPSResume() {
            if (gpsResumeTimer) clearTimeout(gpsResumeTimer);
            gpsResumeTimer = setTimeout(() => {
                gpsResumeTimer = null;
                const gps = StormState.state.gpsFollow;
                if (gps.active && gps.paused) {
                    gps.paused = false;
                    _showGPSPaused(false);
                    _updateGPSBtn();
                    // Recenter
                    if (gps.lat != null) {
                        const map = StormMap.getMap();
                        if (map) map.setView([gps.lat, gps.lon], map.getZoom(), { animate: true });
                    }
                }
            }, GPS_AUTO_RESUME_MS);
        }

        function _showGPSPaused(show) {
            const el = document.getElementById("gps-paused-indicator");
            if (el) {
                el.classList.toggle("visible", show);
                el.classList.toggle("hidden", !show);
            }
        }

        function _updateGPSBtn() {
            const btn = document.getElementById("btn-my-location");
            if (!btn) return;
            const gps = StormState.state.gpsFollow;
            if (gps.active) {
                btn.classList.add("gps-active");
                btn.textContent = gps.paused ? "\u25CE" : "\u2299";
                btn.title = gps.paused
                    ? "GPS paused (panned) — click to recenter"
                    : "GPS follow active — click to deactivate";
            } else {
                btn.classList.remove("gps-active");
                btn.textContent = "\u2299";
                btn.title = "Center on my location + enable features";
            }
        }

        // ── Mode Toast ──────────────────────────────────────────
        let toastTimer = null;
        function showModeToast(text) {
            const el = document.getElementById("mode-toast");
            if (!el) return;
            if (toastTimer) clearTimeout(toastTimer);
            el.textContent = text;
            el.classList.remove("hidden");
            // Force reflow then show
            void el.offsetWidth;
            el.classList.add("visible");
            toastTimer = setTimeout(() => {
                el.classList.remove("visible");
                setTimeout(() => el.classList.add("hidden"), 300);
                toastTimer = null;
            }, 1800);
        }

        // ── Camera ownership toast + indicator ────────────────
        const CAMERA_MESSAGES = {
            gps: "Following your location",
            autotrack: "Tracking storm",
            pulse: "Showing wider context",
        };

        StormState.on("cameraOwnerChanged", (data) => {
            // Toast for meaningful transitions (not idle→idle or pulse suppressed)
            const msg = CAMERA_MESSAGES[data.to];
            if (msg) showModeToast(msg);

            // Update subtle indicator
            const ind = document.getElementById("camera-indicator");
            if (ind) {
                if (data.to === "idle") {
                    ind.classList.add("hidden");
                } else {
                    const label = { gps: "GPS", autotrack: "AT", pulse: "CTX" }[data.to] || data.to;
                    ind.textContent = label;
                    ind.className = "camera-indicator cam-" + data.to;
                }
            }
        });

        // Remove existing manual toasts from GPS/AT handlers (now handled by camera events)
        // The old showModeToast calls in activateGPSFollow and autotrackChanged
        // are still there but harmless — the camera event fires first and the
        // debounce in _emitChange prevents duplicates.

        // 3. Resolve location
        await StormLocation.resolve();

        // 4. Mode badge
        StormState.on("modeChanged", (mode) => {
            const badge = document.getElementById("mode-badge");
            badge.textContent = mode.toUpperCase();
            badge.className = `badge badge-${mode}`;
        });

        // 5. Start freshness monitoring
        updateFreshness();
        freshnessTimer = setInterval(updateFreshness, FRESHNESS_POLL_INTERVAL);

        // 6. Offline detection
        window.addEventListener("online", () => setOffline(false));
        window.addEventListener("offline", () => setOffline(true));

        console.log("[StormTracker] Ready");
    });

    let lastWatchdogStatus = "ok";

    async function updateFreshness() {
        try {
            const resp = await fetch("/api/health");
            if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`);
            const data = await resp.json();

            if (isOffline) setOffline(false);

            if (data.nws_last_poll) {
                lastPollTime = new Date(data.nws_last_poll);
            }

            renderFreshnessIndicator();
            renderStalenessWarning();

            // Also check watchdog via deep health (less frequent)
            checkWatchdog();
        } catch (e) {
            setOffline(true);
            renderStalenessWarning();
        }
    }

    async function checkWatchdog() {
        try {
            const resp = await fetch("/api/health/deep");
            if (!resp.ok) return;
            const data = await resp.json();
            const wd = data.subsystems?.alert_watchdog;
            if (!wd) return;

            const banner = document.getElementById("staleness-banner");
            if (!banner) return;

            if (wd.status === "failed") {
                banner.textContent = "Alert updates unavailable \u2014 showing last known data";
                banner.className = "staleness-banner stale-critical";
                banner.classList.remove("hidden");
                lastWatchdogStatus = "failed";
            } else if (wd.status === "stale" || wd.status === "degraded") {
                banner.textContent = "Alert data may be stale";
                banner.className = "staleness-banner stale-warn";
                banner.classList.remove("hidden");
                lastWatchdogStatus = wd.status;
            } else if (lastWatchdogStatus !== "ok") {
                // Recovered — hide banner
                banner.classList.add("hidden");
                lastWatchdogStatus = "ok";
            }
        } catch (e) { /* silent */ }
    }

    function renderFreshnessIndicator() {
        const el = document.getElementById("data-freshness");
        if (!el) return;

        if (!lastPollTime) {
            el.textContent = "Alerts: waiting...";
            return;
        }

        const ageSec = Math.floor((Date.now() - lastPollTime.getTime()) / 1000);
        if (ageSec < 60) {
            el.textContent = `Alerts: ${ageSec}s ago`;
        } else {
            el.textContent = `Alerts: ${Math.floor(ageSec / 60)}m ago`;
        }
    }

    function renderStalenessWarning() {
        const banner = document.getElementById("staleness-banner");
        if (!banner) return;

        if (isOffline) {
            banner.textContent = "OFFLINE — showing cached data";
            banner.className = "staleness-banner stale-critical";
            banner.classList.remove("hidden");
            return;
        }

        if (!lastPollTime) {
            banner.classList.add("hidden");
            return;
        }

        const ageSec = Math.floor((Date.now() - lastPollTime.getTime()) / 1000);

        if (ageSec > STALE_CRIT_SECONDS) {
            banner.textContent = `Alert data is stale (${Math.floor(ageSec / 60)}m old) — check connection`;
            banner.className = "staleness-banner stale-critical";
            banner.classList.remove("hidden");
        } else if (ageSec > STALE_WARN_SECONDS) {
            banner.textContent = `Alert data may be stale (${Math.floor(ageSec / 60)}m old)`;
            banner.className = "staleness-banner stale-warn";
            banner.classList.remove("hidden");
        } else {
            banner.classList.add("hidden");
        }
    }

    function setOffline(offline) {
        isOffline = offline;
        const indicator = document.getElementById("offline-indicator");
        if (indicator) {
            indicator.classList.toggle("hidden", !offline);
        }
        renderStalenessWarning();
    }
})();

