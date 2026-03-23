/**
 * Storm Tracker — Mobile Gestures & Dock Controller
 *
 * Handles:
 * - Bottom dock button actions
 * - Scroll-aware header hide (hide on scroll down, show on scroll up)
 * - Swipe gestures (up/down = panel expand/collapse only)
 * - No left/right swipe for AT mode — AT mode changes are tap-only
 * - Mobile-only — all gated behind matchMedia check
 *
 * Additive only. Zero impact on desktop.
 */
const MobileGestures = (function () {

    const MOBILE_QUERY = "(max-width: 768px)";
    const SWIPE_THRESHOLD_PX = 60;
    const SWIPE_TIME_MS = 300;
    const SCROLL_HIDE_THRESHOLD = 10;  // px of drag-down before hiding header

    let isMobile = false;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let lastTouchY = 0;
    let headerVisible = true;
    let radarControlsVisible = false;

    function init() {
        const mq = window.matchMedia(MOBILE_QUERY);
        isMobile = mq.matches;
        mq.addEventListener("change", (e) => { isMobile = e.matches; updateDockState(); });

        if (!isMobile) return;

        // Dock buttons
        const dockAT = document.getElementById("dock-autotrack");
        const dockRadar = document.getElementById("dock-radar");
        const dockAudio = document.getElementById("dock-audio");
        const dockAlerts = document.getElementById("dock-alerts");

        if (dockAT) dockAT.addEventListener("click", onDockAT);
        if (dockRadar) dockRadar.addEventListener("click", onDockRadar);
        if (dockAudio) dockAudio.addEventListener("click", onDockAudio);
        if (dockAlerts) dockAlerts.addEventListener("click", onDockAlerts);

        // Swipe gestures on map (vertical only — panel expand/collapse)
        const mapEl = document.getElementById("map");
        if (mapEl) {
            mapEl.addEventListener("touchstart", onTouchStart, { passive: true });
            mapEl.addEventListener("touchmove", onTouchMove, { passive: true });
            mapEl.addEventListener("touchend", onTouchEnd, { passive: true });
        }

        // State listeners
        StormState.on("autotrackChanged", updateDockState);
        StormState.on("panelToggled", updateDockState);

        updateDockState();
    }

    // ── Dock Actions ────────────────────────────────────────────────

    function onDockAT() {
        StormState.cycleAutoTrack();
        showHint(getATModeLabel());
    }

    function onDockRadar() {
        const controls = document.getElementById("radar-controls");
        if (!controls) return;
        radarControlsVisible = !radarControlsVisible;
        controls.style.display = radarControlsVisible ? "flex" : "none";
        updateDockState();
        showHint(radarControlsVisible ? "Radar controls" : "Radar hidden");
    }

    function onDockAudio() {
        if (typeof AudioFollow !== "undefined") {
            AudioFollow.toggleEnabled();
            const af = StormState.state.audioFollow;
            showHint(af.enabled ? "Audio Follow ON" : "Audio Follow OFF");
        }
    }

    function onDockAlerts() {
        StormState.togglePanel();
    }

    // ── Touch / Swipe ───────────────────────────────────────────────

    function onTouchStart(e) {
        if (!isMobile) return;
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        lastTouchY = touch.clientY;
        touchStartTime = Date.now();
    }

    function onTouchMove(e) {
        if (!isMobile) return;
        const touch = e.touches[0];
        const dy = touch.clientY - lastTouchY;
        lastTouchY = touch.clientY;

        // Scroll-aware header: hide on drag down, show on drag up
        // Only when panel is closed and no overlay is open
        if (!StormState.state.alerts.panelOpen) {
            if (dy > SCROLL_HIDE_THRESHOLD && headerVisible) {
                setHeaderVisible(false);
            } else if (dy < -SCROLL_HIDE_THRESHOLD && !headerVisible) {
                setHeaderVisible(true);
            }
        }
    }

    function onTouchEnd() {
        // No swipe gestures on map — all controls via dock buttons
        // Map panning handled natively by Leaflet
    }

    // ── Header Visibility ───────────────────────────────────────────

    function setHeaderVisible(visible) {
        headerVisible = visible;
        const topBar = document.getElementById("top-bar");
        if (topBar) {
            topBar.classList.toggle("header-hidden", !visible);
        }
    }

    // ── Dock State Update ───────────────────────────────────────────

    function updateDockState() {
        if (!isMobile) return;

        const at = StormState.state.autotrack;
        const panelOpen = StormState.state.alerts.panelOpen;

        // Show header when panel is open or overlay active
        if (panelOpen && !headerVisible) {
            setHeaderVisible(true);
        }

        const dockAT = document.getElementById("dock-autotrack");
        if (dockAT) {
            dockAT.classList.remove("at-track", "at-interrogate", "active");
            if (at.mode === "track") dockAT.classList.add("at-track");
            else if (at.mode === "interrogate") dockAT.classList.add("at-interrogate");
        }

        const dockAlerts = document.getElementById("dock-alerts");
        if (dockAlerts) {
            dockAlerts.classList.toggle("active", panelOpen);
        }

        const dockRadar = document.getElementById("dock-radar");
        if (dockRadar) {
            dockRadar.classList.toggle("active", radarControlsVisible);
        }

        const dockAudio = document.getElementById("dock-audio");
        if (dockAudio && typeof StormState !== "undefined") {
            dockAudio.classList.toggle("active", StormState.state.audioFollow.enabled);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

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
