/**
 * Storm Tracker — Audio Notification Module
 * Plays a short alert tone for critical storm alerts (severity 3-4).
 * Triggered ONLY by WebSocket lifecycle events (created/escalated), never by snapshots or polling.
 */
const StormAudio = (function () {
    const STORAGE_KEY = "storm_sound_enabled";
    const COOLDOWN_MS = 15000;
    const TONE_DURATION = 0.4;
    const TONE_FREQ = 880;

    let audioCtx = null;
    let lastPlayTime = 0;
    let seenAlerts = {};  // alertId → lastSeverity
    let autoplayBlocked = false;

    function init() {
        // Restore preference
        const btn = document.getElementById("btn-sound-toggle");
        if (btn) {
            btn.addEventListener("click", toggleSound);
            updateToggleUI();
        }

        // Unlock audio on every user interaction — not { once: true }
        // because programmatic clicks during session restore can consume
        // the listener before a real user gesture occurs
        document.addEventListener("click", unlockAudio);
        document.addEventListener("keydown", unlockAudio);
    }

    function isEnabled() {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored !== "false";  // default ON
    }

    function toggleSound() {
        const current = isEnabled();
        localStorage.setItem(STORAGE_KEY, current ? "false" : "true");
        updateToggleUI();
    }

    function updateToggleUI() {
        const btn = document.getElementById("btn-sound-toggle");
        if (!btn) return;
        const on = isEnabled();
        btn.textContent = on ? "🔔" : "🔕";
        btn.title = on ? "Alert sound: ON (click to mute)" : "Alert sound: OFF (click to enable)";
        btn.classList.toggle("sound-on", on);
        btn.classList.toggle("sound-off", !on);
    }

    function unlockAudio() {
        if (!audioCtx) {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                autoplayBlocked = false;
            } catch (e) {
                // Silent — will retry on next interaction
            }
        }
        // Always try to resume — handles contexts created during non-gesture calls
        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume();
        }
    }

    /**
     * Evaluate a WebSocket lifecycle event and play sound if appropriate.
     * Call this from the WS message handler for "created" and "escalated" events.
     *
     * @param {string} eventType - "created" or "escalated"
     * @param {object} alert - the alert object from the WS message
     */
    function evaluate(eventType, alert) {
        if (!alert || !alert.alert_id) return;
        if (eventType !== "created" && eventType !== "escalated") return;
        if (alert.severity < 3) return;
        if (!isEnabled()) return;

        const alertId = alert.alert_id;
        const prevSeverity = seenAlerts[alertId];

        // Already seen at this or higher severity → no sound
        if (prevSeverity !== undefined && alert.severity <= prevSeverity) return;

        // Record this alert
        seenAlerts[alertId] = alert.severity;

        // Global cooldown
        const now = Date.now();
        if (now - lastPlayTime < COOLDOWN_MS) return;

        // Play
        lastPlayTime = now;
        playTone();
    }

    function playTone() {
        if (!audioCtx) {
            unlockAudio();
        }
        if (!audioCtx) {
            autoplayBlocked = true;
            return;
        }

        try {
            if (audioCtx.state === "suspended") {
                audioCtx.resume();
            }

            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();

            osc.type = "sine";
            osc.frequency.value = TONE_FREQ;
            gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + TONE_DURATION);

            osc.connect(gain);
            gain.connect(audioCtx.destination);

            osc.start();
            osc.stop(audioCtx.currentTime + TONE_DURATION);
        } catch (e) {
            // Silent fail — do not spam console
        }
    }

    /**
     * Clean up old entries periodically (prevent unbounded memory).
     * Called from the storm alert panel on each render cycle.
     */
    function cleanup() {
        const keys = Object.keys(seenAlerts);
        if (keys.length > 200) {
            // Keep only the most recent 100
            const toRemove = keys.slice(0, keys.length - 100);
            toRemove.forEach(k => delete seenAlerts[k]);
        }
    }

    return { init, evaluate, cleanup, isEnabled, toggleSound };
})();
