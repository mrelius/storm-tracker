/**
 * Storm Tracker — Audio Demo Controller
 *
 * Manages synthetic audio state for demo/verification mode.
 * Never triggers real audio playback. Visual/state-only simulation.
 *
 * Ownership: demo controller owns scenario injection + synthetic state.
 * Runtime audio engine owns real playback. UI selectors use
 * getEffectiveAudioViewModel() to resolve final display state.
 */
const AudioDemoController = (function () {

    const SCENARIO_DEBOUNCE_MS = 100;
    let _debounceTimer = null;
    let _simulationTimers = [];
    let _uiBuilt = false;
    let log = null;

    // ── Init ───────────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("audio_demo");
    }

    // ── Enable / Disable ───────────────────────────────────────────────

    function enableAudioDemo() {
        const da = StormState.state.demoAudio;
        const prevEnabled = da.enabled;
        da.enabled = true;
        da.lastScenarioAppliedAt = null;

        if (log && !prevEnabled) {
            log.info("demo_audio_enabled", {
                event_type: "demo_audio_enabled",
                timestamp: Date.now(),
            });
        }

        _updateStripFromDemo();
    }

    function disableAudioDemo() {
        const da = StormState.state.demoAudio;
        const prevScenario = da.scenarioId;

        _clearAllTimers();
        _resetDemoAudioState();
        da.enabled = false;

        if (log) {
            log.info("demo_audio_disabled", {
                event_type: "demo_audio_disabled",
                scenario_id: prevScenario,
                timestamp: Date.now(),
            });
        }

        _updateStripFromDemo();
    }

    // ── Apply Scenario ─────────────────────────────────────────────────

    function applyAudioScenario(id) {
        if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }

        _debounceTimer = setTimeout(() => {
            _debounceTimer = null;
            _applyScenarioImmediate(id);
        }, SCENARIO_DEBOUNCE_MS);
    }

    function _applyScenarioImmediate(id) {
        const scenario = AudioDemoScenarios.getById(id);
        if (!scenario) return;

        const da = StormState.state.demoAudio;
        const prevState = _snapshotState(da);

        // Clear previous simulation timers
        _clearSimulationTimers();

        // ATOMIC RESET: wipe entire state to clean baseline before applying
        // This guarantees no stale flags (fallback, error, autoTrack, etc.)
        // survive from previous scenario
        da.enabled = true;
        da.scenarioId = null;
        da.playbackState = "idle";
        da.muted = false;
        da.volume = 1.0;
        da.selectedSourceId = null;
        da.selectedSourceType = null;
        da.streamTitle = null;
        da.streamSubtitle = null;
        da.eventId = null;
        da.errorCode = null;
        da.errorMessage = null;
        da.autoTrackBound = false;
        da.fallbackActive = false;
        da.lastScenarioAppliedAt = null;

        // Now apply scenario fields on clean state
        da.scenarioId = id;
        da.playbackState = scenario.state.playbackState || "idle";
        da.muted = scenario.state.muted || false;
        da.volume = scenario.state.volume != null ? scenario.state.volume : 1.0;
        da.selectedSourceId = scenario.state.selectedSourceId || null;
        da.selectedSourceType = scenario.state.selectedSourceType || null;
        da.streamTitle = scenario.state.streamTitle || null;
        da.streamSubtitle = scenario.state.streamSubtitle || null;
        da.eventId = scenario.state.eventId || null;
        da.errorCode = scenario.state.errorCode || null;
        da.errorMessage = scenario.state.errorMessage || null;
        da.autoTrackBound = scenario.state.autoTrackBound || false;
        da.fallbackActive = scenario.state.fallbackActive || false;
        da.lastScenarioAppliedAt = Date.now();

        if (log) {
            log.info("demo_audio_scenario_applied", {
                event_type: "demo_audio_scenario_applied",
                scenario_id: id,
                previous_state: prevState.scenarioId,
                next_state: id,
                timestamp: Date.now(),
            });
        }

        _updateStripFromDemo();
        _updateDemoPanelUI();
    }

    // ── Effective View Model Selector ───────────────────────────────────

    function getEffectiveAudioViewModel() {
        const da = StormState.state.demoAudio;

        if (!da.enabled) {
            return _buildRuntimeVM();
        }

        return {
            source: "demo",
            playbackState: da.playbackState,
            muted: da.muted,
            volume: da.volume,
            sourceType: da.selectedSourceType,
            sourceId: da.selectedSourceId,
            title: da.streamTitle,
            subtitle: da.streamSubtitle,
            eventId: da.eventId,
            error: da.errorMessage,
            errorCode: da.errorCode,
            fallback: da.fallbackActive,
            autoTrack: da.autoTrackBound,
        };
    }

    function _buildRuntimeVM() {
        const af = StormState.state.audioFollow;
        return {
            source: "runtime",
            playbackState: af.enabled ? af.status : "idle",
            muted: false,
            volume: 1.0,
            sourceType: af.currentSource ? _mapSourceType(af.currentSource) : null,
            sourceId: af.currentSource,
            title: af.currentSource ? _sourceLabel(af.currentSource) : null,
            subtitle: af.owner ? `Owner: ${af.owner}` : null,
            eventId: af.targetEvent || null,
            error: af.status === "unavailable" ? "Stream unavailable" : null,
            errorCode: af.status === "unavailable" ? "UNAVAILABLE" : null,
            fallback: false,
            autoTrack: af.owner === "auto-follow",
        };
    }

    function _mapSourceType(source) {
        if (source === "noaa") return "weather_radio";
        if (source === "scanner") return "scanner";
        if (source === "spotter") return "event";
        return "custom";
    }

    function _sourceLabel(source) {
        if (source === "noaa") return "NOAA Weather Radio";
        if (source === "scanner") return "Scanner";
        if (source === "spotter") return "Spotter Network";
        return source;
    }

    // ── Demo Override Controls ──────────────────────────────────────────

    function setDemoMuted(muted) {
        const da = StormState.state.demoAudio;
        if (!da.enabled) return;
        da.muted = !!muted;

        if (log) log.info("demo_audio_override_changed", {
            event_type: "demo_audio_override_changed",
            field: "muted",
            value: da.muted,
            scenario_id: da.scenarioId,
            timestamp: Date.now(),
        });

        _updateStripFromDemo();
        _updateDemoPanelUI();
    }

    function setDemoVolume(volume) {
        const da = StormState.state.demoAudio;
        if (!da.enabled) return;
        da.volume = Math.max(0, Math.min(1, volume));
        _updateDemoPanelUI();
    }

    function setDemoFallback(active) {
        const da = StormState.state.demoAudio;
        if (!da.enabled) return;
        da.fallbackActive = !!active;
        if (active) {
            da.selectedSourceType = "fallback";
            da.streamTitle = "Fallback Audio Active";
        }

        if (log) log.info("demo_audio_override_changed", {
            event_type: "demo_audio_override_changed",
            field: "fallback",
            value: da.fallbackActive,
            scenario_id: da.scenarioId,
            timestamp: Date.now(),
        });

        _updateStripFromDemo();
        _updateDemoPanelUI();
    }

    function setDemoAutoTrack(bound) {
        const da = StormState.state.demoAudio;
        if (!da.enabled) return;
        da.autoTrackBound = !!bound;

        if (log) log.info("demo_audio_override_changed", {
            event_type: "demo_audio_override_changed",
            field: "autoTrackBound",
            value: da.autoTrackBound,
            scenario_id: da.scenarioId,
            timestamp: Date.now(),
        });

        _updateStripFromDemo();
        _updateDemoPanelUI();
    }

    // ── Cleanup ────────────────────────────────────────────────────────

    function cleanupAudioDemo() {
        _clearAllTimers();
        _resetDemoAudioState();
        _updateStripFromDemo();

        if (log) log.info("demo_audio_cleanup", {
            event_type: "demo_audio_cleanup",
            timestamp: Date.now(),
        });
    }

    function _clearAllTimers() {
        if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
        _clearSimulationTimers();
    }

    function _clearSimulationTimers() {
        for (const t of _simulationTimers) clearTimeout(t);
        _simulationTimers = [];
    }

    function _resetDemoAudioState() {
        const da = StormState.state.demoAudio;
        da.scenarioId = null;
        da.playbackState = "idle";
        da.muted = false;
        da.volume = 1.0;
        da.selectedSourceId = null;
        da.selectedSourceType = null;
        da.streamTitle = null;
        da.streamSubtitle = null;
        da.eventId = null;
        da.errorCode = null;
        da.errorMessage = null;
        da.autoTrackBound = false;
        da.fallbackActive = false;
        da.lastScenarioAppliedAt = null;
    }

    // ── Status Strip Integration ───────────────────────────────────────

    /**
     * Strict priority-ordered status strip resolver.
     * Priority order (highest to lowest):
     *   1. Error states (most urgent)
     *   2. Unavailable
     *   3. Fallback active
     *   4. Muted
     *   5. Loading
     *   6. Playing
     *   7. Paused
     *   8. Off / idle (lowest)
     *
     * Only one label is ever returned — no conflicting text.
     */
    function getStatusStripText() {
        const vm = getEffectiveAudioViewModel();
        if (vm.source !== "demo") return null; // Let runtime handle it

        return _resolveAudioStatus(vm);
    }

    function _resolveAudioStatus(vm) {
        // Priority 1: Error (highest urgency)
        if (vm.errorCode || vm.playbackState === "error") {
            return "AUDIO ERROR: " + (vm.error || "UNKNOWN").toUpperCase();
        }

        // Priority 2: Unavailable
        if (vm.playbackState === "unavailable") {
            return "AUDIO: UNAVAILABLE";
        }

        // Priority 3: Fallback active
        if (vm.fallback) {
            return "AUDIO: FALLBACK ACTIVE";
        }

        // Priority 4: Muted (while still connected)
        if (vm.muted && vm.playbackState !== "idle") {
            return "AUDIO: MUTED";
        }

        // Priority 5: Loading
        if (vm.playbackState === "loading") {
            const type = vm.sourceType ? vm.sourceType.replace(/_/g, " ").toUpperCase() : "STREAM";
            return "AUDIO: LOADING " + type;
        }

        // Priority 6: Playing
        if (vm.playbackState === "playing") {
            const type = vm.sourceType ? vm.sourceType.replace(/_/g, " ").toUpperCase() : "STREAM";
            return "AUDIO: PLAYING " + type;
        }

        // Priority 7: Paused
        if (vm.playbackState === "paused") {
            return "AUDIO: PAUSED";
        }

        // Priority 8: Off / idle (lowest)
        return "AUDIO: OFF";
    }

    function _updateStripFromDemo() {
        // Trigger SystemStatus refresh if available
        if (typeof SystemStatus !== "undefined" && SystemStatus.update) {
            SystemStatus.update();
        }
    }

    // ── Demo Panel UI ──────────────────────────────────────────────────

    function buildDemoPanelSection(container) {
        if (!container) return;
        _uiBuilt = true;

        const section = document.createElement("div");
        section.id = "demo-audio-section";
        section.className = "demo-audio-section";

        const scenarios = AudioDemoScenarios.SCENARIOS;
        const optionsHtml = scenarios.map(s =>
            `<option value="${s.id}">${s.label} [${s.category}]</option>`
        ).join("");

        section.innerHTML = `
            <div class="demo-audio-header">AUDIO DEMO</div>
            <div class="demo-audio-row">
                <label class="demo-audio-label">
                    <input type="checkbox" id="demo-audio-enable" />
                    Enable Audio Demo
                </label>
            </div>
            <div class="demo-audio-row">
                <select id="demo-audio-scenario" class="demo-audio-select" disabled>
                    <option value="">— Select Scenario —</option>
                    ${optionsHtml}
                </select>
            </div>
            <div class="demo-audio-row">
                <label class="demo-audio-label">
                    <input type="checkbox" id="demo-audio-mute" disabled />
                    Mute
                </label>
                <label class="demo-audio-label">
                    <input type="checkbox" id="demo-audio-fallback" disabled />
                    Fallback
                </label>
                <label class="demo-audio-label">
                    <input type="checkbox" id="demo-audio-autotrack" disabled />
                    AT Bound
                </label>
            </div>
            <div class="demo-audio-row">
                <span class="demo-audio-vol-label">Vol</span>
                <input type="range" id="demo-audio-volume" min="0" max="1" step="0.05" value="1" class="demo-audio-slider" disabled />
            </div>
            <div class="demo-audio-row">
                <button class="demo-btn demo-audio-err-btn" data-error="BUFFER_TIMEOUT" disabled>Buf Timeout</button>
                <button class="demo-btn demo-audio-err-btn" data-error="SOURCE_DOWN" disabled>Src Down</button>
                <button class="demo-btn demo-audio-err-btn" data-error="NO_STREAM" disabled>No Stream</button>
            </div>
            <div class="demo-audio-status" id="demo-audio-status">—</div>
        `;

        container.appendChild(section);
        _wireEvents();
    }

    function _wireEvents() {
        const enableCb = document.getElementById("demo-audio-enable");
        const scenarioSel = document.getElementById("demo-audio-scenario");
        const muteCb = document.getElementById("demo-audio-mute");
        const fallbackCb = document.getElementById("demo-audio-fallback");
        const autotrackCb = document.getElementById("demo-audio-autotrack");
        const volSlider = document.getElementById("demo-audio-volume");
        const errBtns = document.querySelectorAll(".demo-audio-err-btn");

        if (enableCb) {
            enableCb.addEventListener("change", () => {
                if (enableCb.checked) {
                    enableAudioDemo();
                } else {
                    disableAudioDemo();
                }
                _setControlsEnabled(enableCb.checked);
                _updateDemoPanelUI();
            });
        }

        if (scenarioSel) {
            scenarioSel.addEventListener("change", () => {
                if (scenarioSel.value) {
                    applyAudioScenario(scenarioSel.value);
                }
            });
        }

        if (muteCb) {
            muteCb.addEventListener("change", () => setDemoMuted(muteCb.checked));
        }

        if (fallbackCb) {
            fallbackCb.addEventListener("change", () => setDemoFallback(fallbackCb.checked));
        }

        if (autotrackCb) {
            autotrackCb.addEventListener("change", () => setDemoAutoTrack(autotrackCb.checked));
        }

        if (volSlider) {
            volSlider.addEventListener("input", () => setDemoVolume(parseFloat(volSlider.value)));
        }

        errBtns.forEach(btn => {
            btn.addEventListener("click", () => {
                const code = btn.dataset.error;
                const errorScenarios = {
                    "BUFFER_TIMEOUT": "audio-buffer-timeout",
                    "SOURCE_DOWN": "audio-source-unavailable",
                    "NO_STREAM": "audio-no-stream-found",
                };
                const scenarioId = errorScenarios[code];
                if (scenarioId) applyAudioScenario(scenarioId);
            });
        });
    }

    function _setControlsEnabled(enabled) {
        const ids = ["demo-audio-scenario", "demo-audio-mute", "demo-audio-fallback",
                     "demo-audio-autotrack", "demo-audio-volume"];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = !enabled;
        });
        document.querySelectorAll(".demo-audio-err-btn").forEach(btn => {
            btn.disabled = !enabled;
        });
    }

    function _updateDemoPanelUI() {
        if (!_uiBuilt) return;

        const da = StormState.state.demoAudio;
        const statusEl = document.getElementById("demo-audio-status");
        const scenarioSel = document.getElementById("demo-audio-scenario");
        const muteCb = document.getElementById("demo-audio-mute");
        const fallbackCb = document.getElementById("demo-audio-fallback");
        const autotrackCb = document.getElementById("demo-audio-autotrack");
        const volSlider = document.getElementById("demo-audio-volume");

        if (statusEl) {
            const stripText = getStatusStripText();
            statusEl.textContent = stripText || "AUDIO: OFF";
            statusEl.className = "demo-audio-status" + (da.errorCode ? " demo-audio-error" : da.playbackState === "playing" ? " demo-audio-playing" : "");
        }

        if (scenarioSel && scenarioSel.value !== da.scenarioId) {
            scenarioSel.value = da.scenarioId || "";
        }

        if (muteCb) muteCb.checked = da.muted;
        if (fallbackCb) fallbackCb.checked = da.fallbackActive;
        if (autotrackCb) autotrackCb.checked = da.autoTrackBound;
        if (volSlider) volSlider.value = da.volume;
    }

    // ── Snapshot ────────────────────────────────────────────────────────

    function _snapshotState(da) {
        return {
            scenarioId: da.scenarioId,
            playbackState: da.playbackState,
            muted: da.muted,
            errorCode: da.errorCode,
        };
    }

    // ── Debug ──────────────────────────────────────────────────────────

    function getDebugState() {
        const da = StormState.state.demoAudio;
        return {
            enabled: da.enabled,
            scenarioId: da.scenarioId,
            playbackState: da.playbackState,
            muted: da.muted,
            volume: da.volume,
            sourceType: da.selectedSourceType,
            errorCode: da.errorCode,
            autoTrackBound: da.autoTrackBound,
            fallbackActive: da.fallbackActive,
            effectiveVM: getEffectiveAudioViewModel(),
            stripText: getStatusStripText(),
        };
    }

    return {
        init,
        enableAudioDemo,
        disableAudioDemo,
        applyAudioScenario,
        getEffectiveAudioViewModel,
        getStatusStripText,
        cleanupAudioDemo,
        setDemoMuted,
        setDemoVolume,
        setDemoFallback,
        setDemoAutoTrack,
        buildDemoPanelSection,
        getDebugState,
    };
})();
