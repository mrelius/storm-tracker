/**
 * Storm Tracker — State Debug Overlay
 *
 * Toggleable overlay showing real-time storm state sync info.
 * Toggle: Shift+Alt+S
 *
 * Shows:
 * - sequence_id (backend)
 * - primary alert id + event type
 * - active alert count
 * - transport (ws/poll)
 * - WS connected status
 * - last update age
 * - match check vs backend
 */
const StateDebugOverlay = (function () {

    var _visible = false;
    var _overlay = null;
    var _updateTimer = null;
    var UPDATE_INTERVAL_MS = 1000;

    function init() {
        // Toggle on Shift+Alt+S
        document.addEventListener("keydown", function (e) {
            if (e.shiftKey && e.altKey && e.key === "S") {
                e.preventDefault();
                toggle();
            }
        });
    }

    function toggle() {
        _visible = !_visible;
        if (_visible) {
            _create();
            _update();
            _updateTimer = setInterval(_update, UPDATE_INTERVAL_MS);
        } else {
            _destroy();
            if (_updateTimer) { clearInterval(_updateTimer); _updateTimer = null; }
        }
    }

    function _create() {
        if (_overlay) return;
        _overlay = document.createElement("div");
        _overlay.id = "state-debug-overlay";
        _overlay.style.cssText = [
            "position: fixed",
            "bottom: 8px",
            "left: 8px",
            "z-index: 10000",
            "background: rgba(0,0,0,0.85)",
            "color: #e2e8f0",
            "font-family: 'Courier New', monospace",
            "font-size: 11px",
            "line-height: 1.5",
            "padding: 8px 12px",
            "border-radius: 6px",
            "border: 1px solid #334155",
            "pointer-events: none",
            "max-width: 360px",
            "white-space: pre",
        ].join(";");
        document.body.appendChild(_overlay);
    }

    function _destroy() {
        if (_overlay && _overlay.parentNode) {
            _overlay.parentNode.removeChild(_overlay);
        }
        _overlay = null;
    }

    function _update() {
        if (!_overlay) return;

        var client = (typeof StormStateClient !== "undefined" && StormStateClient.getState)
            ? StormStateClient.getState() : {};
        var alerts = StormState.state.alerts.data || [];
        var at = StormState.state.autotrack || {};
        var cam = StormState.state.camera || {};

        var seq = client.lastSequenceId || 0;
        var primary = client.lastPrimaryId || "none";
        var transport = client.wsConnected ? "WS" : "POLL";
        var transportColor = client.wsConnected ? "#22c55e" : "#f59e0b";
        var wsApply = client.wsApplyCount || 0;
        var pollCount = client.fetchCount || 0;
        var errors = client.errorCount || 0;

        // Age since last state timestamp
        var age = client.lastStateTs > 0
            ? Math.round((Date.now() / 1000) - client.lastStateTs)
            : "?";

        // Truncate primary ID for display
        var primaryShort = primary === "none" ? "none"
            : (primary.length > 24 ? "..." + primary.slice(-20) : primary);

        // Find primary event type
        var primaryEvent = "—";
        if (primary !== "none") {
            for (var i = 0; i < alerts.length; i++) {
                if (alerts[i].id === primary) {
                    primaryEvent = alerts[i].event || "?";
                    break;
                }
            }
        }

        // Camera mode
        var camMode = cam.owner || "idle";
        var camCtrl = (typeof CameraController !== "undefined" && CameraController.getMode)
            ? CameraController.getMode() : "?";

        var lines = [
            "┌─ STORM STATE ─────────────────┐",
            " seq:       " + seq,
            " primary:   " + primaryShort,
            " event:     " + primaryEvent,
            " alerts:    " + alerts.length,
            " transport: <span style='color:" + transportColor + "'>" + transport + "</span>" +
                " (ws:" + wsApply + " poll:" + pollCount + ")",
            " age:       " + age + "s",
            " errors:    " + errors,
            "├─ CAMERA ─────────────────────-┤",
            " owner:     " + camMode,
            " ctrl:      " + camCtrl,
            " AT:        " + (at.enabled ? "ON → " + (at.targetAlertId ? at.targetAlertId.slice(-12) : "none") : "OFF"),
            "└───────────────────────────────┘",
        ];

        _overlay.innerHTML = lines.join("\n");
    }

    return { init: init, toggle: toggle };
})();
