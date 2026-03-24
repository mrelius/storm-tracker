/**
 * Storm Tracker — Optional Enhancement Pack (v2 — hardened)
 *
 * 1. Predictive attention — gated to calm-only
 * 2. Audio crossfade — latest-wins interruption policy
 * 3. Batched DOM updates — rAF queue
 * 4. Session persistence — live state always overrides restored
 * 5. Debug overlay — single-write, low-cost
 *
 * Additive only. Does not modify existing behavior.
 */
const OptionalEnhancements = (function () {

    const CROSSFADE_MS = 1200;
    const PREDICTIVE_CHECK_MS = 30000;
    const SESSION_SAVE_DEBOUNCE_MS = 2000;
    const SESSION_KEY = "st_session_state";
    const SESSION_MAX_AGE_MS = 86400000; // 24h — ignore stale sessions

    let log = null;
    let predictiveTimer = null;
    let sessionSaveTimer = null;
    let debugOverlay = null;
    let debugTimer = null;
    let rafQueue = [];
    let rafScheduled = false;
    let sessionRestoreComplete = false;

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("opt_enhance");

        _initPredictiveAttention();
        _initAudioCrossfade();
        _initSessionPersistence();
        _initDebugOverlay();

        if (log) log.info("optional_enhancements_init", {});
    }

    // ══════════════════════════════════════════════════════════════
    // 1. PREDICTIVE ATTENTION — calm-only gate
    // ══════════════════════════════════════════════════════════════

    let lastWatchDistances = {};

    function _initPredictiveAttention() {
        predictiveTimer = setInterval(_checkPredictiveSignals, PREDICTIVE_CHECK_MS);
    }

    function _checkPredictiveSignals() {
        const app = document.getElementById("app");
        if (!app) return;

        // Gate: only show pre-alert when attention is calm
        const attention = StormState.state.mobile ? StormState.state.mobile.attentionLevel : "calm";
        if (attention !== "calm") {
            app.classList.remove("m-pre-alert");
            return;
        }

        const alerts = StormState.state.alerts.data || [];
        let preAlert = false;

        for (const a of alerts) {
            const evt = (a.event || "").toLowerCase();
            const isWatch = evt.includes("watch");
            const isSevere = evt.includes("tornado") || evt.includes("severe");

            if (isWatch && isSevere && a.distance_mi != null) {
                const prevDist = lastWatchDistances[a.id];
                if (prevDist != null && a.distance_mi < prevDist - 5 && a.distance_mi < 50) {
                    preAlert = true;
                }
                lastWatchDistances[a.id] = a.distance_mi;
            }
        }

        // Clean stale
        const currentIds = new Set(alerts.map(a => a.id));
        for (const id of Object.keys(lastWatchDistances)) {
            if (!currentIds.has(id)) delete lastWatchDistances[id];
        }

        app.classList.toggle("m-pre-alert", preAlert);
    }

    // ══════════════════════════════════════════════════════════════
    // 2. AUDIO CROSSFADE — latest-wins interruption
    // ══════════════════════════════════════════════════════════════

    let crossfadeId = 0;  // monotonic ID for latest-wins

    function _initAudioCrossfade() {
        const audioEl = document.getElementById("audio-follow-player");
        if (!audioEl) return;

        const targetVolume = audioEl.volume || 0.7;
        let _prevSrc = audioEl.src;

        const observer = new MutationObserver(() => {
            const newSrc = audioEl.src;
            if (newSrc !== _prevSrc && _prevSrc && newSrc) {
                _crossfade(audioEl, targetVolume);
            }
            _prevSrc = newSrc;
        });

        setTimeout(() => {
            _prevSrc = audioEl.src;
            observer.observe(audioEl, { attributes: true, attributeFilter: ["src"] });
        }, 3000);
    }

    function _crossfade(audioEl, targetVolume) {
        // Latest-wins: cancel any active crossfade by incrementing ID
        crossfadeId++;
        const myId = crossfadeId;

        const halfDuration = CROSSFADE_MS / 2;
        const startVolume = audioEl.volume;
        const fadeStart = Date.now();

        function fadeOut() {
            if (crossfadeId !== myId) return; // interrupted by newer crossfade
            const elapsed = Date.now() - fadeStart;
            const progress = Math.min(1, elapsed / halfDuration);
            audioEl.volume = Math.max(0, startVolume * (1 - progress));

            if (progress < 1) {
                requestAnimationFrame(fadeOut);
            } else {
                const fadeInStart = Date.now();
                function fadeIn() {
                    if (crossfadeId !== myId) return; // interrupted
                    const elapsed = Date.now() - fadeInStart;
                    const progress = Math.min(1, elapsed / halfDuration);
                    audioEl.volume = targetVolume * progress;

                    if (progress < 1) {
                        requestAnimationFrame(fadeIn);
                    } else {
                        audioEl.volume = targetVolume;
                    }
                }
                requestAnimationFrame(fadeIn);
            }
        }
        requestAnimationFrame(fadeOut);
    }

    // ══════════════════════════════════════════════════════════════
    // 3. BATCHED DOM UPDATES
    // ══════════════════════════════════════════════════════════════

    function batchDOMUpdate(fn) {
        rafQueue.push(fn);
        if (!rafScheduled) {
            rafScheduled = true;
            requestAnimationFrame(_flushRAF);
        }
    }

    function _flushRAF() {
        const batch = rafQueue.splice(0);
        rafScheduled = false;
        for (const fn of batch) {
            try { fn(); } catch (e) { /* silent */ }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 4. SESSION PERSISTENCE — live state overrides restored
    // ══════════════════════════════════════════════════════════════

    function _initSessionPersistence() {
        // Restore — only if no live runtime state has been set yet
        try {
            const saved = localStorage.getItem(SESSION_KEY);
            if (saved) {
                const data = JSON.parse(saved);

                // Reject stale sessions
                if (data.savedAt && Date.now() - data.savedAt > SESSION_MAX_AGE_MS) {
                    localStorage.removeItem(SESSION_KEY);
                } else {
                    _restoreSession(data);
                }
            }
        } catch (e) { /* ignore */ }

        // Mark restore complete after a short window — live state takes precedence after this
        setTimeout(() => { sessionRestoreComplete = true; }, 2000);

        StormState.on("mobilePanelSnapped", _debouncedSaveSession);
        StormState.on("alertsUpdated", _debouncedSaveSession);
    }

    function _restoreSession(data) {
        const mq = window.matchMedia("(max-width: 768px)");

        // Panel snap — only restore if mobile AND no live interaction has occurred
        if (data.panelSnap && mq.matches && typeof StormState.setMobilePanelSnap === "function") {
            const currentSnap = StormState.state.mobile.panelSnap;
            // Only restore if still at default (closed) — live state wins
            if (currentSnap === "closed" && data.panelSnap !== "closed") {
                setTimeout(() => {
                    // Double-check: if live state changed during delay, skip restore
                    if (!sessionRestoreComplete && StormState.state.mobile.panelSnap === "closed") {
                        StormState.setMobilePanelSnap(data.panelSnap);
                    }
                }, 500);
            }
        }

        // Audio — only restore if not already enabled by live interaction
        if (data.audioEnabled === true && typeof AudioFollow !== "undefined") {
            setTimeout(() => {
                if (!sessionRestoreComplete && !StormState.state.audioFollow.enabled) {
                    AudioFollow.toggleEnabled();
                }
            }, 1000);
        }
    }

    function _debouncedSaveSession() {
        if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
        sessionSaveTimer = setTimeout(_saveSession, SESSION_SAVE_DEBOUNCE_MS);
    }

    function _saveSession() {
        try {
            localStorage.setItem(SESSION_KEY, JSON.stringify({
                panelSnap: StormState.state.mobile.panelSnap,
                audioEnabled: StormState.state.audioFollow.enabled,
                savedAt: Date.now(),
            }));
        } catch (e) { /* quota exceeded */ }
    }

    // ══════════════════════════════════════════════════════════════
    // 5. DEBUG OVERLAY — single-write, low-cost
    // ══════════════════════════════════════════════════════════════

    let lastDebugHTML = "";

    function _initDebugOverlay() {
        if (!window.location.search.includes("debug=1")) return;

        debugOverlay = document.createElement("div");
        debugOverlay.id = "opt-debug-overlay";
        debugOverlay.style.cssText = `
            position: fixed; bottom: 70px; left: 4px; z-index: 9999;
            background: rgba(0,0,0,0.85); color: #0f0; font-family: monospace;
            font-size: 9px; padding: 6px 8px; border-radius: 4px;
            max-width: 260px; max-height: 40vh; overflow-y: auto;
            pointer-events: none; line-height: 1.4;
        `;
        document.body.appendChild(debugOverlay);

        debugTimer = setInterval(_updateDebugOverlay, 1000);
        _updateDebugOverlay();
    }

    function _updateDebugOverlay() {
        if (!debugOverlay) return;

        const cam = StormState.state.camera;
        const at = StormState.state.autotrack;
        const af = StormState.state.audioFollow;
        const m = StormState.state.mobile;
        const p = StormState.state.pulse;
        const alertCount = (StormState.state.alerts.data || []).length;

        // Build as string array — cheap concatenation
        const parts = [
            "v", (window.__ST_BUILD__ || "?"), " | ", alertCount, " alerts\n",
            "cam:", cam.owner, " pulse:", cam.contextPulsePhase, "\n",
            "at:", at.enabled ? at.mode : "off", " tgt:", at.targetAlertId ? at.targetAlertId.slice(-8) : "—", "\n",
            "af:", af.enabled ? af.status : "off", " src:", af.currentSource || "—", "\n",
            "snap:", m.panelSnap, " card:", m.cardMode, " attn:", m.attentionLevel, "\n",
            "energy:", m.energyMode, " audio:", m.audioIndicator || "—", "\n",
            "inView:", p.inViewCount, " pri:", p.primaryInViewEventId ? p.primaryInViewEventId.slice(-8) : "—",
        ];

        if (typeof ThreatFocusEngine !== "undefined") {
            const tfe = ThreatFocusEngine.getDerivedOutputs();
            parts.push("\ntfe:", tfe.focusMode, " pri:", tfe.primaryEventId ? tfe.primaryEventId.slice(-8) : "—", " cards:", tfe.visibleCardEventIds.length);
        }

        if (typeof RadarManager !== "undefined" && RadarManager.getRefHiresState) {
            const rh = RadarManager.getRefHiresState();
            if (rh.active) {
                parts.push("\nref:", rh.primarySite, "@1.0");
                if (rh.secondarySite) parts.push("+", rh.secondarySite, "@", rh.secondaryOpacity);
                parts.push(" z", rh.zoom);
            }
        }

        const html = parts.join("");

        // Single-write guard: skip DOM update if unchanged
        if (html === lastDebugHTML) return;
        lastDebugHTML = html;
        debugOverlay.textContent = html;
    }

    // ── Cleanup ──────────────────────────────────────────────────

    function destroy() {
        if (predictiveTimer) clearInterval(predictiveTimer);
        if (debugTimer) clearInterval(debugTimer);
        if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
        if (debugOverlay) debugOverlay.remove();
        lastDebugHTML = "";
    }

    return { init, destroy, batchDOMUpdate };
})();
