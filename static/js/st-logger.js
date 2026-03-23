/**
 * Storm Tracker — Frontend Structured Logger
 *
 * Replaces scattered console.log with structured, leveled logging.
 * Ships meaningful events to backend via POST /api/logs/client.
 * Captures uncaught errors and unhandled rejections.
 *
 * Usage:
 *   const log = STLogger.for("autotrack");
 *   log.info("target_locked", { alertId: "abc", score: 85 });
 *   log.warn("source_unavailable", { source: "noaa" });
 *   log.error("api_fetch_failed", { url: "/api/alerts", status: 502 });
 */
const STLogger = (function () {

    const SHIP_LEVELS = { warn: true, error: true };  // Only ship warn+ by default
    const SHIP_EVENTS = new Set([
        "frontend_api_error",
        "frontend_panel_state_changed",
        "primary_alert_changed",
        "autotrack_target_locked",
        "autotrack_suppressed",
        "audio_source_changed",
        "audio_source_unavailable",
        "radar_site_changed",
        "radar_mode_changed",
        "notification_fired",
        "notification_suppressed",
        "uncaught_error",
        "unhandled_rejection",
    ]);

    const THROTTLE_MS = 5000;  // Min interval between identical event ships
    const _lastShip = {};       // event → timestamp

    function init() {
        // Capture uncaught errors
        window.addEventListener("error", (e) => {
            _ship("error", "global", "uncaught_error", e.message, {
                filename: e.filename,
                line: e.lineno,
                col: e.colno,
            });
        });

        // Capture unhandled promise rejections
        window.addEventListener("unhandledrejection", (e) => {
            const reason = e.reason ? (e.reason.message || String(e.reason)) : "unknown";
            _ship("error", "global", "unhandled_rejection", reason, {});
        });
    }

    /**
     * Create a module-scoped logger.
     * @param {string} moduleName - e.g. "autotrack", "audio", "radar"
     * @returns {{ debug, info, warn, error }}
     */
    function forModule(moduleName) {
        return {
            debug: (event, extra) => _log("debug", moduleName, event, extra),
            info:  (event, extra) => _log("info",  moduleName, event, extra),
            warn:  (event, extra) => _log("warn",  moduleName, event, extra),
            error: (event, extra) => _log("error", moduleName, event, extra),
        };
    }

    function _log(level, module, event, extra) {
        const msg = `[${module}] ${event}`;

        // Always log to console
        const consoleFn = level === "error" ? console.error
            : level === "warn" ? console.warn
            : level === "debug" ? console.debug
            : console.log;
        if (extra) {
            consoleFn(msg, extra);
        } else {
            consoleFn(msg);
        }

        // Ship to backend if qualifies
        if (SHIP_LEVELS[level] || SHIP_EVENTS.has(event)) {
            _ship(level, module, event, event, extra || {});
        }
    }

    function _ship(level, module, event, message, extra) {
        // Throttle identical events
        const key = `${module}:${event}`;
        const now = Date.now();
        if (_lastShip[key] && now - _lastShip[key] < THROTTLE_MS) {
            return;
        }
        _lastShip[key] = now;

        // Prune throttle cache
        if (Object.keys(_lastShip).length > 100) {
            const cutoff = now - THROTTLE_MS * 2;
            for (const k in _lastShip) {
                if (_lastShip[k] < cutoff) delete _lastShip[k];
            }
        }

        // Fire-and-forget POST
        try {
            fetch("/api/logs/client", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    level,
                    module,
                    event,
                    message: String(message).slice(0, 500),
                    extra: extra || {},
                }),
            }).catch(() => {});  // Silent on network failure
        } catch (e) {
            // Never break app flow
        }
    }

    return { init, for: forModule };
})();
