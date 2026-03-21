/**
 * Storm Tracker — Browser Notification Module
 * Shows browser notifications for critical storm alerts (severity 3-4).
 * Triggered ONLY by WebSocket lifecycle events (created/escalated).
 * Independent from audio — both can fire for the same event.
 */
const StormNotify = (function () {
    const STORAGE_KEY = "storm_notify_enabled";
    const COOLDOWN_MS = 15000;

    let lastNotifyTime = 0;
    let notifiedAlerts = {};  // alertId → lastNotifiedSeverity

    function init() {
        const btn = document.getElementById("btn-notify-toggle");
        if (btn) {
            btn.addEventListener("click", onToggleClick);
            updateToggleUI();
        }
    }

    function isSupported() {
        return "Notification" in window;
    }

    function isPermissionGranted() {
        return isSupported() && Notification.permission === "granted";
    }

    function isPermissionDenied() {
        return isSupported() && Notification.permission === "denied";
    }

    function isEnabled() {
        if (!isSupported()) return false;
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === "true";  // default OFF (conservative — requires explicit opt-in)
    }

    async function onToggleClick() {
        if (!isSupported()) return;

        if (isEnabled()) {
            // Turn off
            localStorage.setItem(STORAGE_KEY, "false");
        } else {
            // Turn on — request permission if needed
            if (Notification.permission === "default") {
                const result = await Notification.requestPermission();
                if (result !== "granted") {
                    updateToggleUI();
                    return;
                }
            }
            if (isPermissionDenied()) {
                updateToggleUI();
                return;
            }
            localStorage.setItem(STORAGE_KEY, "true");
        }
        updateToggleUI();
    }

    function updateToggleUI() {
        const btn = document.getElementById("btn-notify-toggle");
        if (!btn) return;

        if (!isSupported()) {
            btn.textContent = "⊘";
            btn.title = "Browser notifications not supported";
            btn.classList.add("notify-unsupported");
            return;
        }

        if (isPermissionDenied()) {
            btn.textContent = "⊘";
            btn.title = "Notifications blocked by browser — check site permissions";
            btn.classList.add("notify-denied");
            return;
        }

        const on = isEnabled();
        btn.textContent = on ? "📢" : "🔇";
        btn.title = on
            ? "Browser notifications: ON (click to disable)"
            : "Browser notifications: OFF (click to enable)";
        btn.classList.toggle("notify-on", on);
        btn.classList.toggle("notify-off", !on);
        btn.classList.remove("notify-unsupported", "notify-denied");
    }

    /**
     * Evaluate a WebSocket lifecycle event and show notification if appropriate.
     * @param {string} eventType - "created" or "escalated"
     * @param {object} alert - the alert object from the WS message
     */
    function evaluate(eventType, alert) {
        if (!alert || !alert.alert_id) return;
        if (eventType !== "created" && eventType !== "escalated") return;
        if (alert.severity < 3) return;
        if (!isEnabled() || !isPermissionGranted()) return;

        const alertId = alert.alert_id;
        const prevSeverity = notifiedAlerts[alertId];

        // Already notified at this or higher severity
        if (prevSeverity !== undefined && alert.severity <= prevSeverity) return;

        notifiedAlerts[alertId] = alert.severity;

        // Global cooldown
        const now = Date.now();
        if (now - lastNotifyTime < COOLDOWN_MS) return;
        lastNotifyTime = now;

        showNotification(alert);
    }

    function showNotification(alert) {
        try {
            const title = alert.title || "Storm Alert";
            const body = alert.message || "Critical storm alert detected.";

            const notification = new Notification(title, {
                body: body,
                tag: alert.alert_id,  // replaces existing notification with same tag
                requireInteraction: alert.severity >= 4,
                silent: true,  // audio handled separately by StormAudio
            });

            notification.onclick = () => {
                window.focus();
                notification.close();
            };
        } catch (e) {
            // Silent fail
        }
    }

    function cleanup() {
        const keys = Object.keys(notifiedAlerts);
        if (keys.length > 200) {
            const toRemove = keys.slice(0, keys.length - 100);
            toRemove.forEach(k => delete notifiedAlerts[k]);
        }
    }

    return { init, evaluate, cleanup, isEnabled, isSupported };
})();
