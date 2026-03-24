/**
 * Storm Tracker — Contextual Auto Zoom-Out (v2 — spatial intelligence)
 *
 * Cluster-aware selection: prefer alerts that expand spatial coverage.
 * Bounding sanity: reject if expanded area > 3x tracked polygon area.
 * Directional spread: require alerts in different directions from tracked.
 * Anti-flap: debounce enter/exit, cooldown, manual suppression.
 *
 * Only applies in AUTO_TRACK mode.
 */
const ContextZoom = (function () {

    // ── Thresholds ───────────────────────────────────────────────
    const TRACKED_CLOSE_MILES = 30;
    const NEARBY_ALERT_RADIUS = 25;
    const MIN_ALERT_COUNT = 2;
    const ZOOM_OUT_MIN = 1;
    const ZOOM_OUT_MAX = 2;
    const BOUNDS_EXPANSION_LIMIT = 3.0; // max 3x tracked polygon area
    const MIN_ANGULAR_SPREAD = 30;      // degrees — min spread between candidates

    // ── Timing ───────────────────────────────────────────────────
    const ENTER_DEBOUNCE_MS = 4000;
    const EXIT_DEBOUNCE_MS = 10000;
    const COOLDOWN_MS = 12000;
    const MANUAL_SUPPRESS_MS = 25000;
    const EVAL_INTERVAL_MS = 15000;
    const EDGE_HYSTERESIS_MI = 3; // prevent flap at boundary (29mi↔31mi)

    // ── Important Event Filter ───────────────────────────────────
    const IMPORTANT_EVENTS = new Set([
        "Tornado Warning",
        "Severe Thunderstorm Warning",
        "Flash Flood Warning",
    ]);

    // ── State ────────────────────────────────────────────────────
    let state = {
        active: false,
        enteredAt: null,
        lastTransitionAt: null,
        suppressedUntil: null,
        causeAlertIds: [],
        baseZoom: null,
        targetZoom: null,
    };

    let enterTimer = null;
    let exitTimer = null;
    let evalTimer = null;
    let log = null;
    let lastCandidateHash = "";

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("ctx_zoom");

        StormState.on("alertsUpdated", _scheduleEval);
        StormState.on("autotrackTargetChanged", _scheduleEval);
        StormState.on("userMapInteraction", _onManualInteraction);

        evalTimer = setInterval(_evaluate, EVAL_INTERVAL_MS);
    }

    function _scheduleEval() {
        setTimeout(_evaluate, 500);
    }

    // ── Core Evaluation ──────────────────────────────────────────

    function _evaluate() {
        const at = StormState.state.autotrack;
        if (!at.enabled || !at.targetAlertId) {
            if (state.active) _exit("autotrack_off");
            return;
        }

        const now = Date.now();
        if (state.suppressedUntil && now < state.suppressedUntil) return;

        const alerts = StormState.state.alerts.data || [];
        const tracked = alerts.find(a => a.id === at.targetAlertId);
        if (!tracked) {
            if (state.active) _exit("tracked_lost");
            return;
        }

        // Tracked must be close — with hysteresis
        const effectiveThreshold = state.active
            ? TRACKED_CLOSE_MILES + EDGE_HYSTERESIS_MI
            : TRACKED_CLOSE_MILES;

        if (tracked.distance_mi == null || tracked.distance_mi > effectiveThreshold) {
            if (state.active) _scheduleExit("tracked_far");
            return;
        }

        // Find nearby important alerts
        const candidates = [];
        for (const a of alerts) {
            if (a.id === at.targetAlertId) continue;
            if (!IMPORTANT_EVENTS.has(a.event)) continue;
            if (!a.polygon) continue;
            if (a.distance_mi == null || a.distance_mi > NEARBY_ALERT_RADIUS) continue;
            candidates.push(a);
        }

        if (candidates.length < MIN_ALERT_COUNT) {
            if (state.active) _scheduleExit("insufficient_alerts");
            return;
        }

        // Cluster-aware selection: prefer spatial spread
        const selected = _selectForCoverage(tracked, candidates);

        if (selected.length < MIN_ALERT_COUNT) {
            if (state.active) _scheduleExit("no_spread");
            return;
        }

        // Anti-flap: check if candidate set changed
        const hash = [tracked.id, ...selected.map(a => a.id)].sort().join(",");
        if (hash === lastCandidateHash && state.active) return; // same set, no change
        lastCandidateHash = hash;

        if (!state.active) {
            _scheduleEnter(tracked, selected);
        } else {
            state.causeAlertIds = [tracked.id, ...selected.map(a => a.id)];
        }
    }

    // ── Cluster-Aware Selection ──────────────────────────────────

    function _selectForCoverage(tracked, candidates) {
        if (candidates.length <= 2) return candidates;

        // Compute bearing from tracked to each candidate
        const trackedCenter = _getAlertCenter(tracked);
        if (!trackedCenter) return candidates.slice(0, 2);

        const withBearing = candidates.map(a => {
            const center = _getAlertCenter(a);
            if (!center) return null;
            const bearing = _bearing(trackedCenter.lat, trackedCenter.lon, center.lat, center.lon);
            return { alert: a, bearing, distance: a.distance_mi || 9999 };
        }).filter(Boolean);

        if (withBearing.length < 2) return candidates.slice(0, 2);

        // Sort by severity * closeness
        withBearing.sort((a, b) => {
            const scoreA = _importanceScore(a.alert) / (a.distance + 1);
            const scoreB = _importanceScore(b.alert) / (b.distance + 1);
            return scoreB - scoreA;
        });

        // Pick first, then find second with maximum angular spread
        const first = withBearing[0];
        let bestSecond = null;
        let bestSpread = 0;

        for (let i = 1; i < withBearing.length; i++) {
            const spread = _angularDistance(first.bearing, withBearing[i].bearing);
            if (spread > bestSpread) {
                bestSpread = spread;
                bestSecond = withBearing[i];
            }
        }

        // Require minimum spread — avoid picking overlapping alerts
        if (!bestSecond || bestSpread < MIN_ANGULAR_SPREAD) {
            return [first.alert]; // only 1 — won't pass MIN_ALERT_COUNT
        }

        return [first.alert, bestSecond.alert];
    }

    function _importanceScore(alert) {
        const evt = (alert.event || "").toLowerCase();
        if (evt.includes("tornado") && evt.includes("warning")) return 100;
        if (evt.includes("severe") && evt.includes("thunderstorm")) return 70;
        if (evt.includes("flash flood")) return 40;
        return 10;
    }

    function _angularDistance(a, b) {
        let diff = Math.abs(a - b) % 360;
        if (diff > 180) diff = 360 - diff;
        return diff;
    }

    // ── Enter / Exit ─────────────────────────────────────────────

    function _scheduleEnter(tracked, nearby) {
        if (enterTimer) return;
        enterTimer = setTimeout(() => {
            enterTimer = null;
            _enter(tracked, nearby);
        }, ENTER_DEBOUNCE_MS);
    }

    function _enter(tracked, nearby) {
        if (state.active) return;

        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        const currentZoom = map.getZoom();

        // Build tracked bounds
        const trackedBounds = _getAlertBounds(tracked);
        if (!trackedBounds) return;

        // Build combined bounds
        const allAlerts = [tracked, ...nearby];
        let combinedBounds = L.latLngBounds(trackedBounds.getSouthWest(), trackedBounds.getNorthEast());
        for (const a of nearby) {
            const ab = _getAlertBounds(a);
            if (ab) combinedBounds.extend(ab);
        }

        if (!combinedBounds.isValid()) return;

        // Bounding sanity: reject if area expansion too large
        const trackedArea = _boundsArea(trackedBounds);
        const combinedArea = _boundsArea(combinedBounds);
        if (trackedArea > 0 && combinedArea / trackedArea > BOUNDS_EXPANSION_LIMIT) {
            if (log) log.info("context_zoom_suppressed_bounds", {
                trackedArea: Math.round(trackedArea * 1000) / 1000,
                combinedArea: Math.round(combinedArea * 1000) / 1000,
                ratio: Math.round(combinedArea / trackedArea * 10) / 10,
            });
            return;
        }

        // Compute target zoom
        const fitZoom = map.getBoundsZoom(combinedBounds.pad(0.15));
        const delta = Math.max(ZOOM_OUT_MIN, Math.min(ZOOM_OUT_MAX, currentZoom - fitZoom));
        const targetZoom = Math.max(7, currentZoom - delta);

        if (currentZoom - targetZoom < 0.5) return;

        state.active = true;
        state.enteredAt = Date.now();
        state.lastTransitionAt = Date.now();
        state.baseZoom = currentZoom;
        state.targetZoom = targetZoom;
        state.causeAlertIds = [tracked.id, ...nearby.map(a => a.id)];

        if (log) log.info("context_zoom_entered", {
            trackedAlertId: tracked.id.slice(-12),
            candidateAlertIds: nearby.map(a => a.id.slice(-12)),
            baseZoom: currentZoom,
            targetZoom: targetZoom,
            distanceMiles: Math.round(tracked.distance_mi || 0),
            reason: "multiple_close_important_alerts",
        });

        const center = combinedBounds.getCenter();
        Camera.move({
            source: "autotrack",
            center: [center.lat, center.lng],
            zoom: targetZoom,
            flyOptions: { duration: 1.0, easeLinearity: 0.25 },
            reason: "context_zoom_in",
        });
    }

    function _scheduleExit(reason) {
        if (exitTimer) return;
        exitTimer = setTimeout(() => {
            exitTimer = null;
            _exit(reason);
        }, EXIT_DEBOUNCE_MS);
    }

    function _exit(reason) {
        if (!state.active) return;

        if (log) log.info("context_zoom_exited", {
            reason: reason,
            duration_s: state.enteredAt ? Math.round((Date.now() - state.enteredAt) / 1000) : 0,
        });

        state.active = false;
        state.enteredAt = null;
        state.lastTransitionAt = Date.now();
        state.causeAlertIds = [];
        state.baseZoom = null;
        state.targetZoom = null;
        lastCandidateHash = "";

        state.suppressedUntil = Date.now() + COOLDOWN_MS;

        if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
        if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    }

    function _onManualInteraction() {
        if (state.active) {
            if (log) log.info("context_zoom_suppressed_manual", {});
            _exit("manual_override");
            state.suppressedUntil = Date.now() + MANUAL_SUPPRESS_MS;
        }
        // Also cancel pending enters
        if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
    }

    // ── Geometry Helpers ─────────────────────────────────────────

    function _getAlertCenter(alert) {
        if (!alert || !alert.polygon) return null;
        try {
            const geo = JSON.parse(alert.polygon);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            const c = b.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) { return null; }
    }

    function _getAlertBounds(alert) {
        if (!alert || !alert.polygon) return null;
        try {
            const geo = JSON.parse(alert.polygon);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            return b.isValid() ? b : null;
        } catch (e) { return null; }
    }

    function _boundsArea(bounds) {
        if (!bounds || !bounds.isValid()) return 0;
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        return Math.abs(ne.lat - sw.lat) * Math.abs(ne.lng - sw.lng);
    }

    function _bearing(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
                - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    // ── Debug ────────────────────────────────────────────────────

    function getState() {
        return { ...state };
    }

    return { init, getState };
})();
