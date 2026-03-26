/**
 * Storm Tracker — Motion Engine
 *
 * Tracks storm polygon centroids over time, computes motion vectors,
 * and renders projected future positions as ghost polygons + trajectory paths.
 *
 * Data sources (priority):
 *   1. UnifiedTarget motion data (speed/heading from detection engine)
 *   2. Centroid history tracking (fallback)
 *
 * Renders for up to MAX_PROJECTED qualifying polygons (Tornado/Severe TS warnings).
 * Ghost polygons are shifted copies at 15 and 30 min horizons.
 */
const MotionEngine = (function () {

    // ── Config ─────────────────────────────────────────────────────
    const MAX_PROJECTED = 3;
    const UPDATE_INTERVAL_MS = 5000;
    const MAX_HISTORY_POINTS = 5;
    const MAX_HISTORY_AGE_MS = 600000;  // 10 min
    const MIN_SPEED_MPH = 2;
    const MAX_SPEED_MPH = 100;
    const JITTER_THRESHOLD_MPH = 2;
    const PROJECTION_STEPS_MIN = [15, 30];
    const DEG_PER_MI = 1 / 69.0;

    const QUALIFYING_EVENTS = new Set([
        "Tornado Warning",
        "Severe Thunderstorm Warning",
    ]);

    // ── Visual Config ──────────────────────────────────────────────
    const ARROW_COLOR = "#ffffff";
    const PATH_COLOR = "#f59e0b";
    const GHOST_OPACITY_15 = 0.18;
    const GHOST_OPACITY_30 = 0.10;

    // ── State ──────────────────────────────────────────────────────
    let _motionLayer = null;    // L.layerGroup for all motion visuals
    let _updateTimer = null;
    let _map = null;
    let log = null;

    // ── Init ───────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("motion");

        StormState.on("alertsUpdated", _onAlertsUpdated);
        StormState.on("autotrackTargetChanged", _scheduleUpdate);
    }

    /**
     * Called after map is available. Starts rendering loop.
     */
    function start(leafletMap) {
        _map = leafletMap;
        _motionLayer = L.layerGroup().addTo(_map);
        _updateTimer = setInterval(_update, UPDATE_INTERVAL_MS);
    }

    function stop() {
        if (_updateTimer) { clearInterval(_updateTimer); _updateTimer = null; }
        _clearVisuals();
    }

    // ── Alert Update → History Tracking ────────────────────────────

    function _onAlertsUpdated() {
        const alerts = StormState.state.alerts.data || [];
        const now = Date.now();
        const history = StormState.state.motion.history;

        for (const alert of alerts) {
            if (!QUALIFYING_EVENTS.has(alert.event)) continue;
            if (!alert.polygon) continue;

            const centroid = _getPolygonCentroid(alert.polygon);
            if (!centroid) continue;

            if (!history[alert.id]) history[alert.id] = [];

            const h = history[alert.id];
            // Don't add duplicate if position hasn't changed
            if (h.length > 0) {
                const last = h[h.length - 1];
                const dist = _haversineMi(last.lat, last.lon, centroid.lat, centroid.lon);
                if (dist < 0.1) continue;  // less than 0.1 mi — skip
            }

            h.push({ lat: centroid.lat, lon: centroid.lon, ts: now });

            // Prune old entries
            while (h.length > MAX_HISTORY_POINTS) h.shift();
            while (h.length > 0 && now - h[0].ts > MAX_HISTORY_AGE_MS) h.shift();
        }

        // Prune expired alerts from history
        const activeIds = new Set(alerts.map(a => a.id));
        for (const eid of Object.keys(history)) {
            if (!activeIds.has(eid)) delete history[eid];
        }

        _scheduleUpdate();
    }

    function _scheduleUpdate() {
        // Debounce via next frame
        requestAnimationFrame(_update);
    }

    // ── Vector Computation ─────────────────────────────────────────

    /**
     * Compute motion vector from centroid history.
     * Uses last 2-3 points with smoothing.
     */
    function computeMotionVector(history) {
        if (!history || history.length < 2) return null;

        // Use last 2 points for primary vector
        const p1 = history[history.length - 2];
        const p2 = history[history.length - 1];
        const dt = (p2.ts - p1.ts) / 3600000;  // hours
        if (dt <= 0) return null;

        const distMi = _haversineMi(p1.lat, p1.lon, p2.lat, p2.lon);
        let speedMph = distMi / dt;
        let bearingDeg = _bearing(p1.lat, p1.lon, p2.lat, p2.lon);

        // Smoothing: average with previous vector if 3+ points
        if (history.length >= 3) {
            const p0 = history[history.length - 3];
            const dt0 = (p1.ts - p0.ts) / 3600000;
            if (dt0 > 0) {
                const dist0 = _haversineMi(p0.lat, p0.lon, p1.lat, p1.lon);
                const speed0 = dist0 / dt0;
                const bearing0 = _bearing(p0.lat, p0.lon, p1.lat, p1.lon);

                // Weighted average: 60% recent, 40% previous
                speedMph = speedMph * 0.6 + speed0 * 0.4;
                bearingDeg = _avgBearing(bearingDeg, bearing0, 0.6);
            }
        }

        // Jitter filter
        if (speedMph < JITTER_THRESHOLD_MPH) return null;

        // Clamp unrealistic
        if (speedMph > MAX_SPEED_MPH) return null;

        return {
            speedMph: Math.round(speedMph * 10) / 10,
            bearingDeg: Math.round(bearingDeg * 10) / 10,
            lastUpdated: Date.now(),
        };
    }

    // ── Intensity Computation ────────────────────────────────────────

    /**
     * Compute intensity scale for an alert.
     * TOR: base = 1.0
     * SVR: scaled by description keywords (wind/hail)
     * FFW: base = 0.5
     * Used for border thickness and glow strength in polygon rendering.
     */
    function computeIntensity(alert) {
        if (!alert || !alert.event) return { scale: 0.3, level: "low" };

        const event = alert.event.toLowerCase();
        const desc = (alert.description || "").toLowerCase();

        // Tornado Warning: highest intensity
        if (event.includes("tornado") && event.includes("warning")) {
            // Check for PDS (Particularly Dangerous Situation)
            if (desc.includes("particularly dangerous") || desc.includes("pds")) {
                return { scale: 1.0, level: "extreme" };
            }
            return { scale: 0.9, level: "critical" };
        }

        // Severe Thunderstorm Warning: scale by wind/hail
        if (event.includes("severe thunderstorm") && event.includes("warning")) {
            let scale = 0.5;
            // Wind scaling
            const windMatch = desc.match(/(\d+)\s*mph/);
            if (windMatch) {
                const mph = parseInt(windMatch[1]);
                if (mph >= 80) scale = Math.max(scale, 0.8);
                else if (mph >= 70) scale = Math.max(scale, 0.7);
                else if (mph >= 60) scale = Math.max(scale, 0.6);
            }
            // Hail scaling
            const hailMatch = desc.match(/([\d.]+)\s*inch/);
            if (hailMatch) {
                const inches = parseFloat(hailMatch[1]);
                if (inches >= 2.0) scale = Math.max(scale, 0.8);
                else if (inches >= 1.5) scale = Math.max(scale, 0.7);
                else if (inches >= 1.0) scale = Math.max(scale, 0.6);
            }
            // Destructive keyword
            if (desc.includes("destructive")) scale = Math.max(scale, 0.85);

            const level = scale >= 0.8 ? "critical" : scale >= 0.6 ? "high" : "moderate";
            return { scale, level };
        }

        // Flash Flood Warning
        if (event.includes("flash flood") && event.includes("warning")) {
            if (desc.includes("flash flood emergency")) {
                return { scale: 0.8, level: "critical" };
            }
            return { scale: 0.5, level: "moderate" };
        }

        // Everything else
        return { scale: 0.3, level: "low" };
    }

    // ── Projection ─────────────────────────────────────────────────

    /**
     * Project a lat/lon forward by bearing and speed.
     */
    function projectPosition(lat, lon, bearingDeg, speedMph, minutes) {
        const distMi = speedMph * (minutes / 60);
        const bearingRad = bearingDeg * Math.PI / 180;
        const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.01);

        const dLat = distMi * Math.cos(bearingRad) * DEG_PER_MI;
        const dLon = distMi * Math.sin(bearingRad) * DEG_PER_MI / cosLat;

        return { lat: lat + dLat, lon: lon + dLon };
    }

    /**
     * Shift an entire polygon geometry by a delta.
     */
    function projectPolygon(polygonGeoJson, deltaLat, deltaLon) {
        const shifted = JSON.parse(JSON.stringify(polygonGeoJson));

        function shiftCoords(coords) {
            if (typeof coords[0] === "number") {
                // [lon, lat] pair
                coords[0] += deltaLon;
                coords[1] += deltaLat;
            } else {
                for (const c of coords) shiftCoords(c);
            }
        }

        if (shifted.coordinates) {
            shiftCoords(shifted.coordinates);
        }
        return shifted;
    }

    // ── Main Update Loop ───────────────────────────────────────────

    function _update() {
        if (!_map || !_motionLayer) return;
        // Feature flag gate
        if (typeof StormVizState !== "undefined" && !StormVizState.isEnabled()) {
            _clearVisuals();
            return;
        }

        _clearVisuals();

        const alerts = StormState.state.alerts.data || [];
        const trackedId = StormState.state.autotrack.targetAlertId;
        const history = StormState.state.motion.history;
        const vectors = StormState.state.motion.vectors;

        // Collect qualifying alerts with motion data
        const candidates = [];

        for (const alert of alerts) {
            if (!QUALIFYING_EVENTS.has(alert.event)) continue;
            if (!alert.polygon) continue;

            const centroid = _getPolygonCentroid(alert.polygon);
            if (!centroid) continue;

            // Priority 1: UnifiedTarget motion data (if AT is tracking this)
            let vector = null;
            if (alert._unifiedMotion) {
                // Injected by UnifiedTarget bridge
                const m = alert._unifiedMotion;
                if (m.speed_mph >= MIN_SPEED_MPH && m.motion_confidence >= 0.3) {
                    vector = {
                        speedMph: m.speed_mph,
                        bearingDeg: m.heading_deg,
                        lastUpdated: Date.now(),
                    };
                }
            }

            // Priority 2: Compute from centroid history
            if (!vector && history[alert.id]) {
                vector = computeMotionVector(history[alert.id]);
            }

            if (!vector) continue;

            // Store vector in state
            vectors[alert.id] = vector;

            // Score for prioritization
            const isTracked = alert.id === trackedId;
            const severityScore = alert.event.includes("Tornado") ? 100 : 50;
            const score = (isTracked ? 1000 : 0) + severityScore + vector.speedMph;

            candidates.push({ alert, centroid, vector, score, isTracked });
            if (log) log.info("motion_intensity_computed", {
                id: alert.id,
                event: alert.event,
                speed_mph: vector.speedMph,
                bearing_deg: vector.bearingDeg,
                intensity: computeIntensity(alert).level,
            });
        }

        // Sort by score, take top MAX_PROJECTED
        candidates.sort((a, b) => b.score - a.score);
        const selected = candidates.slice(0, MAX_PROJECTED);

        // Render each
        for (const { alert, centroid, vector, isTracked } of selected) {
            _renderMotionVisuals(alert, centroid, vector, isTracked);
        }
    }

    // ── Rendering ──────────────────────────────────────────────────

    function _renderMotionVisuals(alert, centroid, vector, isTracked) {
        const color = StormState.getEventColor(alert.event);

        // 1. Motion arrow at centroid
        _renderArrow(centroid, vector.bearingDeg, isTracked);

        // 2. Trajectory path + ghost polygons for each projection step
        for (const minutes of PROJECTION_STEPS_MIN) {
            const projected = projectPosition(
                centroid.lat, centroid.lon,
                vector.bearingDeg, vector.speedMph,
                minutes
            );

            // Trajectory path (dashed line)
            const pathLine = L.polyline(
                [[centroid.lat, centroid.lon], [projected.lat, projected.lon]],
                {
                    color: PATH_COLOR,
                    weight: isTracked ? 2 : 1.5,
                    opacity: minutes === 15 ? 0.5 : 0.3,
                    dashArray: "6,4",
                    interactive: false,
                    className: "motion-path",
                }
            );
            _motionLayer.addLayer(pathLine);

            // Ghost polygon
            try {
                const geo = JSON.parse(alert.polygon);
                const deltaLat = projected.lat - centroid.lat;
                const deltaLon = projected.lon - centroid.lon;
                const ghostGeo = projectPolygon(geo, deltaLat, deltaLon);

                const ghostOpacity = minutes === 15 ? GHOST_OPACITY_15 : GHOST_OPACITY_30;

                const ghostLayer = L.geoJSON(ghostGeo, {
                    style: {
                        color: color,
                        weight: 1,
                        opacity: ghostOpacity + 0.1,
                        fillColor: color,
                        fillOpacity: ghostOpacity,
                        dashArray: "4,4",
                        interactive: false,
                        className: `polygon--future polygon--future-${minutes}`,
                    },
                });
                _motionLayer.addLayer(ghostLayer);

                // Time label at ghost centroid (only for 15 and 30 min, tracked only)
                if (isTracked) {
                    const label = L.tooltip({
                        permanent: true,
                        direction: "center",
                        className: "motion-time-label",
                        offset: [0, 0],
                    }).setLatLng([projected.lat, projected.lon])
                      .setContent(`${minutes}m`);
                    label.addTo(_map);
                    // Store for cleanup
                    if (!_motionLayer._tooltips) _motionLayer._tooltips = [];
                    _motionLayer._tooltips.push(label);
                }
            } catch (e) { /* skip ghost for bad geometry */ }
        }

        // Speed label near arrow (tracked only)
        if (isTracked) {
            const speedLabel = L.tooltip({
                permanent: true,
                direction: "right",
                className: "motion-speed-label",
                offset: [12, 0],
            }).setLatLng([centroid.lat, centroid.lon])
              .setContent(`${Math.round(vector.speedMph)} mph`);
            speedLabel.addTo(_map);
            if (!_motionLayer._tooltips) _motionLayer._tooltips = [];
            _motionLayer._tooltips.push(speedLabel);
        }
    }

    function _renderArrow(centroid, bearingDeg, isTracked) {
        const bearingRad = bearingDeg * Math.PI / 180;
        const arrowLen = 0.04;  // degrees — visible at most zooms
        const headLen = 0.015;
        const headAngle = Math.PI / 6;

        const cosLat = Math.max(Math.cos(centroid.lat * Math.PI / 180), 0.01);

        // Arrow endpoint
        const endLat = centroid.lat + arrowLen * Math.cos(bearingRad);
        const endLon = centroid.lon + arrowLen * Math.sin(bearingRad) / cosLat;

        // Arrow shaft
        const shaft = L.polyline(
            [[centroid.lat, centroid.lon], [endLat, endLon]],
            {
                color: ARROW_COLOR,
                weight: isTracked ? 2.5 : 1.5,
                opacity: isTracked ? 0.9 : 0.6,
                interactive: false,
                className: "motion-arrow",
            }
        );
        _motionLayer.addLayer(shaft);

        // Arrowhead
        const left = [
            endLat - headLen * Math.cos(bearingRad - headAngle),
            endLon - headLen * Math.sin(bearingRad - headAngle) / cosLat,
        ];
        const right = [
            endLat - headLen * Math.cos(bearingRad + headAngle),
            endLon - headLen * Math.sin(bearingRad + headAngle) / cosLat,
        ];

        const head = L.polygon([[endLat, endLon], left, right], {
            color: ARROW_COLOR,
            fillColor: ARROW_COLOR,
            fillOpacity: isTracked ? 0.9 : 0.5,
            weight: 1,
            opacity: isTracked ? 0.9 : 0.6,
            interactive: false,
            className: "motion-arrowhead",
        });
        _motionLayer.addLayer(head);
    }

    function _clearVisuals() {
        if (!_motionLayer) return;

        // Remove tooltips (stored separately since they're added to map, not layer group)
        if (_motionLayer._tooltips) {
            for (const t of _motionLayer._tooltips) {
                if (_map) _map.removeLayer(t);
            }
            _motionLayer._tooltips = [];
        }

        _motionLayer.clearLayers();
    }

    // ── Geometry Helpers ───────────────────────────────────────────

    function _getPolygonCentroid(polygonStr) {
        try {
            const geo = JSON.parse(polygonStr);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            const c = b.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) { return null; }
    }

    function _haversineMi(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
                + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
                * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function _bearing(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
                - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    function _avgBearing(b1, b2, w1) {
        const r1 = b1 * Math.PI / 180;
        const r2 = b2 * Math.PI / 180;
        const x = w1 * Math.cos(r1) + (1 - w1) * Math.cos(r2);
        const y = w1 * Math.sin(r1) + (1 - w1) * Math.sin(r2);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    // ── Prune ──────────────────────────────────────────────────────

    function pruneMotionHistory() {
        const history = StormState.state.motion.history;
        const now = Date.now();
        for (const eid of Object.keys(history)) {
            const h = history[eid];
            while (h.length > 0 && now - h[0].ts > MAX_HISTORY_AGE_MS) h.shift();
            if (h.length === 0) delete history[eid];
        }
    }

    // ── Public API ─────────────────────────────────────────────────

    return {
        init,
        start,
        stop,
        computeMotionVector,
        computeIntensity,
        projectPosition,
        projectPolygon,
        pruneMotionHistory,
    };
})();
