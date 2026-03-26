/**
 * Storm Tracker — Audio Test Mode (Phase 1)
 *
 * Validates audio playback without requiring real alerts.
 * Scenarios: NOAA_STREAM, TEST_TONE
 * Max runtime: 2 minutes. Preempted by real alert audio.
 */
const AudioTest = (function () {

    const MAX_RUNTIME_MS = 120000;
    const PREEMPT_CHECK_MS = 1000;

    let state = {
        enabled: false,
        running: false,
        scenario: null,
        playbackState: "idle",
        currentSource: null,
        lastError: null,
        startedAt: null,
        muted: false,
        volume: 1.0,
    };

    let audioEl = null;
    let maxTimer = null;
    let preemptTimer = null;
    let log = null;

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("audio_test");

        const toggleBtn = document.getElementById("btn-audio-test-toggle");
        if (toggleBtn) toggleBtn.addEventListener("click", _togglePanel);

        const startBtn = document.getElementById("btn-at-start");
        if (startBtn) startBtn.addEventListener("click", () => {
            const sel = document.getElementById("at-scenario");
            startTest(sel ? sel.value : "TEST_TONE");
        });

        const stopBtn = document.getElementById("btn-at-stop");
        if (stopBtn) stopBtn.addEventListener("click", stopTest);

        const muteBtn = document.getElementById("btn-at-mute");
        if (muteBtn) muteBtn.addEventListener("click", _toggleMute);

        const volSlider = document.getElementById("at-volume");
        if (volSlider) volSlider.addEventListener("input", (e) => {
            state.volume = parseFloat(e.target.value);
            if (audioEl) audioEl.volume = state.muted ? 0 : state.volume;
            _updateUI();
        });
    }

    function _togglePanel() {
        const panel = document.getElementById("audio-test-panel");
        if (panel) {
            state.enabled = !state.enabled;
            panel.classList.toggle("hidden", !state.enabled);
        }
    }

    // ── Core ─────────────────────────────────────────────────────

    function startTest(scenario) {
        if (state.running) stopTest();

        // Check preemption
        if (_isRealAudioActive()) {
            state.lastError = "Real alert audio active — cannot start test";
            _logEvent("audio_test_preempted", { scenario, reason: "real_audio_active" });
            _updateUI();
            return;
        }

        state.running = true;
        state.scenario = scenario;
        state.playbackState = "loading";
        state.lastError = null;
        state.startedAt = Date.now();

        _logEvent("audio_test_started", { scenario });

        // Create dedicated audio element (separate from audio-follow)
        if (!audioEl) {
            audioEl = document.createElement("audio");
            audioEl.id = "audio-test-player";
            audioEl.preload = "none";
            document.body.appendChild(audioEl);
        }

        audioEl.volume = state.muted ? 0 : state.volume;
        audioEl.muted = state.muted;

        if (scenario === "NOAA_STREAM") {
            _playNOAA();
        } else {
            _playTestTone();
        }

        // Max runtime guard
        maxTimer = setTimeout(() => {
            if (state.running) stopTest();
        }, MAX_RUNTIME_MS);

        // Preemption check
        preemptTimer = setInterval(() => {
            if (_isRealAudioActive() && state.running) {
                stopTest();
                state.lastError = "Preempted by real alert audio";
                _logEvent("audio_test_preempted", { scenario: state.scenario, reason: "real_alert" });
                _updateUI();
            }
        }, PREEMPT_CHECK_MS);

        _updateUI();
    }

    function stopTest() {
        if (audioEl) {
            try {
                audioEl.pause();
                audioEl.removeAttribute("src");
                audioEl.load();
            } catch (e) { /* ok */ }
        }

        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
        if (preemptTimer) { clearInterval(preemptTimer); preemptTimer = null; }

        if (state.running) {
            _logEvent("audio_test_stopped", { scenario: state.scenario, duration_ms: Date.now() - (state.startedAt || 0) });
        }

        state.running = false;
        state.playbackState = "stopped";
        state.currentSource = null;
        _updateUI();
    }

    // ── Playback ─────────────────────────────────────────────────

    function _playNOAA() {
        // Get NOAA URL from existing stream registry
        let url = null;
        if (typeof AudioFollow !== "undefined" && AudioFollow.getDebugState) {
            // Try to get from the stream registry
        }
        // Fallback: use known Broadcastify NOAA URLs
        const noaaUrls = [
            "https://broadcastify.cdnstream1.com/33645",
            "https://broadcastify.cdnstream1.com/22514",
        ];
        url = noaaUrls[0];

        state.currentSource = url;

        audioEl.addEventListener("canplay", _onCanPlay, { once: true });
        audioEl.addEventListener("error", _onError, { once: true });

        audioEl.src = url;
        audioEl.load();

        try {
            const p = audioEl.play();
            if (p && p.then) {
                p.then(() => {
                    if (state.playbackState === "loading") {
                        state.playbackState = "playing";
                        _logEvent("audio_test_playing", { scenario: "NOAA_STREAM", source: url });
                        _updateUI();
                    }
                }).catch(err => {
                    state.playbackState = "failed";
                    state.lastError = err.name === "NotAllowedError"
                        ? "Autoplay blocked — click page first"
                        : err.message;
                    _logEvent("audio_test_failed", { scenario: "NOAA_STREAM", error: err.message });
                    _updateUI();
                });
            }
        } catch (e) {
            state.playbackState = "failed";
            state.lastError = e.message;
            _updateUI();
        }
    }

    function _playTestTone() {
        state.currentSource = "generated_tone";

        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = "sine";
            osc.frequency.value = 880;
            gain.gain.value = state.muted ? 0 : state.volume * 0.25;

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();

            state.playbackState = "playing";
            _logEvent("audio_test_playing", { scenario: "TEST_TONE", source: "880Hz_sine" });
            _updateUI();

            // Store for stop
            audioEl._toneCtx = ctx;
            audioEl._toneOsc = osc;
            audioEl._toneGain = gain;

            // Auto-stop tone after 15s (tones don't need 2 minutes)
            setTimeout(() => {
                if (state.running && state.scenario === "TEST_TONE") {
                    try { osc.stop(); ctx.close(); } catch (e) { /* ok */ }
                    stopTest();
                }
            }, 15000);
        } catch (e) {
            state.playbackState = "failed";
            state.lastError = e.message;
            _logEvent("audio_test_failed", { scenario: "TEST_TONE", error: e.message });
            _updateUI();
        }
    }

    function _onCanPlay() {
        if (state.playbackState === "loading") {
            state.playbackState = "playing";
            _updateUI();
        }
    }

    function _onError() {
        if (state.running) {
            state.playbackState = "failed";
            state.lastError = audioEl.error ? `Media error code ${audioEl.error.code}` : "Unknown error";
            _logEvent("audio_test_failed", { scenario: state.scenario, error: state.lastError });
            _updateUI();
        }
    }

    // ── Controls ─────────────────────────────────────────────────

    function _toggleMute() {
        state.muted = !state.muted;
        if (audioEl) {
            audioEl.muted = state.muted;
            audioEl.volume = state.muted ? 0 : state.volume;
        }
        // Handle tone gain
        if (audioEl._toneGain) {
            audioEl._toneGain.gain.value = state.muted ? 0 : state.volume * 0.25;
        }
        _updateUI();
    }

    // ── Preemption ───────────────────────────────────────────────

    function _isRealAudioActive() {
        const af = StormState.state.audioFollow;
        return af.enabled && af.status === "live" && af.owner === "auto-follow";
    }

    // ── UI ────────────────────────────────────────────────────────

    function _updateUI() {
        const statusEl = document.getElementById("at-playback-state");
        const sourceEl = document.getElementById("at-current-source");
        const errorEl = document.getElementById("at-last-error");
        const muteBtn = document.getElementById("btn-at-mute");
        const startBtn = document.getElementById("btn-at-start");
        const stopBtn = document.getElementById("btn-at-stop");

        if (statusEl) {
            const cls = { idle: "", loading: "at-loading", playing: "at-playing", failed: "at-failed", stopped: "" };
            statusEl.textContent = state.playbackState;
            statusEl.className = "at-status-value " + (cls[state.playbackState] || "");
        }
        if (sourceEl) sourceEl.textContent = state.currentSource || "—";
        if (errorEl) {
            errorEl.textContent = state.lastError || "—";
            errorEl.classList.toggle("at-error-active", !!state.lastError);
        }
        if (muteBtn) muteBtn.textContent = state.muted ? "Unmute" : "Mute";
        if (startBtn) startBtn.disabled = state.running;
        if (stopBtn) stopBtn.disabled = !state.running;

        // PASS/FAIL indicators
        const passStart = document.getElementById("at-v-started");
        const passStopped = document.getElementById("at-v-stopped");
        if (passStart) {
            passStart.textContent = state.playbackState === "playing" ? "PASS" : state.playbackState === "failed" ? "FAIL" : "—";
            passStart.className = "at-v-result " + (state.playbackState === "playing" ? "at-v-pass" : state.playbackState === "failed" ? "at-v-fail" : "");
        }
        if (passStopped) {
            passStopped.textContent = state.playbackState === "stopped" ? "PASS" : "—";
            passStopped.className = "at-v-result " + (state.playbackState === "stopped" ? "at-v-pass" : "");
        }
    }

    function _logEvent(event, data) {
        if (log) log.info(event, { ...data, timestamp: Date.now() });
    }

    function getState() { return { ...state }; }

    function destroy() {
        stopTest();
        if (audioEl) { audioEl.remove(); audioEl = null; }
    }

    return { init, startTest, stopTest, getState, destroy };
})();
