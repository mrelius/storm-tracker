/**
 * Storm Tracker — Audio Follow Module
 *
 * Adds audio-follow behavior to Auto Track mode. When enabled and Auto Track
 * is active, automatically routes audio to NOAA or scanner streams based on
 * the currently tracked event type.
 *
 * Ownership model: manual audio always wins. Auto-follow only controls streams
 * it started. Tornado warnings may override immediately; all other events
 * require stability + debounce before switching.
 *
 * Additive only. Zero side effects when disabled or when Auto Track is off.
 * Does NOT listen to map interaction/drag pause state.
 */
const AudioFollow = (function () {

    // ── Stream Registry ─────────────────────────────────────────────────
    // Configurable stream URLs. Add/remove entries as needed.
    const STREAMS = {
        noaa: {
            label: "NOAA Weather Radio",
            urls: [
                "https://broadcastify.cdnstream1.com/33645",
                "https://broadcastify.cdnstream1.com/22514",
            ],
            urlIndex: 0,
        },
        spotter: {
            label: "Spotter Network",
            urls: [],
            urlIndex: 0,
        },
        scanner: {
            label: "Scanner",
            urls: [
                "https://broadcastify.cdnstream1.com/14439",
            ],
            urlIndex: 0,
        },
    };

    // ── Routing Table ────────────────────────────────────────────────────
    // NOAA preferred, Spotter fallback. Scanner is manual-only (never auto-selected).
    const AUTO_ROUTING = {
        tornado_warning: {
            chain: ["noaa", "spotter"],
            priority: 100,
            immediateOverride: true,
        },
        severe_thunderstorm_warning: {
            chain: ["noaa", "spotter"],
            priority: 50,
            immediateOverride: false,
        },
    };

    // Fixed-mode routing — user explicitly picks source
    const FIXED_ROUTING = {
        noaa:    { chain: ["noaa", "spotter"], immediateOverride: false },
        spotter: { chain: ["spotter", "noaa"], immediateOverride: false },
        scanner: { chain: ["scanner"],         immediateOverride: false },
    };

    // ── Timing Constants ────────────────────────────────────────────────
    const STABILITY_MS       = 9000;   // 9s — target must be stable before normal switch
    const DEBOUNCE_MS        = 2000;   // 2s — blocks re-eval after target update
    const COOLDOWN_MS        = 5000;   // 5s — blocks further switches after a switch
    const GRACE_MS           = 12000;  // 12s — wait before stopping on target loss
    const PROBE_TIMEOUT_MS   = 2500;   // 2.5s — availability probe timeout
    const PROBE_CACHE_MS     = 45000;  // 45s — cache probe result
    const PROBE_FAIL_LIMIT   = 2;      // mark degraded after N consecutive failures
    const TIMER_TICK_MS      = 500;    // UI countdown tick interval

    // ── Internal State ──────────────────────────────────────────────────
    let audioEl = null;
    let currentVolume = 0.7;
    let resolvedSourceLabel = "";      // area label for UI (e.g. "Wilmington OH")

    // Availability probe cache: { available: bool, checkedAt: epoch, failCount: int }
    const probeCache = {
        noaa: { available: null, checkedAt: 0, failCount: 0 },
        spotter: { available: null, checkedAt: 0, failCount: 0 },
        scanner: { available: null, checkedAt: 0, failCount: 0 },
    };

    // Timer handles
    let stabilityTimer = null;
    let debounceTimer = null;
    let cooldownTimer = null;
    let graceTimer = null;
    let tickTimer = null;

    // Last tracked target ID to detect meaningful changes
    let lastTrackedTargetId = null;
    let lastTrackedEventClass = null;

    // ── NOAA Test Mode ────────────────────────────────────────────────
    const NOAA_TEST_DURATION_MS = 12000;  // 12 seconds
    let testState = {
        active: false,
        startedAt: 0,
        endsAt: 0,
        timer: null,
        tickTimer: null,
    };
    let testLog = null;

    function triggerNoaaTest() {
        if (testState.active) {
            if (testLog) testLog.info("AUDIO_TEST_IGNORED_ALREADY_RUNNING", { timestamp: Date.now() });
            return;
        }

        if (!testLog && typeof STLogger !== "undefined") {
            testLog = STLogger.for("audio_test");
        }

        const now = Date.now();
        testState.active = true;
        testState.startedAt = now;
        testState.endsAt = now + NOAA_TEST_DURATION_MS;

        if (testLog) testLog.info("AUDIO_TEST_START", {
            timestamp: now,
            duration_ms: NOAA_TEST_DURATION_MS,
        });

        // Force NOAA playback, bypass all routing/debounce
        const af = StormState.state.audioFollow;
        const prevSource = af.currentSource;
        const prevOwner = af.owner;

        af.currentSource = "noaa";
        af.owner = "test";
        af.status = "live";

        startPlayback("noaa");
        _updateTestUI(true);

        // Countdown tick
        testState.tickTimer = setInterval(_updateTestCountdown, 500);

        // Self-terminating timer
        testState.timer = setTimeout(function () {
            _endNoaaTest(prevSource, prevOwner);
        }, NOAA_TEST_DURATION_MS);
    }

    function _endNoaaTest(prevSource, prevOwner) {
        if (!testState.active) return;

        if (testState.tickTimer) { clearInterval(testState.tickTimer); testState.tickTimer = null; }
        if (testState.timer) { clearTimeout(testState.timer); testState.timer = null; }

        const af = StormState.state.audioFollow;
        const streamWasPlaying = audioEl && !audioEl.paused && audioEl.src;
        const result = streamWasPlaying ? "success" : "stream_fail";

        testState.active = false;
        testState.startedAt = 0;
        testState.endsAt = 0;

        if (testLog) testLog.info("AUDIO_TEST_END", {
            timestamp: Date.now(),
            duration_ms: NOAA_TEST_DURATION_MS,
            result: result,
        });

        // Stop test playback
        stopPlayback("test_ended");

        // Restore previous state — let normal routing take over
        af.owner = null;
        af.currentSource = null;
        af.status = "idle";

        _updateTestUI(false);
        updateUI();
        emitDebug();
    }

    function _updateTestUI(active) {
        const indicator = document.getElementById("audio-test-indicator");
        if (indicator) {
            indicator.classList.toggle("audio-test-active", active);
            indicator.textContent = active ? "NOAA TEST" : "";
        }
        const btn = document.getElementById("btn-noaa-test");
        if (btn) btn.disabled = active;
    }

    function _updateTestCountdown() {
        if (!testState.active) return;
        const remaining = Math.max(0, Math.ceil((testState.endsAt - Date.now()) / 1000));
        const indicator = document.getElementById("audio-test-indicator");
        if (indicator && testState.active) {
            indicator.textContent = `NOAA TEST ${remaining}s`;
        }
    }

    function isTestActive() {
        return testState.active;
    }

    // ── Init ────────────────────────────────────────────────────────────

    function init() {
        // Create the audio element (hidden, no controls)
        audioEl = document.createElement("audio");
        audioEl.id = "audio-follow-player";
        audioEl.preload = "none";
        audioEl.volume = currentVolume;
        document.body.appendChild(audioEl);

        audioEl.addEventListener("playing", onAudioPlaying);
        audioEl.addEventListener("error", onAudioError);
        audioEl.addEventListener("pause", onAudioPause);

        // Prime the audio element on first real user gesture so browser
        // allows future .play() calls from non-gesture contexts
        document.addEventListener("click", function primeAudio() {
            if (audioEl && audioEl.paused && !audioEl.src) {
                // Silent play+pause primes the element
                audioEl.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
                audioEl.play().then(() => { audioEl.pause(); audioEl.removeAttribute("src"); }).catch(() => {});
            }
            document.removeEventListener("click", primeAudio);
        });

        // UI toggle button
        const btn = document.getElementById("btn-audio-follow-toggle");
        if (btn) btn.addEventListener("click", toggleEnabled);

        // Listen to autotrack events — NOT map interaction
        StormState.on("autotrackTargetChanged", onTargetChanged);
        StormState.on("autotrackChanged", onAutoTrackModeChanged);

        // Detect manual audio actions on the same audio element
        // (Manual play from external control would set owner to manual)

        // Start tick timer for UI countdowns
        tickTimer = setInterval(tickCountdowns, TIMER_TICK_MS);

        // NOAA test button
        const testBtn = document.getElementById("btn-noaa-test");
        if (testBtn) testBtn.addEventListener("click", triggerNoaaTest);

        // Keyboard shortcut: Shift+T for NOAA test
        document.addEventListener("keydown", (e) => {
            if (e.shiftKey && e.key === "T" && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                triggerNoaaTest();
            }
        });

        updateUI();
    }

    // ── Toggle ──────────────────────────────────────────────────────────

    function toggleEnabled() {
        const af = StormState.state.audioFollow;
        af.enabled = !af.enabled;

        if (af.enabled) {
            // If autotrack is active and has a target, evaluate immediately
            const at = StormState.state.autotrack;
            if (at.mode !== "off" && at.targetAlertId) {
                evaluateRouting("enable_toggle");
            }
        } else {
            // Disable: stop only if auto-follow owns playback
            if (af.owner === "auto-follow") {
                stopPlayback("disabled");
            }
            clearAllTimers();
            af.status = "idle";
            af.pendingSwitch = null;
            af.targetEvent = null;
        }

        updateUI();
        emitDebug();
        // Trigger session save
        StormState.emit("audioFollowChanged", { enabled: af.enabled });
    }

    // ── Event Handlers ──────────────────────────────────────────────────

    function onTargetChanged(targetId) {
        if (testState.active) return; // test mode blocks target changes
        const af = StormState.state.audioFollow;
        if (!af.enabled) return;

        const at = StormState.state.autotrack;
        if (at.mode === "off") return;

        // TFE-driven path: resolve target from TFE outputs
        let effectiveTargetId = targetId;
        let effectiveTargetEvent = at.targetEvent;
        if (typeof ThreatFocusEngine !== "undefined" && ThreatFocusEngine.useThreatFocusEngine()) {
            const outputs = ThreatFocusEngine.getDerivedOutputs();
            effectiveTargetId = outputs.audioTargetEventId;
            if (effectiveTargetId) {
                const alerts = StormState.state.alerts.data || [];
                const alert = alerts.find(a => a.id === effectiveTargetId);
                effectiveTargetEvent = alert ? alert.event : at.targetEvent;
            }
        }

        // Detect meaningful change: new target ID or target lost
        if (effectiveTargetId === lastTrackedTargetId) {
            setDecision(af.targetEvent, null, null, af.currentSource, "same_target_noop");
            emitDebug();
            return;
        }

        lastTrackedTargetId = effectiveTargetId;

        if (!effectiveTargetId) {
            onTargetLost();
            return;
        }

        // New target — resolve event class
        const eventClass = resolveEventClass(effectiveTargetEvent);
        lastTrackedEventClass = eventClass;

        if (!eventClass || !AUTO_ROUTING[eventClass]) {
            // Not a qualifying event — treat as target lost for audio purposes
            onTargetLost();
            return;
        }

        // Cancel grace if active (new valid target appeared)
        if (graceTimer) {
            clearTimeout(graceTimer);
            graceTimer = null;
            af.graceUntil = null;
            af.status = af.currentSource ? "live" : "idle";
        }

        af.targetEvent = eventClass;

        // Resolve location-aware audio sources for this target
        _resolveSourcesForTarget(targetId);

        evaluateRouting("target_changed");
    }

    function onAutoTrackModeChanged(data) {
        const af = StormState.state.audioFollow;
        const { mode } = data;

        if (mode === "off") {
            // Auto Track turned off — stop if auto-follow owns
            if (af.owner === "auto-follow") {
                stopPlayback("autotrack_off");
            }
            clearAllTimers();
            af.status = "idle";
            af.targetEvent = null;
            af.pendingSwitch = null;
            lastTrackedTargetId = null;
            lastTrackedEventClass = null;
            updateUI();
            emitDebug();
            return;
        }

        // Mode turned on or changed (track <-> interrogate)
        if (af.enabled) {
            const at = StormState.state.autotrack;
            if (at.targetAlertId) {
                lastTrackedTargetId = at.targetAlertId;
                const eventClass = resolveEventClass(at.targetEvent);
                lastTrackedEventClass = eventClass;
                af.targetEvent = eventClass;
                evaluateRouting("mode_changed");
            }
        }
        updateUI();
        emitDebug();
    }

    function onTargetLost() {
        const af = StormState.state.audioFollow;

        // Clear pending switch if any
        if (stabilityTimer) {
            clearTimeout(stabilityTimer);
            stabilityTimer = null;
            af.stabilityUntil = null;
            af.pendingSwitch = null;
        }

        af.targetEvent = null;
        lastTrackedEventClass = null;

        if (af.owner !== "auto-follow") {
            // Manual owns playback or nothing playing — don't touch
            setDecision(null, null, null, null, "manual_owner_preserved");
            af.status = af.currentSource ? "live" : "idle";
            updateUI();
            emitDebug();
            return;
        }

        // Auto-follow owns — enter grace period
        if (af.currentSource) {
            af.status = "grace";
            af.graceUntil = Date.now() + GRACE_MS;
            setDecision(null, null, null, af.currentSource, "no_target_enter_grace");

            if (graceTimer) clearTimeout(graceTimer);
            graceTimer = setTimeout(() => {
                graceTimer = null;
                af.graceUntil = null;
                // Still no target after grace — stop
                if (!af.targetEvent && af.owner === "auto-follow") {
                    stopPlayback("grace_expired");
                }
                updateUI();
                emitDebug();
            }, GRACE_MS);
        } else {
            af.status = "idle";
            setDecision(null, null, null, null, "no_target_idle");
        }

        updateUI();
        emitDebug();
    }

    // ── Routing Engine ──────────────────────────────────────────────────

    function _resolveSourcesForTarget(targetId) {
        if (typeof AudioSourceLookup === "undefined") return;

        // Find the alert to get sender info
        const alert = StormState.state.alerts.data.find(a => a.id === targetId);
        const sender = alert ? (alert.sender || "") : "";

        // Get user overrides from settings
        let userOvr = {};
        try {
            const s = JSON.parse(localStorage.getItem("storm_tracker_settings") || "{}");
            userOvr = s.audioSources || {};
        } catch (e) { /* ok */ }

        const resolved = AudioSourceLookup.resolve({
            sender: sender,
            userOverrides: {
                noaa: (userOvr.noaa && userOvr.noaa.length > 0) ? userOvr.noaa : null,
                spotter: (userOvr.spotter && userOvr.spotter.length > 0) ? userOvr.spotter : null,
                scanner: (userOvr.scanner && userOvr.scanner.length > 0) ? userOvr.scanner : null,
            },
        });

        // Push resolved URLs into STREAMS registry
        for (const type of ["noaa", "spotter", "scanner"]) {
            const r = resolved[type];
            if (r && r.urls && r.urls.length > 0) {
                STREAMS[type].urls = r.urls;
                STREAMS[type].urlIndex = 0;
                // Reset probe cache for fresh probing
                if (probeCache[type]) {
                    probeCache[type].available = null;
                    probeCache[type].checkedAt = 0;
                    probeCache[type].failCount = 0;
                }
            }
        }

        // Store label for UI
        const activeType = StormState.state.audioFollow.currentSource;
        if (activeType && resolved[activeType]) {
            resolvedSourceLabel = resolved[activeType].label;
        } else if (resolved.noaa) {
            resolvedSourceLabel = resolved.noaa.label;
        } else {
            resolvedSourceLabel = "";
        }
    }

    function _getSourceMode() {
        // Read from normalized state, fall back to settings localStorage
        const policy = StormState.state.audioFollow.policy;
        if (policy === "noaa_preferred") return "noaa";
        if (policy === "spotter_preferred") return "spotter";
        if (policy === "scanner_only") return "scanner";
        // Legacy fallback
        try {
            const s = JSON.parse(localStorage.getItem("storm_tracker_settings") || "{}");
            return s.audioSourceMode || "noaa";
        } catch (e) { return "noaa"; }
    }

    function _resolveRoute(eventClass) {
        // Returns { chain: [...], immediateOverride: bool, prefer: string, fallback: string }
        const mode = _getSourceMode();

        if (mode !== "auto" && FIXED_ROUTING[mode]) {
            const fixed = FIXED_ROUTING[mode];
            return {
                chain: fixed.chain,
                immediateOverride: fixed.immediateOverride,
                prefer: fixed.chain[0],
                fallback: fixed.chain[1] || null,
            };
        }

        // Auto mode — use event-specific routing
        const auto = AUTO_ROUTING[eventClass];
        if (!auto) return null;
        return {
            chain: auto.chain,
            immediateOverride: auto.immediateOverride,
            prefer: auto.chain[0],
            fallback: auto.chain[1] || null,
        };
    }

    async function evaluateRouting(trigger) {
        // Test mode blocks all normal routing
        if (testState.active) return;

        const af = StormState.state.audioFollow;
        const eventClass = af.targetEvent;

        if (!eventClass) {
            setDecision(eventClass, null, null, null, "no_route_for_event");
            updateUI();
            emitDebug();
            return;
        }

        const route = _resolveRoute(eventClass);
        if (!route) {
            setDecision(eventClass, null, null, null, "no_route_for_event");
            updateUI();
            emitDebug();
            return;
        }

        // Check debounce
        if (af.debounceUntil && Date.now() < af.debounceUntil) {
            setDecision(eventClass, route.prefer, route.fallback, af.currentSource, "debounce_blocked");
            updateUI();
            emitDebug();
            return;
        }

        // Start debounce
        af.debounceUntil = Date.now() + DEBOUNCE_MS;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            af.debounceUntil = null;
            emitDebug();
        }, DEBOUNCE_MS);

        // Probe the chain in order — first available wins
        let chosenSource = null;
        for (const src of route.chain) {
            const avail = await probeSource(src);
            if (avail) { chosenSource = src; break; }
        }

        if (!chosenSource) {
            af.status = "unavailable";
            af.pendingSwitch = null;
            if (stabilityTimer) { clearTimeout(stabilityTimer); stabilityTimer = null; af.stabilityUntil = null; }
            setDecision(eventClass, route.prefer, route.fallback, null, "source_unavailable");
            updateUI();
            emitDebug();
            return;
        }

        // If same source already playing and auto-follow owns it, no-op
        if (chosenSource === af.currentSource && af.owner === "auto-follow" && af.status === "live") {
            setDecision(eventClass, route.prefer, route.fallback, chosenSource, "same_source_noop");
            updateUI();
            emitDebug();
            return;
        }

        // Check ownership: if manual owns playback, preserve unless tornado override
        if (af.owner === "manual" && !route.immediateOverride) {
            setDecision(eventClass, route.prefer, route.fallback, af.currentSource, "manual_owner_preserved");
            updateUI();
            emitDebug();
            return;
        }

        // Check cooldown (tornado may bypass)
        if (af.cooldownUntil && Date.now() < af.cooldownUntil && !route.immediateOverride) {
            setDecision(eventClass, route.prefer, route.fallback, af.currentSource, "cooldown_blocked");
            af.pendingSwitch = { source: chosenSource, reason: "cooldown" };
            af.status = "pending";
            updateUI();
            emitDebug();
            return;
        }

        // Tornado warning: immediate override
        if (route.immediateOverride) {
            executeSwitch(chosenSource, eventClass, "override_tornado");
            return;
        }

        // Normal event: require stability period
        if (stabilityTimer) {
            // Already waiting — update pending target but don't restart timer
            // unless the chosen source changed
            if (af.pendingSwitch && af.pendingSwitch.source === chosenSource) {
                // Same pending — let timer run
                emitDebug();
                return;
            }
            clearTimeout(stabilityTimer);
            stabilityTimer = null;
            af.stabilityUntil = null;
        }

        af.pendingSwitch = { source: chosenSource, reason: "stability_wait" };
        af.status = "pending";
        af.stabilityUntil = Date.now() + STABILITY_MS;
        setDecision(eventClass, route.prefer, route.fallback, chosenSource, "stability_wait");
        updateUI();
        emitDebug();

        stabilityTimer = setTimeout(() => {
            stabilityTimer = null;
            af.stabilityUntil = null;

            // Re-validate: target must still be the same event class
            if (af.targetEvent !== eventClass) {
                af.pendingSwitch = null;
                setDecision(af.targetEvent, null, null, af.currentSource, "stability_expired_target_changed");
                updateUI();
                emitDebug();
                return;
            }

            // Re-check ownership
            if (af.owner === "manual" && !AUTO_ROUTING[eventClass]?.immediateOverride) {
                af.pendingSwitch = null;
                setDecision(eventClass, route.prefer, route.fallback, af.currentSource, "manual_owner_preserved");
                updateUI();
                emitDebug();
                return;
            }

            executeSwitch(chosenSource, eventClass, "stable_switch");
        }, STABILITY_MS);
    }

    function executeSwitch(source, eventClass, reason) {
        const af = StormState.state.audioFollow;

        af.pendingSwitch = null;

        // Start cooldown
        af.cooldownUntil = Date.now() + COOLDOWN_MS;
        if (cooldownTimer) clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => {
            cooldownTimer = null;
            af.cooldownUntil = null;
            emitDebug();
        }, COOLDOWN_MS);

        // Cancel grace if active
        if (graceTimer) {
            clearTimeout(graceTimer);
            graceTimer = null;
            af.graceUntil = null;
        }

        const switchRoute = _resolveRoute(eventClass);
        setDecision(eventClass, switchRoute?.prefer, switchRoute?.fallback, source, reason);

        // If same source type already playing, don't restart
        if (source === af.currentSource && isPlaying()) {
            af.owner = "auto-follow";
            af.status = "live";
            af.manualOverride = false;
            updateUI();
            emitDebug();
            return;
        }

        startPlayback(source);
        af.owner = "auto-follow";
        af.currentSource = source;
        af.status = "live";
        af.manualOverride = false;

        // Update area label for the active source
        if (typeof AudioSourceLookup !== "undefined") {
            try {
                const alert = StormState.state.alerts.data.find(a => a.id === lastTrackedTargetId);
                const sender = alert ? (alert.sender || "") : "";
                let userOvr = {};
                try { userOvr = JSON.parse(localStorage.getItem("storm_tracker_settings") || "{}").audioSources || {}; } catch(e) {}
                const resolved = AudioSourceLookup.resolve({ sender, userOverrides: userOvr });
                if (resolved[source]) resolvedSourceLabel = resolved[source].label;
            } catch (e) { /* ok */ }
        }

        updateUI();
        emitDebug();
    }

    // ── Availability Probes ─────────────────────────────────────────────

    async function probeSource(sourceType) {
        const cache = probeCache[sourceType];
        if (!cache) return false;

        // Return cached if fresh
        if (cache.available !== null && (Date.now() - cache.checkedAt) < PROBE_CACHE_MS) {
            return cache.available;
        }

        const stream = STREAMS[sourceType];
        if (!stream || !stream.urls || stream.urls.length === 0) {
            cache.available = false;
            cache.checkedAt = Date.now();
            return false;
        }

        const url = stream.urls[stream.urlIndex % stream.urls.length];

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

            const resp = await fetch(url, {
                method: "GET",
                headers: { "Range": "bytes=0-1" },
                signal: controller.signal,
                mode: "no-cors",  // streams are cross-origin
            });
            clearTimeout(timeoutId);

            // no-cors: opaque response, status=0 but if we got here it didn't abort
            // For no-cors, any response means reachable
            cache.available = true;
            cache.failCount = 0;
            cache.checkedAt = Date.now();
            return true;
        } catch (e) {
            cache.failCount++;
            if (cache.failCount >= PROBE_FAIL_LIMIT) {
                cache.available = false;
            }
            cache.checkedAt = Date.now();

            // Try next URL in rotation on failure
            stream.urlIndex = (stream.urlIndex + 1) % stream.urls.length;
            return cache.available !== false ? null : false;
        }
    }

    function getSourceHealth(sourceType) {
        const cache = probeCache[sourceType];
        if (!cache) return "unknown";
        if (cache.available === null) return "unchecked";
        if (cache.available === true) return "ok";
        if (cache.failCount >= PROBE_FAIL_LIMIT) return "degraded";
        return "failed";
    }

    // ── Audio Playback ──────────────────────────────────────────────────

    function startPlayback(sourceType) {
        if (!audioEl) return;

        const stream = STREAMS[sourceType];
        if (!stream || !stream.urls || stream.urls.length === 0) return;

        const url = stream.urls[stream.urlIndex % stream.urls.length];

        // Preserve volume
        audioEl.volume = currentVolume;

        try {
            audioEl.src = url;
            audioEl.load();
            const playPromise = audioEl.play();
            if (playPromise && playPromise.catch) {
                playPromise.catch(e => {
                    console.warn("[AudioFollow] Play failed:", e.message);
                    const af = StormState.state.audioFollow;
                    af.status = "unavailable";
                    updateUI();
                    emitDebug();
                });
            }
        } catch (e) {
            console.warn("[AudioFollow] Start playback error:", e.message);
        }
    }

    function stopPlayback(reason) {
        const af = StormState.state.audioFollow;

        if (audioEl) {
            try {
                audioEl.pause();
                audioEl.removeAttribute("src");
                audioEl.load();  // reset
            } catch (e) {
                // Ignore
            }
        }

        af.currentSource = null;
        af.owner = null;
        af.status = "idle";
        af.manualOverride = false;
        af.pendingSwitch = null;

        setDecision(af.targetEvent, null, null, null, reason || "stopped");
        updateUI();
        emitDebug();
    }

    function isPlaying() {
        return audioEl && !audioEl.paused && audioEl.src;
    }

    // Audio element event handlers
    function onAudioPlaying() {
        const af = StormState.state.audioFollow;
        if (af.owner === "auto-follow") {
            af.status = "live";
            updateUI();
            emitDebug();
        }
    }

    function onAudioError() {
        // Handle stream failure during test mode
        if (testState.active) {
            if (testLog) testLog.info("AUDIO_TEST_STREAM_FAIL", { timestamp: Date.now() });
            // Let test timer complete naturally — don't abort early
            return;
        }

        const af = StormState.state.audioFollow;
        if (af.owner === "auto-follow") {
            // Mark source as failed
            if (af.currentSource) {
                const cache = probeCache[af.currentSource];
                if (cache) {
                    cache.failCount++;
                    if (cache.failCount >= PROBE_FAIL_LIMIT) {
                        cache.available = false;
                    }
                    cache.checkedAt = Date.now();
                }

                // Try next source in chain
                const route = af.targetEvent ? _resolveRoute(af.targetEvent) : null;
                if (route && route.chain) {
                    const curIdx = route.chain.indexOf(af.currentSource);
                    for (let i = curIdx + 1; i < route.chain.length; i++) {
                        const fb = route.chain[i];
                        const fbCache = probeCache[fb];
                        if (fbCache && fbCache.available !== false) {
                            executeSwitch(fb, af.targetEvent, "primary_error_fallback");
                            return;
                        }
                    }
                }
            }

            af.status = "unavailable";
            updateUI();
            emitDebug();
        }
    }

    function onAudioPause() {
        // If user manually paused (not our stop), set manual ownership
        const af = StormState.state.audioFollow;
        if (af.owner === "auto-follow" && af.status === "live") {
            // Check if we caused the pause (our stopPlayback removes src)
            if (audioEl.src) {
                // User manually paused — transfer ownership
                af.owner = "manual";
                af.manualOverride = true;
                setDecision(af.targetEvent, null, null, af.currentSource, "manual_pause_override");
                updateUI();
                emitDebug();
            }
        }
    }

    // ── Manual Ownership Interface ──────────────────────────────────────
    // Call these from external manual audio controls to coordinate ownership.

    function notifyManualPlay(sourceType) {
        const af = StormState.state.audioFollow;
        af.owner = "manual";
        af.manualOverride = true;
        if (sourceType) af.currentSource = sourceType;
        af.status = "live";
        setDecision(af.targetEvent, null, null, sourceType, "manual_play_started");
        updateUI();
        emitDebug();
    }

    function notifyManualStop() {
        const af = StormState.state.audioFollow;
        if (af.owner === "manual") {
            af.owner = null;
            af.currentSource = null;
            af.status = "idle";
            af.manualOverride = false;
            setDecision(af.targetEvent, null, null, null, "manual_stop");
            updateUI();
            emitDebug();
        }
    }

    // ── Event Class Normalization ───────────────────────────────────────

    function resolveEventClass(rawEvent) {
        if (!rawEvent) return null;
        const normalized = rawEvent.toLowerCase().replace(/\s+/g, "_");
        // Match against known routing keys
        if (AUTO_ROUTING[normalized]) return normalized;
        // Partial match fallbacks
        if (normalized.includes("tornado") && normalized.includes("warning")) return "tornado_warning";
        if (normalized.includes("severe") && normalized.includes("thunderstorm") && normalized.includes("warning")) return "severe_thunderstorm_warning";
        return null;
    }

    // ── Decision Logging ────────────────────────────────────────────────

    function setDecision(targetEvent, preferred, fallback, chosen, reason) {
        StormState.state.audioFollow.lastDecision = {
            targetEvent: targetEvent || null,
            preferred: preferred || null,
            fallback: fallback || null,
            chosen: chosen || null,
            reason: reason,
            timestamp: Date.now(),
        };
    }

    // ── Timer Management ────────────────────────────────────────────────

    function clearAllTimers() {
        const af = StormState.state.audioFollow;
        if (stabilityTimer) { clearTimeout(stabilityTimer); stabilityTimer = null; }
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        af.stabilityUntil = null;
        af.debounceUntil = null;
        af.cooldownUntil = null;
        af.graceUntil = null;
    }

    function tickCountdowns() {
        // Update UI if any active timer is ticking
        const af = StormState.state.audioFollow;
        if (!af.enabled) return;
        const now = Date.now();
        const hasActive = (af.stabilityUntil && now < af.stabilityUntil) ||
                          (af.graceUntil && now < af.graceUntil) ||
                          (af.cooldownUntil && now < af.cooldownUntil) ||
                          (af.debounceUntil && now < af.debounceUntil);
        if (hasActive) {
            updateUI();
        }
    }

    // ── UI Rendering ────────────────────────────────────────────────────

    function updateUI() {
        const strip = document.getElementById("audio-follow-strip");
        if (!strip) return;

        const af = StormState.state.audioFollow;
        const at = StormState.state.autotrack;

        // Toggle button
        const btn = document.getElementById("btn-audio-follow-toggle");
        if (btn) {
            btn.classList.toggle("af-enabled", af.enabled);
            btn.classList.toggle("af-disabled", !af.enabled);
            btn.textContent = af.enabled ? "AF" : "AF";
            btn.title = af.enabled ? "Audio Follow: ON (click to disable)" : "Audio Follow: OFF (click to enable)";
        }

        // Hide strip if disabled or autotrack off
        if (!af.enabled || at.mode === "off") {
            strip.classList.add("hidden");
            return;
        }

        strip.classList.remove("hidden");

        const now = Date.now();
        const parts = [];

        // Source indicator
        if (af.currentSource) {
            const srcName = af.currentSource === "noaa" ? "NOAA"
                : af.currentSource === "spotter" ? "Spotter"
                : "Scanner";
            const areaStr = resolvedSourceLabel ? ` \u00b7 ${resolvedSourceLabel}` : "";
            parts.push(`<span class="af-source af-source-${af.currentSource}">${srcName}${areaStr}</span>`);
        }

        // Status
        const statusClass = {
            idle: "af-status-idle",
            live: "af-status-live",
            pending: "af-status-pending",
            unavailable: "af-status-unavail",
            grace: "af-status-grace",
        }[af.status] || "af-status-idle";
        parts.push(`<span class="af-status ${statusClass}">${af.status}</span>`);

        // Event being followed
        if (af.targetEvent) {
            const eventLabel = af.targetEvent === "tornado_warning" ? "TOR" : "SVR";
            parts.push(`<span class="af-event">${eventLabel}</span>`);
        }

        // Pending countdown
        if (af.status === "pending" && af.stabilityUntil && now < af.stabilityUntil) {
            const remain = Math.ceil((af.stabilityUntil - now) / 1000);
            parts.push(`<span class="af-countdown">Switch in ${remain}s</span>`);
        }

        // Grace countdown
        if (af.status === "grace" && af.graceUntil && now < af.graceUntil) {
            const remain = Math.ceil((af.graceUntil - now) / 1000);
            parts.push(`<span class="af-countdown">Stop in ${remain}s</span>`);
        }

        // Manual override indicator
        if (af.manualOverride) {
            parts.push(`<span class="af-manual">MANUAL</span>`);
        }

        // Countdown progress bar
        let barHtml = "";
        if (af.status === "pending" && af.stabilityUntil && now < af.stabilityUntil) {
            const pct = Math.max(0, ((af.stabilityUntil - now) / STABILITY_MS) * 100);
            barHtml = `<div class="af-countdown-bar af-bar-pending" style="width:${pct}%"></div>`;
        } else if (af.status === "grace" && af.graceUntil && now < af.graceUntil) {
            const pct = Math.max(0, ((af.graceUntil - now) / GRACE_MS) * 100);
            barHtml = `<div class="af-countdown-bar af-bar-grace" style="width:${pct}%"></div>`;
        }

        strip.innerHTML = parts.join("") + barHtml;
    }

    // ── Debug State ─────────────────────────────────────────────────────

    function getDebugState() {
        const af = StormState.state.audioFollow;
        const now = Date.now();

        const route = af.targetEvent ? _resolveRoute(af.targetEvent) : null;

        return {
            enabled: af.enabled,
            owner: af.owner,
            currentSource: af.currentSource,
            targetEvent: af.targetEvent,
            status: af.status,
            manualOverride: af.manualOverride,
            sourceMode: _getSourceMode(),
            preferredSource: route ? route.prefer : null,
            fallbackSource: route ? route.fallback : null,
            actualSource: af.currentSource,
            debounceRemain: af.debounceUntil ? Math.max(0, Math.ceil((af.debounceUntil - now) / 1000)) : 0,
            stabilityRemain: af.stabilityUntil ? Math.max(0, Math.ceil((af.stabilityUntil - now) / 1000)) : 0,
            cooldownRemain: af.cooldownUntil ? Math.max(0, Math.ceil((af.cooldownUntil - now) / 1000)) : 0,
            graceRemain: af.graceUntil ? Math.max(0, Math.ceil((af.graceUntil - now) / 1000)) : 0,
            streamHealth: {
                noaa: getSourceHealth("noaa"),
                spotter: getSourceHealth("spotter"),
                scanner: getSourceHealth("scanner"),
            },
            lastDecision: af.lastDecision,
            pendingSwitch: af.pendingSwitch,
        };
    }

    function emitDebug() {
        StormState.emit("audioFollowDebug", getDebugState());
        // Also trigger autotrack debug refresh
        StormState.emit("autotrackDebug", typeof AutoTrack !== "undefined" ? AutoTrack.getDebugState() : null);
    }

    /**
     * Update stream URLs for a source type. Called by Settings when user changes URLs.
     * @param {string} type - "noaa" | "spotter" | "scanner"
     * @param {string[]} urls - array of stream URLs
     */
    function setStreamUrls(type, urls) {
        if (!STREAMS[type]) return;
        STREAMS[type].urls = urls || [];
        STREAMS[type].urlIndex = 0;
        // Reset probe cache — new URLs need fresh probing
        if (probeCache[type]) {
            probeCache[type].available = null;
            probeCache[type].checkedAt = 0;
            probeCache[type].failCount = 0;
        }
    }

    // ── Public API ──────────────────────────────────────────────────────

    return {
        init,
        getDebugState,
        setStreamUrls,
        notifyManualPlay,
        notifyManualStop,
        toggleEnabled,
        triggerNoaaTest,
        isTestActive,
    };
})();
