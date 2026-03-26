/**
 * Storm Tracker — Speaking Alert Engine
 *
 * Generates alert messages and routes speech to the active audio engine.
 *
 * ROUTING RULES (v228+):
 *   1. AI audio ON + AI healthy → ALWAYS use AI voice
 *   2. AI audio ON + AI unhealthy → fallback to legacy IF legacy toggle ON
 *   3. AI audio OFF → use legacy IF legacy toggle ON
 *   4. Both OFF → no speech (pre-tones still play)
 *
 * AlertEngine NEVER speaks directly when AI audio is ON.
 * All spoken alert paths route through _trySpeak (single decision point).
 *
 * Pre-attention tones ALWAYS play regardless of speech routing.
 *
 * Audio pipeline:
 *   Event → _trySpeak → generateMessage → route decision → speak (AI or legacy)
 *   Pre-tone plays in parallel with routing (not gated by toggle)
 *
 * Legacy speech features (when legacy toggle ON):
 *   - Priority-based interrupt (higher severity cancels lower)
 *   - Voice persistence (localStorage)
 *   - Severity-distinct voice profiles (rate/pitch/prefix)
 *   - Cancel-and-replace with 50ms iOS delay
 */
const AlertEngine = (function () {

    let log = null;
    let _speechAvailable = false;
    let _speaking = false;
    let _activePriority = null;
    let _lastImpactActive = false;
    let _speakTimer = null;
    let _lastSpokenMessage = null;
    let _lastSpeechEvent = null;
    let _selectedVoice = null;

    // ── Toggle State ──────────────────────────────────────────────
    // Legacy speech toggle — persisted in localStorage
    let _legacyEnabled = true;  // default ON (fallback)

    function _loadToggle() {
        const saved = localStorage.getItem("alert_speech_enabled");
        if (saved !== null) _legacyEnabled = saved === "true";
    }

    function setLegacyEnabled(enabled) {
        _legacyEnabled = enabled;
        localStorage.setItem("alert_speech_enabled", enabled);
        if (!enabled && _speaking) {
            _cancelSpeech();
        }
        if (log) log.info("legacy_speech_toggled", { enabled });
    }

    function isLegacyEnabled() { return _legacyEnabled; }

    // ── Priority Values (must match AlertState.PRIORITY) ────────────
    const PRIORITY_ORD = {
        target_acquired: 1,
        severity_escalation: 2,
        impact_radius_entered: 3,
        tornado_warning: 4,
    };

    // ── Voice Profiles ──────────────────────────────────────────────
    const VOICE_PROFILES = {
        target_acquired:       { rate: 1.0,  pitch: 0.9,  prefix: "",           toneHz: 440,  toneMs: 80 },
        severity_escalation:   { rate: 1.1,  pitch: 1.1,  prefix: "Attention. ", toneHz: 660,  toneMs: 100 },
        impact_radius_entered: { rate: 1.15, pitch: 1.2,  prefix: "Warning. ",  toneHz: 880,  toneMs: 100 },
        tornado_warning:       { rate: 1.3,  pitch: 1.4,  prefix: "Alert. ",    toneHz: 1100, toneMs: 120 },
    };

    // ── Compass ─────────────────────────────────────────────────────
    const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

    function _bearingToCompass(deg) {
        if (deg == null || !isFinite(deg)) return null;
        return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
    }

    // ── Init ────────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("alert_engine");

        _loadToggle();

        _speechAvailable = typeof window !== "undefined"
            && typeof window.speechSynthesis !== "undefined";

        if (!_speechAvailable) {
            if (log) log.warn("alert_unavailable", { reason: "speechSynthesis_not_supported" });
            _updateStatus("unavailable", "Speech API not supported");
            return;
        }

        _initVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = _initVoices;
        }

        // Hook into state events
        StormState.on("vizTargetChanged", _onTargetChanged);
        StormState.on("vizIntensityChanged", _onIntensityChanged);
        StormState.on("alertsUpdated", _checkImpactRadius);
        StormState.on("autotrackChanged", _onModeChanged);

        // React to backend-driven primary target changes for audio arbitration
        StormState.on("primary_target_changed", function (data) {
            if (!data || !data.primary_id) return;

            // New critical alert — interrupt AI if needed
            var event = (data.event || "").toLowerCase();
            if (event.includes("tornado") && event.includes("warning")) {
                onAlertAudioStart();
                if (log) log.info("audio_priority_override", {
                    reason: "tornado_primary",
                    primary_id: data.primary_id,
                });
            }
        });

        _updateStatus(
            AudioUnlock.isUnlocked() ? "ready" : "locked",
            AudioUnlock.isUnlocked() ? "Audio ready" : "Waiting for user gesture"
        );

        if (log) log.info("alert_engine_init", {
            speechAvailable: true,
            unlocked: AudioUnlock.isUnlocked(),
            legacyEnabled: _legacyEnabled,
        });
    }

    // ── Audio Arbitration State ──────────────────────────────────────
    // Rule: Alert audio > AI narration. Always.
    let _audioState = {
        isAlertPlaying: false,
        isAiSpeaking: false,
        lastAlertTs: 0,
        lastAiSuppressTs: 0,
        suppressCount: 0,
    };

    /**
     * Check if AI narration should be suppressed.
     * Alert audio always takes priority over AI narration.
     */
    function shouldSuppressAi() {
        if (_audioState.isAlertPlaying) {
            _audioState.lastAiSuppressTs = Date.now();
            _audioState.suppressCount++;
            if (log) log.info("ai_suppressed", {
                reason: "alert_audio_active",
                suppress_count: _audioState.suppressCount,
            });
            return true;
        }
        return false;
    }

    /**
     * Called when alert audio starts playing.
     * Cancels any active AI speech immediately.
     */
    function onAlertAudioStart() {
        _audioState.isAlertPlaying = true;
        _audioState.lastAlertTs = Date.now();

        // Cancel AI speech if active
        if (_audioState.isAiSpeaking) {
            _audioState.isAiSpeaking = false;
            if (log) log.info("audio_interrupt", {
                reason: "alert_priority",
                ai_was_speaking: true,
            });
            // Emit event for AI panel to stop
            StormState.emit("aiSpeechCancelled", { reason: "alert_priority" });
        }
    }

    /**
     * Called when alert audio finishes.
     */
    function onAlertAudioEnd() {
        _audioState.isAlertPlaying = false;
    }

    /**
     * Called when AI narration starts.
     */
    function onAiSpeechStart() {
        if (_audioState.isAlertPlaying) {
            // Don't allow AI to start during alert
            if (log) log.info("ai_suppressed", { reason: "alert_active_on_ai_start" });
            StormState.emit("aiSpeechCancelled", { reason: "alert_active" });
            return false;
        }
        _audioState.isAiSpeaking = true;
        return true;
    }

    /**
     * Called when AI narration ends.
     */
    function onAiSpeechEnd() {
        _audioState.isAiSpeaking = false;
    }

    function getAudioState() {
        return { ..._audioState };
    }

    // ── Voice Persistence ───────────────────────────────────────────

    function _initVoices() {
        const voices = window.speechSynthesis.getVoices();
        if (!voices || voices.length === 0) return;

        const savedName = localStorage.getItem("st_speech_voice");
        if (savedName) {
            const match = voices.find(v => v.name === savedName);
            if (match) {
                _selectedVoice = match;
                if (log) log.info("voice_restored", { name: match.name, lang: match.lang });
                return;
            }
        }

        const english = voices.filter(v => v.lang && v.lang.startsWith("en"));
        const preferred = english.find(v => v.default) || english[0] || voices[0];

        if (preferred) {
            _selectedVoice = preferred;
            localStorage.setItem("st_speech_voice", preferred.name);
            if (log) log.info("voice_selected", { name: preferred.name, lang: preferred.lang, count: voices.length });
        }
    }

    // ── Event Handlers ────────────────────────────────────────────

    function _onTargetChanged(data) {
        if (!data.currentTarget) return;

        const alerts = StormState.state.alerts.data || [];
        const alert = alerts.find(a => a.id === data.currentTarget);
        if (!alert) return;

        const isTornado = alert.event && alert.event.toLowerCase().includes("tornado")
            && alert.event.toLowerCase().includes("warning");

        if (isTornado) {
            _trySpeak("tornado:" + alert.id, "tornado_warning", alert, data.intensity);
        } else {
            _trySpeak("target:" + alert.id, "target_acquired", alert, data.intensity);
        }
    }

    function _onIntensityChanged(data) {
        if (!data.targetId) return;

        const alerts = StormState.state.alerts.data || [];
        const alert = alerts.find(a => a.id === data.targetId);
        if (!alert) return;

        const prevOrd = _intensityOrd(data.prevIntensity);
        const currOrd = _intensityOrd(data.currentIntensity);
        if (currOrd <= prevOrd) return;

        _trySpeak("escalation:" + data.targetId + ":" + data.currentIntensity,
            "severity_escalation", alert, data.currentIntensity);
    }

    function _checkImpactRadius() {
        const impactActive = StormState.state.impactZone.active;
        if (impactActive && !_lastImpactActive) {
            const at = StormState.state.autotrack;
            if (at.enabled && at.targetAlertId) {
                const alerts = StormState.state.alerts.data || [];
                const alert = alerts.find(a => a.id === at.targetAlertId);
                if (alert) {
                    _trySpeak("impact:" + alert.id, "impact_radius_entered", alert, null);
                }
            }
        }
        _lastImpactActive = impactActive;
    }

    function _onModeChanged(data) {
        if (data.mode === "off") {
            AlertState.reset();
            _cancelSpeech();
            _updateStatus(AudioUnlock.isUnlocked() ? "ready" : "locked", "Tracking stopped");
        }
    }

    // ── SINGLE DECISION POINT — Speech Routing ───────────────────
    //
    // ALL spoken alert paths converge here.
    // This function decides: AI voice, legacy voice, or no speech.
    // Pre-tones ALWAYS play regardless of routing decision.

    function _trySpeak(eventKey, triggerType, alert, intensity) {
        // Gate: AudioUnlock (gesture required for any audio)
        if (!AudioUnlock.canSpeak()) {
            if (log) log.info("alert_skipped", {
                eventKey: eventKey.slice(-30), triggerType,
                reason: "audio_locked", event: alert.event,
            });
            _updateStatus("locked", "Speech blocked — click to unlock");
            return;
        }

        // Gate: AlertState cooldown/priority/de-dupe
        const check = AlertState.canSpeak(eventKey, triggerType);
        if (!check.allowed) {
            if (log) log.info("alert_skipped", {
                eventKey: eventKey.slice(-30), triggerType,
                reason: check.reason, event: alert.event,
            });
            _updateStatus("suppressed", "Skipped: " + check.reason);
            return;
        }

        // Gate: interrupt check (applies to legacy path)
        const newPriority = PRIORITY_ORD[triggerType] || 0;

        // Generate the alert message text (always — AlertEngine is the message author)
        const message = generateAlertMessage(triggerType, alert, intensity);
        if (!message) return;

        // Pre-tone ALWAYS plays (not gated by speech toggle)
        const profile = VOICE_PROFILES[triggerType] || VOICE_PROFILES.target_acquired;
        _playPreTone(profile.toneHz, profile.toneMs, () => {});

        // ── ROUTING DECISION ──────────────────────────────────────
        const aiEnabled = typeof AIPanel !== "undefined" && AIPanel.isEnabled();
        const aiHealthy = typeof AIPanel !== "undefined" && AIPanel.isHealthy();

        let engine = "none";
        let reason = "";

        if (aiEnabled && aiHealthy) {
            // RULE 1: AI is PRIMARY — always route to AI when available
            engine = "ai";
            reason = "preferred";
        } else if (aiEnabled && !aiHealthy && _legacyEnabled) {
            // RULE 2: AI enabled but unhealthy — fallback to legacy
            engine = "legacy";
            reason = "ai_unhealthy";
        } else if (!aiEnabled && _legacyEnabled) {
            // RULE 3: AI off — use legacy
            engine = "legacy";
            reason = "ai_disabled";
        } else {
            // RULE 4: Both off — no speech
            engine = "none";
            reason = "both_disabled";
        }

        // Log routing decision
        if (log) log.info("audio_route", {
            engine, reason, triggerType,
            event: alert.event,
            eventKey: eventKey.slice(-30),
            aiEnabled, aiHealthy, legacyEnabled: _legacyEnabled,
        });

        // ── EXECUTE ROUTED SPEECH ─────────────────────────────────

        if (engine === "ai") {
            // Cancel any existing AI speech before new alert
            if (typeof AIPanel !== "undefined" && AIPanel.cancelSpeech) {
                AIPanel.cancelSpeech("alert_route");
            }
            // Route to AI voice
            AIPanel.speakAlert(message, triggerType);
            AlertState.markSpoken(eventKey, triggerType);
            _lastSpeechEvent = { eventKey, triggerType, intensity, message, ts: Date.now(), engine: "ai" };

        } else if (engine === "legacy") {
            // Legacy path: interrupt check + speak
            if (!_shouldInterrupt(newPriority)) {
                if (log) log.info("alert_skipped", {
                    eventKey: eventKey.slice(-30), triggerType,
                    reason: "lower_priority_active",
                });
                return;
            }
            const spoken = _speakLegacy(message, triggerType);
            if (spoken) {
                AlertState.markSpoken(eventKey, triggerType);
                _lastSpeechEvent = { eventKey, triggerType, intensity, message, ts: Date.now(), engine: "legacy" };
            }

        } else {
            // No speech — log blocked
            if (log) log.info("audio_blocked", {
                reason, triggerType, event: alert.event,
            });
            _updateStatus("suppressed", "Speech disabled");
        }
    }

    function _shouldInterrupt(newPriority) {
        if (_activePriority === null) return true;
        return newPriority >= _activePriority;
    }

    // ── Message Generation ──────────────────────────────────────

    function generateAlertMessage(triggerType, alert, intensity) {
        if (!alert) return null;

        const motion = _getMotionContext(alert.id);
        const dirPhrase = motion ? " moving " + motion.direction : "";
        const speedPhrase = motion && motion.speedMph ? " at " + Math.round(motion.speedMph) + " miles per hour" : "";

        switch (triggerType) {
            case "tornado_warning":
                return "Tornado warning." + dirPhrase + ". Immediate attention required.";
            case "severity_escalation":
                return "Storm intensifying. " + _intensityLabel(intensity) + " severity detected" + dirPhrase + ".";
            case "impact_radius_entered":
                return "Storm approaching impact zone" + dirPhrase + speedPhrase + ".";
            case "target_acquired":
                return "Storm tracking initiated. " + _shortEventName(alert.event) + dirPhrase + ".";
            default:
                return null;
        }
    }

    // ── Legacy TTS Engine (gated behind _legacyEnabled) ──────────

    function _speakLegacy(text, triggerType) {
        if (!_speechAvailable || !AudioUnlock.canSpeak()) return false;

        try {
            const wasSpeaking = _speaking;
            window.speechSynthesis.cancel();
            if (_speakTimer) { clearTimeout(_speakTimer); _speakTimer = null; }

            // Cancel any AI speech too
            if (typeof AIPanel !== "undefined" && AIPanel.cancelSpeech) {
                AIPanel.cancelSpeech("legacy_priority");
            }

            if (wasSpeaking && log) {
                log.info("speech_overlap_prevented", {
                    action: "cancel_replace", prevPriority: _activePriority, newTrigger: triggerType,
                });
            }

            const profile = VOICE_PROFILES[triggerType] || VOICE_PROFILES.target_acquired;
            const newPriority = PRIORITY_ORD[triggerType] || 0;
            _activePriority = newPriority;
            const fullText = profile.prefix + text;

            // Speak after small delay (tone already played in _trySpeak)
            _speakTimer = setTimeout(() => {
                _speakTimer = null;
                _doSpeak(fullText, profile, triggerType);
            }, 130);  // 130ms = tone duration + gap

            return true;
        } catch (e) {
            _activePriority = null;
            if (log) log.warn("alert_error", { error: e.message, text: text.slice(0, 50) });
            _updateStatus("error", e.message);
            return false;
        }
    }

    function _doSpeak(text, profile, triggerType) {
        try {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = profile.rate;
            utterance.pitch = profile.pitch;
            utterance.volume = 1.0;

            if (_selectedVoice) utterance.voice = _selectedVoice;

            utterance.onstart = () => {
                _speaking = true;
                _lastSpokenMessage = text;
                _updateStatus("speaking", text.slice(0, 40));
                if (log) log.info("speech_start", {
                    triggerType, rate: profile.rate, pitch: profile.pitch,
                    voice: _selectedVoice ? _selectedVoice.name : "default",
                    priority: _activePriority, engine: "legacy",
                });
            };

            utterance.onend = () => {
                _speaking = false;
                _activePriority = null;
                _updateStatus("ready", "Last: " + text.slice(0, 30));
                if (log) log.info("speech_end", { triggerType, engine: "legacy" });
            };

            utterance.onerror = (e) => {
                _speaking = false;
                _activePriority = null;
                const errType = e.error || "unknown";
                _updateStatus("error", errType);
                if (log) log.warn("alert_error", { error: errType, text: text.slice(0, 50), triggerType });
            };

            window.speechSynthesis.speak(utterance);
        } catch (e) {
            _speaking = false;
            _activePriority = null;
            if (log) log.warn("alert_error", { error: e.message, text: text.slice(0, 50) });
        }
    }

    function _cancelSpeech() {
        if (_speechAvailable) {
            try { window.speechSynthesis.cancel(); } catch (e) { /* safe */ }
        }
        if (_speakTimer) { clearTimeout(_speakTimer); _speakTimer = null; }
        _speaking = false;
        _activePriority = null;
    }

    // ── Pre-Attention Tone (ALWAYS plays — not gated by toggle) ──

    function _playPreTone(freqHz, durationMs, onDone) {
        const ctx = typeof AudioUnlock !== "undefined" ? AudioUnlock.getAudioContext() : null;

        if (!ctx || ctx.state !== "running") {
            if (onDone) onDone();
            return;
        }

        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = freqHz;
            gain.gain.value = 0.15;

            osc.connect(gain);
            gain.connect(ctx.destination);

            const now = ctx.currentTime;
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
            gain.gain.linearRampToValueAtTime(0, now + durationMs / 1000);

            osc.start(now);
            osc.stop(now + durationMs / 1000);

            osc.onended = () => {
                osc.disconnect();
                gain.disconnect();
                if (onDone) onDone();
            };
        } catch (e) {
            if (onDone) onDone();
        }
    }

    // ── UI Status Indicator ─────────────────────────────────────────

    function _updateStatus(state, detail) {
        const el = document.getElementById("speech-status");
        if (!el) return;
        el.className = "speech-status speech-status--" + state;
        el.textContent = _statusLabel(state) + (detail ? " — " + detail : "");
        el.classList.remove("hidden");
    }

    function _statusLabel(state) {
        return ({ locked: "SPEECH LOCKED", ready: "SPEECH READY", speaking: "SPEAKING",
            suppressed: "SUPPRESSED", error: "SPEECH ERROR", unavailable: "SPEECH N/A" })[state] || state.toUpperCase();
    }

    function getStatus() {
        return {
            available: _speechAvailable,
            unlocked: typeof AudioUnlock !== "undefined" ? AudioUnlock.isUnlocked() : false,
            speaking: _speaking,
            activePriority: _activePriority,
            voice: _selectedVoice ? _selectedVoice.name : null,
            lastMessage: _lastSpokenMessage,
            lastEvent: _lastSpeechEvent,
            legacyEnabled: _legacyEnabled,
        };
    }

    // ── Helpers ─────────────────────────────────────────────────────

    function _getMotionContext(alertId) {
        const v = StormState.state.motion.vectors[alertId];
        if (!v || v.speedMph < 2) return null;
        return { direction: _bearingToCompass(v.bearingDeg), speedMph: v.speedMph };
    }

    function _intensityOrd(level) {
        return ({ low: 0, moderate: 1, high: 2, extreme: 3 })[level] || 0;
    }

    function _intensityLabel(level) {
        return ({ low: "Low", moderate: "Moderate", high: "High", extreme: "Extreme" })[level] || "Unknown";
    }

    function _shortEventName(event) {
        if (!event) return "Alert";
        if (event.includes("Tornado") && event.includes("Warning")) return "Tornado warning";
        if (event.includes("Severe") && event.includes("Thunderstorm")) return "Severe thunderstorm warning";
        if (event.includes("Flash Flood")) return "Flash flood warning";
        return event;
    }

    // ── Public API ──────────────────────────────────────────────────

    function isSpeaking() { return _speaking; }

    return {
        init,
        generateAlertMessage,
        isSpeaking,
        isLegacyEnabled,
        setLegacyEnabled,
        getStatus,
        shouldSuppressAi,
        onAlertAudioStart,
        onAlertAudioEnd,
        onAiSpeechStart,
        onAiSpeechEnd,
        getAudioState,
        forceUnlock: function() { if (typeof AudioUnlock !== "undefined") AudioUnlock.forceUnlock(); },
    };
})();
