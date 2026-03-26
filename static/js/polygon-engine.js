/**
 * Storm Tracker — Polygon Engine
 *
 * Multi-polygon rendering with normalization, deduplication,
 * stale cleanup, and safety caps. Manages all alert polygon
 * lifecycle on the Leaflet map.
 *
 * Pipeline: normalize → dedup → dropStale → enforceCap → render
 */
const PolygonEngine = (function () {

    // ── Constants ─────────────────────────────────────────────────
    const MAX_POLYGONS = 25;
    const STALE_EXPIRY_MS = 60000;          // 60s past expires = drop
    const UPDATE_THROTTLE_MS = 1000;        // max 1 update/sec

    const COLOR_MAP = {
        "Tornado Warning":              "#ff0000",
        "Severe Thunderstorm Warning":  "#ffd700",
        "Flash Flood Warning":          "#00ff7f",
    };
    const DEFAULT_COLOR = "#4a90d9";

    // Priority ranking for cap enforcement (lower = higher priority)
    const PRIORITY_RANK = {
        "Tornado Warning":              0,
        "Severe Thunderstorm Warning":  1,
        "Flash Flood Warning":          2,
    };
    const DEFAULT_PRIORITY = 99;

    // ── State ─────────────────────────────────────────────────────
    let _polygons = new Map();              // alert_id → { id, coordinates, intensity, motion_vector, event, expires, layer }
    let _primaryId = null;
    let _lastUpdateTs = 0;
    let _renderCount = 0;
    let _throttleTimer = null;

    let log = null;

    // ── Init ──────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") {
            log = STLogger.for("polygon_engine");
        }

        StormState.on("alertsUpdated", _onAlertsUpdated);
        StormState.on("autotrackTargetChanged", _onAutotrackTargetChanged);

        // React to backend-driven primary target changes
        StormState.on("primary_target_changed", function (data) {
            if (data && data.primary_id) {
                setPrimary(data.primary_id);
                if (log) log.info("polygon_primary_from_backend", { primary_id: data.primary_id });
            }
        });

        _log("info", "init", { max: MAX_POLYGONS, stale_ms: STALE_EXPIRY_MS });
    }

    // ── Event Handlers ────────────────────────────────────────────

    function _onAlertsUpdated() {
        const now = Date.now();
        if (now - _lastUpdateTs < UPDATE_THROTTLE_MS) {
            // Throttled — schedule deferred update
            if (!_throttleTimer) {
                _throttleTimer = setTimeout(function () {
                    _throttleTimer = null;
                    _processUpdate();
                }, UPDATE_THROTTLE_MS - (now - _lastUpdateTs));
            }
            return;
        }
        _processUpdate();
    }

    function _onAutotrackTargetChanged(data) {
        const newId = data && data.alertId ? data.alertId : null;
        if (newId !== _primaryId) {
            setPrimary(newId);
        }
    }

    // ── Core Pipeline ─────────────────────────────────────────────

    function _processUpdate() {
        _lastUpdateTs = Date.now();

        const alerts = _getAlerts();
        let polygons = normalizePolygons(alerts);
        polygons = deduplicatePolygons(polygons);
        polygons = dropStalePolygons(polygons);
        polygons = enforceMaxCap(polygons);

        // Update internal map
        const newMap = new Map();
        for (let i = 0; i < polygons.length; i++) {
            newMap.set(polygons[i].id, polygons[i]);
        }

        // Remove layers for polygons no longer present
        _polygons.forEach(function (entry, id) {
            if (!newMap.has(id) && entry.layer) {
                _removeLayer(entry.layer);
            }
        });

        _polygons = newMap;
        renderAll();

        StormState.emit("polygonsRendered", {
            count: _polygons.size,
            primaryId: _primaryId,
        });
    }

    function _getAlerts() {
        if (typeof StormState !== "undefined" &&
            StormState.state &&
            StormState.state.alerts &&
            Array.isArray(StormState.state.alerts.data)) {
            return StormState.state.alerts.data;
        }
        return [];
    }

    // ── Normalize ─────────────────────────────────────────────────

    function normalizePolygons(alerts) {
        var result = [];

        for (var i = 0; i < alerts.length; i++) {
            var alert = alerts[i];
            if (!alert) continue;

            var coords = _extractCoordinates(alert);
            if (!coords || coords.length === 0) continue;

            var intensity = _computeIntensity(alert);
            var motion = _extractMotionVector(alert);
            var expires = alert.expires ? new Date(alert.expires).getTime() : null;

            result.push({
                id: alert.id || alert.event_id || ("poly_" + i),
                coordinates: coords,
                intensity: intensity,
                motion_vector: motion,
                event: alert.event || "Unknown",
                expires: expires,
                layer: null,
            });
        }

        return result;
    }

    function _extractCoordinates(alert) {
        // GeoJSON geometry from alert
        var geom = alert.geometry;
        if (!geom) return null;

        if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
            // GeoJSON Polygon: coordinates[0] is outer ring [[lon,lat], ...]
            return _lonLatToLatLon(geom.coordinates[0]);
        }

        if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
            // Use first polygon of multi
            if (geom.coordinates.length > 0 && geom.coordinates[0].length > 0) {
                return _lonLatToLatLon(geom.coordinates[0][0]);
            }
        }

        // Fallback: check for polygon field directly
        if (Array.isArray(alert.polygon)) {
            return alert.polygon;
        }

        return null;
    }

    function _lonLatToLatLon(ring) {
        if (!Array.isArray(ring)) return null;
        var result = [];
        for (var i = 0; i < ring.length; i++) {
            if (Array.isArray(ring[i]) && ring[i].length >= 2) {
                result.push([ring[i][1], ring[i][0]]);  // [lat, lon]
            }
        }
        return result.length > 0 ? result : null;
    }

    function _computeIntensity(alert) {
        var event = alert.event || "";
        if (event === "Tornado Warning") return 100;
        if (event === "Severe Thunderstorm Warning") return 70;
        if (event === "Flash Flood Warning") return 50;
        return 30;
    }

    function _extractMotionVector(alert) {
        // Try to parse motion from NWS description
        var desc = alert.description || "";
        var match = desc.match(/moving\s+([\w]+)\s+at\s+(\d+)\s*mph/i);
        if (match) {
            return {
                direction: match[1],
                speed_mph: parseInt(match[2], 10),
            };
        }
        return null;
    }

    // ── Deduplicate ───────────────────────────────────────────────

    function deduplicatePolygons(polygons) {
        var seen = {};
        var result = [];

        for (var i = 0; i < polygons.length; i++) {
            var hash = _coordinateHash(polygons[i].coordinates);
            if (!seen[hash]) {
                seen[hash] = true;
                result.push(polygons[i]);
            }
        }

        return result;
    }

    function _coordinateHash(coords) {
        if (!coords || coords.length === 0) return "empty";
        var parts = [];
        for (var i = 0; i < coords.length; i++) {
            parts.push(coords[i][0].toFixed(4) + "," + coords[i][1].toFixed(4));
        }
        return parts.join("|");
    }

    // ── Stale Cleanup ─────────────────────────────────────────────

    function dropStalePolygons(polygons) {
        var now = Date.now();
        var kept = [];
        var droppedIds = [];

        for (var i = 0; i < polygons.length; i++) {
            var p = polygons[i];
            if (p.expires && (now - p.expires) > STALE_EXPIRY_MS) {
                droppedIds.push(p.id);
            } else {
                kept.push(p);
            }
        }

        if (droppedIds.length > 0) {
            _log("info", "polygon_dropped_stale", {
                count: droppedIds.length,
                ids: droppedIds,
            });
        }

        return kept;
    }

    // ── Cap Enforcement ───────────────────────────────────────────

    function enforceMaxCap(polygons) {
        if (polygons.length <= MAX_POLYGONS) return polygons;

        // Sort by priority (TOR > SVR > FFW > other), then by intensity desc
        polygons.sort(function (a, b) {
            var pa = PRIORITY_RANK[a.event] !== undefined ? PRIORITY_RANK[a.event] : DEFAULT_PRIORITY;
            var pb = PRIORITY_RANK[b.event] !== undefined ? PRIORITY_RANK[b.event] : DEFAULT_PRIORITY;
            if (pa !== pb) return pa - pb;
            return b.intensity - a.intensity;
        });

        var dropped = polygons.length - MAX_POLYGONS;
        var result = polygons.slice(0, MAX_POLYGONS);

        _log("warn", "polygon_cap_enforced", {
            dropped_count: dropped,
            max: MAX_POLYGONS,
        });

        return result;
    }

    // ── Rendering ─────────────────────────────────────────────────

    function renderAll() {
        var map = _getMap();
        if (!map) return;

        // Remove all existing polygon layers
        _polygons.forEach(function (entry) {
            if (entry.layer) {
                _removeLayer(entry.layer);
                entry.layer = null;
            }
        });

        var count = 0;

        _polygons.forEach(function (entry, id) {
            var isPrimary = (id === _primaryId);
            var color = COLOR_MAP[entry.event] || DEFAULT_COLOR;

            var style = isPrimary ? {
                color: color,
                weight: 4,
                opacity: 1.0,
                fillColor: color,
                fillOpacity: 0.3,
                dashArray: null,
                className: "polygon--engine-primary",
            } : {
                color: color,
                weight: 1.5,
                opacity: 0.4,
                fillColor: color,
                fillOpacity: 0.08,
                dashArray: "6, 4",
                className: "polygon--engine-secondary",
            };

            var layer = L.polygon(entry.coordinates, style);

            // Popup with alert info
            var popupHtml = '<div class="polygon-engine-popup">' +
                '<strong>' + _escapeHtml(entry.event) + '</strong>' +
                (entry.expires ? '<br>Expires: ' + new Date(entry.expires).toLocaleTimeString() : '') +
                (entry.motion_vector ? '<br>Motion: ' + _escapeHtml(entry.motion_vector.direction) +
                    ' at ' + entry.motion_vector.speed_mph + ' mph' : '') +
                '<br>Intensity: ' + entry.intensity +
                '</div>';
            layer.bindPopup(popupHtml);

            layer.addTo(map);
            entry.layer = layer;
            count++;
        });

        _renderCount++;

        _log("info", "polygon_rendered_count", {
            count: count,
            primary_id: _primaryId,
        });

        if (count > MAX_POLYGONS) {
            _log("warn", "polygon_count_exceeds_cap", {
                count: count,
                max: MAX_POLYGONS,
            });
        }
    }

    // ── Primary Selection ─────────────────────────────────────────

    function setPrimary(alertId) {
        var prev = _primaryId;
        _primaryId = alertId || null;

        if (prev !== _primaryId) {
            // Re-render to update styles
            renderAll();
            _log("info", "primary_changed", {
                prev: prev,
                current: _primaryId,
            });
        }
    }

    // ── Debug / State ─────────────────────────────────────────────

    function getState() {
        var polygonList = [];
        _polygons.forEach(function (entry, id) {
            polygonList.push({
                id: id,
                event: entry.event,
                intensity: entry.intensity,
                expires: entry.expires,
                isPrimary: id === _primaryId,
                hasLayer: !!entry.layer,
                motion: entry.motion_vector,
            });
        });

        return {
            count: _polygons.size,
            primaryId: _primaryId,
            renderCount: _renderCount,
            lastUpdateTs: _lastUpdateTs,
            polygons: polygonList,
        };
    }

    // ── Helpers ───────────────────────────────────────────────────

    function _getMap() {
        if (typeof StormMap !== "undefined" && StormMap.getMap) {
            return StormMap.getMap();
        }
        return null;
    }

    function _removeLayer(layer) {
        var map = _getMap();
        if (map && layer) {
            try { map.removeLayer(layer); } catch (e) { /* already removed */ }
        }
    }

    function _escapeHtml(str) {
        if (!str) return "";
        return str.replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;");
    }

    function _log(level, event, data) {
        if (log && typeof log[level] === "function") {
            log[level](event, data || {});
        }
    }

    // ── Public API ────────────────────────────────────────────────

    return {
        init:                 init,
        normalizePolygons:    normalizePolygons,
        deduplicatePolygons:  deduplicatePolygons,
        dropStalePolygons:    dropStalePolygons,
        enforceMaxCap:        enforceMaxCap,
        renderAll:            renderAll,
        setPrimary:           setPrimary,
        getState:             getState,
    };

})();
