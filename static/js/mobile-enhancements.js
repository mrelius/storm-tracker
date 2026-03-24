/**
 * Storm Tracker — Mobile Enhancement Layer (v2 — final refinement)
 *
 * 1. Visual priority system (attention > tracking > audio > idle)
 * 2. Haptic cooldown (1500ms, critical override)
 * 3. Event-driven audio sync (polling fallback)
 * 4. Attention decay (elevated 90s, critical 120s)
 * 5. Auto-track stickiness (5s lock)
 * 6. Critical-state toning (primary focused, secondaries muted)
 *
 * Zero desktop impact. Zero architecture changes.
 */
const MobileEnhancements = (function () {

    const MOBILE_QUERY = "(max-width: 768px)";
    const CARD_REORDER_LOCK_MS = 180;
    const HAPTIC_COOLDOWN_MS = 1500;
    const ATTENTION_DECAY_ELEVATED_MS = 90000;
    const ATTENTION_DECAY_CRITICAL_MS = 120000;
    const AT_STICKINESS_MS = 5000;
    const AUDIO_POLL_FALLBACK_MS = 5000;

    // ── State ────────────────────────────────────────────────────
    let isMobile = false;
    let reorderLockTimer = null;
    let log = null;

    // Attention
    let lastAttention = "calm";
    let attentionSetAt = 0;
    let attentionDecayTimer = null;

    // Haptic
    let lastHapticAt = 0;

    // AT stickiness
    let atLockedUntil = 0;
    let lastTrackedId = null;

    // Audio
    let audioSyncInterval = null;
    let lastAudioSource = null;

    // Visual priority resolution cache
    let lastResolvedPriority = null;

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        const mq = window.matchMedia(MOBILE_QUERY);
        isMobile = mq.matches;
        mq.addEventListener("change", (e) => { isMobile = e.matches; });

        if (!isMobile) return;

        if (typeof STLogger !== "undefined") log = STLogger.for("m_enhance");

        // Attention
        StormState.on("alertsUpdated", _deriveAttention);

        // AT visuals
        StormState.on("autotrackTargetChanged", _onTargetChanged);
        StormState.on("autotrackChanged", _onATModeChanged);

        // Snap haptic + reorder lock
        StormState.on("mobilePanelSnapped", _onSnap);

        // Audio: event-driven primary, polling fallback
        StormState.on("alertsUpdated", _syncAudioFromState);
        StormState.on("autotrackTargetChanged", _syncAudioFromState);
        audioSyncInterval = setInterval(_syncAudioFromState, AUDIO_POLL_FALLBACK_MS);

        // Energy
        _initEnergyManagement();

        // Initial state
        _deriveAttention();
        _updateTrackedVisuals();
        _syncAudioFromState();
    }

    // ══════════════════════════════════════════════════════════════
    // 1. VISUAL PRIORITY SYSTEM
    // Precedence: critical > elevated > tracking > audio > idle > calm
    // ══════════════════════════════════════════════════════════════

    function _resolveVisualPriority() {
        if (!isMobile) return;
        const app = document.getElementById("app");
        if (!app) return;

        const attention = StormState.state.mobile.attentionLevel;
        const atActive = StormState.state.autotrack.enabled;
        const audioLive = StormState.state.mobile.audioIndicator !== null;
        const idle = app.classList.contains("m-idle");
        const energy = StormState.state.mobile.energyMode;

        // Determine dominant visual mode
        let priority;
        if (attention === "critical") priority = "critical";
        else if (attention === "elevated") priority = "elevated";
        else if (atActive) priority = "tracking";
        else if (audioLive) priority = "audio";
        else if (idle) priority = "idle";
        else priority = "calm";

        if (priority === lastResolvedPriority) return;
        lastResolvedPriority = priority;

        const batch = typeof OptionalEnhancements !== "undefined"
            ? OptionalEnhancements.batchDOMUpdate
            : (fn) => fn();

        // Apply — remove all, add resolved
        batch(() => {
            app.classList.remove("m-vis-critical", "m-vis-elevated", "m-vis-tracking", "m-vis-audio", "m-vis-idle", "m-vis-calm");
            app.classList.add(`m-vis-${priority}`);
            app.classList.toggle("m-critical-focus", attention === "critical");
        });
    }

    // ══════════════════════════════════════════════════════════════
    // 2. ATTENTION (with decay)
    // ══════════════════════════════════════════════════════════════

    function _deriveAttention(alerts) {
        if (!isMobile) return;
        if (!alerts || !Array.isArray(alerts)) alerts = StormState.state.alerts.data || [];

        let level = "calm";
        for (const a of alerts) {
            const evt = (a.event || "").toLowerCase();
            if (evt.includes("tornado") && evt.includes("warning")) {
                level = "critical";
                break;
            }
            if (evt.includes("severe") && evt.includes("warning")) {
                if (level !== "critical") level = "elevated";
            }
        }

        const app = document.getElementById("app");
        if (!app) return;

        const changed = level !== lastAttention;
        const escalated = _attentionRank(level) > _attentionRank(lastAttention);

        if (changed) {
            app.classList.remove("m-attention-calm", "m-attention-elevated", "m-attention-critical");
            app.classList.add(`m-attention-${level}`);
            StormState.state.mobile.attentionLevel = level;
            attentionSetAt = Date.now();

            if (log) log.info("attention_changed", { level, prev: lastAttention });

            if (escalated && level === "critical") {
                _haptic("critical");
            }

            lastAttention = level;
            _scheduleAttentionDecay(level);
        }

        _resolveVisualPriority();
    }

    function _attentionRank(level) {
        if (level === "critical") return 3;
        if (level === "elevated") return 2;
        return 1;
    }

    function _scheduleAttentionDecay(level) {
        if (attentionDecayTimer) { clearTimeout(attentionDecayTimer); attentionDecayTimer = null; }
        if (level === "calm") return;

        const decayMs = level === "critical" ? ATTENTION_DECAY_CRITICAL_MS : ATTENTION_DECAY_ELEVATED_MS;

        attentionDecayTimer = setTimeout(() => {
            attentionDecayTimer = null;
            // Re-derive — if alerts still warrant the level, it stays; if not, it decays
            const currentAlerts = StormState.state.alerts.data || [];
            _deriveAttention(currentAlerts);

            // If still same level after re-derive and no fresh alerts refreshed it, force decay
            if (StormState.state.mobile.attentionLevel === level && Date.now() - attentionSetAt >= decayMs) {
                const decayTo = level === "critical" ? "elevated" : "calm";
                const app = document.getElementById("app");
                if (app) {
                    app.classList.remove("m-attention-calm", "m-attention-elevated", "m-attention-critical");
                    app.classList.add(`m-attention-${decayTo}`);
                }
                StormState.state.mobile.attentionLevel = decayTo;
                lastAttention = decayTo;
                attentionSetAt = Date.now();
                if (log) log.info("attention_decayed", { from: level, to: decayTo });
                _resolveVisualPriority();

                // Schedule next decay if still above calm
                if (decayTo !== "calm") _scheduleAttentionDecay(decayTo);
            }
        }, decayMs);
    }

    // ══════════════════════════════════════════════════════════════
    // 3. HAPTIC (with cooldown)
    // ══════════════════════════════════════════════════════════════

    function _haptic(type) {
        if (!navigator.vibrate) return;
        if (StormState.state.mobile.energyMode === "reduced") return;

        const now = Date.now();

        // Cooldown: suppress within window unless critical override
        if (type !== "critical" && now - lastHapticAt < HAPTIC_COOLDOWN_MS) return;

        // Critical override: only if it's a NEW critical (not re-trigger)
        if (type === "critical" && now - lastHapticAt < HAPTIC_COOLDOWN_MS) {
            // Allow only if this is an escalation (checked by caller)
            // Still enforce a shorter minimum gap (300ms) to prevent spam
            if (now - lastHapticAt < 300) return;
        }

        lastHapticAt = now;

        if (type === "snap") {
            navigator.vibrate(10);
        } else if (type === "critical") {
            navigator.vibrate([50, 30, 50]);
        }
    }

    function _onSnap(data) {
        if (!isMobile) return;
        _haptic("snap");
        lockReorder();
    }

    // ══════════════════════════════════════════════════════════════
    // 4. AUTO-TRACK STICKINESS + VISUALS
    // ══════════════════════════════════════════════════════════════

    function _onTargetChanged(targetId) {
        if (!isMobile) return;
        const now = Date.now();

        // Stickiness: if within lock window and not a higher-priority override, suppress visual change
        if (lastTrackedId && targetId !== lastTrackedId && now < atLockedUntil) {
            // Check if new target is higher priority (TOR overrides SVR)
            const at = StormState.state.autotrack;
            const newEvt = (at.targetEvent || "").toLowerCase();
            const isTorOverride = newEvt.includes("tornado") && newEvt.includes("warning");
            if (!isTorOverride) {
                // Suppress visual update — AT stickiness active
                return;
            }
        }

        lastTrackedId = targetId;
        atLockedUntil = now + AT_STICKINESS_MS;
        _updateTrackedVisuals();
    }

    function _onATModeChanged() {
        if (!isMobile) return;
        lastTrackedId = null;
        atLockedUntil = 0;
        _updateTrackedVisuals();
    }

    function _updateTrackedVisuals() {
        if (!isMobile) return;

        const at = StormState.state.autotrack;
        const app = document.getElementById("app");
        if (!app) return;

        const batch = typeof OptionalEnhancements !== "undefined"
            ? OptionalEnhancements.batchDOMUpdate
            : (fn) => requestAnimationFrame(fn);

        batch(() => {
            app.classList.toggle("m-at-active", at.enabled);
            app.classList.toggle("m-at-off", !at.enabled);

            const cards = document.querySelectorAll(".pcs-card");
            cards.forEach(card => {
                const isTracked = card.classList.contains("pcs-tracked");
                card.classList.toggle("m-tracked-emphasis", isTracked && at.enabled);
                card.classList.toggle("m-non-tracked", !isTracked && at.enabled);
            });
        });

        _resolveVisualPriority();
    }

    // ══════════════════════════════════════════════════════════════
    // 5. AUDIO (event-driven + polling fallback)
    // ══════════════════════════════════════════════════════════════

    function _syncAudioFromState() {
        if (!isMobile) return;
        const af = StormState.state.audioFollow;
        const source = af.enabled && af.status === "live" ? af.currentSource : null;

        if (source === lastAudioSource) return;
        lastAudioSource = source;
        StormState.state.mobile.audioIndicator = source;

        const batch = typeof OptionalEnhancements !== "undefined"
            ? OptionalEnhancements.batchDOMUpdate
            : (fn) => fn();

        const app = document.getElementById("app");
        if (!app) return;
        batch(() => {
            app.classList.remove("m-audio-live", "m-audio-noaa", "m-audio-scanner", "m-audio-spotter");
            if (source) {
                app.classList.add("m-audio-live", `m-audio-${source}`);
            }
        });

        _resolveVisualPriority();
    }

    // ══════════════════════════════════════════════════════════════
    // 6. REORDER LOCK
    // ══════════════════════════════════════════════════════════════

    function lockReorder() {
        if (!isMobile) return;
        StormState.state.mobile.cardReorderLocked = true;
        const stack = document.getElementById("pulse-card-stack");
        if (stack) stack.classList.add("m-reorder-locked");

        if (reorderLockTimer) clearTimeout(reorderLockTimer);
        reorderLockTimer = setTimeout(() => {
            StormState.state.mobile.cardReorderLocked = false;
            if (stack) stack.classList.remove("m-reorder-locked");
        }, CARD_REORDER_LOCK_MS);
    }

    function isReorderLocked() {
        return StormState.state.mobile.cardReorderLocked;
    }

    // ══════════════════════════════════════════════════════════════
    // 7. ENERGY MANAGEMENT
    // ══════════════════════════════════════════════════════════════

    function _initEnergyManagement() {
        if (navigator.getBattery) {
            navigator.getBattery().then(battery => {
                _checkBattery(battery);
                battery.addEventListener("levelchange", () => _checkBattery(battery));
                battery.addEventListener("chargingchange", () => _checkBattery(battery));
            }).catch(() => {});
        }

        const app = document.getElementById("app");
        if (app) {
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === "attributes" && m.attributeName === "class") {
                        const isIdle = app.classList.contains("m-idle");
                        _setEnergyMode(isIdle ? "reduced" : "normal");
                        _resolveVisualPriority();
                    }
                }
            });
            observer.observe(app, { attributes: true });
        }
    }

    function _checkBattery(battery) {
        if (!battery.charging && battery.level < 0.15) {
            _setEnergyMode("reduced");
        } else {
            const app = document.getElementById("app");
            if (StormState.state.mobile.energyMode === "reduced" && app && !app.classList.contains("m-idle")) {
                _setEnergyMode("normal");
            }
        }
    }

    function _setEnergyMode(mode) {
        if (StormState.state.mobile.energyMode === mode) return;
        StormState.state.mobile.energyMode = mode;

        const app = document.getElementById("app");
        if (app) app.classList.toggle("m-energy-reduced", mode === "reduced");

        if (log) log.info("energy_mode_changed", { mode });
    }

    return { init, lockReorder, isReorderLocked };
})();
