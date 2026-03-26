/**
 * Storm Tracker — Impact Zone Shading
 *
 * Shows what lies inside the projected storm path:
 *   - Shaded impact corridor (15 / 30 min horizons)
 *   - Impacted place labels with ETA
 *   - Ranked by urgency
 *
 * Uses MotionEngine vectors + Overpass API for places.
 * Max 3 corridors rendered. Max 8 place labels total.
 * Roads deferred — integration hook only.
 */
const ImpactZone = (function () {

    // ── Config ─────────────────────────────────────────────────────
    const MAX_CORRIDORS = 3;
    const MAX_PLACE_LABELS = 8;
    const RECALC_DEBOUNCE_MS = 500;
    const LABEL_MIN_HOLD_MS = 8000;
    const ETA_CHANGE_THRESHOLD_MIN = 2;
    const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
    const OVERPASS_CACHE_TTL_MS = 300000;  // 5 min
    const DEG_PER_MI = 1 / 69.0;

    const QUALIFYING_EVENTS = new Set([
        "Tornado Warning",
        "Severe Thunderstorm Warning",
    ]);

    const CORRIDOR_COLORS = {
        "Tornado Warning":              { fill: "rgba(255, 0, 60, 0.12)", stroke: "rgba(255, 0, 60, 0.25)" },
        "Severe Thunderstorm Warning":  { fill: "rgba(255, 170, 0, 0.10)", stroke: "rgba(255, 170, 0, 0.20)" },
    };
    const DEFAULT_CORRIDOR_COLOR = { fill: "rgba(200, 100, 50, 0.08)", stroke: "rgba(200, 100, 50, 0.15)" };

    // ── State ──────────────────────────────────────────────────────
    let _map = null;
    let _corridorLayer = null;
    let _labelLayer = null;
    let _debounceTimer = null;
    let _lastLabelUpdateAt = 0;
    let _lastLabelHash = "";
    let _placeCache = {};   // bbox key -> { places, fetchedAt }
    let log = null;

    // ── Init ───────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("impact");

        StormState.on("alertsUpdated", _scheduleRecalc);
        StormState.on("autotrackTargetChanged", _scheduleRecalc);
    }

    function start(leafletMap) {
        _map = leafletMap;
        _corridorLayer = L.layerGroup().addTo(_map);
        _labelLayer = L.layerGroup().addTo(_map);

        // Ensure corridors sit below polygons by adding early
        // (Leaflet draws in add order; polygons added later via AlertRenderer)
    }

    function stop() {
        clearImpactZones();
    }

    // ── Scheduling ─────────────────────────────────────────────────

    function _scheduleRecalc() {
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(_recalc, RECALC_DEBOUNCE_MS);
    }

    // ── Main Recalculation ─────────────────────────────────────────

    async function _recalc() {
        if (!_map) return;
        // Feature flag gate
        if (typeof StormVizState !== "undefined" && !StormVizState.isEnabled()) {
            clearImpactZones();
            return;
        }

        const alerts = StormState.state.alerts.data || [];
        const trackedId = StormState.state.autotrack.targetAlertId;
        const vectors = StormState.state.motion.vectors;

        // Collect eligible alerts with motion
        const candidates = [];
        for (const alert of alerts) {
            if (!QUALIFYING_EVENTS.has(alert.event)) continue;
            if (!alert.polygon) continue;

            const vector = vectors[alert.id];
            if (!vector || vector.speedMph < 2) continue;

            const centroid = _getCentroid(alert.polygon);
            if (!centroid) continue;

            const isTracked = alert.id === trackedId;
            const score = (isTracked ? 1000 : 0)
                + (alert.event.includes("Tornado") ? 100 : 50)
                + vector.speedMph;

            candidates.push({ alert, centroid, vector, score, isTracked });
        }

        candidates.sort((a, b) => b.score - a.score);
        const selected = candidates.slice(0, MAX_CORRIDORS);

        if (selected.length === 0) {
            clearImpactZones();
            StormState.state.impactZone.active = false;
            return;
        }

        // Build corridors and render
        _corridorLayer.clearLayers();

        const allCorridors = {};
        const allImpacts = {};

        for (const { alert, centroid, vector, isTracked } of selected) {
            // Build corridors
            const corridors = buildImpactCorridorsForEvent(alert.polygon, centroid, vector);
            allCorridors[alert.id] = corridors;

            // Render corridor shading
            for (const c of corridors) {
                _renderCorridor(c, alert.event, isTracked);
            }

            // Find impacted places (async, but don't block rendering)
            _findImpactedPlaces(alert.id, corridors, centroid, vector, isTracked);
        }

        StormState.state.impactZone.active = true;
        StormState.state.impactZone.corridorsByEventId = allCorridors;
        StormState.state.impactZone.lastComputedAt = Date.now();
    }

    // ── Corridor Builder ───────────────────────────────────────────

    /**
     * Build 15 and 30 min impact corridors from polygon + motion vector.
     * Creates convex hull of current + projected polygon vertices.
     */
    function buildImpactCorridorsForEvent(polygonStr, centroid, vector) {
        const corridors = [];

        for (const minutes of [15, 30]) {
            const corridor = buildImpactCorridor({ polygonStr, centroid, vector, minutes });
            if (corridor) corridors.push(corridor);
        }

        return corridors;
    }

    function buildImpactCorridor({ polygonStr, centroid, vector, minutes }) {
        try {
            const geo = JSON.parse(polygonStr);
            const ring = _getOuterRing(geo);
            if (!ring || ring.length < 3) return null;

            // Project centroid forward
            const projected = _projectPosition(centroid.lat, centroid.lon, vector.bearingDeg, vector.speedMph, minutes);
            const deltaLat = projected.lat - centroid.lat;
            const deltaLon = projected.lon - centroid.lon;

            // Collect all vertices: current + projected
            const allPoints = [];
            for (const [lon, lat] of ring) {
                allPoints.push([lon, lat]);
                allPoints.push([lon + deltaLon, lat + deltaLat]);
            }

            // Convex hull
            const hull = _convexHull(allPoints);
            if (hull.length < 3) return null;

            // Build GeoJSON polygon
            const corridorGeo = {
                type: "Feature",
                geometry: {
                    type: "Polygon",
                    coordinates: [hull.concat([hull[0]])],  // close ring
                },
                properties: { minutes },
            };

            // Compute bbox
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            for (const [lon, lat] of hull) {
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
            }

            return {
                minutes,
                polygon: corridorGeo,
                ring: hull,
                bbox: { s: minLat, n: maxLat, w: minLon, e: maxLon },
            };
        } catch (e) {
            if (log) log.info("impact_corridor_fallback", { reason: "geometry_error" });
            return null;
        }
    }

    // ── Corridor Rendering ─────────────────────────────────────────

    function _renderCorridor(corridor, eventType, isTracked) {
        if (!corridor || !corridor.polygon) return;

        const colors = CORRIDOR_COLORS[eventType] || DEFAULT_CORRIDOR_COLOR;
        const is15 = corridor.minutes === 15;

        const layer = L.geoJSON(corridor.polygon, {
            style: {
                fillColor: colors.fill,
                fillOpacity: is15 ? 1.0 : 0.7,  // CSS handles actual opacity via class
                color: colors.stroke,
                weight: is15 ? 1 : 0.5,
                opacity: is15 ? 1.0 : 0.6,
                dashArray: is15 ? "" : "4,3",
                interactive: false,
                className: `impact-zone impact-zone--${corridor.minutes} ${isTracked ? "impact-zone--tracked" : ""}`,
            },
        });
        _corridorLayer.addLayer(layer);
    }

    // ── Place Impact Detection ─────────────────────────────────────

    async function _findImpactedPlaces(eventId, corridors, centroid, vector, isTracked) {
        if (corridors.length === 0) return;

        // Use the widest corridor (30 min) bbox for place query
        const widest = corridors[corridors.length - 1];
        if (!widest || !widest.bbox) return;

        const bbox = widest.bbox;
        const cacheKey = `${bbox.s.toFixed(2)},${bbox.w.toFixed(2)},${bbox.n.toFixed(2)},${bbox.e.toFixed(2)}`;

        // Check cache
        let places;
        if (_placeCache[cacheKey] && Date.now() - _placeCache[cacheKey].fetchedAt < OVERPASS_CACHE_TTL_MS) {
            places = _placeCache[cacheKey].places;
        } else {
            places = await _queryPlaces(bbox);
            _placeCache[cacheKey] = { places, fetchedAt: Date.now() };
        }

        if (!places || places.length === 0) {
            if (log && !_placeCache._loggedMissing) {
                log.info("impact_dataset_missing", { dataset: "places" });
                _placeCache._loggedMissing = true;
            }
            return;
        }

        // Test each place against corridors
        const impactedPlaces = [];
        for (const place of places) {
            let bucket = null;
            let inMinutes = null;

            // Check 15 min corridor first
            const c15 = corridors.find(c => c.minutes === 15);
            if (c15 && c15.ring && _pointInRing(place.lat, place.lon, c15.ring)) {
                bucket = "imminent";
                inMinutes = 15;
            }

            // Check 30 min corridor
            if (!bucket) {
                const c30 = corridors.find(c => c.minutes === 30);
                if (c30 && c30.ring && _pointInRing(place.lat, place.lon, c30.ring)) {
                    bucket = "near";
                    inMinutes = 30;
                }
            }

            if (!bucket) continue;

            // Estimate ETA
            const eta = estimateEtaMinutes(centroid, place.lat, place.lon, vector.speedMph, vector.bearingDeg);

            impactedPlaces.push({
                id: `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`,
                name: place.name,
                lat: place.lat,
                lon: place.lon,
                type: place.type,
                etaMin: eta,
                bucket,
                priorityScore: (bucket === "imminent" ? 100 : 50) + (eta != null ? (30 - Math.min(eta, 30)) : 0),
            });
        }

        // Sort by priority
        impactedPlaces.sort((a, b) => b.priorityScore - a.priorityScore);

        // Store impacts
        StormState.state.impactZone.impactsByEventId[eventId] = {
            places: impactedPlaces,
            highestPriorityPlace: impactedPlaces[0] || null,
        };

        // Render labels (with anti-flap)
        _renderPlaceLabels(impactedPlaces, isTracked, eventId);

        if (log && impactedPlaces.length > 0) {
            log.info("impact_zone_updated", {
                event_id: eventId.slice(-12),
                place_count: impactedPlaces.length,
                road_count: 0,
                corridor_count: corridors.length,
                tracked: isTracked,
            });
        }
    }

    // ── Place Labels ───────────────────────────────────────────────

    function _renderPlaceLabels(places, isTracked, eventId) {
        const now = Date.now();

        // Anti-flap: check if labels changed materially
        const labelHash = places.slice(0, MAX_PLACE_LABELS).map(p =>
            `${p.name}:${p.etaMin != null ? Math.round(p.etaMin) : "?"}`
        ).join("|");

        if (labelHash === _lastLabelHash && now - _lastLabelUpdateAt < LABEL_MIN_HOLD_MS) {
            return;  // Hold current labels
        }

        // Clear existing labels
        if (_labelLayer) {
            // Remove tooltips from map
            if (_labelLayer._tooltips) {
                for (const t of _labelLayer._tooltips) {
                    if (_map) _map.removeLayer(t);
                }
            }
            _labelLayer.clearLayers();
            _labelLayer._tooltips = [];
        }

        // Track total labels across all events
        let totalLabels = 0;
        const maxForThisEvent = isTracked ? 5 : 3;
        const toRender = places.slice(0, Math.min(maxForThisEvent, MAX_PLACE_LABELS - totalLabels));

        for (const place of toRender) {
            if (totalLabels >= MAX_PLACE_LABELS) break;

            const etaText = place.etaMin != null ? ` ${Math.round(place.etaMin)}m` : "";
            const isImminent = place.bucket === "imminent";

            // Circle marker at place location
            const marker = L.circleMarker([place.lat, place.lon], {
                radius: isImminent ? 4 : 3,
                color: isImminent ? "#ff4444" : "#f59e0b",
                fillColor: isImminent ? "#ff4444" : "#f59e0b",
                fillOpacity: isImminent ? 0.7 : 0.5,
                weight: 1,
                interactive: false,
                className: "impact-place-dot",
            });
            _labelLayer.addLayer(marker);

            // Tooltip label
            const tooltip = L.tooltip({
                permanent: true,
                direction: "right",
                className: `impact-place-label ${isImminent ? "impact-place-label--imminent" : ""}`,
                offset: [6, 0],
            }).setLatLng([place.lat, place.lon])
              .setContent(`${_esc(place.name)}${etaText}`);
            tooltip.addTo(_map);

            if (!_labelLayer._tooltips) _labelLayer._tooltips = [];
            _labelLayer._tooltips.push(tooltip);
            totalLabels++;
        }

        _lastLabelHash = labelHash;
        _lastLabelUpdateAt = now;
    }

    // ── ETA Estimation ─────────────────────────────────────────────

    /**
     * Estimate time to reach a target point along the motion bearing.
     * Projects distance along the bearing axis only (not perpendicular).
     */
    function estimateEtaMinutes(originCentroid, targetLat, targetLon, speedMph, bearingDeg) {
        if (!speedMph || speedMph < 1) return null;

        const bearingRad = bearingDeg * Math.PI / 180;
        const cosLat = Math.max(Math.cos(originCentroid.lat * Math.PI / 180), 0.01);

        // Vector from origin to target
        const dy = (targetLat - originCentroid.lat) / DEG_PER_MI;
        const dx = (targetLon - originCentroid.lon) / (DEG_PER_MI / cosLat);

        // Project onto bearing axis (dot product)
        const alongBearing = dx * Math.sin(bearingRad) + dy * Math.cos(bearingRad);

        // Negative = behind the storm
        if (alongBearing <= 0) return null;

        const etaHours = alongBearing / speedMph;
        const etaMin = etaHours * 60;

        // Clamp
        if (etaMin < 0 || etaMin > 60) return null;

        return Math.round(etaMin * 10) / 10;
    }

    // ── Overpass Query ─────────────────────────────────────────────

    async function _queryPlaces(bbox) {
        const query = `[out:json][timeout:5];
            (node["place"~"city|town|village"](${bbox.s},${bbox.w},${bbox.n},${bbox.e}););
            out body 30;`;

        try {
            const resp = await fetch(OVERPASS_URL, {
                method: "POST",
                body: "data=" + encodeURIComponent(query),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
            if (!resp.ok) return [];
            const data = await resp.json();
            return (data.elements || []).map(el => ({
                name: el.tags?.name || "Unknown",
                type: el.tags?.place || "place",
                lat: el.lat,
                lon: el.lon,
            }));
        } catch (e) {
            return [];
        }
    }

    // ── Geometry Helpers ───────────────────────────────────────────

    function _getCentroid(polygonStr) {
        try {
            const geo = JSON.parse(polygonStr);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            const c = b.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) { return null; }
    }

    function _getOuterRing(geo) {
        if (geo.type === "Polygon") return geo.coordinates[0];
        if (geo.type === "MultiPolygon") return geo.coordinates[0][0];
        return null;
    }

    function _projectPosition(lat, lon, bearingDeg, speedMph, minutes) {
        const distMi = speedMph * (minutes / 60);
        const bearingRad = bearingDeg * Math.PI / 180;
        const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.01);
        return {
            lat: lat + distMi * Math.cos(bearingRad) * DEG_PER_MI,
            lon: lon + distMi * Math.sin(bearingRad) * DEG_PER_MI / cosLat,
        };
    }

    function _pointInRing(lat, lon, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if ((yi > lat) !== (yj > lat) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Convex hull via gift wrapping (Jarvis march).
     * Input: [[lon, lat], ...]. Output: [[lon, lat], ...] in CCW order.
     */
    function _convexHull(points) {
        if (points.length < 3) return points.slice();

        // Find leftmost point
        let startIdx = 0;
        for (let i = 1; i < points.length; i++) {
            if (points[i][0] < points[startIdx][0] ||
                (points[i][0] === points[startIdx][0] && points[i][1] < points[startIdx][1])) {
                startIdx = i;
            }
        }

        const hull = [];
        let current = startIdx;
        const visited = new Set();

        do {
            hull.push(points[current]);
            visited.add(current);
            let next = 0;
            for (let i = 0; i < points.length; i++) {
                if (i === current) continue;
                const cross = _cross(points[current], points[next], points[i]);
                if (next === current || cross > 0 ||
                    (cross === 0 && _dist2(points[current], points[i]) > _dist2(points[current], points[next]))) {
                    next = i;
                }
            }
            current = next;

            // Safety: prevent infinite loop
            if (hull.length > points.length) break;
        } while (current !== startIdx);

        return hull;
    }

    function _cross(o, a, b) {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }

    function _dist2(a, b) {
        return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    }

    // ── Clear ──────────────────────────────────────────────────────

    function clearImpactZones() {
        if (_corridorLayer) _corridorLayer.clearLayers();
        if (_labelLayer) {
            if (_labelLayer._tooltips) {
                for (const t of _labelLayer._tooltips) {
                    if (_map) _map.removeLayer(t);
                }
                _labelLayer._tooltips = [];
            }
            _labelLayer.clearLayers();
        }
        _lastLabelHash = "";

        StormState.state.impactZone.active = false;
        StormState.state.impactZone.corridorsByEventId = {};
        StormState.state.impactZone.impactsByEventId = {};
    }

    function _esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    // ── Public API ─────────────────────────────────────────────────

    return {
        init,
        start,
        stop,
        buildImpactCorridor,
        buildImpactCorridorsForEvent,
        estimateEtaMinutes,
        clearImpactZones,
    };
})();
