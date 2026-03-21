/**
 * Storm Tracker — Browser Notification Module
 *
 * Single source of truth: BACKEND decides whether to notify.
 * Frontend only consumes backend-approved notification payloads.
 *
 * Backend sends notification decision in WS lifecycle events:
 *   { type: "created"|"escalated", alert: {...}, notification: {title, body, ...} }
 *
 * Frontend role:
 * - Display browser notification from backend-approved payload
 * - Avoid duplicate browser notifications for same event
 * - Handle permission and opt-in state
 */
const StormNotify = (function () {
    const STORAGE_KEY = "storm_notify_enabled";
    const DEDUP_WINDOW_MS = 10000;  // ignore duplicate payloads within 10s

    let lastNotifyKey = "";
    let lastNotifyTime = 0;

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
        return stored === "true";
    }

    async function onToggleClick() {
        if (!isSupported()) return;

        if (isEnabled()) {
            localStorage.setItem(STORAGE_KEY, "false");
        } else {
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
            btn.textContent = "\u2298";
            btn.title = "Browser notifications not supported";
            btn.classList.add("notify-unsupported");
            return;
        }

        if (isPermissionDenied()) {
            btn.textContent = "\u2298";
            btn.title = "Notifications blocked by browser \u2014 check site permissions";
            btn.classList.add("notify-denied");
            return;
        }

        const on = isEnabled();
        btn.textContent = on ? "\uD83D\uDD14" : "\uD83D\uDD07";
        btn.title = on
            ? "Browser notifications: ON (click to disable)"
            : "Browser notifications: OFF (click to enable)";
        btn.classList.toggle("notify-on", on);
        btn.classList.toggle("notify-off", !on);
        btn.classList.remove("notify-unsupported", "notify-denied");
    }

    /**
     * Evaluate a WebSocket lifecycle event.
     * Backend is source of truth — only show notification if backend included payload.
     *
     * @param {string} eventType - "created" or "escalated"
     * @param {object} alert - the alert object
     * @param {object} notification - backend notification payload (may be undefined)
     */
    function evaluate(eventType, alert, notification) {
        if (!notification) return;  // backend did not approve notification
        if (!alert || !alert.alert_id) return;
        if (eventType !== "created" && eventType !== "escalated") return;
        if (!isEnabled() || !isPermissionGranted()) return;

        // Dedup: same alert_id + event_type within window
        const key = `${alert.alert_id}:${eventType}`;
        const now = Date.now();
        if (key === lastNotifyKey && (now - lastNotifyTime) < DEDUP_WINDOW_MS) return;
        lastNotifyKey = key;
        lastNotifyTime = now;

        showNotification(notification, alert);
    }

    function showNotification(payload, alert) {
        try {
            const title = payload.title || "Storm Alert";
            const body = payload.body || payload.summary || "Storm alert detected.";

            const notification = new Notification(title, {
                body: body,
                tag: alert.alert_id,
                requireInteraction: (payload.action_state === "take_action"),
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
        // No-op — dedup is time-based, no unbounded state
    }

    return { init, evaluate, cleanup, isEnabled, isSupported };
})();
