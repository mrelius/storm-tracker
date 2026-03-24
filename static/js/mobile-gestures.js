/**
 * Storm Tracker — Mobile Gestures & Layout Controller (v3 — hardened)
 *
 * Velocity-aware snapping, gesture ownership, card depth signaling,
 * animated mode transitions, idle behavior, performance guards.
 *
 * Zero desktop impact — all gated behind matchMedia.
 */
const MobileGestures = (function () {

    const MOBILE_QUERY = "(max-width: 768px)";

    // ── Gesture Thresholds ───────────────────────────────────────
    const SWIPE_MIN_PX = 30;               // min distance for snap change
    const SWIPE_MAX_MS = 400;              // max gesture duration
    const VELOCITY_THRESHOLD = 0.4;        // px/ms — fast swipe overrides distance
    const SCROLL_HIDE_THRESHOLD = 10;
    const SNAP_COOLDOWN_MS = 280;          // prevent oscillation between states
    const ANIMATION_LOCK_MS = 250;         // lock panel during transition

    // ── Performance Guards ───────────────────────────────────────
    const RESIZE_DEBOUNCE_MS = 150;
    const REORDER_DEBOUNCE_MS = 300;
    const MAX_RENDER_CARDS = 3;
    const IDLE_TIMEOUT_MS = 60000;         // 60s inactivity → reduce UI

    // ── State ────────────────────────────────────────────────────
    let isMobile = false;
    let headerVisible = true;
    let radarControlsVisible = false;

    // Gesture ownership: only one surface handles a gesture at a time
    let gestureOwner = null;   // "map" | "panel" | "cards" | null
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let lastTouchY = 0;
    let touchSamples = [];     // for velocity calc

    // Anti-oscillation
    let lastSnapTime = 0;
    let panelAnimating = false;

    // Idle tracking
    let lastInteractionTime = Date.now();
    let idleTimer = null;
    let isIdle = false;

    // Performance
    let resizeTimer = null;
    let reorderTimer = null;

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        const mq = window.matchMedia(MOBILE_QUERY);
        isMobile = mq.matches;
        mq.addEventListener("change", _onMediaChange);

        if (!isMobile) return;
        _setup();
    }

    function _setup() {
        // Dock buttons
        _bindDock("dock-autotrack", onDockAT);
        _bindDock("dock-radar", onDockRadar);
        _bindDock("dock-audio", onDockAudio);
        _bindDock("dock-alerts", onDockAlerts);

        // Gesture surfaces with ownership
        _bindGestures("map", "map");
        _bindGestures("alert-panel", "panel");

        // Card stack — prevent scroll from propagating as snap gesture
        const cardStack = document.getElementById("pulse-card-stack");
        if (cardStack) {
            cardStack.addEventListener("touchstart", (e) => { gestureOwner = "cards"; }, { passive: true });
            cardStack.addEventListener("touchend", () => { gestureOwner = null; }, { passive: true });
        }

        StormState.on("autotrackChanged", updateDockState);
        StormState.on("panelToggled", _onLegacyPanelToggle);
        StormState.on("mobilePanelSnapped", _onSnapChanged);
        StormState.on("alertsUpdated", _onAlertsUpdated);

        // Resize/orientation debounce
        window.addEventListener("resize", _debouncedResize);
        if (screen.orientation) {
            screen.orientation.addEventListener("change", _onOrientationChange);
        }

        // Idle detection
        document.addEventListener("touchstart", _resetIdle, { passive: true });
        _startIdleTimer();

        _applySnap("closed");
        updateDockState();
    }

    function _bindDock(id, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", handler);
    }

    function _bindGestures(elementId, owner) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.addEventListener("touchstart", (e) => _onTouchStart(e, owner), { passive: true });
        el.addEventListener("touchmove", _onTouchMove, { passive: true });
        el.addEventListener("touchend", _onTouchEnd, { passive: true });
    }

    function _onMediaChange(e) {
        const wasMobile = isMobile;
        isMobile = e.matches;
        if (isMobile && !wasMobile) {
            _setup();
        }
        if (isMobile) {
            _applySnap(StormState.state.mobile.panelSnap);
            updateDockState();
        }
    }

    // ── Dock Actions ─────────────────────────────────────────────

    function onDockAT() {
        _resetIdle();
        StormState.cycleAutoTrack();
        showHint(getATModeLabel());
    }

    function onDockRadar() {
        _resetIdle();
        const controls = document.getElementById("radar-controls");
        if (!controls) return;
        radarControlsVisible = !radarControlsVisible;
        controls.style.display = radarControlsVisible ? "flex" : "none";
        updateDockState();
    }

    function onDockAudio() {
        _resetIdle();
        if (typeof AudioFollow !== "undefined") {
            AudioFollow.toggleEnabled();
            const af = StormState.state.audioFollow;
            showHint(af.enabled ? "Audio Follow ON" : "Audio Follow OFF");
        }
    }

    function onDockAlerts() {
        _resetIdle();
        if (panelAnimating) return;
        const current = StormState.state.mobile.panelSnap;
        if (current === "closed") StormState.setMobilePanelSnap("peek");
        else if (current === "peek") StormState.setMobilePanelSnap("expanded");
        else StormState.setMobilePanelSnap("closed");
    }

    // ── Panel Snap System ────────────────────────────────────────

    function _onLegacyPanelToggle(open) {
        if (!isMobile) return;
        StormState.setMobilePanelSnap(open ? "expanded" : "closed");
    }

    function _onSnapChanged(data) {
        if (!isMobile) return;
        _applySnap(data.snap);
        updateDockState();
    }

    function _applySnap(snap) {
        if (panelAnimating) return;

        const panel = document.getElementById("alert-panel");
        const app = document.getElementById("app");
        if (!panel || !app) return;

        // Lock during animation
        panelAnimating = true;
        setTimeout(() => { panelAnimating = false; }, ANIMATION_LOCK_MS);

        lastSnapTime = Date.now();

        panel.classList.remove("panel-closed", "panel-open", "m-snap-closed", "m-snap-peek", "m-snap-expanded");
        app.classList.remove("panel-is-closed", "m-panel-closed", "m-panel-peek", "m-panel-expanded");

        if (snap === "closed") {
            panel.classList.add("panel-closed", "m-snap-closed");
            app.classList.add("panel-is-closed", "m-panel-closed");
            StormState.state.alerts.panelOpen = false;
        } else if (snap === "peek") {
            panel.classList.add("panel-open", "m-snap-peek");
            app.classList.add("m-panel-peek");
            StormState.state.alerts.panelOpen = true;
        } else {
            panel.classList.add("panel-open", "m-snap-expanded");
            app.classList.add("m-panel-expanded");
            StormState.state.alerts.panelOpen = true;
        }

        if (snap !== "closed" && !headerVisible) setHeaderVisible(true);
    }

    // ── Gesture Handling (velocity-aware, ownership-locked) ──────

    function _onTouchStart(e, owner) {
        if (!isMobile) return;
        gestureOwner = owner;
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        lastTouchY = touch.clientY;
        touchStartTime = Date.now();
        touchSamples = [{ y: touch.clientY, t: touchStartTime }];
        _resetIdle();
    }

    function _onTouchMove(e) {
        if (!isMobile || !gestureOwner) return;
        const touch = e.touches[0];
        const dy = touch.clientY - lastTouchY;
        lastTouchY = touch.clientY;

        // Sample for velocity (keep last 5)
        const now = Date.now();
        touchSamples.push({ y: touch.clientY, t: now });
        if (touchSamples.length > 5) touchSamples.shift();

        // Scroll-aware header (map only, panel closed)
        if (gestureOwner === "map" && StormState.state.mobile.panelSnap === "closed") {
            if (dy > SCROLL_HIDE_THRESHOLD && headerVisible) setHeaderVisible(false);
            else if (dy < -SCROLL_HIDE_THRESHOLD && !headerVisible) setHeaderVisible(true);
        }
    }

    function _onTouchEnd() {
        if (!isMobile || !gestureOwner) return;

        const owner = gestureOwner;
        gestureOwner = null;

        // Anti-oscillation cooldown
        if (Date.now() - lastSnapTime < SNAP_COOLDOWN_MS) return;
        if (panelAnimating) return;

        const totalDy = touchStartY - lastTouchY; // positive = swipe up
        const elapsed = Date.now() - touchStartTime;
        if (elapsed > SWIPE_MAX_MS && Math.abs(totalDy) < 100) return;

        // Compute velocity from samples
        const velocity = _computeVelocity();
        const absDy = Math.abs(totalDy);
        const isUp = totalDy > 0;

        // Decision: velocity OR distance must exceed threshold
        const triggered = absDy >= SWIPE_MIN_PX || Math.abs(velocity) >= VELOCITY_THRESHOLD;
        if (!triggered) return;

        const current = StormState.state.mobile.panelSnap;

        if (owner === "map") {
            if (isUp && current === "closed") StormState.setMobilePanelSnap("peek");
            else if (!isUp && current === "peek") StormState.setMobilePanelSnap("closed");
        } else if (owner === "panel") {
            if (isUp && current === "peek") StormState.setMobilePanelSnap("expanded");
            else if (!isUp && current === "expanded") StormState.setMobilePanelSnap("peek");
            else if (!isUp && current === "peek") StormState.setMobilePanelSnap("closed");
        }
    }

    function _computeVelocity() {
        if (touchSamples.length < 2) return 0;
        const first = touchSamples[0];
        const last = touchSamples[touchSamples.length - 1];
        const dt = last.t - first.t;
        if (dt === 0) return 0;
        return (first.y - last.y) / dt; // positive = upward
    }

    // ── Idle Behavior ────────────────────────────────────────────

    function _resetIdle() {
        lastInteractionTime = Date.now();
        if (isIdle) {
            isIdle = false;
            const app = document.getElementById("app");
            if (app) app.classList.remove("m-idle");
        }
        _startIdleTimer();
    }

    function _startIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            isIdle = true;
            const app = document.getElementById("app");
            if (app) app.classList.add("m-idle");
        }, IDLE_TIMEOUT_MS);
    }

    // ── Performance Guards ───────────────────────────────────────

    function _debouncedResize() {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (isMobile) _applySnap(StormState.state.mobile.panelSnap);
        }, RESIZE_DEBOUNCE_MS);
    }

    function _onOrientationChange() {
        // Force safe-area recalc by triggering a reflow after orientation settles
        setTimeout(() => {
            if (isMobile) _applySnap(StormState.state.mobile.panelSnap);
        }, 200);
    }

    function _onAlertsUpdated() {
        if (!isMobile) return;
        // Debounce card reorder
        if (reorderTimer) clearTimeout(reorderTimer);
        reorderTimer = setTimeout(() => {
            _updateIdleCardVisibility();
        }, REORDER_DEBOUNCE_MS);
    }

    function _updateIdleCardVisibility() {
        const alerts = StormState.state.alerts.data || [];
        const app = document.getElementById("app");
        if (!app) return;
        // Hide card stack when no alerts
        app.classList.toggle("m-no-alerts", alerts.length === 0);
    }

    // ── Header Visibility ────────────────────────────────────────

    function setHeaderVisible(visible) {
        headerVisible = visible;
        const topBar = document.getElementById("top-bar");
        if (topBar) topBar.classList.toggle("header-hidden", !visible);
    }

    // ── Dock State ───────────────────────────────────────────────

    function updateDockState() {
        if (!isMobile) return;
        const at = StormState.state.autotrack;
        const snap = StormState.state.mobile.panelSnap;

        const dockAT = document.getElementById("dock-autotrack");
        if (dockAT) {
            dockAT.classList.remove("at-track", "at-interrogate", "active");
            if (at.mode === "track") dockAT.classList.add("at-track");
            else if (at.mode === "interrogate") dockAT.classList.add("at-interrogate");
        }

        const dockAlerts = document.getElementById("dock-alerts");
        if (dockAlerts) dockAlerts.classList.toggle("active", snap !== "closed");

        const dockRadar = document.getElementById("dock-radar");
        if (dockRadar) dockRadar.classList.toggle("active", radarControlsVisible);

        const dockAudio = document.getElementById("dock-audio");
        if (dockAudio) dockAudio.classList.toggle("active", StormState.state.audioFollow.enabled);
    }

    // ── Helpers ──────────────────────────────────────────────────

    function getATModeLabel() {
        const mode = StormState.state.autotrack.mode;
        if (mode === "off") return "AT: Off";
        if (mode === "track") return "AT: Track";
        return "AT: Interrogate";
    }

    function showHint(text) {
        const hint = document.getElementById("swipe-hint");
        if (!hint) return;
        hint.textContent = text;
        hint.classList.add("visible");
        setTimeout(() => hint.classList.remove("visible"), 1200);
    }

    return { init };
})();
