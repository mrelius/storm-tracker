/**
 * Storm Tracker — Main Application Controller
 * Wires all modules together and bootstraps the app.
 * Manages data freshness, staleness warnings, and offline detection.
 */
(function () {
    const FRESHNESS_POLL_INTERVAL = 15000;  // check every 15s
    const STALE_WARN_SECONDS = 120;         // amber warning at 2 min
    const STALE_CRIT_SECONDS = 300;         // red warning at 5 min

    let lastPollTime = null;
    let freshnessTimer = null;
    let isOffline = false;

    document.addEventListener("DOMContentLoaded", async () => {
        console.log("[StormTracker] Initializing...");

        // 1. Initialize map
        const map = StormMap.init();

        // 2. Initialize subsystems
        RadarManager.init(map);
        AlertRenderer.init(map);
        AlertPanel.init();
        Validation.init(map);

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
        } catch (e) {
            // Fetch failed — likely offline or server down
            setOffline(true);
            renderStalenessWarning();
        }
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
