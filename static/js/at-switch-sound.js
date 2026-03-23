/**
 * Storm Tracker — Auto Track Switch Sound
 *
 * Plays a short notification tone when Auto Track switches from one
 * tracked alert to a different one. Separate from audio-follow streams
 * and from the existing storm-audio alert tones.
 *
 * Rules:
 * - Only fires on true target ID changes, not same-alert metadata refreshes
 * - Silent on first acquisition (no previous target)
 * - 8s cooldown between sounds to prevent churn spam
 * - Immediate sound (bypass cooldown) when new target is materially higher
 *   priority (e.g. tornado replacing severe thunderstorm)
 * - Reuses browser AudioContext unlock from StormAudio
 * - User-toggleable via setting, persisted in session
 */
const ATSwitchSound = (function () {

    const COOLDOWN_MS = 8000;
    const TONE_FREQ_LOW  = 660;   // first tone
    const TONE_FREQ_HIGH = 880;   // second tone (rising = new target)
    const TONE_DURATION  = 0.15;
    const TONE_GAP       = 0.08;
    const TONE_VOLUME    = 0.25;

    // Event priority for "materially higher" check
    const EVENT_PRIORITY = {
        "Tornado Warning": 100,
        "Severe Thunderstorm Warning": 60,
        "Tornado Watch": 40,
        "Flash Flood Warning": 30,
        "Flood Warning": 20,
        "Winter Storm Warning": 10,
    };
    const PRIORITY_JUMP_THRESHOLD = 30;  // must jump by this much to bypass cooldown

    let audioCtx = null;
    let previousTargetId = null;
    let previousTargetEvent = null;
    let hasHadTarget = false;  // tracks whether we've ever had a target this session

    // ── Init ────────────────────────────────────────────────────────────

    function init() {
        // Toggle button
        const btn = document.getElementById("btn-switch-sound-toggle");
        if (btn) {
            btn.addEventListener("click", toggleEnabled);
            updateToggleUI();
        }

        // Listen for target changes and mode changes
        StormState.on("autotrackTargetChanged", onTargetChanged);
        StormState.on("autotrackChanged", onModeChanged);

        // Unlock audio on every user interaction (not once — session restore
        // can consume once-listeners before a real gesture occurs)
        document.addEventListener("click", ensureAudioCtx);
        document.addEventListener("keydown", ensureAudioCtx);
    }

    function toggleEnabled() {
        const ss = StormState.state.switchSound;
        ss.enabled = !ss.enabled;
        updateToggleUI();
        StormState.emit("switchSoundChanged", { enabled: ss.enabled });
    }

    function updateToggleUI() {
        const btn = document.getElementById("btn-switch-sound-toggle");
        if (!btn) return;
        const on = StormState.state.switchSound.enabled;
        btn.textContent = on ? "SW" : "SW";
        btn.title = on ? "Switch sound: ON (click to mute)" : "Switch sound: OFF (click to enable)";
        btn.classList.toggle("sw-sound-on", on);
        btn.classList.toggle("sw-sound-off", !on);
    }

    function onModeChanged(data) {
        if (data.mode === "off") {
            reset();
        }
    }

    // ── Target Change Handler ───────────────────────────────────────────

    function onTargetChanged(targetId) {
        const ss = StormState.state.switchSound;
        const at = StormState.state.autotrack;

        // No target — just record state
        if (!targetId) {
            // Don't reset previousTargetId — we need it for the next acquisition
            return;
        }

        // Same target — no-op
        if (targetId === previousTargetId) return;

        const prevId = previousTargetId;
        const prevEvent = previousTargetEvent;

        // Update tracking state
        previousTargetId = targetId;
        previousTargetEvent = at.targetEvent;
        ss.lastSwitchFromId = prevId;
        ss.lastSwitchToId = targetId;

        // First acquisition — silent
        if (!hasHadTarget) {
            hasHadTarget = true;
            ss.suppressed = true;
            ss.suppressReason = "first_acquisition";
            emitDebug();
            return;
        }

        // If previous was null (target was lost then re-acquired), also treat as first
        if (!prevId) {
            ss.suppressed = true;
            ss.suppressReason = "first_acquisition";
            emitDebug();
            return;
        }

        // Enabled check
        if (!ss.enabled) {
            ss.suppressed = true;
            ss.suppressReason = "disabled";
            emitDebug();
            return;
        }

        // Priority jump check — tornado replacing SVR can bypass cooldown
        const newPriority = EVENT_PRIORITY[at.targetEvent] || 0;
        const oldPriority = EVENT_PRIORITY[prevEvent] || 0;
        const priorityJump = newPriority - oldPriority >= PRIORITY_JUMP_THRESHOLD;

        // Cooldown check
        const now = Date.now();
        const cooldownActive = (now - ss.lastSoundTime) < COOLDOWN_MS;

        if (cooldownActive && !priorityJump) {
            ss.suppressed = true;
            ss.suppressReason = "cooldown";
            emitDebug();
            return;
        }

        // Play the switch sound
        ss.suppressed = false;
        ss.suppressReason = null;
        ss.lastSoundTime = now;
        playSwitch(priorityJump);
        emitDebug();
    }

    // ── Audio Playback ──────────────────────────────────────────────────

    function ensureAudioCtx() {
        if (!audioCtx) {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) { /* silent */ }
        }
        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume();
        }
    }

    function playSwitch(isUrgent) {
        ensureAudioCtx();
        if (!audioCtx) return;

        try {
            const t = audioCtx.currentTime;

            // Two-tone rising chirp
            const freq1 = isUrgent ? TONE_FREQ_HIGH : TONE_FREQ_LOW;
            const freq2 = TONE_FREQ_HIGH;

            // First tone
            const osc1 = audioCtx.createOscillator();
            const gain1 = audioCtx.createGain();
            osc1.type = "sine";
            osc1.frequency.value = freq1;
            gain1.gain.setValueAtTime(TONE_VOLUME, t);
            gain1.gain.exponentialRampToValueAtTime(0.01, t + TONE_DURATION);
            osc1.connect(gain1);
            gain1.connect(audioCtx.destination);
            osc1.start(t);
            osc1.stop(t + TONE_DURATION);

            // Second tone (higher)
            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.type = "sine";
            osc2.frequency.value = freq2;
            gain2.gain.setValueAtTime(TONE_VOLUME, t + TONE_DURATION + TONE_GAP);
            gain2.gain.exponentialRampToValueAtTime(0.01, t + TONE_DURATION * 2 + TONE_GAP);
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.start(t + TONE_DURATION + TONE_GAP);
            osc2.stop(t + TONE_DURATION * 2 + TONE_GAP);
        } catch (e) {
            // Silent fail
        }
    }

    // ── Debug State ─────────────────────────────────────────────────────

    function getDebugState() {
        const ss = StormState.state.switchSound;
        const now = Date.now();
        const cooldownRemain = ss.lastSoundTime
            ? Math.max(0, Math.ceil((COOLDOWN_MS - (now - ss.lastSoundTime)) / 1000))
            : 0;

        return {
            enabled: ss.enabled,
            currentTargetId: previousTargetId ? previousTargetId.slice(-12) : null,
            previousTargetId: ss.lastSwitchFromId ? ss.lastSwitchFromId.slice(-12) : null,
            lastSoundTime: ss.lastSoundTime || null,
            lastSoundAge: ss.lastSoundTime ? Math.round((now - ss.lastSoundTime) / 1000) + "s" : null,
            cooldownRemain,
            suppressed: ss.suppressed,
            suppressReason: ss.suppressReason,
        };
    }

    function emitDebug() {
        // Trigger autotrack debug refresh so our section updates
        if (typeof AutoTrack !== "undefined") {
            StormState.emit("autotrackDebug", AutoTrack.getDebugState());
        }
    }

    // ── Reset (called on mode off) ──────────────────────────────────────

    function reset() {
        previousTargetId = null;
        previousTargetEvent = null;
        hasHadTarget = false;
        const ss = StormState.state.switchSound;
        ss.lastSwitchFromId = null;
        ss.lastSwitchToId = null;
        ss.suppressed = false;
        ss.suppressReason = null;
    }

    // ── Public API ──────────────────────────────────────────────────────

    return { init, getDebugState, reset, toggleEnabled };
})();
