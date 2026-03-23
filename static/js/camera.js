/**
 * Storm Tracker — Camera Ownership Controller
 *
 * Single entry point for all map camera movements. Enforces ownership
 * priority so GPS, Auto Track, and Context Pulse never fight each other.
 *
 * Priority (highest first):
 *   gps > autotrack > pulse > idle
 *
 * Rules:
 * - Lower-priority source cannot override higher-priority owner
 * - Pulse never overrides GPS or Auto Track
 * - Auto Track yields to GPS
 * - User interaction sets owner to "idle" temporarily
 *
 * All camera moves MUST go through setCameraView().
 * Direct map.flyTo/setView calls from other modules should be replaced
 * with Camera.move() calls.
 */
const Camera = (function () {

    // Priority: higher number = higher priority
    // Pulse runs at autotrack priority — it's an autotrack sub-feature
    const PRIORITY = {
        idle: 0,
        pulse: 1,
        autotrack: 1,
        gps: 2,
        user: 3,
    };

    function init() {
        // User interaction resets to idle (temporarily)
        StormState.on("userMapInteraction", () => {
            // Don't change owner to idle — just allow the interaction.
            // GPS and AT have their own pause mechanisms.
            // Camera ownership only changes on explicit mode changes.
        });
    }

    /**
     * Request a camera move. Enforced by ownership priority.
     *
     * @param {object} opts
     * @param {string} opts.source - "gps" | "autotrack" | "pulse" | "user"
     * @param {L.LatLng|number[]} opts.center - [lat, lng] or L.LatLng
     * @param {number} [opts.zoom] - target zoom level
     * @param {object} [opts.bounds] - L.LatLngBounds (alternative to center+zoom)
     * @param {object} [opts.flyOptions] - Leaflet flyTo/flyToBounds options
     * @param {boolean} [opts.animate=true] - whether to animate
     * @param {string} [opts.reason] - human-readable reason for debug
     * @returns {boolean} true if move was executed, false if blocked
     */
    function move(opts) {
        const cam = StormState.state.camera;
        const source = opts.source || "idle";
        const currentPriority = PRIORITY[cam.owner] || 0;
        const requestPriority = PRIORITY[source] || 0;

        // Block if current owner has higher priority
        // Exception: same owner can always update its own view
        if (source !== cam.owner && requestPriority < currentPriority) {
            return false;
        }

        const map = StormMap.getMap();
        if (!map) return false;

        // Execute the move
        if (opts.bounds) {
            map.flyToBounds(opts.bounds, opts.flyOptions || {});
        } else if (opts.center) {
            const center = Array.isArray(opts.center) ? opts.center : [opts.center.lat, opts.center.lng];
            const zoom = opts.zoom || map.getZoom();
            if (opts.animate === false) {
                map.setView(center, zoom, { animate: false });
            } else {
                map.flyTo(center, zoom, opts.flyOptions || {});
            }
        }

        return true;
    }

    /**
     * Claim camera ownership. Called when a system takes control.
     * @param {string} owner - "gps" | "autotrack" | "pulse" | "idle"
     * @param {string} [reason] - why ownership changed
     */
    let lastEmitTime = 0;
    const EMIT_DEBOUNCE_MS = 1000;  // suppress rapid transitions <1s apart

    function claim(owner, reason) {
        const cam = StormState.state.camera;
        if (cam.owner === owner) return;  // already owns it — no event

        const from = cam.owner;
        cam.lastOwner = from;
        cam.owner = owner;
        cam.since = Date.now();
        cam.reason = reason || owner;

        _emitChange(from, owner, reason || owner);
    }

    /**
     * Release camera ownership. Called when a system gives up control.
     * Only the current owner can release.
     * @param {string} owner - must match current owner to release
     */
    function release(owner) {
        const cam = StormState.state.camera;
        if (cam.owner !== owner) return;  // can't release what you don't own

        const from = cam.owner;
        cam.lastOwner = from;
        cam.owner = "idle";
        cam.since = Date.now();
        cam.reason = `${owner} released`;

        _emitChange(from, "idle", `${owner} released`);
    }

    function _emitChange(from, to, reason) {
        const now = Date.now();

        // Structured log for camera transitions
        if (typeof STLogger !== "undefined") {
            STLogger.for("camera").info("camera_mode_transition", { from, to, reason });
        }

        // Suppress rapid transitions (<1s apart)
        if (now - lastEmitTime < EMIT_DEBOUNCE_MS) return;
        lastEmitTime = now;

        // Don't emit for idle → idle
        if (from === "idle" && to === "idle") return;

        StormState.emit("cameraOwnerChanged", { from, to, reason, timestamp: now });
    }

    /**
     * Check if a source can move the camera.
     * @param {string} source
     * @returns {boolean}
     */
    function canMove(source) {
        const cam = StormState.state.camera;
        if (source === cam.owner) return true;
        return (PRIORITY[source] || 0) >= (PRIORITY[cam.owner] || 0);
    }

    /**
     * Get current owner.
     * @returns {string}
     */
    function getOwner() {
        return StormState.state.camera.owner;
    }

    /**
     * Get debug state for display.
     */
    function getDebugState() {
        const cam = StormState.state.camera;
        const now = Date.now();
        return {
            owner: cam.owner,
            lastOwner: cam.lastOwner,
            since: cam.since ? Math.round((now - cam.since) / 1000) + "s" : "—",
            reason: cam.reason,
        };
    }

    return { init, move, claim, release, canMove, getOwner, getDebugState };
})();
