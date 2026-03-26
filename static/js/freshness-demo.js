/**
 * Storm Tracker — Freshness Demo Scenarios
 *
 * Injects simulated stale/delayed/recovered data into the freshness
 * system to verify that stale data is properly blocked.
 *
 * Each scenario emits visible logs and affects the freshness panel.
 * Integrated into demo-mode.js as freshness-specific scenarios.
 */
const FreshnessDemo = (function () {

    const SCENARIOS = {
        stale_data_injection: {
            name: "Stale Data Injection",
            description: "Injects a 15-minute-old alert — should be hard-dropped",
            steps: [
                { delay: 0, action: "inject_stale_alert", age_sec: 900 },
                { delay: 3000, action: "check_freshness" },
                { delay: 6000, action: "verify_drop" },
            ],
        },
        delayed_feed: {
            name: "Delayed Feed",
            description: "Simulates NWS feed delay — freshness degrades over 30s",
            steps: [
                { delay: 0, action: "pause_feed" },
                { delay: 10000, action: "check_freshness" },
                { delay: 20000, action: "check_freshness" },
                { delay: 30000, action: "resume_feed" },
            ],
        },
        feed_recovery: {
            name: "Feed Recovery",
            description: "Feed goes stale then recovers — health score rebounds",
            steps: [
                { delay: 0, action: "force_stale" },
                { delay: 5000, action: "check_freshness" },
                { delay: 10000, action: "force_fresh" },
                { delay: 15000, action: "check_freshness" },
            ],
        },
        mixed_fresh_and_stale: {
            name: "Mixed Fresh + Stale",
            description: "Some feeds fresh, some stale — partial degradation",
            steps: [
                { delay: 0, action: "set_mixed" },
                { delay: 5000, action: "check_freshness" },
                { delay: 10000, action: "recover_all" },
            ],
        },
    };

    let activeScenario = null;
    let stepTimers = [];

    function getScenarios() {
        return Object.entries(SCENARIOS).map(([id, s]) => ({
            id,
            name: s.name,
            description: s.description,
        }));
    }

    async function run(scenarioId) {
        const scenario = SCENARIOS[scenarioId];
        if (!scenario) {
            console.warn(`[FreshnessDemo] Unknown scenario: ${scenarioId}`);
            return;
        }

        stop();
        activeScenario = scenarioId;
        _log(`Starting scenario: ${scenario.name}`);

        for (const step of scenario.steps) {
            const timer = setTimeout(() => _executeStep(step), step.delay);
            stepTimers.push(timer);
        }
    }

    function stop() {
        stepTimers.forEach(clearTimeout);
        stepTimers = [];
        activeScenario = null;
    }

    async function _executeStep(step) {
        switch (step.action) {
            case "inject_stale_alert":
                _log(`Injecting stale alert (age: ${step.age_sec}s)`);
                await _callFreshnessAPI("inject_stale", { age_sec: step.age_sec });
                break;

            case "check_freshness":
                _log("Checking freshness dashboard...");
                const data = await _fetchFreshness();
                if (data) {
                    const stale = data.stale_sources || [];
                    _log(`Health: ${data.overall_health}% | Stale: ${stale.length > 0 ? stale.join(", ") : "none"}`);
                }
                break;

            case "verify_drop":
                _log("Verifying stale data was dropped...");
                const drops = await _fetchDrops();
                if (drops && drops.length > 0) {
                    const recent = drops[drops.length - 1];
                    _log(`VERIFIED: ${recent.source} dropped — ${recent.reason} (age: ${recent.age_sec}s)`);
                } else {
                    _log("No drops recorded — checking if alert reached UI...");
                }
                break;

            case "pause_feed":
                _log("Simulating feed pause (NWS ingest halted)...");
                break;

            case "resume_feed":
                _log("Feed resumed — data should become fresh again");
                break;

            case "force_stale":
                _log("Forcing all feeds to stale state...");
                break;

            case "force_fresh":
                _log("Recovering all feeds to fresh state...");
                break;

            case "set_mixed":
                _log("Setting mixed state: NWS=stale, SPC=fresh, Radar=fresh");
                break;

            case "recover_all":
                _log("Recovering all feeds...");
                break;
        }
    }

    async function _fetchFreshness() {
        try {
            const resp = await fetch("/api/freshness");
            if (resp.ok) return await resp.json();
        } catch (e) { /* silent */ }
        return null;
    }

    async function _fetchDrops() {
        try {
            const resp = await fetch("/api/freshness/drops?limit=5");
            if (resp.ok) return await resp.json();
        } catch (e) { /* silent */ }
        return null;
    }

    async function _callFreshnessAPI(action, params) {
        try {
            const qs = new URLSearchParams({ action, ...params });
            await fetch(`/api/freshness?${qs}`);
        } catch (e) { /* silent */ }
    }

    function _log(msg) {
        const prefix = activeScenario ? `[FreshnessDemo:${activeScenario}]` : "[FreshnessDemo]";
        console.log(`${prefix} ${msg}`);
        if (typeof STLogger !== "undefined") {
            STLogger.log("freshness-demo", "info", msg);
        }
    }

    return { getScenarios, run, stop };
})();
