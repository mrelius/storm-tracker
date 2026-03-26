/**
 * Storm Tracker — Session Persistence & Auto-Refresh
 *
 * Persists UI state to localStorage and restores on load.
 * Schedules hourly page reload with random jitter (±5 min) to pick up
 * code updates and clear stale browser state.
 *
 * Persisted state:
 * - autotrack mode (off/track/interrogate)
 * - radar site (manual override or auto)
 * - SRV/CC active state
 * - map center + zoom
 * - manual override flags (radarPaused)
 *
 * Additive only. If localStorage is empty or corrupt, app starts fresh.
 */
const SessionPersist = (function () {

    const STORAGE_KEY = "storm_tracker_session";
    const RELOAD_BASE_MS = 60 * 60 * 1000;     // 1 hour
    const RELOAD_JITTER_MS = 5 * 60 * 1000;    // ±5 min
    const SAVE_DEBOUNCE_MS = 2000;

    let saveTimer = null;
    let reloadTimer = null;

    // ── Init ──────────────────────────────────────────────────────────

    function init() {
        // Schedule periodic save
        StormState.on("autotrackChanged", debounceSave);
        StormState.on("layerChanged", debounceSave);
        StormState.on("audioFollowChanged", debounceSave);
        StormState.on("switchSoundChanged", debounceSave);

        // Save map position on move (debounced by save timer)
        const map = StormMap.getMap();
        if (map) {
            map.on("moveend", debounceSave);
        }

        // Schedule hourly reload
        scheduleReload();
    }

    // ── Restore ───────────────────────────────────────────────────────

    /**
     * Restore persisted state. Called BEFORE autotrack init.
     * Returns the saved state or null if nothing to restore.
     */
    function restore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;

            const saved = JSON.parse(raw);
            if (!saved || typeof saved !== "object") return null;

            // Validate age — discard if older than 2 hours (stale across restarts)
            if (saved._savedAt && (Date.now() - saved._savedAt > 2 * 60 * 60 * 1000)) {
                localStorage.removeItem(STORAGE_KEY);
                return null;
            }

            return saved;
        } catch (e) {
            localStorage.removeItem(STORAGE_KEY);
            return null;
        }
    }

    /**
     * Apply restored state to the app.
     * Called after map + subsystems are initialized but before location resolve.
     */
    function applyRestore(saved) {
        if (!saved) return;

        // Restore map position
        if (saved.mapCenter && saved.mapZoom) {
            if (typeof Camera !== "undefined") {
                Camera.move({ source: "idle", center: [saved.mapCenter.lat, saved.mapCenter.lng], zoom: saved.mapZoom, animate: false, reason: "session_restore" });
            } else {
                const map = StormMap.getMap();
                if (map) {
                    map.setView([saved.mapCenter.lat, saved.mapCenter.lng], saved.mapZoom, { animate: false });
                }
            }
        }

        // Restore radar site (manual override)
        if (saved.radarSiteManual) {
            const select = document.getElementById("radar-site-selector");
            if (select) {
                // Set value after sites are populated — defer slightly
                setTimeout(() => {
                    const opt = Array.from(select.options).find(o => o.value === saved.radarSiteManual);
                    if (opt) {
                        select.value = saved.radarSiteManual;
                        select.dispatchEvent(new Event("change"));
                    }
                }, 2000);
            }
        }

        // Restore SRV/CC state
        if (saved.srvActive && !StormState.state.radar.activeLayers.includes("srv")) {
            setTimeout(() => {
                const btn = document.getElementById("btn-srv-toggle");
                if (btn && !btn.classList.contains("active")) btn.click();
            }, 3000);
        }
        if (saved.ccActive && !StormState.state.radar.activeLayers.includes("cc")) {
            setTimeout(() => {
                const btn = document.getElementById("btn-cc-toggle");
                if (btn && !btn.classList.contains("active")) btn.click();
            }, 3500);
        }

        // Restore audio-follow enabled state
        if (saved.audioFollowEnabled != null) {
            StormState.state.audioFollow.enabled = !!saved.audioFollowEnabled;
        }

        // Restore switch sound enabled state
        if (saved.switchSoundEnabled != null) {
            StormState.state.switchSound.enabled = !!saved.switchSoundEnabled;
        }

        // Restore autotrack mode (last — after radar state is set)
        if (saved.autotrackMode && saved.autotrackMode !== "off") {
            setTimeout(() => {
                const current = StormState.state.autotrack.mode;
                if (current === "off") {
                    StormState.setAutoTrackMode(saved.autotrackMode);
                }
            }, 4000);
        }

        console.log("[SessionPersist] Restored:", {
            autotrack: saved.autotrackMode || "off",
            radar: saved.radarSiteManual || "auto",
            srv: saved.srvActive || false,
            cc: saved.ccActive || false,
            audioFollow: saved.audioFollowEnabled || false,
            map: saved.mapCenter ? `${saved.mapCenter.lat.toFixed(2)},${saved.mapCenter.lng.toFixed(2)} z${saved.mapZoom}` : "default",
        });
    }

    // ── Save ──────────────────────────────────────────────────────────

    function debounceSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
    }

    function save() {
        try {
            const map = StormMap.getMap();
            const center = map ? map.getCenter() : null;
            const zoom = map ? map.getZoom() : null;

            const at = StormState.state.autotrack;
            const layers = StormState.state.radar.activeLayers;

            // Check if radar site is manually overridden
            const select = document.getElementById("radar-site-selector");
            const radarVal = select ? select.value : "auto";

            const afState = StormState.state.audioFollow;

            const state = {
                _savedAt: Date.now(),
                autotrackMode: at.mode,
                radarSiteManual: radarVal !== "auto" ? radarVal : null,
                radarPaused: at.radarPaused,
                srvActive: layers.includes("srv"),
                ccActive: layers.includes("cc"),
                mapCenter: center ? { lat: center.lat, lng: center.lng } : null,
                mapZoom: zoom,
                audioFollowEnabled: afState.enabled,
                switchSoundEnabled: StormState.state.switchSound.enabled,
            };

            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            // localStorage may be full or disabled — ignore
        }
    }

    // ── Auto-reload ───────────────────────────────────────────────────

    function scheduleReload() {
        const jitter = (Math.random() * 2 - 1) * RELOAD_JITTER_MS;
        const delay = RELOAD_BASE_MS + jitter;

        reloadTimer = setTimeout(() => {
            // Save state right before reload
            save();
            console.log("[SessionPersist] Hourly reload triggered");
            window.location.reload();
        }, delay);

        const mins = Math.round(delay / 60000);
        console.log(`[SessionPersist] Auto-reload scheduled in ${mins}m`);
    }

    // ── Public API ────────────────────────────────────────────────────

    return { init, restore, applyRestore, save };
})();
