/**
 * Storm Tracker — Polygon Visual Differentiation + Flash System
 *
 * Stable color assignment for multi-alert clusters during context zoom.
 * Bounded flashing: primary tracked polygon flashes by default;
 * secondary polygons flash only under critical escalation rules.
 *
 * Max simultaneous flashing polygons: 2.
 * Flash cycle: 1.2s CSS animation (border glow pulse, not hard blink).
 */
const PolygonVisuals = (function () {

    // ── Color Palette (fixed, deterministic) ───────────────────────
    const CONTEXT_POLYGON_PALETTE = [
        "ctx-red",
        "ctx-amber",
        "ctx-yellow",
        "ctx-lime",
        "ctx-cyan",
        "ctx-blue",
        "ctx-violet",
        "ctx-magenta",
    ];

    // Hex values for Leaflet styling (match CSS classes)
    const PALETTE_HEX = {
        "ctx-red":     "#ef4444",
        "ctx-amber":   "#f59e0b",
        "ctx-yellow":  "#eab308",
        "ctx-lime":    "#84cc16",
        "ctx-cyan":    "#06b6d4",
        "ctx-blue":    "#3b82f6",
        "ctx-violet":  "#8b5cf6",
        "ctx-magenta": "#d946ef",
    };

    // ── Flash Config ───────────────────────────────────────────────
    const MAX_FLASHING = 2;
    const FLASH_MIN_HOLD_MS = 6000;
    const FLASH_MIN_CHANGE_MS = 5000;

    // ── Runtime State ──────────────────────────────────────────────
    let _state = {
        clusterId: null,
        primaryEventId: null,
        colorAssignments: {},      // eventId -> color token
        flashingEventIds: [],
        lastFlashChangeAt: 0,
    };

    let log = null;

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("poly_vis");

        // Re-compute SPC intersections when alerts change
        StormState.on("alertsUpdated", () => {
            if (_spcBboxIndex.length > 0) _scheduleIntersectionRecalc();
        });
    }

    // ── Stable Color Assignment ────────────────────────────────────

    /**
     * Deterministic hash of event ID to palette index.
     * @param {string} eventId
     * @returns {number} palette index
     */
    function _hashEventId(eventId) {
        let hash = 0;
        for (let i = 0; i < eventId.length; i++) {
            hash = ((hash << 5) - hash + eventId.charCodeAt(i)) | 0;
        }
        return Math.abs(hash);
    }

    /**
     * Get stable color token for an event ID within a cluster.
     * @param {string} eventId
     * @param {string[]} clusterEventIds - All event IDs in the cluster
     * @returns {string} Color token from CONTEXT_POLYGON_PALETTE
     */
    function getStablePolygonColorToken(eventId, clusterEventIds) {
        const idx = _hashEventId(eventId) % CONTEXT_POLYGON_PALETTE.length;
        let token = CONTEXT_POLYGON_PALETTE[idx];

        // Check for collision within cluster
        const usedTokens = new Set();
        for (const eid of clusterEventIds) {
            if (eid === eventId) continue;
            const otherIdx = _hashEventId(eid) % CONTEXT_POLYGON_PALETTE.length;
            usedTokens.add(CONTEXT_POLYGON_PALETTE[otherIdx]);
        }

        // If collision, find next available
        if (usedTokens.has(token)) {
            for (let offset = 1; offset < CONTEXT_POLYGON_PALETTE.length; offset++) {
                const candidate = CONTEXT_POLYGON_PALETTE[(idx + offset) % CONTEXT_POLYGON_PALETTE.length];
                if (!usedTokens.has(candidate)) {
                    token = candidate;
                    break;
                }
            }
        }

        return token;
    }

    /**
     * Build complete color assignments for a cluster.
     * Primary tracked polygon gets override class; secondaries get palette colors.
     * @param {Object[]} events - Alert objects in the cluster
     * @param {string} primaryEventId - Tracked alert ID
     * @returns {Record<string, string>} eventId -> color token
     */
    function buildClusterColorAssignments(events, primaryEventId) {
        const assignments = {};
        const clusterIds = events.map(e => e.id);

        for (const evt of events) {
            if (evt.id === primaryEventId) {
                assignments[evt.id] = "primary";
            } else {
                assignments[evt.id] = getStablePolygonColorToken(evt.id, clusterIds);
            }
        }

        return assignments;
    }

    // ── Flash Computation ──────────────────────────────────────────

    /**
     * Compute which event IDs should flash.
     * @param {Object[]} events - Alert objects in cluster
     * @param {string} primaryEventId - Tracked alert ID
     * @param {string} clusterSeverity - SeverityTier of the cluster
     * @returns {string[]} Event IDs that should flash (max 2)
     */
    function computeFlashingEventIds(events, primaryEventId, clusterSeverity) {
        const result = [];

        // Primary always flashes (if enabled)
        if (primaryEventId) result.push(primaryEventId);

        // Secondary flashing only if cluster is critical
        if (clusterSeverity === "critical" && result.length < MAX_FLASHING) {
            for (const evt of events) {
                if (evt.id === primaryEventId) continue;
                if (result.length >= MAX_FLASHING) break;

                const tier = SeverityModel.deriveSeverityTierForAlert(evt);
                if (tier === "significant" || tier === "critical") {
                    result.push(evt.id);
                }
            }
        }

        return result.slice(0, MAX_FLASHING);
    }

    // ── Update Context Polygon Visuals ─────────────────────────────

    /**
     * Master update function — called when cluster membership or primary changes.
     * @param {Object} opts
     * @param {Object[]} opts.clusterEvents - All alerts in the context cluster
     * @param {string} opts.primaryEventId - Tracked alert ID
     * @param {string} opts.clusterSeverity - Severity tier of cluster
     * @param {boolean} opts.flashingEnabled - Whether flash is on
     */
    // FM-3: Cap visually differentiated polygons
    const MAX_VISUAL_POLYGONS = 6;

    function updateContextPolygonVisuals({ clusterEvents, primaryEventId, clusterSeverity, flashingEnabled }) {
        if (!clusterEvents || clusterEvents.length === 0) {
            _clear();
            return;
        }

        // FM-3: Cap cluster size — keep primary + top N-1 by severity/proximity
        let capped = clusterEvents;
        if (clusterEvents.length > MAX_VISUAL_POLYGONS) {
            const primary = clusterEvents.find(e => e.id === primaryEventId);
            const rest = clusterEvents.filter(e => e.id !== primaryEventId).slice(0, MAX_VISUAL_POLYGONS - 1);
            capped = primary ? [primary, ...rest] : rest.slice(0, MAX_VISUAL_POLYGONS);
        }

        const clusterId = capped.map(e => e.id).sort().join(",");
        const colorAssignments = buildClusterColorAssignments(capped, primaryEventId);

        let flashingEventIds = [];
        if (flashingEnabled) {
            const now = Date.now();
            const candidateFlash = computeFlashingEventIds(capped, primaryEventId, clusterSeverity);

            // Anti-flap: only update flash set if enough time has passed
            const flashSetChanged = JSON.stringify(candidateFlash) !== JSON.stringify(_state.flashingEventIds);
            if (!flashSetChanged || now - _state.lastFlashChangeAt >= FLASH_MIN_CHANGE_MS) {
                flashingEventIds = candidateFlash;
                if (flashSetChanged) _state.lastFlashChangeAt = now;
            } else {
                flashingEventIds = _state.flashingEventIds; // keep previous
            }
        }

        const changed = clusterId !== _state.clusterId
            || primaryEventId !== _state.primaryEventId;

        _state.clusterId = clusterId;
        _state.primaryEventId = primaryEventId;
        _state.colorAssignments = colorAssignments;
        _state.flashingEventIds = flashingEventIds;

        if (changed && log) {
            log.info("polygon_visual_cluster_applied", {
                cluster_id: clusterId.slice(0, 40),
                primary_event_id: (primaryEventId || "").slice(-12),
                event_count: capped.length,
                flashing_count: flashingEventIds.length,
            });
        }
    }

    function _clear() {
        _state.clusterId = null;
        _state.primaryEventId = null;
        _state.colorAssignments = {};
        _state.flashingEventIds = [];
    }

    // ── Style Getters (for AlertRenderer integration) ──────────────

    /**
     * Get the visual style overrides for an alert polygon during context zoom.
     * Returns null if polygon is not in the active cluster.
     * @param {string} alertId
     * @returns {Object|null} { isPrimary, colorToken, hexColor, isFlashing, weight, opacity, fillOpacity }
     */
    function getPolygonStyle(alertId) {
        if (!_state.clusterId) return null;

        const token = _state.colorAssignments[alertId];
        if (!token) return null;

        const isPrimary = token === "primary";
        const isFlashing = _state.flashingEventIds.includes(alertId);

        return {
            isPrimary,
            colorToken: token,
            hexColor: isPrimary ? null : (PALETTE_HEX[token] || "#888"),
            isFlashing,
            weight: isPrimary ? 4 : 2,
            opacity: isPrimary ? 1.0 : 0.6,
            fillOpacity: isPrimary ? 0.25 : 0.10,
        };
    }

    /**
     * Check if context visuals are currently active.
     */
    function isActive() {
        return _state.clusterId !== null;
    }

    function getState() {
        return { ..._state };
    }

    // ── SPC Intersection Engine ────────────────────────────────────

    const SPC_CATEGORY_ORDER = { "TSTM": 1, "MRGL": 2, "SLGT": 3, "ENH": 4, "MDT": 5, "HIGH": 6 };

    let _spcFeatures = [];       // cached SPC GeoJSON features
    let _spcBboxIndex = [];      // pre-computed bounding boxes
    let _intersectionDebounce = null;
    const INTERSECT_DEBOUNCE_MS = 300;

    /**
     * Set SPC features for intersection testing.
     * Called when SPC layer changes.
     * @param {GeoJSON.Feature[]} features
     */
    function setSpcFeatures(features) {
        _spcFeatures = features || [];
        _spcBboxIndex = _spcFeatures.map(f => {
            const cat = _normalizeSpcLabel(f.properties?.LABEL || f.properties?.LABEL2 || f.properties?.dn || "");
            return {
                feature: f,
                category: cat,
                score: SPC_CATEGORY_ORDER[cat] || 0,
                bbox: _getFeatureBbox(f),
            };
        }).filter(e => e.score > 0);

        // Trigger debounced recalc
        _scheduleIntersectionRecalc();
    }

    function _normalizeSpcLabel(label) {
        const u = (label || "").toUpperCase().trim();
        if (SPC_CATEGORY_ORDER[u] !== undefined) return u;
        // Numeric label fallback
        const numMap = { "2": "TSTM", "0.02": "TSTM", "3": "MRGL", "0.05": "MRGL",
            "4": "SLGT", "0.10": "SLGT", "0.15": "SLGT", "5": "ENH", "0.25": "ENH",
            "0.30": "ENH", "6": "MDT", "0.35": "MDT", "0.45": "MDT", "8": "HIGH", "0.60": "HIGH" };
        return numMap[u] || u;
    }

    function _getFeatureBbox(feature) {
        if (!feature || !feature.geometry) return null;
        try {
            const layer = L.geoJSON({ type: "Feature", geometry: feature.geometry, properties: {} });
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            return b;
        } catch (e) { return null; }
    }

    /**
     * Get the highest SPC category that intersects an alert polygon.
     * Uses bbox precheck then centroid containment.
     * @param {Object} alertGeoJson - Parsed GeoJSON geometry
     * @returns {string|null} SPC category or null
     */
    function getSpcCategoryForPolygon(alertGeoJson) {
        if (_spcBboxIndex.length === 0) return null;

        // Get alert centroid
        let centroid;
        try {
            const layer = L.geoJSON(alertGeoJson);
            const b = layer.getBounds();
            if (!b.isValid()) return null;
            centroid = b.getCenter();
        } catch (e) { return null; }

        let bestCategory = null;
        let bestScore = 0;

        for (const entry of _spcBboxIndex) {
            // Bbox precheck
            if (entry.bbox && !entry.bbox.contains(centroid)) continue;

            // Point-in-polygon check
            if (_pointInSpcFeature({ lat: centroid.lat, lon: centroid.lng }, entry.feature)) {
                if (entry.score > bestScore) {
                    bestScore = entry.score;
                    bestCategory = entry.category;
                }
            }
        }

        return bestCategory;
    }

    function _pointInSpcFeature(point, feature) {
        if (!feature.geometry) return false;
        const geo = feature.geometry;
        if (geo.type === "Polygon") {
            return _pointInRing(point, geo.coordinates[0]);
        }
        if (geo.type === "MultiPolygon") {
            for (const poly of geo.coordinates) {
                if (_pointInRing(point, poly[0])) return true;
            }
        }
        return false;
    }

    function _pointInRing(point, ring) {
        let inside = false;
        const x = point.lon, y = point.lat;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Compute SPC category for all active alert polygons.
     * Stores result in state.spcVisual.categoryMap.
     */
    function computeSpcIntersections() {
        const alerts = StormState.state.alerts.data || [];
        const categoryMap = {};

        if (_spcBboxIndex.length === 0) {
            StormState.state.spcVisual.categoryMap = {};
            StormState.state.spcVisual.lastComputedAt = Date.now();
            return;
        }

        for (const alert of alerts) {
            if (!alert.polygon) continue;
            try {
                const geo = JSON.parse(alert.polygon);
                const cat = getSpcCategoryForPolygon(geo);
                if (cat) categoryMap[alert.id] = cat;
            } catch (e) { /* skip */ }
        }

        StormState.state.spcVisual.categoryMap = categoryMap;
        StormState.state.spcVisual.lastComputedAt = Date.now();

        if (log) {
            const count = Object.keys(categoryMap).length;
            if (count > 0) {
                log.info("spc_intersection_computed", {
                    polygon_count: count,
                    categories: [...new Set(Object.values(categoryMap))].join(","),
                });
            }
        }

        // Trigger polygon re-render to apply glow
        if (typeof AlertRenderer !== "undefined") {
            AlertRenderer.renderPolygons();
        }
    }

    function _scheduleIntersectionRecalc() {
        if (_intersectionDebounce) clearTimeout(_intersectionDebounce);
        _intersectionDebounce = setTimeout(computeSpcIntersections, INTERSECT_DEBOUNCE_MS);
    }

    /**
     * Get the SPC intersection category for a specific alert.
     * @param {string} alertId
     * @returns {string|null} SPC category or null
     */
    function getSpcCategory(alertId) {
        return StormState.state.spcVisual.categoryMap[alertId] || null;
    }

    /**
     * Check if SPC blending is active (features loaded).
     */
    function isSpcBlendingActive() {
        return _spcBboxIndex.length > 0;
    }

    return {
        init,
        getStablePolygonColorToken,
        buildClusterColorAssignments,
        computeFlashingEventIds,
        updateContextPolygonVisuals,
        getPolygonStyle,
        isActive,
        getState,
        PALETTE_HEX,
        // SPC blending
        setSpcFeatures,
        getSpcCategoryForPolygon,
        computeSpcIntersections,
        getSpcCategory,
        isSpcBlendingActive,
    };
})();

