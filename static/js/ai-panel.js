/**
 * Storm Tracker — AI Advisory Module (v228)
 *
 * AI is the PRIMARY spoken-alert engine.
 * Remote inference via Ollama on Gaming PC over LAN.
 *
 * SPEECH ARCHITECTURE:
 *   AlertEngine generates message text + plays pre-tones.
 *   AlertEngine routes speech here via speakAlert() when AI is primary.
 *   AI voice is distinct: slower, lower pitch, analytical.
 *   Legacy AlertEngine voice is fallback only (separate toggle).
 *
 * ROUTING (enforced in AlertEngine._trySpeak):
 *   AI ON + healthy → AI speaks (always)
 *   AI ON + unhealthy → legacy fallback IF legacy ON
 *   AI OFF → legacy IF legacy ON
 *   Both OFF → no speech
 *
 * STALE PROTECTION (severity-aware):
 *   Severe/tornado context → 25s max age
 *   Normal context → 60s max age
 *
 * COLLISION:
 *   New alert routes cancel existing AI speech first
 *   AI never starts if legacy is mid-utterance
 *   No overlapping audio ever
 */
const AIPanel = (function () {

    const STATUS_POLL_MS = 10000;
    const SUMMARY_POLL_MS = 15000;
    const NARRATION_POLL_MS = 12000;

    let log = null;
    let _enabled = true;          // AI audio toggle (primary)
    let _healthy = false;
    let _lastSummary = null;
    let _lastNarration = null;
    let _lastPriority = null;
    let _lastInterpretation = null;
    let _statusTimer = null;
    let _summaryTimer = null;
    let _narrationTimer = null;
    let _narrationSpoken = null;
    let _aiVoice = null;
    let _aiVoiceName = null;

    // AI voice profile — distinct from AlertEngine legacy voice
    const AI_VOICE_PROFILE = {
        rate: 0.85,
        pitch: 0.75,
        volume: 0.85,
    };

    // Severity-aware stale thresholds
    const STALE_SEVERE_SEC = 25;   // tornado/severe context
    const STALE_NORMAL_SEC = 60;   // normal context

    // Speaking state
    let _aiSpeaking = false;
    let _aiUtterance = null;
    let _narrationTimestamp = 0;

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("ai_panel");

        StormState.state.ai = {
            enabled: true,
            healthy: false,
            lastSummary: null,
            lastNarration: null,
            lastPriority: null,
            lastInterpretation: null,
            queueDepth: 0,
            ollamaUrl: "",
            fastModel: "",
            heavyModel: "",
        };

        // Restore toggle (default: ON)
        const saved = localStorage.getItem("ai_enabled");
        if (saved !== null) {
            _enabled = saved === "true";
        }
        StormState.state.ai.enabled = _enabled;

        _initAIVoice();
        _bindUI();
        _startPolling();

        // Priority-aware cancel: alert events cancel AI speech
        StormState.on("vizTargetChanged", () => {
            if (_aiSpeaking) cancelSpeech("new_alert_target");
        });
        StormState.on("vizIntensityChanged", () => {
            if (_aiSpeaking) cancelSpeech("severity_escalation");
        });

        if (log) log.info("ai_panel_init", { enabled: _enabled });
    }

    // ── AI Voice Selection (DISTINCT from AlertEngine) ─────────

    function _initAIVoice() {
        const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        if (voices.length > 0) _selectAIVoice(voices);

        if (window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = () => {
                _selectAIVoice(window.speechSynthesis.getVoices());
            };
        }
    }

    function _selectAIVoice(voices) {
        if (!voices || voices.length === 0) return;

        const savedName = localStorage.getItem("st_ai_voice");
        if (savedName) {
            const match = voices.find(v => v.name === savedName);
            if (match) { _aiVoice = match; _aiVoiceName = match.name; return; }
        }

        const alertVoiceName = localStorage.getItem("st_speech_voice");
        const english = voices.filter(v => v.lang && v.lang.startsWith("en"));
        const nonAlert = english.filter(v => v.name !== alertVoiceName);

        const femaleVoice = nonAlert.find(v => /female|zira|hazel|susan|samantha|karen|moira|fiona/i.test(v.name));
        const maleVoice = nonAlert.find(v => /male|david|james|daniel|mark|george|richard/i.test(v.name));

        let pick = null;
        if (alertVoiceName && /david|james|daniel|mark|george|richard/i.test(alertVoiceName)) {
            pick = femaleVoice || nonAlert[0];
        } else {
            pick = maleVoice || nonAlert[0];
        }
        if (!pick) pick = nonAlert[0] || english[0] || voices[0];

        _aiVoice = pick;
        _aiVoiceName = pick ? pick.name : null;
        if (pick) {
            localStorage.setItem("st_ai_voice", pick.name);
            if (log) log.info("ai_voice_selected", {
                name: pick.name, lang: pick.lang,
                alertEngineVoice: alertVoiceName,
                different: pick.name !== alertVoiceName,
            });
        }
    }

    // ── UI Binding ─────────────────────────────────────────────

    function _bindUI() {
        const btn = document.getElementById("btn-ai-toggle");
        if (btn) {
            btn.addEventListener("click", toggleEnabled);
            _updateToggleBtn();
        }
    }

    function bindSettingsControls() {
        const trigSummary = document.getElementById("sett-ai-trigger-summary");
        if (trigSummary) trigSummary.addEventListener("click", triggerSummary);

        const trigNarration = document.getElementById("sett-ai-trigger-narration");
        if (trigNarration) trigNarration.addEventListener("click", triggerNarration);

        const speakBtn = document.getElementById("sett-ai-speak");
        if (speakBtn) speakBtn.addEventListener("click", speakLastNarration);

        const voiceSelect = document.getElementById("sett-ai-voice");
        if (voiceSelect) {
            _populateVoiceSelect(voiceSelect);
            voiceSelect.addEventListener("change", () => {
                const voices = window.speechSynthesis.getVoices();
                const v = voices.find(v => v.name === voiceSelect.value);
                if (v) {
                    _aiVoice = v;
                    _aiVoiceName = v.name;
                    localStorage.setItem("st_ai_voice", v.name);
                    if (log) log.info("ai_voice_changed", { name: v.name });
                }
            });
        }

        // Legacy toggle
        const legacyToggle = document.getElementById("sett-legacy-speech");
        if (legacyToggle) {
            const legacyOn = typeof AlertEngine !== "undefined" ? AlertEngine.isLegacyEnabled() : true;
            legacyToggle.textContent = legacyOn ? "ON" : "OFF";
            legacyToggle.className = "sett-toggle " + (legacyOn ? "sett-on" : "sett-off");
            legacyToggle.addEventListener("click", () => {
                const newVal = !AlertEngine.isLegacyEnabled();
                AlertEngine.setLegacyEnabled(newVal);
                legacyToggle.textContent = newVal ? "ON" : "OFF";
                legacyToggle.className = "sett-toggle " + (newVal ? "sett-on" : "sett-off");
                _updateStatusBadge();
            });
        }

        // AI audio toggle (in settings)
        const aiToggle = document.getElementById("sett-ai-audio");
        if (aiToggle) {
            aiToggle.textContent = _enabled ? "ON" : "OFF";
            aiToggle.className = "sett-toggle " + (_enabled ? "sett-on" : "sett-off");
            aiToggle.addEventListener("click", () => {
                toggleEnabled();
                aiToggle.textContent = _enabled ? "ON" : "OFF";
                aiToggle.className = "sett-toggle " + (_enabled ? "sett-on" : "sett-off");
            });
        }
    }

    function _populateVoiceSelect(select) {
        const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        const english = voices.filter(v => v.lang && v.lang.startsWith("en"));
        select.innerHTML = "";
        for (const v of english) {
            const opt = document.createElement("option");
            opt.value = v.name;
            opt.textContent = v.name.replace("Microsoft ", "").replace(" - English (United States)", " (US)");
            if (_aiVoiceName && v.name === _aiVoiceName) opt.selected = true;
            select.appendChild(opt);
        }
        if (english.length === 0) {
            const opt = document.createElement("option");
            opt.textContent = "No English voices available";
            select.appendChild(opt);
        }
    }

    // ── Polling ────────────────────────────────────────────────

    function _startPolling() {
        _pollStatus();
        _pollSummary();
        _pollNarration();
        _statusTimer = setInterval(_pollStatus, STATUS_POLL_MS);
        _summaryTimer = setInterval(_pollSummary, SUMMARY_POLL_MS);
        _narrationTimer = setInterval(_pollNarration, NARRATION_POLL_MS);
    }

    async function _pollStatus() {
        if (!_enabled) { _setHealthy(false); return; }
        try {
            const resp = await fetch("/api/ai/status");
            if (!resp.ok) { _setHealthy(false); return; }
            const data = await resp.json();
            // During startup grace, treat as healthy (probe hasn't run yet)
            _setHealthy(data.startup_grace ? true : data.healthy);
            StormState.state.ai.ollamaUrl = data.ollama_url;
            StormState.state.ai.queueDepth = data.queue?.queue_depth || 0;
            StormState.state.ai.fastModel = data.fast_model || "";
            StormState.state.ai.heavyModel = data.heavy_model || "";
            _renderSettingsStatus(data);
        } catch {
            _setHealthy(false);
        }
    }

    async function _pollSummary() {
        if (!_enabled || !_healthy) return;
        try {
            const resp = await fetch("/api/ai/summary");
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.summary && data.summary !== _lastSummary) {
                _lastSummary = data.summary;
                StormState.state.ai.lastSummary = data.summary;
                _renderSettingsSummary(data.summary);
                StormState.emit("aiSummaryUpdated", data.summary);
            }
        } catch { /* silent */ }
    }

    async function _pollNarration() {
        if (!_enabled || !_healthy) return;
        try {
            const resp = await fetch("/api/ai/narration");
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.narration && data.narration !== _lastNarration) {
                _lastNarration = data.narration;
                _narrationTimestamp = Date.now() / 1000;
                StormState.state.ai.lastNarration = data.narration;
                _renderSettingsNarration(data.narration);
                if (data.narration !== _narrationSpoken && StormState.state.audioEnabled) {
                    _speakNarration(data.narration);
                    _narrationSpoken = data.narration;
                }
                StormState.emit("aiNarrationUpdated", data.narration);
            }
        } catch { /* silent */ }

        try {
            const [priResp, intResp] = await Promise.all([
                fetch("/api/ai/priority"),
                fetch("/api/ai/interpretation"),
            ]);
            if (priResp.ok) {
                const d = await priResp.json();
                if (d.priority) { _lastPriority = d.priority; StormState.state.ai.lastPriority = d.priority; }
            }
            if (intResp.ok) {
                const d = await intResp.json();
                if (d.interpretation) {
                    _lastInterpretation = d.interpretation;
                    StormState.state.ai.lastInterpretation = d.interpretation;
                    _renderSettingsInterpretation(d.interpretation);
                }
            }
        } catch { /* silent */ }
    }

    // ── Render in Settings Panel ───────────────────────────────

    function _renderSettingsStatus(data) {
        const el = document.getElementById("sett-ai-status");
        if (!el) return;
        const h = data.healthy;
        const q = data.queue || {};
        el.innerHTML =
            `<span class="${h ? 'ai-ok' : 'ai-err'}">${h ? 'Connected' : 'Offline'}</span>` +
            ` — ${data.fast_model || '?'} / ${data.heavy_model || '?'}` +
            ` — Q: ${q.queue_depth || 0}/${q.max_depth || 10}` +
            ` — ${q.total_completed || 0} done / ${q.total_failed || 0} fail`;
    }

    function _renderSettingsSummary(text) {
        const el = document.getElementById("sett-ai-summary-text");
        if (el) el.textContent = text || "No summary yet";
    }

    function _renderSettingsNarration(text) {
        const el = document.getElementById("sett-ai-narration-text");
        if (el) el.textContent = text || "—";
    }

    function _renderSettingsInterpretation(text) {
        const el = document.getElementById("sett-ai-interpretation-text");
        if (el) el.textContent = text || "—";
    }

    // ── Health State ───────────────────────────────────────────

    function _setHealthy(h) {
        _healthy = h;
        StormState.state.ai.healthy = h;
        _updateToggleBtn();
        _updateStatusBadge();
    }

    function _updateToggleBtn() {
        const btn = document.getElementById("btn-ai-toggle");
        if (!btn) return;
        if (!_enabled) {
            btn.className = "radar-btn ai-disabled";
            btn.title = "AI Audio: OFF (click to enable)";
            btn.textContent = "AI";
        } else if (_healthy) {
            btn.className = "radar-btn ai-active";
            btn.title = "AI Audio: ON — Primary narrator (click to disable)";
            btn.textContent = "AI";
        } else {
            btn.className = "radar-btn ai-unhealthy";
            btn.title = "AI Audio: Connecting... (click to disable)";
            btn.textContent = "AI";
        }
    }

    function _updateStatusBadge() {
        const el = document.getElementById("ss-ai");
        if (!el) return;

        const legacyOn = typeof AlertEngine !== "undefined" ? AlertEngine.isLegacyEnabled() : false;

        if (!_enabled && !legacyOn) {
            el.textContent = "MUTE";
            el.className = "ss-badge ss-mute";
            el.title = "All speech disabled";
        } else if (_enabled && _healthy) {
            el.textContent = "AI ON";
            el.className = "ss-badge ss-ai-on";
            el.title = `AI: Primary — ${StormState.state.ai.fastModel} / ${StormState.state.ai.heavyModel}` +
                (legacyOn ? " | Legacy: standby" : "");
        } else if (_enabled && !_healthy) {
            el.textContent = legacyOn ? "AI !" : "AI !";
            el.className = "ss-badge ss-ai-err";
            el.title = "AI: Offline" + (legacyOn ? " — Legacy fallback active" : " — No fallback");
        } else if (!_enabled && legacyOn) {
            el.textContent = "LEG";
            el.className = "ss-badge ss-legacy";
            el.title = "Legacy Audio Engine active (AI disabled)";
        }
    }

    // ── SPEECH: Routed Alert Speech (called by AlertEngine) ────
    //
    // This is the PRIMARY spoken-alert path when AI is enabled.
    // AlertEngine calls this instead of speaking directly.

    function speakAlert(text, triggerType) {
        if (!_enabled) {
            if (log) log.info("ai_speak_blocked", { reason: "ai_disabled", triggerType });
            return;
        }
        if (!text) return;
        if (typeof window === "undefined" || !window.speechSynthesis) return;
        if (typeof AudioUnlock !== "undefined" && !AudioUnlock.isUnlocked()) return;

        if (log) log.info("ai_speak_alert", { triggerType, len: text.length, engine: "ai" });

        _doSpeakAI(text);
    }

    // ── SPEECH: AI Narration (summaries, context) ──────────────

    function _speakNarration(text) {
        if (!_enabled) return;
        if (!text) return;
        if (typeof window === "undefined" || !window.speechSynthesis) return;
        if (typeof AudioUnlock !== "undefined" && !AudioUnlock.isUnlocked()) return;

        // Collision: never start if anyone is speaking
        if ((typeof AlertEngine !== "undefined" && AlertEngine.isSpeaking()) || _aiSpeaking) {
            if (log) log.info("ai_narration_deferred", { reason: "speech_active" });
            return;
        }

        // Severity-aware stale check
        if (_narrationTimestamp > 0) {
            const age = (Date.now() / 1000) - _narrationTimestamp;
            const isSevere = _isSevereContext();
            const threshold = isSevere ? STALE_SEVERE_SEC : STALE_NORMAL_SEC;
            if (age > threshold) {
                if (log) log.info("ai_narration_dropped", { reason: "stale", age_sec: Math.round(age), threshold, severe: isSevere });
                return;
            }
        }

        _doSpeakAI(text);
    }

    function _isSevereContext() {
        const at = StormState.state.autotrack;
        if (!at.enabled || !at.targetEvent) return false;
        const evt = (at.targetEvent || "").toLowerCase();
        return evt.includes("tornado") || evt.includes("severe thunderstorm");
    }

    // ── SPEECH: Core AI TTS ────────────────────────────────────

    function _doSpeakAI(text) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = AI_VOICE_PROFILE.rate;
        utter.pitch = AI_VOICE_PROFILE.pitch;
        utter.volume = AI_VOICE_PROFILE.volume;
        if (_aiVoice) utter.voice = _aiVoice;

        utter.onstart = () => {
            _aiSpeaking = true;
            _aiUtterance = utter;
            _updateSpeakingIndicator(true);
            if (log) log.info("ai_speech_start", { voice: _aiVoiceName, len: text.length, engine: "ai" });
        };

        utter.onend = () => {
            _aiSpeaking = false;
            _aiUtterance = null;
            _updateSpeakingIndicator(false);
            if (log) log.info("ai_speech_end", { engine: "ai" });
        };

        utter.onerror = (e) => {
            _aiSpeaking = false;
            _aiUtterance = null;
            _updateSpeakingIndicator(false);
            if (log) log.info("ai_speech_error", { error: e.error || "unknown" });
        };

        window.speechSynthesis.speak(utter);
    }

    function cancelSpeech(reason) {
        if (_aiSpeaking) {
            try { window.speechSynthesis.cancel(); } catch (e) { /* safe */ }
            _aiSpeaking = false;
            _aiUtterance = null;
            _updateSpeakingIndicator(false);
            if (log) log.info("ai_speech_cancelled", { reason });
        }
    }

    function _updateSpeakingIndicator(speaking) {
        const el = document.getElementById("ss-ai");
        if (!el) return;
        if (speaking && _enabled && _healthy) {
            el.textContent = "AI \u25B6";
            el.className = "ss-badge ss-ai-speaking";
            el.title = "AI: Speaking...";
        } else {
            _updateStatusBadge();
        }
    }

    function speakLastNarration() {
        if (_lastNarration) _speakNarration(_lastNarration);
        else if (_lastSummary) _speakNarration(_lastSummary);
    }

    function isAISpeaking() { return _aiSpeaking; }

    // ── Controls ───────────────────────────────────────────────

    function toggleEnabled() {
        _enabled = !_enabled;
        StormState.state.ai.enabled = _enabled;
        localStorage.setItem("ai_enabled", _enabled);
        _updateToggleBtn();
        _updateStatusBadge();

        // Cancel AI speech immediately when disabled
        if (!_enabled && _aiSpeaking) {
            cancelSpeech("toggle_disabled");
        }

        fetch(`/api/ai/toggle?enabled=${_enabled}`, { method: "POST" }).catch(() => {});
        if (log) log.info("ai_toggled", { enabled: _enabled });

        if (!_enabled) {
            _renderSettingsSummary(null);
            _renderSettingsNarration(null);
            _renderSettingsInterpretation(null);
        }
    }

    async function triggerSummary() {
        if (!_enabled) return;
        try {
            const resp = await fetch("/api/ai/trigger/summary", { method: "POST" });
            const data = await resp.json();
            if (log) log.info("ai_trigger_summary", data);
            setTimeout(_pollSummary, 4000);
        } catch (e) {
            if (log) log.error("ai_trigger_summary_failed", { error: e.message });
        }
    }

    async function triggerNarration() {
        if (!_enabled) return;
        try {
            const resp = await fetch("/api/ai/trigger/narration", { method: "POST" });
            const data = await resp.json();
            if (log) log.info("ai_trigger_narration", data);
            setTimeout(_pollNarration, 4000);
        } catch (e) {
            if (log) log.error("ai_trigger_narration_failed", { error: e.message });
        }
    }

    // ── Public Getters ─────────────────────────────────────────

    function getDebugState() {
        return {
            enabled: _enabled, healthy: _healthy,
            hasSummary: !!_lastSummary, hasNarration: !!_lastNarration,
            hasPriority: !!_lastPriority, hasInterpretation: !!_lastInterpretation,
            narrationSpoken: !!_narrationSpoken, aiVoice: _aiVoiceName,
            aiSpeaking: _aiSpeaking,
        };
    }

    function getLastSummary() { return _lastSummary; }
    function getLastNarration() { return _lastNarration; }
    function isEnabled() { return _enabled; }
    function isHealthy() { return _healthy; }

    // ── Settings Panel HTML ────────────────────────────────────

    function getSettingsHTML() {
        return `
            <div class="settings-group">
                <label class="settings-label">AI Audio (Primary)</label>
                <button id="sett-ai-audio" class="sett-toggle"></button>
                <div class="sett-hint">AI handles all spoken alerts when enabled</div>
            </div>
            <div class="settings-group">
                <label class="settings-label">Legacy Audio Engine (Fallback)</label>
                <button id="sett-legacy-speech" class="sett-toggle"></button>
                <div class="sett-hint">Original alert voice — used when AI is off or unavailable</div>
            </div>
            <div class="settings-group">
                <label class="settings-label">AI Status</label>
                <div id="sett-ai-status" class="sett-ai-status">Checking...</div>
            </div>
            <div class="settings-group">
                <label class="settings-label">AI Summary</label>
                <div id="sett-ai-summary-text" class="sett-ai-text">No summary yet</div>
                <button id="sett-ai-trigger-summary" class="sett-btn">Generate Summary</button>
            </div>
            <div class="settings-group">
                <label class="settings-label">AI Narration</label>
                <div id="sett-ai-narration-text" class="sett-ai-text">\u2014</div>
                <div class="settings-row">
                    <button id="sett-ai-trigger-narration" class="sett-btn">Generate</button>
                    <button id="sett-ai-speak" class="sett-btn">Speak</button>
                </div>
            </div>
            <div class="settings-group">
                <label class="settings-label">AI Interpretation</label>
                <div id="sett-ai-interpretation-text" class="sett-ai-text">\u2014</div>
            </div>
            <div class="settings-group">
                <label class="settings-label">AI Voice</label>
                <select id="sett-ai-voice" class="settings-select"></select>
                <div class="sett-hint">Distinct from legacy voice \u2014 slower, lower pitch for briefings</div>
            </div>
        `;
    }

    return {
        init,
        toggleEnabled,
        triggerSummary,
        triggerNarration,
        speakLastNarration,
        speakAlert,
        cancelSpeech,
        isAISpeaking,
        getDebugState,
        getLastSummary,
        getLastNarration,
        isEnabled,
        isHealthy,
        getSettingsHTML,
        bindSettingsControls,
    };
})();
