/**
 * Storm Tracker — Unified Camera Policy Controller
 *
 * Top-level policy layer that manages automatic switching between
 * AUTO_TRACK and IDLE_AWARENESS, plus explicit user preferences.
 *
 * Ownership: MANUAL | GPS | AUTOMATIC
 * Preferences: AUTO | FORCE_AUTO_TRACK | FORCE_IDLE | MANUAL_ONLY
 * Automatic submodes: AUTO_TRACK | IDLE_AWARENESS
 */
const CameraPolicy = (function () {

    // ── Constants ────────────────────────────────────────────────
    const AT_TO_IDLE_GRACE_MS = 60000;
    const MIN_SWITCH_INTERVAL_MS = 10000;
    const EVAL_INTERVAL_MS = 3000;
    const IMPORTANT_DISTANCE_MI = 100;

    const SEVERE_EVENTS = new Set([
        "Tornado Warning",
        "Severe Thunderstorm Warning",
    ]);

    // ── State ────────────────────────────────────────────────────
    let policyState = {
        ownerMode: "MANUAL",
        preference: "AUTO",
        automaticSubmode: null,
        importantWeatherPresent: false,
        lastImportantWeatherAt: null,
        lastAutomaticSwitchAt: null,
        lastUserOverrideAt: null,
    };

    let evalTimer = null;
    let log = null;

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("cam_policy");

        // Restore preference
        const saved = localStorage.getItem("camera_policy_pref");
        if (saved && ["AUTO", "FORCE_AUTO_TRACK", "FORCE_IDLE", "MANUAL_ONLY"].includes(saved)) {
            policyState.preference = saved;
        }

        // Wire UI
        _initUI();

        // Listen to state changes
        StormState.on("alertsUpdated", _onAlertsUpdated);
        StormState.on("autotrackChanged", _onATChanged);

        // User interaction → temporary manual ownership
        document.addEventListener("mousedown", _onUserMapGesture, { passive: true });
        document.addEventListener("touchstart", _onUserMapGesture, { passive: true });

        // Start evaluation
        evalTimer = setInterval(_evaluate, EVAL_INTERVAL_MS);

        // Initial evaluation
        setTimeout(_evaluate, 1000);

        _updateUI();
    }

    // ── Important Weather (single authoritative definition) ──────

    function _computeImportantWeather() {
        const alerts = StormState.state.alerts.data || [];
        const at = StormState.state.autotrack;
        const mobile = StormState.state.mobile;

        // Critical attention level
        if (mobile && mobile.attentionLevel === "critical") return true;

        // Severe events within distance threshold
        for (const a of alerts) {
            if (!SEVERE_EVENTS.has(a.event)) continue;
            if (a.distance_mi != null && a.distance_mi <= IMPORTANT_DISTANCE_MI) return true;
            if (a.distance_mi == null) return true; // no distance = assume relevant
        }

        // Active tracked high-priority target
        if (at.enabled && at.targetAlertId) {
            const tracked = alerts.find(x => x.id === at.targetAlertId);
            if (tracked && SEVERE_EVENTS.has(tracked.event)) return true;
        }

        return false;
    }

    // ── Evaluation Loop ──────────────────────────────────────────

    function _evaluate() {
        const now = Date.now();
        const prev = policyState.importantWeatherPresent;
        policyState.importantWeatherPresent = _computeImportantWeather();

        if (policyState.importantWeatherPresent && !prev) {
            policyState.lastImportantWeatherAt = now;
        }

        // Determine ownership
        const cam = StormState.state.camera;
        const gps = StormState.state.gpsFollow;

        if (gps.active) {
            _setOwner("GPS");
            return;
        }

        if (policyState.preference === "MANUAL_ONLY") {
            _setOwner("MANUAL");
            policyState.automaticSubmode = null;
            _updateUI();
            return;
        }

        // User recently interacted — stay manual briefly
        if (policyState.lastUserOverrideAt && now - policyState.lastUserOverrideAt < 5000) {
            return;
        }

        _setOwner("AUTOMATIC");

        // Determine automatic submode
        let targetSubmode;

        if (policyState.preference === "FORCE_AUTO_TRACK") {
            targetSubmode = "AUTO_TRACK";
        } else if (policyState.preference === "FORCE_IDLE") {
            targetSubmode = "IDLE_AWARENESS";
        } else {
            // AUTO policy
            if (policyState.importantWeatherPresent) {
                targetSubmode = "AUTO_TRACK";
            } else {
                // Grace period: stay in AT for a while after weather clears
                if (policyState.automaticSubmode === "AUTO_TRACK" && policyState.lastImportantWeatherAt) {
                    const elapsed = now - policyState.lastImportantWeatherAt;
                    if (elapsed < AT_TO_IDLE_GRACE_MS) {
                        targetSubmode = "AUTO_TRACK";
                    } else {
                        targetSubmode = "IDLE_AWARENESS";
                    }
                } else {
                    targetSubmode = "IDLE_AWARENESS";
                }
            }
        }

        // Anti-flap
        if (targetSubmode !== policyState.automaticSubmode) {
            if (policyState.lastAutomaticSwitchAt && now - policyState.lastAutomaticSwitchAt < MIN_SWITCH_INTERVAL_MS) {
                // Exception: escalation to AT for critical weather is immediate
                if (!(targetSubmode === "AUTO_TRACK" && policyState.importantWeatherPresent)) {
                    return;
                }
            }

            _switchSubmode(targetSubmode);
        }
    }

    function _switchSubmode(submode) {
        const prev = policyState.automaticSubmode;
        policyState.automaticSubmode = submode;
        policyState.lastAutomaticSwitchAt = Date.now();

        console.log("[CAMERA_POLICY] switch:", prev, "→", submode, "| wx:", policyState.importantWeatherPresent);
        StormState.emit("cameraModeChanged", { submode, prev, importantWeather: policyState.importantWeatherPresent });
        if (log) log.info("camera_policy_switch", {
            from: prev, to: submode,
            importantWeather: policyState.importantWeatherPresent,
            preference: policyState.preference,
        });

        // Activate/deactivate AT
        if (submode === "AUTO_TRACK") {
            if (!StormState.state.autotrack.enabled) {
                StormState.setAutoTrackMode("track");
            }
        } else {
            if (StormState.state.autotrack.enabled && policyState.preference !== "FORCE_AUTO_TRACK") {
                StormState.setAutoTrackMode("off");
            }
        }

        // Idle awareness is self-managing — it enters when AT is off and conditions are met
        // No explicit activation needed; it monitors its own entry conditions

        _updateUI();
    }

    function _setOwner(mode) {
        if (policyState.ownerMode === mode) return;
        policyState.ownerMode = mode;
    }

    // ── Events ───────────────────────────────────────────────────

    function _onAlertsUpdated() {
        // Trigger re-evaluation on next tick
    }

    function _onATChanged(data) {
        // If user manually toggled AT, sync preference
        if (data.mode !== "off" && policyState.preference === "MANUAL_ONLY") {
            // User explicitly enabled AT — switch to force AT
            policyState.preference = "FORCE_AUTO_TRACK";
            localStorage.setItem("camera_policy_pref", policyState.preference);
            _updateUI();
        }
    }

    function _onUserMapGesture(e) {
        // Only count actual map interactions, not toolbar/button clicks
        const target = e.target;
        if (target && target.closest) {
            // Ignore clicks on toolbar buttons, panels, controls
            if (target.closest("#top-bar") || target.closest(".radar-btn") || target.closest("#mobile-dock") ||
                target.closest("#alert-panel") || target.closest(".pulse-card-stack")) return;
            if (target.closest("#map")) {
                policyState.lastUserOverrideAt = Date.now();
            }
        }
    }

    // ── User Preference API ──────────────────────────────────────

    function setPreference(pref) {
        if (!["AUTO", "FORCE_AUTO_TRACK", "FORCE_IDLE", "MANUAL_ONLY"].includes(pref)) return;
        policyState.preference = pref;
        policyState.lastAutomaticSwitchAt = null; // allow immediate switch
        localStorage.setItem("camera_policy_pref", pref);

        if (log) log.info("camera_policy_pref_changed", { preference: pref });
        console.log("[CAMERA_POLICY] preference →", pref, "| owner:", policyState.ownerMode, "| submode:", policyState.automaticSubmode);

        _evaluate();
        _updateUI();
    }

    // ── UI: Toolbar Cycle Button ────────────────────────────────

    const MODE_CYCLE = ["AUTO", "FORCE_AUTO_TRACK", "FORCE_IDLE", "MANUAL_ONLY"];
    const MODE_LABELS = { AUTO: "AUTO", FORCE_AUTO_TRACK: "AT", FORCE_IDLE: "IDLE", MANUAL_ONLY: "MAN" };
    const MODE_TOOLTIPS = {
        AUTO: "Camera Mode: AUTO (automatic AT/IDLE switching)",
        FORCE_AUTO_TRACK: "Camera Mode: AT (forced tracking)",
        FORCE_IDLE: "Camera Mode: IDLE (forced idle awareness)",
        MANUAL_ONLY: "Camera Mode: MANUAL (no automatic camera movement)",
    };
    const MODE_CLASSES = {
        AUTO: "cam-auto",
        FORCE_AUTO_TRACK: "cam-at",
        FORCE_IDLE: "cam-idle",
        MANUAL_ONLY: "cam-manual",
    };

    let _collapseTimer = null;

    function _initUI() {
        const btn = document.getElementById("btn-camera-mode");
        const group = document.getElementById("camera-tool-group");
        if (!btn || !group) return;

        // Mobile: tap main button toggles menu
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            group.classList.toggle("cam-open");
        });

        // Menu option clicks
        group.querySelectorAll(".cam-opt").forEach(opt => {
            opt.addEventListener("click", (e) => {
                e.stopPropagation();
                const mode = opt.dataset.mode;
                if (mode) setPreference(mode);
                group.classList.remove("cam-open");
                if (log) log.info("camera_mode_selected", { mode });
            });
        });

        // Hover-out debounce (150ms) to prevent flicker
        group.addEventListener("mouseleave", () => {
            _collapseTimer = setTimeout(() => group.classList.remove("cam-open"), 150);
        });
        group.addEventListener("mouseenter", () => {
            if (_collapseTimer) { clearTimeout(_collapseTimer); _collapseTimer = null; }
        });

        // Click outside closes
        document.addEventListener("click", () => group.classList.remove("cam-open"));

        _updateUI();
    }

    function _updateUI() {
        const btn = document.getElementById("btn-camera-mode");
        if (!btn) return;

        const pref = policyState.preference;
        btn.textContent = MODE_LABELS[pref] || "?";

        // Tooltip
        let tooltip = MODE_TOOLTIPS[pref] || "";
        if (pref === "AUTO" && policyState.ownerMode === "AUTOMATIC" && policyState.automaticSubmode) {
            const sub = policyState.automaticSubmode === "AUTO_TRACK" ? "currently Tracking" : "currently Idle";
            tooltip = `Camera Mode: AUTO (${sub})`;
        }
        btn.title = tooltip;

        // Style classes on main button
        btn.classList.remove("cam-auto", "cam-at", "cam-idle", "cam-manual");
        btn.classList.add(MODE_CLASSES[pref] || "cam-auto");

        // Highlight active option in menu
        const group = document.getElementById("camera-tool-group");
        if (group) {
            group.querySelectorAll(".cam-opt").forEach(opt => {
                opt.classList.toggle("cam-opt-active", opt.dataset.mode === pref);
            });
        }
    }

    function getState() { return { ...policyState }; }

    function destroy() {
        if (evalTimer) clearInterval(evalTimer);
    }

    function requestMode(mode) {
        if (mode === "IDLE") {
            Camera.claim("idle", "idle_awareness_enter");
            if (log) log.info("mode_change", { from: policyState.ownerMode, to: "idle", trigger: "requestMode" });
        } else if (mode === "AUTO_TRACK") {
            Camera.claim("autotrack", "autotrack_enter");
            if (log) log.info("mode_change", { from: policyState.ownerMode, to: "autotrack", trigger: "requestMode" });
        } else if (mode === "GPS") {
            Camera.claim("gps", "gps_enter");
            if (log) log.info("mode_change", { from: policyState.ownerMode, to: "gps", trigger: "requestMode" });
        }
    }

    return { init, setPreference, getState, destroy, requestMode, _SEVERE_EVENTS: SEVERE_EVENTS };
})();
