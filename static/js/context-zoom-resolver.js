/**
 * Storm Tracker — Context Zoom Bounds Resolver
 *
 * Dedicated resolver for context zoom-out framing.
 * Ensures zoom-out always includes:
 *   1. The highlighted polygon
 *   2. Full relevant SPC reporting extent
 *   3. Geographic reference padding for orientation
 *
 * Safe-area-aware: accounts for header, status strip, dock, and open panels.
 * Anti-flap: debounces recomputation, only triggers on material changes.
 */
const ContextZoomResolver = (function () {

    // ── Configuration ──────────────────────────────────────────────────

    const CONFIG = {
        SPC_CONTEXT_RADIUS_MI: 150,        // max distance for SPC reports to be "relevant"
        REFERENCE_PADDING_FRACTION: 0.20,  // 20% padding for geographic reference
        MIN_GLOBAL_ZOOM: 3,               // absolute floor — continental view
        MAX_GLOBAL_ZOOM: 14,              // absolute ceiling — street level
        SAFE_AREA_TOP_PX: 52,             // fallback top bar height
        SAFE_AREA_BOTTOM_PX: 30,          // fallback status strip height
        SAFE_AREA_RIGHT_PX: 0,            // fallback; overridden by dynamic measurement
        SAFE_AREA_LEFT_PX: 0,
        DEBOUNCE_BASE_MS: 300,            // default debounce
        DEBOUNCE_POLYGON_CHANGE_MS: 0,    // immediate on polygon change
        DEBOUNCE_SPC_CHANGE_MS: 150,      // fast on SPC change
        STALE_THRESHOLD_MS: 500,
    };

    let _lastResolution = null;
    let _lastPolygonId = null;
    let _lastSpcCount = 0;
    let _debounceTimer = null;
    let log = null;

    // ── Init ───────────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("ctx_zoom_resolver");
    }

    // ── Primary Resolver ───────────────────────────────────────────────

    /**
     * Resolve context zoom bounds.
     *
     * @param {Object} params
     * @param {L.LatLngBounds} params.highlightedPolygonBounds - bounds of tracked polygon
     * @param {string} params.highlightedPolygonId - alert ID for change detection
     * @param {Array} params.spcReports - array of SPC report features with geometry
     * @param {L.LatLngBounds} params.spcOutlookBounds - bounds of active SPC outlook layer
     * @param {Object} params.viewport - { width, height } in pixels
     * @param {Object} params.safeAreaInsets - { top, bottom, left, right } in pixels
     * @param {L.Map} params.map - Leaflet map instance
     * @returns {Object|null} { bounds, zoom, center, reason }
     */
    function resolveContextZoomBounds(params) {
        const {
            highlightedPolygonBounds,
            highlightedPolygonId,
            spcReports,
            spcOutlookBounds,
            viewport,
            safeAreaInsets,
            map,
        } = params;

        if (!highlightedPolygonBounds || !highlightedPolygonBounds.isValid()) return null;
        if (!map) return null;

        // Step 1: Start with highlighted polygon bounds
        let merged = L.latLngBounds(
            highlightedPolygonBounds.getSouthWest(),
            highlightedPolygonBounds.getNorthEast()
        );
        let reason = "polygon_only";
        let usedSpcExtent = false;

        // Step 2: Filter relevant SPC reports
        const relevantReports = filterRelevantSpcReports(
            spcReports || [],
            highlightedPolygonBounds
        );

        // Step 3: Expand to include relevant SPC report extent
        if (relevantReports.length > 0) {
            const spcExtent = _computeSpcReportExtent(relevantReports);
            if (spcExtent && spcExtent.isValid()) {
                merged.extend(spcExtent);
                reason = "polygon_plus_spc_extent";
                usedSpcExtent = true;
            }
        }

        // Step 3b: Also include SPC outlook bounds if provided
        if (spcOutlookBounds && spcOutlookBounds.isValid()) {
            // Only include if it doesn't cause extreme zoom-out
            const mergedArea = _boundsArea(merged);
            const withSpcArea = _boundsAreaWith(merged, spcOutlookBounds);
            if (mergedArea > 0 && withSpcArea / mergedArea <= 15) {
                merged.extend(spcOutlookBounds);
                usedSpcExtent = true;
                reason = "polygon_plus_spc_extent";
            }
        }

        // Step 4: Apply geographic reference padding
        const paddingFraction = CONFIG.REFERENCE_PADDING_FRACTION;
        const padded = merged.pad(paddingFraction);
        if (usedSpcExtent) {
            reason = "polygon_plus_spc_extent_plus_reference_padding";
        } else {
            reason = "polygon_only_plus_reference_padding";
        }

        // Step 5: Fit to viewport with safe-area adjustments (dynamic measurement)
        const effectiveSafeArea = _computeEffectiveSafeArea(safeAreaInsets);
        const visibleBounds = _fitToVisibleViewport(padded, map, effectiveSafeArea);

        // Step 6: Compute zoom — clamp globally but NEVER clip required content
        const fittedZoom = map.getBoundsZoom(visibleBounds || padded);
        const targetZoom = _clampZoom(
            fittedZoom,
            CONFIG.MIN_GLOBAL_ZOOM,
            CONFIG.MAX_GLOBAL_ZOOM
        );

        // Step 6b: Containment assertion — if clamp pushed zoom tighter,
        // verify polygon + SPC extent still fit. If not, use fitted zoom.
        let finalZoom = targetZoom;
        if (targetZoom > fittedZoom + 0.5) {
            // Clamp made it tighter than content requires — violation
            if (log) {
                log.info("context_zoom_clamped", {
                    event_type: "context_zoom_clamped",
                    fitted_zoom: fittedZoom,
                    clamped_zoom: targetZoom,
                    reason: "clamp_would_clip_content",
                    timestamp: Date.now(),
                });
            }
            finalZoom = Math.max(CONFIG.MIN_GLOBAL_ZOOM, fittedZoom);
        }

        const center = (visibleBounds || padded).getCenter();

        const result = {
            bounds: visibleBounds || padded,
            zoom: finalZoom,
            center: { lat: center.lat, lon: center.lng },
            reason: reason,
            spcReportCount: relevantReports.length,
            usedSpcExtent: usedSpcExtent,
        };

        // Step 7: Log only on material change
        _logIfChanged(result, highlightedPolygonId, relevantReports.length);

        _lastResolution = result;
        return result;
    }

    // ── Debounced Resolver ─────────────────────────────────────────────

    /**
     * Debounced resolver with adaptive delay:
     *   - Polygon changed: immediate (0ms)
     *   - SPC reports changed: fast (150ms)
     *   - Other (viewport, safe-area): standard (300ms)
     */
    function resolveDebounced(params, callback) {
        if (_debounceTimer) clearTimeout(_debounceTimer);

        // Adaptive debounce based on what changed
        let delay = CONFIG.DEBOUNCE_BASE_MS;
        if (params.highlightedPolygonId !== _lastPolygonId) {
            delay = CONFIG.DEBOUNCE_POLYGON_CHANGE_MS;
        } else if (params.spcReports && params.spcReports.length !== _lastSpcCount) {
            delay = CONFIG.DEBOUNCE_SPC_CHANGE_MS;
        }

        _debounceTimer = setTimeout(() => {
            _debounceTimer = null;
            const result = resolveContextZoomBounds(params);
            if (callback) callback(result);
        }, delay);
    }

    // ── SPC Report Filtering ───────────────────────────────────────────

    /**
     * Filter SPC reports by relevance to the highlighted polygon.
     * Uses three criteria (any match = relevant):
     *   1. Bounds intersection with polygon
     *   2. Within directional cone of storm motion vector
     *   3. Within distance radius
     */
    function filterRelevantSpcReports(reports, polygonBounds, stormVector) {
        if (!reports || reports.length === 0) return [];
        if (!polygonBounds || !polygonBounds.isValid()) return reports;

        const center = polygonBounds.getCenter();
        const radiusMi = CONFIG.SPC_CONTEXT_RADIUS_MI;

        return reports.filter(report => {
            if (!report || !report.geometry) return false;

            // Criterion 1: Bounds intersection
            const reportBounds = _getFeatureBounds(report);
            if (reportBounds && polygonBounds.intersects(reportBounds)) {
                return true;
            }

            const reportCenter = _getFeatureCenter(report);
            if (!reportCenter) return false;

            // Criterion 2: Directional cone (if storm vector available)
            if (stormVector && stormVector.bearingDeg != null && stormVector.speedMph > 0) {
                if (_isWithinDirectionalCone(
                    center.lat, center.lng,
                    reportCenter.lat, reportCenter.lon,
                    stormVector.bearingDeg,
                    60 // 60-degree half-cone
                )) {
                    return true;
                }
            }

            // Criterion 3: Distance radius
            const distMi = _haversineDistanceMi(
                center.lat, center.lng,
                reportCenter.lat, reportCenter.lon
            );
            return distMi <= radiusMi;
        });
    }

    function _isWithinDirectionalCone(lat1, lon1, lat2, lon2, stormBearingDeg, halfConeDeg) {
        const bearing = _computeBearing(lat1, lon1, lat2, lon2);
        let diff = Math.abs(bearing - stormBearingDeg) % 360;
        if (diff > 180) diff = 360 - diff;
        return diff <= halfConeDeg;
    }

    function _computeBearing(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
                - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    // ── Geometry Helpers ───────────────────────────────────────────────

    function _computeSpcReportExtent(reports) {
        if (!reports || reports.length === 0) return null;

        let bounds = null;
        for (const report of reports) {
            const reportBounds = _getFeatureBounds(report);
            if (!reportBounds) continue;

            if (!bounds) {
                bounds = L.latLngBounds(reportBounds.getSouthWest(), reportBounds.getNorthEast());
            } else {
                bounds.extend(reportBounds);
            }
        }
        return bounds;
    }

    function _getFeatureCenter(feature) {
        if (!feature || !feature.geometry) return null;
        try {
            const geom = feature.geometry;
            if (geom.type === "Point") {
                return { lat: geom.coordinates[1], lon: geom.coordinates[0] };
            }
            const bounds = _getFeatureBounds(feature);
            if (!bounds) return null;
            const c = bounds.getCenter();
            return { lat: c.lat, lon: c.lng };
        } catch (e) { return null; }
    }

    function _getFeatureBounds(feature) {
        if (!feature || !feature.geometry) return null;
        try {
            const layer = L.geoJSON(feature);
            const b = layer.getBounds();
            return b && b.isValid() ? b : null;
        } catch (e) { return null; }
    }

    function _boundsArea(bounds) {
        if (!bounds || !bounds.isValid()) return 0;
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        return Math.abs(ne.lat - sw.lat) * Math.abs(ne.lng - sw.lng);
    }

    function _boundsAreaWith(baseBounds, extendBounds) {
        const union = L.latLngBounds(baseBounds.getSouthWest(), baseBounds.getNorthEast());
        union.extend(extendBounds);
        return _boundsArea(union);
    }

    function _haversineDistanceMi(lat1, lon1, lat2, lon2) {
        const R = 3958.8; // Earth radius in miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── Safe Area ──────────────────────────────────────────────────────

    /**
     * Compute effective safe area by measuring actual DOM elements,
     * falling back to config defaults if elements are not found.
     */
    function _computeEffectiveSafeArea(insets) {
        // Dynamic measurement of actual UI elements
        const measured = {
            top: _getElementHeight("top-bar") || CONFIG.SAFE_AREA_TOP_PX,
            bottom: _getElementHeight("system-status-strip") || CONFIG.SAFE_AREA_BOTTOM_PX,
            left: CONFIG.SAFE_AREA_LEFT_PX,
            right: _getElementWidth("alert-panel") || CONFIG.SAFE_AREA_RIGHT_PX,
        };

        // Check if panel is actually visible
        const panel = document.getElementById("alert-panel");
        if (panel && (panel.classList.contains("panel-closed") || panel.offsetWidth === 0)) {
            measured.right = 0;
        }

        // Check for demo panel on left
        const demoPanel = document.getElementById("demo-panel");
        if (demoPanel && !demoPanel.classList.contains("hidden") && demoPanel.offsetWidth > 0) {
            measured.left = Math.max(measured.left, demoPanel.offsetWidth + 10);
        }

        // Merge with explicit insets (caller overrides take priority)
        if (!insets) return measured;

        return {
            top: Math.max(measured.top, insets.top || 0),
            bottom: Math.max(measured.bottom, insets.bottom || 0),
            left: Math.max(measured.left, insets.left || 0),
            right: Math.max(measured.right, insets.right || 0),
        };
    }

    function _getElementHeight(id) {
        const el = document.getElementById(id);
        if (!el || el.offsetHeight === 0) return 0;
        return el.offsetHeight;
    }

    function _getElementWidth(id) {
        const el = document.getElementById(id);
        if (!el || el.offsetWidth === 0) return 0;
        return el.offsetWidth;
    }

    function _fitToVisibleViewport(bounds, map, safeArea) {
        if (!map || !bounds || !bounds.isValid()) return bounds;

        try {
            // Convert bounds to pixel coordinates
            const nePx = map.project(bounds.getNorthEast(), map.getZoom());
            const swPx = map.project(bounds.getSouthWest(), map.getZoom());

            // Adjust for safe areas — expand pixel bounds so content
            // is not hidden behind overlays
            const adjustedNePx = L.point(
                nePx.x + safeArea.right,
                nePx.y - safeArea.top
            );
            const adjustedSwPx = L.point(
                swPx.x - safeArea.left,
                swPx.y + safeArea.bottom
            );

            // Convert back to lat/lng
            const adjustedNe = map.unproject(adjustedNePx, map.getZoom());
            const adjustedSw = map.unproject(adjustedSwPx, map.getZoom());

            const adjusted = L.latLngBounds(adjustedSw, adjustedNe);
            return adjusted.isValid() ? adjusted : bounds;
        } catch (e) {
            return bounds;
        }
    }

    // ── Zoom Clamping ──────────────────────────────────────────────────

    function _clampZoom(zoom, min, max) {
        return Math.max(min, Math.min(max, zoom));
    }

    // ── Change Detection & Logging ─────────────────────────────────────

    function _logIfChanged(result, polygonId, spcCount) {
        if (!log) return;

        const polygonChanged = polygonId !== _lastPolygonId;
        const spcChanged = spcCount !== _lastSpcCount;
        const zoomChanged = !_lastResolution || Math.abs(result.zoom - _lastResolution.zoom) > 0.3;

        if (!polygonChanged && !spcChanged && !zoomChanged) {
            // Log skip
            if (_lastResolution && Date.now() - (_lastResolution._ts || 0) < CONFIG.STALE_THRESHOLD_MS) {
                return; // Too frequent, skip
            }
        }

        _lastPolygonId = polygonId;
        _lastSpcCount = spcCount;
        result._ts = Date.now();

        if (polygonChanged || spcChanged || zoomChanged) {
            log.info("context_zoom_resolved", {
                event_type: "context_zoom_resolved",
                highlighted_polygon_id: polygonId,
                spc_report_count: spcCount,
                used_spc_extent: result.usedSpcExtent,
                padding_applied: CONFIG.REFERENCE_PADDING_FRACTION,
                target_zoom: result.zoom,
                reason: result.reason,
                timestamp: Date.now(),
            });
        }
    }

    // ── Debug ──────────────────────────────────────────────────────────

    function getLastResolution() {
        return _lastResolution ? { ..._lastResolution } : null;
    }

    return {
        init,
        resolveContextZoomBounds,
        resolveDebounced,
        filterRelevantSpcReports,
        getLastResolution,
        CONFIG,
    };
})();
