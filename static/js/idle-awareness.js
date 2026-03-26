/**
 * Storm Tracker — Idle Awareness Engine (v3 — final hardening)
 *
 * Hardening additions:
 *   1. Camera interrupt safety (map.stop on exit/ownership loss)
 *   2. Target stickiness (8s hold minimum)
 *   3. Viewport-aware scoring (prefer in-frame targets)
 *   4. Regional scan path smoothing
 *   5. Environmental focus future hook (window.__stormEnvFeatures)
 *   6. Re-entry grace window (15s after alert exit)
 *   7. Log deduplication (2s window)
 *   8. Invalid bounds failsafe
 *   9. Eval throttle (max 1Hz)
 *   10. Label transition smoothing (300ms retain)
 */
const IdleAwareness = (function () {

    // ── Constants ────────────────────────────────────────────────
    const IDLE_ENTRY_DELAY_MS = 30000;
    const MIN_SUBMODE_DURATION_MS = 15000;
    const MIN_TARGET_HOLD_MS = 8000;
    const COOLDOWN_MS = 10000;

    // Part 1: Anti-jitter — dwell enforcement
    const IDLE_MIN_TARGET_DURATION_MS = 20000;   // min hold per target before switch
    const IDLE_CATEGORY_MIN_DURATION_MS = 45000;  // min hold per category before switch
    const CATEGORY_HYSTERESIS_BUFFER = 5;         // added to CATEGORY_SWITCH_MARGIN for stability
    const SUPPRESS_AFTER_INTERACTION_MS = 20000;
    const IDLE_REENTRY_GRACE_MS = 15000;
    const MAX_SUPPRESS_COUNT = 3;
    const SUPPRESS_LONG_MS = 300000;
    const EVAL_INTERVAL_MS = 5000;
    const EVAL_MIN_GAP_MS = 1000; // max 1Hz
    const RECENT_ALERT_WINDOW_MS = 3600000;
    const EXPIRED_SWEEP_WINDOW_MS = 3600000;
    const STALE_DATA_THRESHOLD_MS = 600000;
    const LOG_DEDUP_MS = 2000;
    const LABEL_RETAIN_MS = 300;

    // ── Idle Local Distance Policy ──────────────────────────────
    const IDLE_LOCAL_RADIUS_MI = 150;
    const IDLE_MAX_RADIUS_MI = 300;
    const IDLE_ALLOW_GLOBAL_FALLBACK = false;

    // Part 3: Movement polish — smoother transitions + optional micro-drift
    const IDLE_SMOOTH_TRANSITION_SEC = 3.0;       // default flyTo duration (soft)
    const IDLE_SMOOTH_EASING = 0.15;              // easeLinearity (lower = smoother)

    // Distance-based zoom: closer targets get tighter zoom for street-level detail
    let _lastZoomLogAt = 0;
    const ZOOM_LOG_INTERVAL_MS = 10000;

    // 3mi ≈ 0.043 degrees latitude
    const THREE_MI_DEG = 3 / 69.0;

    // Compute tight bounds: ~3-mile radius around a point
    function _getTargetTightBounds(lat, lng, radiusMi) {
        radiusMi = radiusMi || 3;
        const d = radiusMi / 69.0;
        return L.latLngBounds([lat - d, lng - d], [lat + d, lng + d]);
    }

    // Compute context bounds that include both home and target with padding
    function _getHomeTargetContextBounds(homeLat, homeLng, targetLat, targetLng, paddingFraction) {
        paddingFraction = paddingFraction || 0.3;
        const bounds = L.latLngBounds(
            [Math.min(homeLat, targetLat), Math.min(homeLng, targetLng)],
            [Math.max(homeLat, targetLat), Math.max(homeLng, targetLng)]
        );
        return bounds.pad(paddingFraction);
    }

    // Camera framing authority: only Home may be kept in frame
    // Work/GPS make events relevant but do NOT drive framing
    function _shouldKeepReferenceInFrame(lat, lng) {
        if (lat == null || lng == null) return { keep: false };
        const sl = state.savedLocations;
        if (sl.home && sl.home.lat != null) {
            const d = _haversineMi(lat, lng, sl.home.lat, sl.home.lng);
            if (d <= HOME_RADIUS_MI) return { keep: true, slot: "home", loc: sl.home };
        }
        return { keep: false };
    }

    // Legacy alias used in _focusOnAlert — returns Home-only reference
    function _getRelevantSavedLocationForTarget(lat, lng) {
        const r = _shouldKeepReferenceInFrame(lat, lng);
        return r.keep ? { slot: r.slot, loc: r.loc } : null;
        // (corridor/route association handled separately)
        return best;
    }

    // Compute bounds that include both target and a reference saved location
    function _getTargetReferenceBounds(targetLat, targetLng, refLat, refLng, padding) {
        padding = padding || 0.2;
        const bounds = L.latLngBounds(
            [Math.min(targetLat, refLat), Math.min(targetLng, refLng)],
            [Math.max(targetLat, refLat), Math.max(targetLng, refLng)]
        );
        return bounds.pad(padding);
    }

    let _lastRefFrameLogAt = 0;

    // Authoritative zoom for IDLE target focus
    // Point targets: flyTo at this exact zoom. Polygon targets: maxZoom clamp.
    function _getTargetZoom(distanceMi, category, hasPolygon) {
        if (category === "traffic") return 14;
        if (hasPolygon) return 12; // polygon maxZoom clamp
        return 13; // default 3mi view for all point targets including air/ambient
    }

    // Camera trace for debugging zoom overrides
    let _lastCameraTraceAt = 0;
    function _logCameraCommand(phase, method, zoom, lat, lng) {
        const now = Date.now();
        if (now - _lastCameraTraceAt < 3000) return;
        _lastCameraTraceAt = now;
        if (log) log.info("idle_camera_command", { phase, method, requestedZoom: zoom, centerLat: lat, centerLng: lng });
    }

    function _logZoomDecision(target, zoom, method) {
        const now = Date.now();
        if (now - _lastZoomLogAt < ZOOM_LOG_INTERVAL_MS) return;
        _lastZoomLogAt = now;
        if (log) log.info("idle_zoom_decision", {
            targetId: target.id ? String(target.id).slice(-12) : (target.event || "?"),
            distanceMi: target.distance_mi != null ? Math.round(target.distance_mi) : null,
            category: state.activeCategory || "?",
            zoom,
            method,
        });
    }
    const IDLE_LARGE_JUMP_TRANSITION_SEC = 2.0;   // category switch (purposeful but not instant)
    // Micro-drift: pan-only, no zoom, very infrequent, delayed after landing
    const IDLE_MICRO_DRIFT_PAN = 0.002;           // ~0.14mi — barely perceptible
    const IDLE_MICRO_DRIFT_INTERVAL_MS = 30000;   // every 30s (infrequent)
    const IDLE_MICRO_DRIFT_SETTLE_MS = 20000;     // no drift for 20s after landing
    const IDLE_MICRO_DRIFT_DURATION_SEC = 8.0;    // very slow pan transition
    let _microDriftTimer = null;
    let _microDriftLandedAt = 0;                   // when camera last arrived at target

    const DRIFT_PAN_FRACTION = 0.04;
    const DRIFT_ZOOM_DELTA = 0.3;
    const DRIFT_CYCLE_MS = 30000;
    const FOCUS_DWELL_MS = 10000;
    const SWEEP_DWELL_MS = 7000;
    const PATROL_DWELL_MS = 8000;
    const SCAN_DWELL_MS = 6000;
    const SCAN_TRANSITION_MS = 2000;
    const ENV_DWELL_MS = 12000;

    // Severe weather idle-blocking rules:
    // TOR = global (any distance blocks idle)
    // SVR = local only (must be within radius to block)
    const SVR_BLOCK_RADIUS_MI = 60;
    const SVR_DESTRUCTIVE_HAIL_IN = 1.75;
    const SVR_DESTRUCTIVE_WIND_MPH = 70;

    // ── Phase 1: Multi-Category Framework (additive) ──────────

    const IDLE_CATEGORIES = Object.freeze({
        weather:  "weather",
        traffic:  "traffic",
        outage:   "outage",
        safety:   "safety",
        flood:    "flood",
        air:      "air",
        ambient:  "ambient",
    });

    const CATEGORY_POLICY = Object.freeze({
        weather:  { enabled: true,  canControlCamera: true,  localRadiusMi: 150, minScoreToFocus: 10, dwellSec: 10, cooldownSec: 15 },
        traffic:  { enabled: false, canControlCamera: false, localRadiusMi: 25,  minScoreToFocus: 15, dwellSec: 20, cooldownSec: 60 },
        outage:   { enabled: false, canControlCamera: true,  localRadiusMi: 50,  minScoreToFocus: 15, dwellSec: 8,  cooldownSec: 30 },
        safety:   { enabled: false, canControlCamera: true,  localRadiusMi: 25,  minScoreToFocus: 25, dwellSec: 10, cooldownSec: 30 },
        flood:    { enabled: false, canControlCamera: true,  localRadiusMi: 75,  minScoreToFocus: 15, dwellSec: 10, cooldownSec: 20 },
        air:      { enabled: true,  canControlCamera: false, localRadiusMi: 50,  minScoreToFocus: 10, dwellSec: 20, cooldownSec: 60 },
        ambient:  { enabled: true,  canControlCamera: false, localRadiusMi: 50,  minScoreToFocus: 5,  dwellSec: 15, cooldownSec: 45 },
    });

    // Anti-flapping constants for Phase 2/3
    const CATEGORY_SWITCH_MARGIN = 12;
    const ADAPTER_LOG_INTERVAL_MS = 60000; // max 1 "unavailable" log per adapter per 60s
    const CANDIDATE_SUMMARY_LOG_INTERVAL_MS = 10000; // max 1 summary log per 10s

    // Local awareness markers + sweep
    const LOCAL_MARKER_RADIUS_MI = 30;
    const LOCAL_MARKER_MAX = 12;
    const LOCAL_MARKER_MIN_SCORE = 10;        // minimum score for non-primary markers
    const IDLE_LOCAL_SWEEP_COOLDOWN_MS = 45000;
    const IDLE_LOCAL_SWEEP_HOLD_MS = 5000;    // hold radius view for 5s
    const TRAFFIC_LABEL_MIN_ZOOM = 11;
    const TRAFFIC_LABEL_MIN_SCORE = 20;       // only major traffic gets labels

    // Bounded adapter log tracking
    const _adapterLastLogAt = {};
    let _lastCandidateSummaryLogAt = 0;

    // ── Saved Locations + Local Awareness Zone ──────────────────

    const SAVED_LOC_STORAGE_KEY = "idle_saved_locations";
    // Relevance radii (makes events eligible)
    const HOME_RADIUS_MI = 3;
    const WORK_RADIUS_MI = 2;
    const GPS_RADIUS_MI = 2;  // when fresh

    // Camera framing authority — only Home may be kept in frame
    // Work/GPS make events relevant but do NOT drive framing
    const CORRIDOR_HALF_WIDTH_MI = 5;     // 5mi corridor width (each side)
    const GPS_FRESH_MS = 60000;           // GPS is "fresh" if updated within 60s

    // Commute routes
    // ── Commute Route System (state, fetch, render, visibility) ──
    const COMMUTE_ROUTE_MAX = 3;
    const COMMUTE_ROUTE_POLL_MS = 600000;
    const COMMUTE_ROUTE_NEAR_MI = 1.5;
    const COMMUTE_ROUTE_WIDE_ZOOM = 11; // routes visible at zoom <= this

    // Flow enrichment
    const FLOW_POLL_MS = 300000; // 5 min
    let _commuteRouteFlow = null;   // { routes: [...], mode, fetched_at }
    let _flowFetchedAt = 0;
    let _flowFetching = false;
    const FLOW_COLORS = { free: "#22c55e", moderate: "#eab308", heavy: "#f97316", severe: "#ef4444" };

    async function _fetchCommuteFlow() {
        return; // Traffic feature removed
        if (_flowFetching) return;
        const sl = state.savedLocations;
        if (!sl.home || !(sl.work1 || sl.work2)) return;
        if (Date.now() - _flowFetchedAt < FLOW_POLL_MS) return;

        const work = sl.work1 || sl.work2;
        _flowFetching = true;
        try {
            const url = `/api/traffic/flow?home_lat=${sl.home.lat}&home_lon=${sl.home.lng}&work_lat=${work.lat}&work_lon=${work.lng}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            _commuteRouteFlow = data;
            _flowFetchedAt = Date.now();
        } catch (e) {
            // Keep previous flow data
        } finally {
            _flowFetching = false;
        }
    }

    function _applyFlowColoring(map) {
        if (!map || !_commuteRouteFlow || !_commuteRouteFlow.routes || _commuteRouteFlow.routes.length === 0) return;
        if (!_commuteRoutesVisible || _commuteRouteLayers.length === 0) return;

        const flowRoute = _commuteRouteFlow.routes[0];
        if (!flowRoute || !flowRoute.segments) return;

        // Apply color to primary route based on worst segment level
        const primary = _commuteRouteLayers[0];
        if (!primary) return;

        const worstLevel = flowRoute.worst_level || "free";
        const color = FLOW_COLORS[worstLevel] || FLOW_COLORS.free;

        primary.setStyle({ color, weight: 4, opacity: 0.75 });
    }

    // Authoritative state
    let _commuteRoutes = [];         // [{workSlot, points, minutes, distanceMi, trafficDelay, index}]
    let _commuteRouteLayers = [];    // [L.polyline, ...] — individual layer refs
    let _commuteRouteGroup = null;   // L.layerGroup on map
    let _commuteRoutesVisible = false;
    let _lastCommuteRouteKey = null; // "homeLat:homeLng:workLat:workLng"
    let _commuteRoutesFetchedAt = 0;
    let _commuteRoutesFetching = false;
    let _commuteRoutePane = null;
    let _lastCommuteLogAt = 0;
    const COMMUTE_LOG_INTERVAL_MS = 15000;

    function _ensureCommutePane(map) {
        if (_commuteRoutePane) return;
        _commuteRoutePane = map.createPane("commuteRoutePane");
        _commuteRoutePane.style.zIndex = 420; // above tiles (400), below focus (550)
        _commuteRoutePane.style.pointerEvents = "none";
    }

    function _getCommuteRouteKey() {
        const sl = state.savedLocations;
        if (!sl.home) return null;
        const work = sl.work1 || sl.work2;
        if (!work) return null;
        return `${sl.home.lat.toFixed(3)}:${sl.home.lng.toFixed(3)}:${work.lat.toFixed(3)}:${work.lng.toFixed(3)}`;
    }

    async function _fetchCommuteRoutes() {
        return; // Traffic feature removed
        if (_commuteRoutesFetching) return;
        const sl = state.savedLocations;
        if (!sl.home) return;
        const workSlot = sl.work1 ? "work1" : sl.work2 ? "work2" : null;
        if (!workSlot) return;
        const work = sl[workSlot];

        const now = Date.now();
        const routeKey = _getCommuteRouteKey();

        // Skip if same key and not stale
        if (routeKey === _lastCommuteRouteKey && (now - _commuteRoutesFetchedAt) < COMMUTE_ROUTE_POLL_MS) return;

        _commuteRoutesFetching = true;
        try {
            const url = `/api/commute/routes?home_lat=${sl.home.lat}&home_lon=${sl.home.lng}&work_lat=${work.lat}&work_lon=${work.lng}&alternatives=${COMMUTE_ROUTE_MAX}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();

            if (!data.routes || data.routes.length === 0) {
                // Keep previous routes if fetch returned empty (preserve stale data briefly)
                return;
            }

            _commuteRoutes = data.routes.map(r => ({
                workSlot,
                points: r.points,
                minutes: r.travelTimeMinutes,
                distanceMi: r.distanceMi,
                trafficDelay: r.trafficDelayMinutes,
                index: r.index,
            }));
            _commuteRoutesFetchedAt = now;
            _lastCommuteRouteKey = routeKey;

            if (now - _lastCommuteLogAt >= COMMUTE_LOG_INTERVAL_MS) {
                _lastCommuteLogAt = now;
                if (log) log.info("commute_routes_fetched", {
                    home: [sl.home.lat.toFixed(2), sl.home.lng.toFixed(2)],
                    work: [work.lat.toFixed(2), work.lng.toFixed(2)],
                    route_count: _commuteRoutes.length,
                    fastest_min: _commuteRoutes[0]?.minutes,
                    camera_mode: state.submode,
                });
            }
        } catch (e) {
            // Preserve previous routes on failure
        } finally {
            _commuteRoutesFetching = false;
        }
    }

    let _lastRenderedRouteCount = 0;

    function _renderCommuteRoutes(map) {
        if (!map) return;

        // Anti-flapping: skip if route count hasn't changed and key matches
        if (_commuteRouteLayers.length === _commuteRoutes.length &&
            _commuteRouteLayers.length === _lastRenderedRouteCount &&
            _commuteRouteGroup) return;

        _clearCommuteRouteLayers(map);
        if (_commuteRoutes.length === 0) { _lastRenderedRouteCount = 0; return; }

        _ensureCommutePane(map);
        _commuteRouteLayers = [];

        for (const route of _commuteRoutes) {
            if (!route.points || route.points.length < 2) continue;
            const latlngs = route.points.map(p => [p[0], p[1]]);
            const isPrimary = route.index === 0;

            _commuteRouteLayers.push(L.polyline(latlngs, {
                pane: "commuteRoutePane",
                color: isPrimary ? "#3b82f6" : "#64748b",
                weight: isPrimary ? 4 : 2,
                opacity: isPrimary ? 0.7 : 0.35,
                dashArray: isPrimary ? null : "8 6",
                interactive: false,
                lineCap: "round",
                lineJoin: "round",
            }));
        }

        _commuteRouteGroup = L.layerGroup(_commuteRouteLayers);
        _lastRenderedRouteCount = _commuteRouteLayers.length;

        // Visibility controller adds/removes from map
        _commuteRoutesVisible = false; // reset — let visibility controller decide
        _updateCommuteRouteVisibility(map);

        // Verification + log
        const verified = _commuteRouteLayers.length === _commuteRoutes.length;
        const now = Date.now();
        if (now - _lastCommuteLogAt >= COMMUTE_LOG_INTERVAL_MS) {
            _lastCommuteLogAt = now;
            const sl = state.savedLocations;
            const work = sl.work1 || sl.work2;
            if (log) log.info("commute_routes_rendered", {
                home: sl.home ? [sl.home.lat.toFixed(2), sl.home.lng.toFixed(2)] : null,
                work: work ? [work.lat.toFixed(2), work.lng.toFixed(2)] : null,
                route_count: _commuteRouteLayers.length,
                routes_in_state: _commuteRoutes.length,
                verified,
                visible: _commuteRoutesVisible,
                zoom: map.getZoom().toFixed(1),
                camera_mode: state.submode,
            });
        }

        // Single-path fallback note
        if (_commuteRoutes.length === 1 && log) {
            log.info("commute_routes_single_path_fallback", {
                route_count: 1,
                reason: "provider_returned_single_route",
            });
        }
    }

    let _visibilityDebounce = null;
    function _updateCommuteRouteVisibility(map) {
        if (!map || !_commuteRouteGroup) return;
        // Debounce rapid zoom events (100ms)
        if (_visibilityDebounce) return;
        _visibilityDebounce = setTimeout(() => { _visibilityDebounce = null; }, 100);
        const zoom = map.getZoom();
        const shouldShow = zoom <= COMMUTE_ROUTE_WIDE_ZOOM && _commuteRouteLayers.length > 0;
        const wasVisible = _commuteRoutesVisible;

        if (shouldShow && !_commuteRoutesVisible) {
            _commuteRouteGroup.addTo(map);
            _commuteRoutesVisible = true;
        } else if (!shouldShow && _commuteRoutesVisible) {
            map.removeLayer(_commuteRouteGroup);
            _commuteRoutesVisible = false;
        }

        // Log on transition
        if (wasVisible !== _commuteRoutesVisible) {
            const now = Date.now();
            if (now - _lastCommuteLogAt >= COMMUTE_LOG_INTERVAL_MS) {
                _lastCommuteLogAt = now;
                if (log) log.info("commute_routes_visibility_changed", {
                    visible: _commuteRoutesVisible,
                    zoom: zoom.toFixed(1),
                    camera_mode: state.submode,
                    route_count: _commuteRouteLayers.length,
                });
            }
        }
    }

    function _clearCommuteRouteLayers(map) {
        if (_commuteRouteGroup) {
            if (map && _commuteRoutesVisible) map.removeLayer(_commuteRouteGroup);
            _commuteRouteGroup = null;
        }
        _commuteRouteLayers = [];
        _commuteRoutesVisible = false;
    }

    // Logical check: is a point near any fetched commute route? (independent of visibility)
    function _isNearHighlightedRoute(lat, lng, thresholdMi) {
        thresholdMi = thresholdMi || COMMUTE_ROUTE_NEAR_MI;
        for (const route of _commuteRoutes) {
            if (!route.points || route.points.length < 2) continue;
            // Sample every 5th segment for performance (routes have hundreds of points)
            for (let i = 0; i < route.points.length - 1; i += 5) {
                const j = Math.min(i + 5, route.points.length - 1);
                const dist = _distanceToSegmentMi(
                    lat, lng,
                    route.points[i][0], route.points[i][1],
                    route.points[j][0], route.points[j][1]
                );
                if (dist <= thresholdMi) return true;
            }
        }
        return false;
    }

    // Saved location markers on map
    let _savedLocMarkers = {};  // { home: L.marker, work1: L.marker, work2: L.marker }
    let _gpsDotLayer = null;
    let _corridorDebugLayer = null;
    let _lastSavedLocLogAt = 0;
    let _lastGpsDotLogAt = 0;

    function _loadSavedLocations() {
        try {
            const raw = localStorage.getItem(SAVED_LOC_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed.home || parsed.work1 || parsed.work2) {
                    state.savedLocations = {
                        home: parsed.home || null,
                        work1: parsed.work1 || null,
                        work2: parsed.work2 || null,
                    };
                    // Migration: ensure older records have userLabel field
                    for (const slot of ["home", "work1", "work2"]) {
                        const loc = state.savedLocations[slot];
                        if (loc && loc.userLabel === undefined) {
                            loc.userLabel = loc.label || null;
                        }
                    }
                }
            }
        } catch (e) { /* ignore corrupt data */ }
    }

    function _saveSavedLocations() {
        try {
            localStorage.setItem(SAVED_LOC_STORAGE_KEY, JSON.stringify(state.savedLocations));
        } catch (e) { /* storage full, etc */ }
    }

    // ── Address Normalization ────────────────────────────────────

    const STREET_SUFFIXES = {
        "ct": "Court", "rd": "Road", "st": "Street", "ave": "Avenue",
        "blvd": "Boulevard", "dr": "Drive", "ln": "Lane", "cir": "Circle",
        "pl": "Place", "way": "Way", "pkwy": "Parkway", "hwy": "Highway",
        "trl": "Trail", "ter": "Terrace",
    };

    const US_STATES = {"AL":1,"AK":1,"AZ":1,"AR":1,"CA":1,"CO":1,"CT":1,"DE":1,"FL":1,"GA":1,"HI":1,"ID":1,"IL":1,"IN":1,"IA":1,"KS":1,"KY":1,"LA":1,"ME":1,"MD":1,"MA":1,"MI":1,"MN":1,"MS":1,"MO":1,"MT":1,"NE":1,"NV":1,"NH":1,"NJ":1,"NM":1,"NY":1,"NC":1,"ND":1,"OH":1,"OK":1,"OR":1,"PA":1,"RI":1,"SC":1,"SD":1,"TN":1,"TX":1,"UT":1,"VT":1,"VA":1,"WA":1,"WV":1,"WI":1,"WY":1,"DC":1};
    const STATE_NAMES = {"OHIO":"OH","CALIFORNIA":"CA","TEXAS":"TX","FLORIDA":"FL","ILLINOIS":"IL","INDIANA":"IN","KENTUCKY":"KY","MICHIGAN":"MI","VIRGINIA":"VA","WISCONSIN":"WI","TENNESSEE":"TN","GEORGIA":"GA","PENNSYLVANIA":"PA","NEW YORK":"NY","NORTH CAROLINA":"NC","SOUTH CAROLINA":"SC","WEST VIRGINIA":"WV","NORTH DAKOTA":"ND","SOUTH DAKOTA":"SD","NEW JERSEY":"NJ","NEW MEXICO":"NM","NEW HAMPSHIRE":"NH","RHODE ISLAND":"RI"};

    function _normalizeAddressInput(raw) {
        let s = raw.trim().replace(/\s+/g, " ");
        // Expand street suffixes (only in the street part — before first comma)
        const firstComma = s.indexOf(",");
        const streetPart = firstComma >= 0 ? s.slice(0, firstComma) : s;
        const rest = firstComma >= 0 ? s.slice(firstComma) : "";
        const expandedStreet = streetPart.replace(/\b(\w+)$/i, (m) => {
            const expanded = STREET_SUFFIXES[m.toLowerCase()];
            return expanded || m;
        });
        return expandedStreet + rest;
    }

    function _extractUserState(input) {
        // Priority 1: ", XX 12345" or ", XX 12345-6789"
        const m1 = input.match(/,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/i);
        if (m1 && US_STATES[m1[1].toUpperCase()]) return m1[1].toUpperCase();
        // Priority 2: ", XX" at end
        const m2 = input.match(/,\s*([A-Z]{2})\s*$/i);
        if (m2 && US_STATES[m2[1].toUpperCase()]) return m2[1].toUpperCase();
        // Priority 3: "XX 12345" at end (no comma)
        const m3 = input.match(/\s([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/i);
        if (m3 && US_STATES[m3[1].toUpperCase()]) return m3[1].toUpperCase();
        // Priority 4: full state name near end
        const upper = input.toUpperCase();
        for (const [name, code] of Object.entries(STATE_NAMES)) {
            if (upper.includes(name)) return code;
        }
        return null;
    }

    function _buildGeoQueries(raw, normalized) {
        const queries = [raw]; // full raw first
        if (normalized !== raw) queries.push(normalized);

        const parts = normalized.split(",").map(s => s.trim());
        if (parts.length >= 2) {
            // Without ZIP
            const lastPart = parts[parts.length - 1];
            const noZip = lastPart.replace(/\s*\d{5}(-\d{4})?\s*$/, "").trim();
            if (noZip !== lastPart) queries.push([...parts.slice(0, -1), noZip].join(", "));
            // Without house number
            const streetPart = parts[0].replace(/^\d+\s+/, "").trim();
            if (streetPart !== parts[0]) queries.push([streetPart, ...parts.slice(1)].join(", "));
            // City + state + ZIP
            queries.push(parts.slice(1).join(", "));
            // City + state only
            if (parts.length >= 3) {
                const cityState = parts.slice(1).join(", ").replace(/\s*\d{5}(-\d{4})?\s*$/, "").trim();
                queries.push(cityState);
            }
        }

        // No-comma fallback: parse "Street City ST ZIP"
        const szm = normalized.match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/i);
        if (szm) {
            const beforeState = szm[1].trim();
            const st = szm[2].toUpperCase();
            const zip = szm[3];
            const words = beforeState.split(/\s+/);
            if (words.length >= 2) {
                const city = words[words.length - 1];
                const street = words.slice(0, -1).join(" ");
                queries.push(street + ", " + city + ", " + st + " " + zip);
                queries.push(city + ", " + st + " " + zip);
                queries.push(city + ", " + st);
            }
        }

        // ZIP only (very last resort)
        const zipMatch = normalized.match(/\b(\d{5})\b/);
        if (zipMatch) queries.push(zipMatch[1]);

        // Deduplicate
        const seen = new Set();
        return queries.filter(q => { const k = q.toLowerCase().trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    }

    function _matchesState(result, userState) {
        if (!userState) return true;
        const rState = ((result.address || {}).state || "").toUpperCase();
        if (rState === userState) return true;
        if (rState.includes(userState)) return true;
        for (const [name, code] of Object.entries(STATE_NAMES)) {
            if (code === userState && rState.includes(name)) return true;
        }
        return false;
    }

    async function _geocodeAddress(address) {
        if (!address || address.trim().length < 3) return null;

        const raw = address.trim().replace(/\s+/g, " ");
        const normalized = _normalizeAddressInput(raw);
        const userState = _extractUserState(raw);
        const queries = _buildGeoQueries(raw, normalized);

        if (log) log.info("geocode_state_detected", {
            raw_input: raw.slice(0, 60),
            normalized_input: normalized.slice(0, 60),
            detected_state: userState,
            query_count: queries.length,
        });

        for (let qi = 0; qi < queries.length; qi++) {
            const q = queries[qi];
            if (qi > 0) await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit

            if (log) log.info("geocode_query_attempt", { query: q.slice(0, 60), index: qi });

            try {
                const url = "https://nominatim.openstreetmap.org/search" +
                    "?q=" + encodeURIComponent(q) +
                    "&format=json&limit=5&countrycodes=us&addressdetails=1";
                const resp = await fetch(url, { headers: { "User-Agent": "StormTracker/1.0" } });
                if (!resp.ok) continue;
                const data = await resp.json();
                if (!data || data.length === 0) continue;

                // State guard
                let filtered = data;
                if (userState) {
                    const inState = data.filter(r => _matchesState(r, userState));
                    if (inState.length > 0) {
                        filtered = inState;
                    } else {
                        // All wrong state — log and skip
                        if (log) log.info("geocode_result_rejected_wrong_state", {
                            query: q.slice(0, 40),
                            result_state: ((data[0].address || {}).state || "?"),
                            expected: userState,
                        });
                        continue;
                    }
                }

                // Best result: prefer house-level, then street, then any
                let best = null;
                let precision = "approximate";
                for (const r of filtered) {
                    const addr = r.address || {};
                    if (addr.house_number) { best = r; precision = "exact"; break; }
                    if (!best && addr.road) { best = r; precision = "approximate"; }
                }
                if (!best) { best = filtered[0]; precision = "approximate"; }

                if (log) log.info("geocode_result_selected", {
                    query: q.slice(0, 40),
                    precision,
                    result_state: ((best.address || {}).state || "?"),
                    lat: parseFloat(best.lat).toFixed(4),
                    lng: parseFloat(best.lon).toFixed(4),
                });

                return {
                    lat: parseFloat(best.lat),
                    lng: parseFloat(best.lon),
                    displayName: best.display_name || address,
                    streetLevel: precision === "exact",
                    precision,
                    provider: "nominatim",
                    queryUsed: q,
                };
            } catch (e) { continue; }
        }

        if (log) log.info("saved_location_geocode_failed", { address: raw.slice(0, 60), reason: "all_queries_failed" });
        return null;
    }

    // ── Location Label + Display ─────────────────────────────────

    function _getDisplayLabel(location) {
        if (!location) return "";
        if (location.precision === "manual_pin") {
            return location.userLabel || location.resolvedLabel || `Pinned (${location.lat.toFixed(4)}, ${location.lng.toFixed(4)})`;
        }
        return location.resolvedLabel || location.rawInput || location.address || "";
    }

    function _getPrecisionBadge(location) {
        if (!location) return "";
        if (location.precision === "manual_pin") return "Manual Pin";
        if (location.precision === "exact") return "Geocoded";
        return "Approximate";
    }

    function _formatReverseLabel(data) {
        const addr = data.address || {};
        if (addr.house_number && addr.road) {
            const parts = [addr.house_number + " " + addr.road];
            if (addr.city || addr.town || addr.village) parts.push(addr.city || addr.town || addr.village);
            if (addr.state) parts.push(addr.state);
            return parts.join(", ");
        }
        const parts = [];
        if (addr.road) parts.push(addr.road);
        if (addr.city || addr.town || addr.village) parts.push(addr.city || addr.town || addr.village);
        if (addr.state) parts.push(addr.state);
        if (addr.postcode) parts.push(addr.postcode);
        return parts.join(", ") || data.display_name || "";
    }

    // ── Pin-Drop Location Picker ─────────────────────────────────

    let _locationPickerState = { active: false, targetSlot: null, targetKind: null };
    let _pinPreviewMarker = null;
    let _pickBannerEl = null;

    function _enterLocationPickMode(slot, kind) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        _locationPickerState = { active: true, targetSlot: slot, targetKind: kind || "home" };

        // Show banner
        if (!_pickBannerEl) {
            _pickBannerEl = document.createElement("div");
            _pickBannerEl.className = "loc-pick-banner";
            document.getElementById("app").appendChild(_pickBannerEl);
        }
        const label = kind === "work" ? "Work" : kind === "poi" ? "POI" : "Home";
        _pickBannerEl.innerHTML = `<span>Click map to place ${label} pin</span><button id="loc-pick-cancel" class="loc-pick-cancel">Cancel</button>`;
        _pickBannerEl.classList.remove("hidden");

        document.getElementById("loc-pick-cancel")?.addEventListener("click", () => _exitLocationPickMode());

        // Change cursor
        const mapEl = document.getElementById("map");
        if (mapEl) mapEl.style.cursor = "crosshair";

        // Wire one-time click handler
        map.once("click", (e) => {
            if (!_locationPickerState.active) return;
            _handleLocationPickClick(e.latlng);
        });

        // ESC to cancel
        const escHandler = (e) => { if (e.key === "Escape") { _exitLocationPickMode(); document.removeEventListener("keydown", escHandler); } };
        document.addEventListener("keydown", escHandler);

        if (log) log.info("location_pick_started", { field_id: slot, kind });
    }

    function _exitLocationPickMode() {
        _locationPickerState = { active: false, targetSlot: null, targetKind: null };
        _clearPinPreview();
        if (_pickBannerEl) _pickBannerEl.classList.add("hidden");
        const mapEl = document.getElementById("map");
        if (mapEl) mapEl.style.cursor = "";
        if (log) log.info("location_pick_cancelled", {});
    }

    function _handleLocationPickClick(latlng) {
        const { lat, lng } = latlng;
        const slot = _locationPickerState.targetSlot;
        const kind = _locationPickerState.targetKind;

        // Exit pick mode
        _locationPickerState = { active: false, targetSlot: null, targetKind: null };
        _clearPinPreview();
        if (_pickBannerEl) _pickBannerEl.classList.add("hidden");
        const mapEl = document.getElementById("map");
        if (mapEl) mapEl.style.cursor = "";

        // Save immediately
        _savePinnedLocation(slot, kind, lat, lng);
    }

    function _savePinnedLocation(slot, kind, lat, lng) {
        const prev = state.savedLocations[slot];
        const prevPrecision = prev?.precision;

        // Duplicate guard: skip if same coordinates within ~10m
        if (prev && prev.precision === "manual_pin" &&
            Math.abs(prev.lat - lat) < 0.0001 && Math.abs(prev.lng - lng) < 0.0001) {
            return; // same spot — no redundant save/route invalidation
        }

        const defaultLabel = slot === "home" ? "Home" : slot === "work1" ? "Work 1" : slot === "work2" ? "Work 2" : slot;

        state.savedLocations[slot] = {
            label: defaultLabel,
            userLabel: null, // user can set custom name later
            inputMode: "pin",
            rawInput: null,
            resolvedLabel: null,
            address: `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
            lat,
            lng,
            precision: "manual_pin",
            provider: "manual",
            geocodeQueryUsed: null,
            updatedAt: Date.now(),
        };
        _saveSavedLocations();
        renderSavedLocations();

        // Invalidate and refetch commute routes
        _lastCommuteRouteKey = null;
        _fetchCommuteRoutes();

        if (log) {
            log.info("location_pin_saved", { field_id: slot, kind, lat: lat.toFixed(4), lng: lng.toFixed(4), precision: "manual_pin" });
            if (prevPrecision && prevPrecision !== "manual_pin") {
                log.info("location_precision_upgraded", { from: prevPrecision, to: "manual_pin", lat: lat.toFixed(4), lng: lng.toFixed(4) });
            }
        }

        // Non-blocking reverse geocode for display label
        _reverseGeocodePinnedLocation(slot, lat, lng);

        // Update UI input if Settings panel is open
        const input = document.getElementById("sett-loc-" + slot);
        if (input) input.value = `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        const badge = document.getElementById("sett-badge-" + slot);
        if (badge) { badge.textContent = "MANUAL PIN"; badge.style.color = "#34d399"; }
        const status = document.getElementById("sett-loc-status");
        if (status) { status.textContent = "Saved (Manual Pin)"; status.style.color = "#34d399"; }
    }

    async function _reverseGeocodePinnedLocation(slot, lat, lng) {
        const loc = state.savedLocations[slot];
        if (!loc || loc.precision !== "manual_pin") return;

        try {
            const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`;
            const resp = await fetch(url, { headers: { "User-Agent": "StormTracker/1.0" } });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();

            // Use structured formatter — never raw display_name
            const label = _formatReverseLabel(data);
            if (label) {
                // Only set resolvedLabel — never overwrite userLabel
                loc.resolvedLabel = label;
                _saveSavedLocations();
                if (log) log.info("location_label_resolved", {
                    lat: lat.toFixed(4), lng: lng.toFixed(4),
                    precision: "manual_pin", label_source: "reverse_geocode",
                });
                // Update input display (only if user hasn't set a custom label)
                if (!loc.userLabel) {
                    const input = document.getElementById("sett-loc-" + slot);
                    if (input) input.value = label.slice(0, 60);
                }
                // Update meta line
                const meta = document.getElementById("sett-meta-" + slot);
                if (meta) meta.textContent = label.slice(0, 50) + " · " + lat.toFixed(4) + ", " + lng.toFixed(4);
            }
        } catch (e) {
            if (!loc.resolvedLabel) {
                loc.resolvedLabel = `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                _saveSavedLocations();
            }
            if (log) log.info("location_reverse_geocode_failed", { field_id: slot, lat: lat.toFixed(4), lng: lng.toFixed(4) });
        }
    }

    function _renderPinPreview(latlng) {
        _clearPinPreview();
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;
        _pinPreviewMarker = L.circleMarker([latlng.lat, latlng.lng], {
            radius: 8, color: "#f59e0b", fillColor: "#fbbf24", fillOpacity: 0.6,
            weight: 2, interactive: false,
        }).addTo(map);
    }

    function _clearPinPreview() {
        if (_pinPreviewMarker) {
            const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
            if (map) map.removeLayer(_pinPreviewMarker);
            _pinPreviewMarker = null;
        }
    }

    async function setSavedLocation(slot, address) {
        if (!["home", "work1", "work2"].includes(slot)) return { ok: false, error: "invalid slot" };
        if (!address || address.trim().length < 3) {
            // Clear the slot
            state.savedLocations[slot] = null;
            _saveSavedLocations();
            return { ok: true, cleared: true };
        }
        const geo = await _geocodeAddress(address);
        if (!geo) return { ok: false, error: "Address not found — try street, city, state ZIP" };

        state.savedLocations[slot] = {
            label: slot === "home" ? "Home" : slot === "work1" ? "Work 1" : "Work 2",
            rawInput: address.trim(),
            address: address.trim(),
            resolvedLabel: geo.displayName || address.trim(),
            lat: geo.lat,
            lng: geo.lng,
            precision: geo.precision || "approximate",
            provider: geo.provider || "nominatim",
            geocodeQueryUsed: geo.queryUsed || address.trim(),
            updatedAt: Date.now(),
        };
        _saveSavedLocations();

        const now = Date.now();
        if (now - _lastSavedLocLogAt >= 5000) {
            _lastSavedLocLogAt = now;
            if (log) log.info("saved_location_updated", {
                slot, address: address.trim(), lat: geo.lat.toFixed(4), lng: geo.lng.toFixed(4),
            });
        }
        // Immediately render + refetch routes
        renderSavedLocations();
        _lastCommuteRouteKey = null; // force route refresh on next render
        _fetchCommuteRoutes();
        if (log) log.info("commute_zone_model_updated", {
            home: state.savedLocations.home ? [state.savedLocations.home.lat.toFixed(2), state.savedLocations.home.lng.toFixed(2)] : null,
            work: (state.savedLocations.work1 || state.savedLocations.work2) ? [(state.savedLocations.work1 || state.savedLocations.work2).lat.toFixed(2), (state.savedLocations.work1 || state.savedLocations.work2).lng.toFixed(2)] : null,
            route_count: _commuteRoutes.length,
        });
        return { ok: true, lat: geo.lat, lng: geo.lng, displayName: geo.displayName, approximate: geo.precision !== "exact", precision: geo.precision };
    }

    // ── Local Awareness Zone Geometry ────────────────────────────

    function _isWithinSavedLocationRadius(lat, lng, loc, radiusMi) {
        if (!loc || loc.lat == null || loc.lng == null) return false;
        return _haversineMi(lat, lng, loc.lat, loc.lng) <= (radiusMi || LOCAL_RADIUS_MI);
    }

    // Distance from point to line segment AB (in miles)
    function _distanceToSegmentMi(pLat, pLng, aLat, aLng, bLat, bLng) {
        // Project point onto segment using parametric t
        const dx = bLat - aLat, dy = bLng - aLng;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-10) return _haversineMi(pLat, pLng, aLat, aLng); // degenerate segment

        let t = ((pLat - aLat) * dx + (pLng - aLng) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const projLat = aLat + t * dx;
        const projLng = aLng + t * dy;
        return _haversineMi(pLat, pLng, projLat, projLng);
    }

    function _isWithinLocationCorridor(lat, lng, a, b, halfWidthMi) {
        if (!a || !b || a.lat == null || b.lat == null) return false;
        const dist = _distanceToSegmentMi(lat, lng, a.lat, a.lng, b.lat, b.lng);
        return dist <= (halfWidthMi || CORRIDOR_HALF_WIDTH_MI);
    }

    function _isWithinLocalAwarenessZone(lat, lng) {
        if (lat == null || lng == null) return false;
        const sl = state.savedLocations;
        const home = sl.home;
        const w1 = sl.work1;
        const w2 = sl.work2;

        // Fresh GPS 2mi radius (relevance only, not framing)
        const gps = StormState.state.gpsFollow;
        const gpsFresh = gps && gps.active && gps.lat != null && gps.lon != null &&
            gps.lastUpdate && (Date.now() - gps.lastUpdate) < GPS_FRESH_MS;
        if (gpsFresh && GPS_RADIUS_MI > 0 && _haversineMi(lat, lng, gps.lat, gps.lon) <= GPS_RADIUS_MI) return true;

        // No saved locations and no GPS → fallback: always eligible
        if (!home && !w1 && !w2 && !gpsFresh) return true;

        // Home 3mi radius
        if (home && _isWithinSavedLocationRadius(lat, lng, home, HOME_RADIUS_MI)) return true;

        // Work 2mi radius (relevance only — does NOT drive camera framing)
        if (w1 && _isWithinSavedLocationRadius(lat, lng, w1, WORK_RADIUS_MI)) return true;
        if (w2 && _isWithinSavedLocationRadius(lat, lng, w2, WORK_RADIUS_MI)) return true;

        // Check corridors (straight-line fallback)
        if (home && w1 && _isWithinLocationCorridor(lat, lng, home, w1, CORRIDOR_HALF_WIDTH_MI)) return true;
        if (home && w2 && _isWithinLocationCorridor(lat, lng, home, w2, CORRIDOR_HALF_WIDTH_MI)) return true;

        // Check proximity to highlighted commute routes (more precise than corridor)
        if (_isNearHighlightedRoute(lat, lng, COMMUTE_ROUTE_NEAR_MI)) return true;

        return false;
    }

    // ── GPS Blue Dot ─────────────────────────────────────────────

    function _renderGpsBlueDot(map) {
        if (!map) return;
        _clearGpsBlueDot(map);

        const gps = StormState.state.gpsFollow;
        if (!gps || !gps.active || gps.lat == null || gps.lon == null) {
            state.gpsBlueDot = null;
            return;
        }

        const freshMs = gps.lastUpdate ? (Date.now() - gps.lastUpdate) : Infinity;
        if (freshMs > GPS_FRESH_MS) {
            state.gpsBlueDot = null;
            const now = Date.now();
            if (now - _lastGpsDotLogAt >= LOCAL_LOG_INTERVAL_MS) {
                _lastGpsDotLogAt = now;
                if (log) log.info("gps_dot_hidden", { reason: "stale" });
            }
            return;
        }

        _ensureFocusPane(map);
        _gpsDotLayer = L.circleMarker([gps.lat, gps.lon], {
            pane: "idleFocusPane",
            radius: 6,
            color: "#3b82f6",
            fillColor: "#60a5fa",
            fillOpacity: 0.9,
            weight: 2,
            opacity: 1,
            interactive: false,
            className: "idle-gps-dot",
        }).addTo(map);

        state.gpsBlueDot = { lat: gps.lat, lng: gps.lon, fresh: true };

        const now = Date.now();
        if (now - _lastGpsDotLogAt >= LOCAL_LOG_INTERVAL_MS) {
            _lastGpsDotLogAt = now;
            if (log) log.info("gps_dot_rendered", { lat: gps.lat.toFixed(4), lng: gps.lon.toFixed(4), fresh: true });
        }
    }

    function _clearGpsBlueDot(map) {
        if (_gpsDotLayer) { if (map) map.removeLayer(_gpsDotLayer); _gpsDotLayer = null; }
    }

    // ── Saved Location Map Markers ───────────────────────────────

    const SAVED_LOC_ICONS = {
        home:  "\uD83C\uDFE0",  // 🏠
        work1: "\uD83D\uDCBC",  // 💼
        work2: "\uD83D\uDCBC",  // 💼
    };

    function _renderSavedLocationMarkers(map) {
        if (!map) return;
        _clearSavedLocationMarkers(map);
        _ensureFocusPane(map);

        const sl = state.savedLocations;
        const now = Date.now();

        for (const slot of ["home", "work1", "work2"]) {
            const loc = sl[slot];
            if (!loc || loc.lat == null || loc.lng == null) continue;

            const icon = SAVED_LOC_ICONS[slot] || "\uD83D\uDCCD";
            const html = `<span class="idle-saved-loc-icon" data-slot="${slot}">${icon}</span>`;

            // Build popup content
            const displayName = loc.userLabel || loc.label || "Pinned Location";
            const precBadge = _getPrecisionBadge(loc);
            const metaLine = loc.resolvedLabel ? loc.resolvedLabel.slice(0, 50) : "";
            const coordLine = `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
            const popupHtml = `<div class="idle-loc-popup"><strong>${_esc(displayName)}</strong><br><span class="idle-loc-popup-badge">${precBadge}</span>${metaLine ? "<br>" + _esc(metaLine) : ""}</div>`;

            _savedLocMarkers[slot] = L.marker([loc.lat, loc.lng], {
                icon: L.divIcon({
                    className: "idle-saved-loc-wrapper",
                    html: html,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10],
                }),
                pane: "idleFocusPane",
                interactive: true,
                keyboard: false,
                zIndexOffset: -200,
            }).bindPopup(popupHtml, { className: "idle-loc-popup-container", maxWidth: 200 }).addTo(map);

            if (now - _lastSavedLocLogAt >= LOCAL_LOG_INTERVAL_MS) {
                _lastSavedLocLogAt = now;
                if (log) log.info("saved_location_rendered", { slot, lat: loc.lat.toFixed(2), lng: loc.lng.toFixed(2) });
            }
        }
    }

    function _clearSavedLocationMarkers(map) {
        for (const slot of ["home", "work1", "work2"]) {
            if (_savedLocMarkers[slot]) {
                if (map) map.removeLayer(_savedLocMarkers[slot]);
                _savedLocMarkers[slot] = null;
            }
        }
    }

    // Optional: render corridor debug lines
    function _renderCorridorDebug(map) {
        if (!map) return;
        if (_corridorDebugLayer) { map.removeLayer(_corridorDebugLayer); _corridorDebugLayer = null; }
        _ensureFocusPane(map);

        const sl = state.savedLocations;
        const lines = [];
        if (sl.home && sl.work1) lines.push([[sl.home.lat, sl.home.lng], [sl.work1.lat, sl.work1.lng]]);
        if (sl.home && sl.work2) lines.push([[sl.home.lat, sl.home.lng], [sl.work2.lat, sl.work2.lng]]);
        if (lines.length === 0) return;

        _corridorDebugLayer = L.layerGroup(
            lines.map(coords => L.polyline(coords, {
                pane: "idleFocusPane",
                color: "#475569",
                weight: 1,
                opacity: 0.3,
                dashArray: "4 6",
                interactive: false,
            }))
        ).addTo(map);
    }

    function _hasSevereBlocker(alerts) {
        let hasAnyTOR = false;
        let hasLocalSVR = false;
        let nearestSVRmi = null;

        for (const a of alerts) {
            const evt = a.event || "";

            if (evt === "Tornado Warning") {
                hasAnyTOR = true;
                break; // global — no need to check further
            }

            if (evt === "Severe Thunderstorm Warning") {
                const dist = a.distance_mi;
                if (nearestSVRmi === null || (dist != null && dist < nearestSVRmi)) {
                    nearestSVRmi = dist;
                }

                // Local: within radius
                if (dist != null && dist <= SVR_BLOCK_RADIUS_MI) {
                    hasLocalSVR = true;
                    continue;
                }

                // Escalation: destructive SVR blocks even if slightly outside radius
                if (dist != null && dist <= SVR_BLOCK_RADIUS_MI * 1.5) {
                    const desc = (a.description || "").toLowerCase();
                    const hailMatch = desc.match(/(\d[\d.]*)\s*inch\s*hail/);
                    const windMatch = desc.match(/(\d+)\s*mph\s*wind/);
                    if (hailMatch && parseFloat(hailMatch[1]) >= SVR_DESTRUCTIVE_HAIL_IN) hasLocalSVR = true;
                    if (windMatch && parseInt(windMatch[1]) >= SVR_DESTRUCTIVE_WIND_MPH) hasLocalSVR = true;
                    if (/destructive|considerable|pds/i.test(desc)) hasLocalSVR = true;
                }
            }
        }

        return { hasAnyTOR, hasLocalSVR, nearestSVRmi };
    }

    const LOW_PRIORITY_EVENTS = new Set([
        "Tornado Watch", "Severe Thunderstorm Watch", "Flash Flood Watch",
        "Winter Weather Advisory", "Special Weather Statement", "Red Flag Warning",
    ]);

    // ── State ────────────────────────────────────────────────────
    let state = {
        mode: "inactive",
        submode: null,
        enteredAt: null,
        lastUserInteractionAt: Date.now(),
        lastMeaningfulAlertAt: 0,
        lastSubmodeChangeAt: 0,
        lastIdleTargetChangeAt: 0,
        lastExitReason: null,
        lastExitAt: 0,
        idleTargetId: null,
        idleTargetType: null,
        idleSuppressedUntil: 0,
        interruptCount: 0,
        cameraOwned: false,
        dataStale: false,
        // Phase 1: multi-category state (additive — existing fields unchanged)
        referencePoint: null,
        activeCategory: null,
        activeTargetId: null,
        candidates: [],
        categoryCooldowns: {},
        targetCooldowns: {},
        lastRotationAt: 0,
        lastDispatchAt: 0,
        secondaryTargets: [],  // max 2 compact context cards
        primaryContext: null,  // { reason, etaMinutes, direction, contextLine }
        // Local awareness map state
        visibleLocalMarkers: [],
        localSweepActive: false,
        localSweepLastAt: null,
        localSweepReturnTargetId: null,
        locationMarker: null,
        // Saved locations + corridor model
        savedLocations: { home: null, work1: null, work2: null },
        gpsBlueDot: null, // { lat, lng, fresh }
    };

    let evalTimer = null;
    let dwellTimer = null;
    let driftTimer = null;
    let labelRetainTimer = null;
    let lastEvalAt = 0;
    let log = null;

    // Log dedup
    let lastLogKey = "";
    let lastLogAt = 0;

    let patrolNodes = [];
    let regionalScanNodes = [];
    let submodeCycleIdx = 0;
    let infoModel = _emptyInfoModel();

    function _emptyInfoModel() {
        return {
            quietMode: false, statusLabel: "", submodeLabel: "",
            targetLabel: null, summaryLine1: null, summaryLine2: null,
            recentActivityCount1h: 0, nearestRecentWarningText: null,
            localRiskBadge: null, nearestInterestingFeature: null,
        };
    }

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("idle_aware");
        _loadSavedLocations();
        if (log) log.info("idle_local_zone_model", {
            homeRadiusMi: HOME_RADIUS_MI,
            workRadiusMi: WORK_RADIUS_MI,
            gpsRadiusMi: GPS_RADIUS_MI,
            corridorWidthMi: CORRIDOR_HALF_WIDTH_MI,
            commuteRouteNearMi: COMMUTE_ROUTE_NEAR_MI,
            framingAuthority: "home_only",
        });
        document.addEventListener("mousedown", _onUserInteraction, { passive: true });
        document.addEventListener("touchstart", _onUserInteraction, { passive: true });
        document.addEventListener("wheel", _onUserInteraction, { passive: true });
        document.addEventListener("keydown", _onUserInteraction, { passive: true });
        StormState.on("alertsUpdated", _onAlertsUpdated);
        evalTimer = setInterval(_evaluate, EVAL_INTERVAL_MS);
        _initLocationPanel();

        // Wire zoom listener for camera-aware route visibility
        setTimeout(() => {
            const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
            if (map) {
                map.on("zoomend", () => _updateCommuteRouteVisibility(map));
                map.on("moveend", () => _updateCommuteRouteVisibility(map));
            }
        }, 2000);
    }

    // ── Location Panel UI ────────────────────────────────────────

    function _initLocationPanel() {
        const btn = document.getElementById("btn-locations");
        const panel = document.getElementById("locations-panel");
        const closeBtn = document.getElementById("loc-panel-close");
        if (!btn || !panel) return;

        // Toggle panel
        btn.addEventListener("click", () => {
            console.log("[IDLE] locations_button_clicked");
            panel.classList.toggle("hidden");
            if (!panel.classList.contains("hidden")) {
                console.log("[IDLE] locations_panel_opened");
                _syncLocationInputs();
            }
            // Hide prompt if showing
            const prompt = document.getElementById("loc-setup-prompt");
            if (prompt) prompt.classList.add("hidden");
        });

        if (closeBtn) closeBtn.addEventListener("click", () => panel.classList.add("hidden"));

        // Close on click outside
        document.addEventListener("click", (e) => {
            if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                panel.classList.add("hidden");
            }
        });

        // Save buttons
        panel.querySelectorAll(".loc-save-btn").forEach(saveBtn => {
            saveBtn.addEventListener("click", async () => {
                const slot = saveBtn.dataset.slot;
                const input = document.getElementById("loc-input-" + slot);
                const status = document.getElementById("loc-status");
                if (!input || !status) return;

                const address = input.value.trim();
                if (!address) { status.textContent = "Enter an address"; status.style.color = "#f87171"; return; }

                saveBtn.disabled = true;
                status.textContent = "Geocoding...";
                status.style.color = "#94a3b8";

                const result = await setSavedLocation(slot, address);
                if (result.ok) {
                    status.textContent = "Saved: " + (result.displayName || address).slice(0, 60);
                    status.style.color = "#34d399";
                    // Immediately render marker
                    const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
                    if (map) _renderSavedLocationMarkers(map);
                } else {
                    status.textContent = "Could not find address. Try more specific.";
                    status.style.color = "#f87171";
                }
                saveBtn.disabled = false;
                setTimeout(() => { if (status.textContent.startsWith("Saved") || status.textContent.startsWith("Could")) status.textContent = ""; }, 5000);
            });
        });

        // Populate inputs from stored data
        _syncLocationInputs();

        // First-load prompt: if no saved locations, show hint after 3s
        const sl = state.savedLocations;
        if (!sl.home && !sl.work1 && !sl.work2) {
            setTimeout(() => {
                // Only show if panel not already open and page has loaded
                if (panel.classList.contains("hidden")) {
                    const prompt = document.createElement("div");
                    prompt.id = "loc-setup-prompt";
                    prompt.className = "loc-prompt";
                    prompt.textContent = "📍 Set your Home location for local awareness";
                    prompt.addEventListener("click", () => {
                        prompt.classList.add("hidden");
                        panel.classList.remove("hidden");
                        _syncLocationInputs();
                    });
                    document.getElementById("app").appendChild(prompt);
                    // Auto-dismiss after 12s
                    setTimeout(() => { if (prompt) prompt.classList.add("hidden"); }, 12000);
                }
            }, 3000);
        }
    }

    function _syncLocationInputs() {
        const sl = state.savedLocations;
        for (const slot of ["home", "work1", "work2"]) {
            const input = document.getElementById("loc-input-" + slot);
            if (input && sl[slot] && sl[slot].address) {
                input.value = sl[slot].address;
            }
        }
    }

    function _onUserInteraction(e) {
        // Only count map gestures as user interaction — not toolbar/button clicks
        if (e && e.target && e.target.closest) {
            if (e.target.closest("#top-bar") || e.target.closest(".radar-btn") ||
                e.target.closest("#mobile-dock") || e.target.closest("#alert-panel") ||
                e.target.closest(".pulse-card-stack") || e.target.closest(".camera-policy-control") ||
                e.target.closest("#locations-panel") || e.target.closest(".loc-prompt") ||
                e.target.closest("select") || e.target.closest("button")) {
                return; // ignore UI interactions
            }
        }
        // Don't count as interaction if pin-pick mode is active
        if (_locationPickerState.active) return;
        state.lastUserInteractionAt = Date.now();
        if (state.mode === "active") _exit("user_interaction");
    }

    function _onAlertsUpdated(alerts) {
        if (!alerts) return;
        const severe = _hasSevereBlocker(alerts);
        if (severe.hasAnyTOR || severe.hasLocalSVR) {
            state.lastMeaningfulAlertAt = Date.now();
            if (state.mode === "active") _exit("severe_alert");
        }
    }

    // ── #1: Camera Interrupt Safety ──────────────────────────────

    function _safeInterruptCamera() {
        _cancelMotion();
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (map && map.stop) map.stop(); // Leaflet stop
    }

    function _claimCamera() {
        if (typeof Camera !== "undefined" && Camera.claim) {
            if (typeof CameraPolicy !== "undefined" && CameraPolicy.requestMode) { CameraPolicy.requestMode("IDLE"); } else { Camera.claim("idle", "idle_awareness_enter"); }
            // Camera.claim is void — check owner after calling
            state.cameraOwned = StormState.state.camera.owner === "idle";
            return state.cameraOwned;
        }
        const cam = StormState.state.camera;
        state.cameraOwned = cam.owner === "idle" || (cam.owner === "autotrack" && !StormState.state.autotrack.enabled);
        return state.cameraOwned;
    }

    function _releaseCamera() {
        _safeInterruptCamera();
        if (typeof Camera !== "undefined" && Camera.release) Camera.release("idle"); // CameraPolicy manages ownership transitions
        state.cameraOwned = false;
    }

    function _canAnimate() {
        return state.mode === "active" && state.cameraOwned && !state.dataStale;
    }

    // ── #9: Eval Throttle + Stale Check ──────────────────────────

    let lastEvalLog = 0;

    function _evaluate() {
        const now = Date.now();
        if (now - lastEvalAt < EVAL_MIN_GAP_MS) return;
        lastEvalAt = now;

        _checkDataFreshness();

        if (state.mode === "active") {
            if (_shouldExit()) { _exit("condition_changed"); return; }
            if (state.dataStale) return;
            // Refresh candidate pool each eval
            _buildAllCandidates();
            if (now - state.lastSubmodeChangeAt >= MIN_SUBMODE_DURATION_MS + _getSubmodeDwell()) {
                _selectNextSubmode();
            } else {
                // Refresh local markers even when not re-selecting (candidates may have changed)
                _renderLocalMarkers();
            }
            return;
        }

        const canEnter = _shouldEnter();
        // Log entry attempts periodically (every 10s max)
        if (now - lastEvalLog > 10000) {
            lastEvalLog = now;
            const sevCheck = _hasSevereBlocker(StormState.state.alerts.data || []);
            console.log("[IDLE] eval:", canEnter ? "ENTERING" : "blocked", {
                mode: state.mode,
                atEnabled: StormState.state.autotrack.enabled,
                pulseActive: StormState.state.camera.contextPulseActive,
                camOwner: StormState.state.camera.owner,
                panelOpen: StormState.state.alerts.panelOpen,
                suppressed: now < state.idleSuppressedUntil,
                interactionAge: Math.round((now - state.lastUserInteractionAt) / 1000) + "s",
                policy: typeof CameraPolicy !== "undefined" ? CameraPolicy.getState().preference : "?",
                hasAnyTOR: sevCheck.hasAnyTOR,
                hasLocalSVR: sevCheck.hasLocalSVR,
                nearestSVRmi: sevCheck.nearestSVRmi,
                svrBlockRadiusMi: SVR_BLOCK_RADIUS_MI,
            });
        }
        if (canEnter) _enter();
    }

    function _checkDataFreshness() {
        const lastPoll = StormState.state._lastAlertPoll || Date.now();
        const wasStale = state.dataStale;
        state.dataStale = (Date.now() - lastPoll) > STALE_DATA_THRESHOLD_MS;
        if (state.dataStale && !wasStale) {
            _safeInterruptCamera();
            _updateInfoModel();
            _renderIdleUI();
        }
    }

    function _shouldEnter() {
        const now = Date.now();
        const at = StormState.state.autotrack;
        const cam = StormState.state.camera;
        const alerts = StormState.state.alerts.data || [];

        // Hard blockers — always prevent idle
        if (cam.contextPulseActive || cam.owner === "gps") return false;

        // Check if user explicitly forced IDLE via camera policy
        const policyPref = (typeof CameraPolicy !== "undefined" && CameraPolicy.getState)
            ? CameraPolicy.getState().preference : null;
        const forcedIdle = policyPref === "FORCE_IDLE";

        // If forced IDLE, skip interaction delay and AT check (policy already turned AT off)
        if (!forcedIdle) {
            if (at.enabled) return false;
            if (now < state.idleSuppressedUntil) return false;
            if (now - state.lastUserInteractionAt < IDLE_ENTRY_DELAY_MS) return false;
            if (StormState.state.alerts.panelOpen) return false;
        } else {
            // Even forced idle respects a brief 2s settle after last map gesture
            if (now - state.lastUserInteractionAt < 2000) return false;
        }

        // Re-entry grace after alert exit (applies even for forced)
        if (state.lastExitReason === "severe_alert" && now - state.lastExitAt < IDLE_REENTRY_GRACE_MS) return false;

        // Severe weather blocking: TOR global, SVR local only
        const severe = _hasSevereBlocker(alerts);
        if (severe.hasAnyTOR || severe.hasLocalSVR) return false;
        const mobile = StormState.state.mobile;
        if (mobile && mobile.attentionLevel === "critical") return false;

        return true;
    }

    function _shouldExit() {
        const cam = StormState.state.camera;
        if (cam.contextPulseActive || cam.owner === "gps") return true;

        // If user forced IDLE, don't exit just because AT state is stale
        const policyPref = (typeof CameraPolicy !== "undefined" && CameraPolicy.getState)
            ? CameraPolicy.getState().preference : null;
        if (policyPref !== "FORCE_IDLE") {
            const at = StormState.state.autotrack;
            if (at.enabled) return true;
        }

        // Severe weather: TOR global, SVR local
        const alerts = StormState.state.alerts.data || [];
        const severe = _hasSevereBlocker(alerts);
        if (severe.hasAnyTOR || severe.hasLocalSVR) return true;
        const mobile = StormState.state.mobile;
        if (mobile && mobile.attentionLevel === "critical") return true;
        return false;
    }

    // ── Entry / Exit ─────────────────────────────────────────────

    function _enter() {
        console.log("[IDLE] ★ ENTERING idle awareness");
        if (!_claimCamera()) {
            console.log("[IDLE] ✗ camera claim failed, cam.owner =", StormState.state.camera.owner);
            return;
        }
        state.mode = "active";
        state.enteredAt = Date.now();
        state.interruptCount = 0;
        state.lastExitReason = null;
        submodeCycleIdx = 0;
        console.log("[IDLE] idle_enter_state", { cameraOwned: state.cameraOwned, camOwner: StormState.state.camera.owner });
        _dedupLog("idle_mode_entered", { timestamp: state.enteredAt });
        // Phase 1: build candidate pool on entry (informational only — does not affect dispatch)
        _buildAllCandidates();
        _buildPatrolNodes();
        _buildRegionalScanNodes();
        console.log("[IDLE] nodes built: patrol=" + patrolNodes.length + " scan=" + regionalScanNodes.length);
        _selectNextSubmode();
        _updateInfoModel();
        _startIntelEngine(); // Start intelligence engine
        const app = document.getElementById("app");
        if (app) app.classList.add("idle-awareness-active");
    }

    function _exit(reason) {
        if (state.mode !== "active") return;
        _stopIntelEngine(); // Stop intelligence engine
        _releaseCamera(); // #1: includes map.stop()
        _clearAllMapLayers(typeof StormMap !== "undefined" ? StormMap.getMap() : null);
        _dedupLog("idle_mode_exited", { submode: state.submode, reason, timestamp: Date.now() });

        state.interruptCount++;
        state.idleSuppressedUntil = Date.now() + (
            state.interruptCount >= MAX_SUPPRESS_COUNT ? SUPPRESS_LONG_MS : SUPPRESS_AFTER_INTERACTION_MS
        );
        if (state.interruptCount >= MAX_SUPPRESS_COUNT) state.interruptCount = 0;

        state.mode = "inactive";
        state.submode = null;
        state.idleTargetId = null;
        state.idleTargetType = null;
        state.lastExitReason = reason;
        state.lastExitAt = Date.now();
        state.cameraOwned = false;

        // #10: retain label briefly before clearing
        if (labelRetainTimer) clearTimeout(labelRetainTimer);
        labelRetainTimer = setTimeout(() => {
            infoModel = _emptyInfoModel();
            _renderIdleUI();
        }, LABEL_RETAIN_MS);

        const app = document.getElementById("app");
        if (app) app.classList.remove("idle-awareness-active");
    }

    // ── #7: Log Deduplication ────────────────────────────────────

    function _dedupLog(event, data) {
        if (!log) return;
        const key = event + (data.submode || "") + (data.reason || "");
        const now = Date.now();
        if (key === lastLogKey && now - lastLogAt < LOG_DEDUP_MS) return;
        lastLogKey = key;
        lastLogAt = now;
        log.info(event, data);
    }

    // ── Idle Reference + Distance ───────────────────────────────

    function _getIdleReferencePoint() {
        // Priority: fresh GPS → configured home/default → map center
        const gps = StormState.state.gpsFollow;
        if (gps && gps.active && gps.lat != null && gps.lon != null) {
            const freshMs = gps.lastUpdate ? (Date.now() - gps.lastUpdate) : Infinity;
            if (freshMs < 60000) {
                const ref = { lat: gps.lat, lng: gps.lon, source: "gps" };
                state.referencePoint = ref;
                _logReferencePoint(ref);
                return ref;
            }
        }

        const loc = StormState.state.location;
        if (loc.lat && loc.lon) {
            const ref = { lat: loc.lat, lng: loc.lon, source: "user_location" };
            state.referencePoint = ref;
            _logReferencePoint(ref);
            return ref;
        }

        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (map) {
            const c = map.getCenter();
            const ref = { lat: c.lat, lng: c.lng, source: "map_center" };
            state.referencePoint = ref;
            _logReferencePoint(ref);
            return ref;
        }

        const ref = { lat: 39.5, lng: -84.5, source: "default" };
        state.referencePoint = ref;
        _logReferencePoint(ref);
        return ref;
    }

    // Bounded reference point log (max 1 per 30s)
    let _lastRefPointLogAt = 0;
    function _logReferencePoint(ref) {
        const now = Date.now();
        if (now - _lastRefPointLogAt < 30000) return;
        _lastRefPointLogAt = now;
        if (log) log.info("idle_reference_point_resolved", {
            lat: ref.lat.toFixed(2),
            lng: ref.lng.toFixed(2),
            source: ref.source,
        });
    }

    function _getTargetDistanceMi(target, ref) {
        if (!ref) return Infinity;

        // Try alert's pre-computed distance
        if (target.distance_mi != null && isFinite(target.distance_mi)) return target.distance_mi;

        // Try center/lat/lon
        const geo = _resolveTargetGeometry(target);
        if (geo.centroid) return _haversineMi(ref.lat, ref.lng, geo.centroid.lat, geo.centroid.lng);

        return Infinity;
    }

    function _filterByDistance(targets, ref, maxMi) {
        return targets.filter(t => _getTargetDistanceMi(t, ref) <= maxMi);
    }

    function _distancePenalty(distMi) {
        if (distMi <= 25) return 0;
        if (distMi <= 75) return -5;
        if (distMi <= 150) return -12;
        if (distMi <= 300) return -25;
        return -50; // should be excluded before this
    }

    // ── Submode Selection ────────────────────────────────────────

    function _selectNextSubmode() {
        // Phase 3: route through category system when enabled
        if (USE_CATEGORY_SELECTION && state.candidates.length > 0) {
            _selectNextSubmodeV2();
            return;
        }

        const alerts = StormState.state.alerts.data || [];
        const now = Date.now();
        const ref = _getIdleReferencePoint();

        // Low-priority alerts — distance-gated (original v181 path)
        const lowPri = alerts.filter(a => LOW_PRIORITY_EVENTS.has(a.event));
        if (lowPri.length > 0) {
            const animatable = lowPri.filter(_isAnimatableTarget);
            // Try local first, then regional
            let pool = _filterByDistance(animatable, ref, IDLE_LOCAL_RADIUS_MI);
            if (pool.length === 0) pool = _filterByDistance(animatable, ref, IDLE_MAX_RADIUS_MI);
            if (pool.length === 0 && IDLE_ALLOW_GLOBAL_FALLBACK) pool = animatable;

            _logCandidatePool(ref, animatable, pool, "LOW_PRIORITY_FOCUS");

            if (pool.length > 0) {
                const target = _pickBestTarget(pool, ref);
                _setSubmode("LOW_PRIORITY_FOCUS", target, "alert"); return;
            }
        }

        // Recently expired — distance-gated
        const recentExpired = alerts.filter(a => {
            if (!a.expires) return false;
            const exp = new Date(a.expires).getTime();
            return exp < now && (now - exp) < EXPIRED_SWEEP_WINDOW_MS;
        });
        if (recentExpired.length > 0) {
            const animatable = recentExpired.filter(_isAnimatableTarget);
            let pool = _filterByDistance(animatable, ref, IDLE_LOCAL_RADIUS_MI);
            if (pool.length === 0) pool = _filterByDistance(animatable, ref, IDLE_MAX_RADIUS_MI);

            if (pool.length > 0) {
                const target = _pickBestTarget(pool, ref);
                _setSubmode("RECENT_HISTORY_SWEEP", target, "alert"); return;
            }
        }

        // #5: Environmental focus hook
        const envTargets = _getEnvironmentalTargets();
        if (envTargets.length > 0) {
            _setSubmode("ENVIRONMENTAL_FOCUS", envTargets[0], "feature"); return;
        }

        if (patrolNodes.length > 0) { _setSubmode("PATROL", null, "region"); return; }
        if (regionalScanNodes.length > 0) { _setSubmode("REGIONAL_SCAN", null, "region"); return; }
        _setSubmode("AMBIENT_DRIFT", null, null);
    }

    // Target selection with distance penalty and stickiness
    function _pickBestTarget(candidates, ref) {
        if (candidates.length <= 1) return candidates[0] || null;

        const now = Date.now();
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        const bounds = map ? map.getBounds() : null;
        if (!ref) ref = _getIdleReferencePoint();

        // Stickiness: keep current if hold time not elapsed
        if (state.idleTargetId && now - state.lastIdleTargetChangeAt < MIN_TARGET_HOLD_MS) {
            const current = candidates.find(a => a.id === state.idleTargetId);
            if (current) return current;
        }

        const scored = candidates.map(a => {
            let score = 0;
            // In viewport bonus
            if (bounds && a.polygon) {
                try {
                    const geo = JSON.parse(a.polygon);
                    const layer = L.geoJSON(geo);
                    const ab = layer.getBounds();
                    if (ab.isValid() && bounds.intersects(ab)) score += 50;
                } catch (e) { /* skip */ }
            }
            // Distance-aware scoring with penalty
            const dist = _getTargetDistanceMi(a, ref);
            score += Math.max(0, 30 - dist * 0.3); // proximity bonus
            score += _distancePenalty(dist);          // distance penalty
            // Recency
            if (a.effective) {
                const age = (now - new Date(a.effective).getTime()) / 60000;
                score += Math.max(0, 20 - age * 0.5);
            }
            return { alert: a, score, dist };
        });

        scored.sort((a, b) => b.score - a.score);

        // Log top pick
        if (scored.length > 0) {
            const top = scored[0];
            console.log("[IDLE] idle_target_ranked", {
                targetId: top.alert.id?.slice?.(-12),
                event: top.alert.event,
                score: Math.round(top.score),
                distanceMi: Math.round(top.dist),
            });
        }

        const topN = scored.slice(0, 3);
        return topN[submodeCycleIdx++ % topN.length].alert;
    }

    function _logCandidatePool(ref, allAnimatable, pool, submode) {
        const localCount = _filterByDistance(allAnimatable, ref, IDLE_LOCAL_RADIUS_MI).length;
        const regionalCount = _filterByDistance(allAnimatable, ref, IDLE_MAX_RADIUS_MI).length;
        console.log("[IDLE] idle_candidate_pool", {
            submode,
            referenceSource: ref.source,
            refLat: ref.lat.toFixed(1),
            refLng: ref.lng.toFixed(1),
            totalAnimatable: allAnimatable.length,
            localCount,
            regionalCount,
            poolUsed: pool.length,
            distantExcluded: allAnimatable.length - regionalCount,
        });
    }

    // ── Phase 1: Unified IdleCandidate Factory ─────────────────

    function _makeCandidate(fields) {
        return {
            id:               fields.id || null,
            category:         fields.category || IDLE_CATEGORIES.weather,
            source:           fields.source || "unknown",
            title:            fields.title || "",
            summary:          fields.summary || "",
            lat:              fields.lat != null ? fields.lat : null,
            lng:              fields.lng != null ? fields.lng : null,
            bounds:           fields.bounds || null,
            polygon:          fields.polygon || null,
            distanceMi:       fields.distanceMi != null ? fields.distanceMi : null,
            score:            fields.score != null ? fields.score : 0,
            severity:         fields.severity || "minor",
            freshness:        fields.freshness || "current",
            actionability:    fields.actionability || "informational",
            relevance:        fields.relevance || "local",
            canControlCamera: fields.canControlCamera != null ? fields.canControlCamera : true,
            geometryType:     fields.geometryType || "none",
            metadata:         fields.metadata || {},
            updatedAt:        fields.updatedAt || Date.now(),
        };
    }

    // ── Phase 1: Weather Adapter ─────────────────────────────────
    // Wraps existing alert logic into IdleCandidate objects.
    // Local-first: contextual weather penalized when distant; important weather allowed broad.

    // IDLE local-first: contextual weather distance cap
    const IDLE_CONTEXTUAL_WX_MAX_MI = 50;      // contextual weather capped at 50mi for primary
    const IDLE_CONTEXTUAL_WX_PENALTY = 0.35;   // score multiplier for contextual wx beyond cap

    // Important weather events — these can be primary at any distance within radius
    const IMPORTANT_WX_EVENTS = new Set([
        "Tornado Warning", "Severe Thunderstorm Warning",
        "Flash Flood Warning", "Flood Warning",
        "Tornado Watch", "Severe Thunderstorm Watch",
    ]);

    function _classifyWeatherCandidate(candidate, alertEvent) {
        // Important: warned severe weather or active watch within local radius
        if (alertEvent && IMPORTANT_WX_EVENTS.has(alertEvent)) return "important";

        // Contextual: radar-derived, low-priority advisories, expired alerts, environmental
        return "contextual";
    }

    function _buildWeatherCandidates() {
        const ref = _getIdleReferencePoint();
        const alerts = StormState.state.alerts.data || [];
        const now = Date.now();
        const candidates = [];
        const policy = CATEGORY_POLICY.weather;

        // Low-priority alerts
        const lowPri = alerts.filter(a => LOW_PRIORITY_EVENTS.has(a.event));
        for (const a of lowPri) {
            if (!_isAnimatableTarget(a)) continue;
            const dist = _getTargetDistanceMi(a, ref);
            if (dist > IDLE_MAX_RADIUS_MI) continue;

            const geo = _resolveTargetGeometry(a);
            const age = a.effective ? (now - new Date(a.effective).getTime()) / 60000 : 0;
            const proximityScore = Math.max(0, 30 - dist * 0.3);
            const recencyScore = Math.max(0, 20 - age * 0.5);
            const penaltyScore = _distancePenalty(dist);

            const wxClass = _classifyWeatherCandidate(null, a.event);
            let score = proximityScore + recencyScore + penaltyScore;
            // Exclude contextual weather outside local-awareness zone entirely
            if (wxClass === "contextual" && geo.centroid) {
                if (!_isWithinLocalAwarenessZone(geo.centroid.lat, geo.centroid.lng)) continue;
            }

            candidates.push(_makeCandidate({
                id:               a.id,
                category:         IDLE_CATEGORIES.weather,
                source:           "nws_low_priority",
                title:            a.event || "Weather Alert",
                summary:          a.headline ? a.headline.slice(0, 80) : "",
                lat:              geo.centroid ? geo.centroid.lat : null,
                lng:              geo.centroid ? geo.centroid.lng : null,
                bounds:           geo.bounds || null,
                polygon:          a.polygon || null,
                distanceMi:       dist,
                score:            score,
                severity:         "minor",
                freshness:        age < 30 ? "current" : age < 120 ? "recent" : "stale",
                actionability:    "informational",
                relevance:        dist <= policy.localRadiusMi ? "local" : "regional",
                canControlCamera: true,
                geometryType:     geo.hasPolygon ? "polygon" : geo.hasPoint ? "point" : "none",
                metadata:         { alertId: a.id, event: a.event, subtype: "low_priority", weatherClass: wxClass },
                updatedAt:        a.effective ? new Date(a.effective).getTime() : now,
            }));
        }

        // Recently expired alerts (same logic as _selectNextSubmode)
        const recentExpired = alerts.filter(a => {
            if (!a.expires) return false;
            const exp = new Date(a.expires).getTime();
            return exp < now && (now - exp) < EXPIRED_SWEEP_WINDOW_MS;
        });
        for (const a of recentExpired) {
            if (!_isAnimatableTarget(a)) continue;
            const dist = _getTargetDistanceMi(a, ref);
            if (dist > IDLE_MAX_RADIUS_MI) continue;

            const geo = _resolveTargetGeometry(a);
            const expAge = (now - new Date(a.expires).getTime()) / 60000;
            const proximityScore = Math.max(0, 25 - dist * 0.3);
            const recencyScore = Math.max(0, 15 - expAge * 0.3);
            const penaltyScore = _distancePenalty(dist);

            const wxClass = _classifyWeatherCandidate(null, a.event);
            let score = proximityScore + recencyScore + penaltyScore;
            if (wxClass === "contextual" && geo.centroid) {
                if (!_isWithinLocalAwarenessZone(geo.centroid.lat, geo.centroid.lng)) continue;
            }

            candidates.push(_makeCandidate({
                id:               a.id,
                category:         IDLE_CATEGORIES.weather,
                source:           "nws_recently_expired",
                title:            a.event || "Expired Alert",
                summary:          a.headline ? a.headline.slice(0, 80) : "",
                lat:              geo.centroid ? geo.centroid.lat : null,
                lng:              geo.centroid ? geo.centroid.lng : null,
                bounds:           geo.bounds || null,
                polygon:          a.polygon || null,
                distanceMi:       dist,
                score:            score,
                severity:         "minor",
                freshness:        "expired",
                actionability:    "historical",
                relevance:        dist <= policy.localRadiusMi ? "local" : "regional",
                canControlCamera: true,
                geometryType:     geo.hasPolygon ? "polygon" : geo.hasPoint ? "point" : "none",
                metadata:         { alertId: a.id, event: a.event, subtype: "recently_expired", weatherClass: wxClass },
                updatedAt:        a.expires ? new Date(a.expires).getTime() : now,
            }));
        }

        // Environmental targets (radar-derived, injected, alert-derived)
        // All environmental targets are contextual — they're radar returns, not warned events.
        const envTargets = _getEnvironmentalTargets();
        for (const t of envTargets) {
            const dist = t.distanceMiles != null ? t.distanceMiles : Infinity;
            if (dist > IDLE_MAX_RADIUS_MI) continue;

            const ENV_KIND_LABELS = {
                reflectivity_core: "Strong radar returns detected",
                precipitation_area: "Active precipitation area",
                lightning_cluster: "Lightning cluster",
                weak_rotation: "Weak rotation signature",
                mixed_phase: "Mixed precipitation",
                weather_feature: "Weather feature",
                injected_feature: "Notable feature",
            };

            let score = (ENV_BASE_SCORES[t.kind] || 10) + (t.intensityScore || 0);

            // Exclude contextual env weather outside local-awareness zone entirely
            if (t.center && !_isWithinLocalAwarenessZone(t.center.lat, t.center.lon)) {
                if (log) {
                    _dedupLog("idle_weather_suppressed", {
                        targetId: t.id ? String(t.id).slice(-12) : null,
                        weatherClass: "contextual",
                        reason: "outside_local_awareness_zone",
                    });
                }
                continue;
            }

            candidates.push(_makeCandidate({
                id:               t.id,
                category:         IDLE_CATEGORIES.weather,
                source:           "env_" + (t.kind || "feature"),
                title:            t.label || "Environmental Feature",
                summary:          ENV_KIND_LABELS[t.kind] || t.kind || "",
                lat:              t.center ? t.center.lat : null,
                lng:              t.center ? t.center.lon : null,
                bounds:           t.bounds || null,
                polygon:          null,
                distanceMi:       dist,
                score:            score,
                severity:         t.intensityScore > 30 ? "moderate" : "minor",
                freshness:        t.freshnessTs && (now - t.freshnessTs) < 300000 ? "current" : "recent",
                actionability:    "informational",
                relevance:        dist <= policy.localRadiusMi ? "local" : "regional",
                canControlCamera: true,
                geometryType:     t.bounds ? "polygon" : (t.center ? "point" : "none"),
                metadata:         { kind: t.kind, intensityScore: t.intensityScore, subtype: "environmental", weatherClass: "contextual" },
                updatedAt:        t.freshnessTs || now,
            }));
        }

        // Trace: log final weather pool (bounded)
        if (candidates.length > 0 || state.savedLocations.home) {
            _dedupLog("idle_weather_pool_final", {
                count: candidates.length,
                ids: candidates.map(c => c.id ? String(c.id).slice(-15) : "?"),
            });
        }

        return candidates;
    }

    // ── Phase 1: Stub Adapters (no live data — return []) ────────

    // ── Traffic Adapter (backend proxy → TomTom) ──────────────
    // Polls backend /api/traffic/incidents at most every 5 minutes.
    // Returns max 3 candidates within localRadiusMi.
    // If no API key configured, returns [] with bounded unavailable log.

    const TRAFFIC_POLL_INTERVAL_MS = 300000; // 5 min
    const TRAFFIC_MAX_CANDIDATES = 3;
    const TRAFFIC_STALE_MS = 3600000; // ignore incidents >60 min old
    const TRAFFIC_MIN_SCORE = 15;     // filter low-value noise (construction/unknown magnitude 0-1)
    let _trafficCache = null;         // { incidents: [], fetchedAt, providerEnabled }
    let _trafficFetchInFlight = false;
    let _trafficRejectLogAt = 0;
    const TRAFFIC_REJECT_LOG_INTERVAL_MS = 30000;

    const TRAFFIC_SEVERITY_SCORES = {
        closure:      40,
        accident:     20,
        weather:      15,
        hazard:       10,
        construction: 8,
    };

    // TomTom magnitude: 0=unknown, 1=minor, 2=moderate, 3=major, 4=undefined
    const TRAFFIC_MAGNITUDE_BONUS = { 0: 0, 1: 0, 2: 10, 3: 20, 4: 0 };

    // Advisory type classification for metadata
    const TRAFFIC_ADVISORY_TYPES = {
        closure:      "road_closure",
        accident:     "accident_report",
        weather:      "weather_hazard",
        hazard:       "road_hazard",
        construction: "construction_zone",
    };

    function _buildTrafficCandidates() {
        return []; // Traffic feature removed
        const ref = state.referencePoint || _getIdleReferencePoint();
        if (!ref) return [];

        const now = Date.now();
        const policy = CATEGORY_POLICY.traffic;

        // Trigger async fetch if stale (non-blocking)
        if (!_trafficCache || (now - _trafficCache.fetchedAt) > TRAFFIC_POLL_INTERVAL_MS) {
            _fetchTrafficIncidents(ref.lat, ref.lng, policy.localRadiusMi);
        }

        // Provider not configured — return [] silently (unavailable already logged in fetch)
        if (_trafficCache && _trafficCache.providerEnabled === false) return [];

        if (!_trafficCache || !_trafficCache.incidents || _trafficCache.incidents.length === 0) return [];

        const candidates = [];
        const seenPositions = new Set();  // dedup by lat/lon grid
        const seenRoads = new Set();      // dedup by road segment name
        let rejectedCount = 0;
        let rejectedReasons = {};

        for (const inc of _trafficCache.incidents) {
            if (!inc.lat || !inc.lon) continue;

            // ── Local awareness zone filter ──
            const dist = _haversineMi(ref.lat, ref.lng, inc.lat, inc.lon);
            if (!_isWithinLocalAwarenessZone(inc.lat, inc.lon) && dist > policy.localRadiusMi) {
                rejectedCount++; rejectedReasons.outside_zone = (rejectedReasons.outside_zone || 0) + 1;
                continue;
            }

            // ── Staleness filter ──
            if (inc.startTime) {
                const startMs = new Date(inc.startTime).getTime();
                if (isFinite(startMs) && (now - startMs) > TRAFFIC_STALE_MS) {
                    rejectedCount++; rejectedReasons.stale = (rejectedReasons.stale || 0) + 1;
                    continue;
                }
            }

            // ── Noise filter: low-value incidents below score threshold ──
            const baseScore = TRAFFIC_SEVERITY_SCORES[inc.severity] || 10;
            const magBonus = TRAFFIC_MAGNITUDE_BONUS[inc.magnitude] || 0;
            const score = baseScore + magBonus;

            if (score < TRAFFIC_MIN_SCORE) {
                rejectedCount++; rejectedReasons.below_threshold = (rejectedReasons.below_threshold || 0) + 1;
                continue;
            }

            // ── Dedup: position grid (0.01° ≈ 0.7mi) ──
            const posKey = Math.round(inc.lat * 100) + ":" + Math.round(inc.lon * 100);
            if (seenPositions.has(posKey)) {
                rejectedCount++; rejectedReasons.dedup_position = (rejectedReasons.dedup_position || 0) + 1;
                continue;
            }
            seenPositions.add(posKey);

            // ── Dedup: same road segment name ──
            if (inc.from) {
                const roadKey = inc.from.toLowerCase().replace(/\s+/g, "").slice(0, 30);
                if (seenRoads.has(roadKey)) {
                    rejectedCount++; rejectedReasons.dedup_road = (rejectedReasons.dedup_road || 0) + 1;
                    continue;
                }
                seenRoads.add(roadKey);
            }

            // ── Build title ──
            const typeLabel = inc.severity === "closure" ? "Road closure" :
                              inc.severity === "accident" ? "Accident" :
                              inc.severity === "construction" ? "Construction" :
                              inc.severity === "weather" ? "Weather hazard" : "Traffic incident";
            const roadName = inc.from ? inc.from.slice(0, 40) : "";
            const title = roadName
                ? typeLabel + ": " + roadName + " (" + Math.round(dist) + " mi)"
                : typeLabel + " (" + Math.round(dist) + " mi away)";

            // ── Build summary ──
            let summary = inc.description ? inc.description.slice(0, 80) : "";
            if (inc.delay && inc.delay > 0) {
                summary += (summary ? " · " : "") + "Delay: " + Math.round(inc.delay / 60) + " min";
            }
            if (inc.length && inc.length > 0) {
                const lengthMi = (inc.length / 1609.34).toFixed(1);
                summary += (summary ? " · " : "") + lengthMi + " mi affected";
            }

            // ── Freshness ──
            let freshness = "current";
            if (inc.startTime) {
                const ageMin = (now - new Date(inc.startTime).getTime()) / 60000;
                if (ageMin > 30) freshness = "recent";
            }

            candidates.push(_makeCandidate({
                id:               "traffic:" + (inc.id || posKey),
                category:         IDLE_CATEGORIES.traffic,
                source:           "tomtom",
                title:            title,
                summary:          summary,
                lat:              inc.lat,
                lng:              inc.lon,
                distanceMi:       dist,
                score:            score,
                severity:         inc.magnitude >= 3 ? "major" : inc.magnitude >= 2 ? "moderate" : "minor",
                freshness:        freshness,
                actionability:    inc.severity === "closure" || inc.magnitude >= 3 ? "advisory" : "informational",
                relevance:        "local",
                canControlCamera: false,
                geometryType:     "point",
                metadata:         {
                    tomtomId:     inc.id,
                    roadName:     roadName || null,
                    advisoryType: TRAFFIC_ADVISORY_TYPES[inc.severity] || "unknown",
                    severity:     inc.severity,
                    magnitude:    inc.magnitude,
                    delay:        inc.delay || 0,
                    lengthMeters: inc.length || 0,
                },
                updatedAt:        _trafficCache.fetchedAt,
            }));

            if (candidates.length >= TRAFFIC_MAX_CANDIDATES) break;
        }

        // Bounded rejection log
        if (rejectedCount > 0 && now - _trafficRejectLogAt >= TRAFFIC_REJECT_LOG_INTERVAL_MS) {
            _trafficRejectLogAt = now;
            if (log) log.info("idle_target_rejected", {
                category: "traffic",
                reason: "batch_filter",
                rejected: rejectedCount,
                accepted: candidates.length,
                breakdown: rejectedReasons,
            });
        }

        // Sort by score descending
        candidates.sort((a, b) => b.score - a.score);
        return candidates;
    }

    async function _fetchTrafficIncidents(lat, lng, radiusMi) {
        return; // Traffic feature removed
        if (_trafficFetchInFlight) return;
        _trafficFetchInFlight = true;

        try {
            const url = "/api/traffic/incidents?lat=" + lat.toFixed(2) +
                        "&lon=" + lng.toFixed(2) +
                        "&radius_mi=" + radiusMi;

            const resp = await fetch(url);
            if (!resp.ok) throw new Error("HTTP " + resp.status);

            const data = await resp.json();

            if (data.reason === "no_api_key" || data.source === "none") {
                _trafficCache = { incidents: [], fetchedAt: Date.now(), providerEnabled: false };
                _logAdapterUnavailable("traffic");
                return;
            }

            if (data.error) {
                _trafficCache = { incidents: [], fetchedAt: Date.now(), providerEnabled: true };
                _logAdapterUnavailable("traffic");
                return;
            }

            _trafficCache = {
                incidents: data.incidents || [],
                fetchedAt: Date.now(),
                providerEnabled: true,
            };
        } catch (e) {
            _logAdapterUnavailable("traffic");
            // Keep stale cache if exists — better than nothing
        } finally {
            _trafficFetchInFlight = false;
        }
    }

    function _buildOutageCandidates() {
        _logAdapterUnavailable("outage");
        return [];
    }

    function _buildSafetyCandidates() {
        _logAdapterUnavailable("safety");
        return [];
    }

    function _buildFloodCandidates() {
        _logAdapterUnavailable("flood");
        return [];
    }

    // ── Air Quality Adapter (Open-Meteo Air Quality API) ───────
    // Free, no key required. Polls at most every 5 minutes.
    // Returns 1 candidate max based on US AQI.

    const AIR_POLL_INTERVAL_MS = 300000; // 5 min
    let _airCache = null;       // { aqi, pm25, pm10, ozone, fetchedAt }
    let _airFetchInFlight = false;

    const AIR_CATEGORIES = [
        { max: 50,  label: "Good",                         severity: "none",     score: 5  },
        { max: 100, label: "Moderate",                     severity: "minor",    score: 10 },
        { max: 150, label: "Unhealthy for Sensitive Groups", severity: "moderate", score: 25 },
        { max: 200, label: "Unhealthy",                    severity: "major",    score: 50 },
        { max: 300, label: "Very Unhealthy",               severity: "major",    score: 50 },
        { max: Infinity, label: "Hazardous",               severity: "extreme",  score: 50 },
    ];

    function _classifyAqi(aqi) {
        for (const c of AIR_CATEGORIES) {
            if (aqi <= c.max) return c;
        }
        return AIR_CATEGORIES[AIR_CATEGORIES.length - 1];
    }

    function _buildAirCandidates() {
        const ref = state.referencePoint || _getIdleReferencePoint();
        if (!ref) return [];

        // Trigger async fetch if cache is stale (non-blocking)
        const now = Date.now();
        if (!_airCache || (now - _airCache.fetchedAt) > AIR_POLL_INTERVAL_MS) {
            _fetchAirQuality(ref.lat, ref.lng);
        }

        // Return candidate from cache if available
        if (!_airCache) return [];

        const aqi = _airCache.aqi;
        if (aqi == null || !isFinite(aqi)) return [];

        const cat = _classifyAqi(aqi);

        return [_makeCandidate({
            id:               "air:" + ref.lat.toFixed(1) + ":" + ref.lng.toFixed(1),
            category:         IDLE_CATEGORIES.air,
            source:           "open_meteo_air",
            title:            "Air Quality: " + cat.label,
            summary:          "AQI " + Math.round(aqi) +
                              (_airCache.pm25 != null ? " · PM2.5 " + _airCache.pm25.toFixed(1) + " μg/m³" : ""),
            lat:              ref.lat,
            lng:              ref.lng,
            distanceMi:       0,
            score:            cat.score,
            severity:         cat.severity,
            freshness:        (now - _airCache.fetchedAt) < 600000 ? "current" : "stale",
            actionability:    aqi >= 100 ? "advisory" : "informational",
            relevance:        "local",
            canControlCamera: false,
            geometryType:     "none",
            metadata:         { aqi: Math.round(aqi), pm25: _airCache.pm25, pm10: _airCache.pm10, ozone: _airCache.ozone },
            updatedAt:        _airCache.fetchedAt,
        })];
    }

    async function _fetchAirQuality(lat, lng) {
        if (_airFetchInFlight) return;
        _airFetchInFlight = true;

        try {
            const url = "https://air-quality-api.open-meteo.com/v1/air-quality" +
                "?latitude=" + lat.toFixed(2) +
                "&longitude=" + lng.toFixed(2) +
                "&current=us_aqi,pm2_5,pm10,ozone&timezone=auto";

            const resp = await fetch(url);
            if (!resp.ok) throw new Error("HTTP " + resp.status);

            const data = await resp.json();
            const cur = data.current;
            if (!cur || cur.us_aqi == null) throw new Error("no AQI in response");

            _airCache = {
                aqi:       cur.us_aqi,
                pm25:      cur.pm2_5 != null ? cur.pm2_5 : null,
                pm10:      cur.pm10 != null ? cur.pm10 : null,
                ozone:     cur.ozone != null ? cur.ozone : null,
                fetchedAt: Date.now(),
            };
        } catch (e) {
            _logAdapterUnavailable("air");
            // Keep stale cache if it exists — better than nothing
        } finally {
            _airFetchInFlight = false;
        }
    }

    function _buildAmbientCandidates() {
        const ref = state.referencePoint || _getIdleReferencePoint();
        if (!ref) return [];

        const now = Date.now();
        const candidates = [];
        const hour = new Date().getHours();

        // Time-of-day context
        let timeTitle, timeSummary, timeScore;
        if (hour >= 5 && hour < 12) {
            timeTitle = "Morning conditions";
            timeSummary = "Quiet start — monitoring for developing weather";
            timeScore = 8;
        } else if (hour >= 12 && hour < 17) {
            timeTitle = "Afternoon watch";
            timeSummary = "Peak heating period — watching for convective development";
            timeScore = 10;
        } else if (hour >= 17 && hour < 21) {
            timeTitle = "Evening conditions";
            timeSummary = "Activity winding down — monitoring residual threats";
            timeScore = 7;
        } else {
            timeTitle = "Overnight monitoring";
            timeSummary = "Overnight quiet — low probability of new development";
            timeScore = 6;
        }

        candidates.push(_makeCandidate({
            id:               "ambient:time_of_day:" + (hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night"),
            category:         IDLE_CATEGORIES.ambient,
            source:           "time_context",
            title:            timeTitle,
            summary:          timeSummary,
            lat:              ref.lat,
            lng:              ref.lng,
            distanceMi:       0,
            score:            timeScore,
            severity:         "none",
            freshness:        "current",
            actionability:    "informational",
            relevance:        "local",
            canControlCamera: false,
            geometryType:     "none",
            metadata:         { hour, period: hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night" },
            updatedAt:        now,
        }));

        // Radar quiet context: if no weather candidates were built, note clear skies
        const weatherCount = (state.candidates || []).filter(c => c.category === IDLE_CATEGORIES.weather).length;
        if (weatherCount === 0) {
            candidates.push(_makeCandidate({
                id:               "ambient:clear_skies",
                category:         IDLE_CATEGORIES.ambient,
                source:           "radar_context",
                title:            "Clear skies nearby",
                summary:          "No significant radar returns in local area",
                lat:              ref.lat,
                lng:              ref.lng,
                distanceMi:       0,
                score:            7,
                severity:         "none",
                freshness:        "current",
                actionability:    "informational",
                relevance:        "local",
                canControlCamera: false,
                geometryType:     "none",
                metadata:         { weatherCandidates: 0 },
                updatedAt:        now,
            }));
        }

        return candidates;
    }

    function _logAdapterUnavailable(category) {
        const now = Date.now();
        const lastAt = _adapterLastLogAt[category] || 0;
        if (now - lastAt < ADAPTER_LOG_INTERVAL_MS) return;
        _adapterLastLogAt[category] = now;
        if (log) log.info("idle_adapter_unavailable", { category, reason: "no_live_source" });
    }

    // ── Phase 1: Build All Candidates + Summary Log ──────────────

    function _buildAllCandidates() {
        const all = [];
        const counts = {
            weather: 0, traffic: 0, outage: 0,
            safety: 0, flood: 0, air: 0, ambient: 0,
        };

        for (const cat of Object.values(IDLE_CATEGORIES)) {
            const policy = CATEGORY_POLICY[cat];
            if (!policy || !policy.enabled) continue;

            let catCandidates;
            switch (cat) {
                case "weather":  catCandidates = _buildWeatherCandidates(); break;
                case "traffic":  catCandidates = _buildTrafficCandidates(); break;
                case "outage":   catCandidates = _buildOutageCandidates(); break;
                case "safety":   catCandidates = _buildSafetyCandidates(); break;
                case "flood":    catCandidates = _buildFloodCandidates(); break;
                case "air":      catCandidates = _buildAirCandidates(); break;
                case "ambient":  catCandidates = _buildAmbientCandidates(); break;
                default:         catCandidates = []; break;
            }

            counts[cat] = catCandidates.length;
            all.push(...catCandidates);
        }

        // Bounded summary log
        const now = Date.now();
        if (now - _lastCandidateSummaryLogAt >= CANDIDATE_SUMMARY_LOG_INTERVAL_MS) {
            _lastCandidateSummaryLogAt = now;
            if (log) log.info("idle_candidate_pool_summary", {
                total: all.length,
                weather: counts.weather,
                traffic: counts.traffic,
                outage: counts.outage,
                safety: counts.safety,
                flood: counts.flood,
                air: counts.air,
                ambient: counts.ambient,
            });
        }

        state.candidates = all;
        return all;
    }

    // ── Phase 2: Shadow Category/Target Selection ────────────────
    // Runs in parallel with existing _selectNextSubmode.
    // Does NOT dispatch — shadow only, for comparison logging.

    let _lastShadowLogAt = 0;
    const SHADOW_LOG_INTERVAL_MS = 10000; // max 1 shadow log per 10s

    function _selectIdleCategory(candidates, now) {
        if (!candidates || candidates.length === 0) return null;

        // Group by category and compute max score per category
        const categoryScores = {};
        const categoryCounts = {};
        for (const c of candidates) {
            const cat = c.category;
            const policy = CATEGORY_POLICY[cat];
            if (!policy || !policy.enabled) continue;
            if (c.score < policy.minScoreToFocus) continue;

            if (!categoryScores[cat] || c.score > categoryScores[cat]) {
                categoryScores[cat] = c.score;
            }
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
        }

        const cats = Object.keys(categoryScores);
        if (cats.length === 0) return null;

        // Sort by max score descending
        cats.sort((a, b) => categoryScores[b] - categoryScores[a]);

        const best = cats[0];
        const bestScore = categoryScores[best];

        // Part 1: Category dwell — don't switch before minimum hold unless higher-priority category
        if (state.activeCategory && state.activeCategory !== best) {
            const categoryAge = now - (state.lastDispatchAt || 0);
            const currentIdx = CATEGORY_DISPLAY_ORDER.indexOf(state.activeCategory);
            const bestIdx = CATEGORY_DISPLAY_ORDER.indexOf(best);
            const isEscalation = bestIdx >= 0 && currentIdx >= 0 && bestIdx < currentIdx; // lower index = higher priority

            if (categoryAge < IDLE_CATEGORY_MIN_DURATION_MS && !isEscalation) {
                return state.activeCategory; // hold — minimum category duration not met
            }

            // Anti-flapping: require margin + hysteresis to switch
            const currentScore = categoryScores[state.activeCategory];
            const requiredMargin = CATEGORY_SWITCH_MARGIN + (isEscalation ? 0 : CATEGORY_HYSTERESIS_BUFFER);
            if (currentScore != null && bestScore - currentScore < requiredMargin) {
                return state.activeCategory; // stay — margin + hysteresis not exceeded
            }
        }

        // Category cooldown check
        const cooldownEnd = state.categoryCooldowns[best] || 0;
        if (now < cooldownEnd) {
            // Best category on cooldown — try next
            for (const cat of cats) {
                if (cat === best) continue;
                const cd = state.categoryCooldowns[cat] || 0;
                if (now >= cd) return cat;
            }
            return state.activeCategory || null; // all on cooldown, stay
        }

        // Log category selection (bounded)
        if (now - _lastShadowLogAt >= SHADOW_LOG_INTERVAL_MS) {
            if (log && best !== state.activeCategory) {
                log.info("idle_category_selected", {
                    prevCategory: state.activeCategory,
                    nextCategory: best,
                    candidateCount: categoryCounts[best] || 0,
                    topScore: Math.round(bestScore),
                });
            }
        }

        return best;
    }

    function _selectIdleTarget(candidates, category, now) {
        if (!candidates || !category) return null;

        const policy = CATEGORY_POLICY[category];
        if (!policy) return null;

        // Part 1: Target dwell — keep current target if minimum hold not met
        if (state.activeTargetId && state.activeCategory === category) {
            const targetAge = now - (state.lastDispatchAt || 0);
            if (targetAge < IDLE_MIN_TARGET_DURATION_MS) {
                const current = candidates.find(c => c.id === state.activeTargetId && c.category === category);
                if (current) return current; // hold — minimum target duration not met
            }
        }

        // Filter to this category, within local radius, meeting min score
        const pool = candidates.filter(c =>
            c.category === category &&
            c.score >= policy.minScoreToFocus &&
            (c.distanceMi == null || c.distanceMi <= policy.localRadiusMi)
        );

        if (pool.length === 0) return null;

        // Part 2: Local bias — boost closer targets, penalize far, prefer unseen
        pool.sort((a, b) => {
            let sa = a.score;
            let sb = b.score;

            // Distance bias: closer = small boost, far = small penalty
            if (a.distanceMi != null) sa += Math.max(0, 8 - a.distanceMi * 0.2);
            if (b.distanceMi != null) sb += Math.max(0, 8 - b.distanceMi * 0.2);

            // Freshness bias: prefer targets not recently viewed
            const aCd = state.targetCooldowns[a.id] || 0;
            const bCd = state.targetCooldowns[b.id] || 0;
            if (aCd > now) sa -= 5; // recently viewed — slight penalty
            if (bCd > now) sb -= 5;

            return sb - sa;
        });

        // Target cooldown check — skip targets still on hard cooldown
        for (const c of pool) {
            const cd = state.targetCooldowns[c.id] || 0;
            if (now >= cd) return c;
        }

        return null; // all targets on cooldown
    }

    // Run shadow selection and log comparison (called from _selectNextSubmode)
    function _runShadowSelection() {
        const now = Date.now();
        const candidates = state.candidates;
        if (!candidates || candidates.length === 0) return;

        const shadowCategory = _selectIdleCategory(candidates, now);
        if (!shadowCategory) return;

        const shadowTarget = _selectIdleTarget(candidates, shadowCategory, now);
        if (!shadowTarget) return;

        // Bounded shadow comparison log
        if (now - _lastShadowLogAt < SHADOW_LOG_INTERVAL_MS) return;
        _lastShadowLogAt = now;

        const oldTargetId = state.idleTargetId ? String(state.idleTargetId).slice(-12) : null;
        const newTargetId = shadowTarget.id ? String(shadowTarget.id).slice(-12) : null;
        const match = oldTargetId === newTargetId;

        if (log) log.info("idle_shadow_selection", {
            oldTargetId,
            newTargetId,
            oldSubmode: state.submode,
            newCategory: shadowCategory,
            match,
        });

        // Mismatch detail — only when shadow disagrees, bounded by same interval
        if (!match && log) {
            const ref = state.referencePoint;
            // Find old target distance from candidates or state
            let oldDistanceMi = null;
            if (state.idleTargetId) {
                const oldCandidate = candidates.find(c => c.id === state.idleTargetId);
                if (oldCandidate) oldDistanceMi = oldCandidate.distanceMi;
            }
            log.info("idle_shadow_mismatch_detail", {
                oldTargetId,
                newTargetId,
                oldSubmode: state.submode,
                newCategory: shadowCategory,
                oldDistanceMi: oldDistanceMi != null ? Math.round(oldDistanceMi) : null,
                newDistanceMi: shadowTarget.distanceMi != null ? Math.round(shadowTarget.distanceMi) : null,
                referenceSource: ref ? ref.source : "unknown",
            });
        }
    }

    // ── Phase 3: Category-Driven Selection + Dispatch ───────────
    // Replaces _selectNextSubmode path when USE_CATEGORY_SELECTION = true.
    // Preserves all existing geometry, patrol, drift, and dispatch logic.

    const USE_CATEGORY_SELECTION = true;

    let _lastCategoryLogAt = 0;
    let _lastTargetLogAt = 0;
    const CATEGORY_LOG_INTERVAL_MS = 10000;

    let _lastLiveSelectionLogAt = 0;
    const LIVE_SELECTION_LOG_INTERVAL_MS = 10000;

    function _selectNextSubmodeV2() {
        const now = Date.now();
        const candidates = state.candidates || [];

        // HARD FALLBACK: if candidate pool is empty or selection throws, use v181
        try {
            if (!candidates || candidates.length === 0) {
                _v181Fallback();
                return;
            }

            // Stage 1: select category
            const category = _selectIdleCategory(candidates, now);
            if (!category) {
                _v181Fallback();
                return;
            }

            // Stage 2: select target within category
            const target = _selectIdleTarget(candidates, category, now);
            if (!target) {
                _v181Fallback();
                return;
            }

            // LOCALITY ENFORCEMENT: reject if outside policy radius relative to referencePoint
            const ref = state.referencePoint;
            const policy = CATEGORY_POLICY[category];
            if (ref && policy && target.distanceMi != null && target.distanceMi > policy.localRadiusMi) {
                if (log) log.info("idle_target_rejected", {
                    category,
                    targetId: target.id ? String(target.id).slice(-12) : null,
                    reason: "outside_local_radius",
                    distanceMi: Math.round(target.distanceMi),
                    localRadiusMi: policy.localRadiusMi,
                });
                // Try next candidate in same category
                const remaining = candidates.filter(c =>
                    c.category === category &&
                    c.id !== target.id &&
                    c.score >= policy.minScoreToFocus &&
                    (c.distanceMi == null || c.distanceMi <= policy.localRadiusMi)
                );
                if (remaining.length > 0) {
                    remaining.sort((a, b) => b.score - a.score);
                    // Recurse with replacement — but only once to avoid loop
                    const replacement = remaining[0];
                    _dispatchWithState(category, replacement, now);
                    return;
                }
                // No local candidates — fall back to patrol/drift
                _patrolDriftFallback();
                return;
            }

            // Dispatch selected target
            _dispatchWithState(category, target, now);

        } catch (e) {
            // HARD FALLBACK: any error → v181
            console.warn("[IDLE] V2 selection error, falling back to v181:", e.message);
            _v181Fallback();
        }
    }

    let _lastHoldLogAt = 0;
    const HOLD_LOG_INTERVAL_MS = 15000;

    // Shared dispatch + state update for successful category/target selection
    function _dispatchWithState(category, target, now) {
        const prevCategory = state.activeCategory;
        const prevTargetId = state.activeTargetId;
        const prevDispatchAt = state.lastDispatchAt || now;

        // Part 5: Hold logs — log duration of previous hold on transition
        if (now - _lastHoldLogAt >= HOLD_LOG_INTERVAL_MS) {
            if (prevTargetId && prevTargetId !== target.id && log) {
                _lastHoldLogAt = now;
                log.info("idle_target_hold", {
                    category: prevCategory,
                    targetId: prevTargetId ? String(prevTargetId).slice(-12) : null,
                    duration: Math.round((now - prevDispatchAt) / 1000),
                });
            }
            if (prevCategory && prevCategory !== category && log) {
                _lastHoldLogAt = now;
                log.info("idle_category_hold", {
                    category: prevCategory,
                    duration: Math.round((now - prevDispatchAt) / 1000),
                });
            }
        }

        state.activeCategory = category;
        state.activeTargetId = target.id;
        state.lastDispatchAt = now;

        // Weather classification + primary reason logs (bounded, same interval)
        if (now - _lastCategoryLogAt >= CATEGORY_LOG_INTERVAL_MS && log) {
            const wxClass = (target.metadata && target.metadata.weatherClass) || null;
            if (wxClass) {
                log.info("idle_weather_classification", {
                    targetId: target.id ? String(target.id).slice(-12) : null,
                    weatherClass: wxClass,
                    distanceMi: target.distanceMi != null ? Math.round(target.distanceMi) : null,
                });
            }

            let reason = "fallback_local";
            if (category === "weather" && wxClass === "important") reason = "important_weather";
            else if (category === "weather") reason = "local_context";
            else if (category === "traffic" || category === "air") reason = "local_context";
            else if (category === "ambient") reason = "fallback_local";

            log.info("idle_primary_reason", {
                category,
                targetId: target.id ? String(target.id).slice(-12) : null,
                reason,
            });
        }

        // Log category transition (bounded)
        if (prevCategory !== category && now - _lastCategoryLogAt >= CATEGORY_LOG_INTERVAL_MS) {
            _lastCategoryLogAt = now;
            if (log) log.info("idle_category_selected", {
                prevCategory,
                nextCategory: category,
                candidateCount: (state.candidates || []).filter(c => c.category === category).length,
                topScore: Math.round(target.score),
            });
        }

        // Log target selection (bounded)
        if (now - _lastTargetLogAt >= CATEGORY_LOG_INTERVAL_MS) {
            _lastTargetLogAt = now;
            if (log) log.info("idle_target_selected", {
                category,
                targetId: target.id ? String(target.id).slice(-12) : null,
                score: Math.round(target.score),
                distanceMi: target.distanceMi != null ? Math.round(target.distanceMi) : null,
                geometryType: target.geometryType,
            });
        }

        // Dispatch
        const dispatchResult = _dispatchIdleCandidate(target);

        // Render focus indicator + all local markers
        _renderFocusIndicator(target);
        _renderAllMapLayers();

        // Trigger local sweep on primary target change — delayed until focus flyTo completes
        if (prevTargetId !== target.id) {
            const focusSettleMs = (IDLE_SMOOTH_TRANSITION_SEC * 1000) + 500; // flyTo duration + settle buffer
            setTimeout(() => {
                if (state.mode === "active" && state.activeTargetId === target.id) {
                    _triggerLocalSweep(target.id);
                }
            }, focusSettleMs);
        }

        // Live selection log (bounded)
        if (now - _lastLiveSelectionLogAt >= LIVE_SELECTION_LOG_INTERVAL_MS) {
            _lastLiveSelectionLogAt = now;
            if (log) log.info("idle_live_selection", {
                category,
                targetId: target.id ? String(target.id).slice(-12) : null,
                distanceMi: target.distanceMi != null ? Math.round(target.distanceMi) : null,
                canControlCamera: target.canControlCamera,
                dispatchType: dispatchResult || "camera",
            });
        }

        // Set cooldowns
        const policy = CATEGORY_POLICY[category];
        if (policy) {
            state.categoryCooldowns[category] = now + (policy.cooldownSec * 1000);
            if (target.id) {
                state.targetCooldowns[target.id] = now + (policy.dwellSec * 1000);
            }
        }
        state.lastRotationAt = now;
    }

    // v181 fallback: run the original selection path verbatim
    function _v181Fallback() {
        const alerts = StormState.state.alerts.data || [];
        const now = Date.now();
        const ref = _getIdleReferencePoint();

        state.activeCategory = null;
        state.activeTargetId = null;

        const lowPri = alerts.filter(a => LOW_PRIORITY_EVENTS.has(a.event));
        if (lowPri.length > 0) {
            const animatable = lowPri.filter(_isAnimatableTarget);
            let pool = _filterByDistance(animatable, ref, IDLE_LOCAL_RADIUS_MI);
            if (pool.length === 0) pool = _filterByDistance(animatable, ref, IDLE_MAX_RADIUS_MI);
            if (pool.length === 0 && IDLE_ALLOW_GLOBAL_FALLBACK) pool = animatable;
            _logCandidatePool(ref, animatable, pool, "LOW_PRIORITY_FOCUS");
            if (pool.length > 0) {
                const target = _pickBestTarget(pool, ref);
                _setSubmode("LOW_PRIORITY_FOCUS", target, "alert"); return;
            }
        }

        const recentExpired = alerts.filter(a => {
            if (!a.expires) return false;
            const exp = new Date(a.expires).getTime();
            return exp < now && (now - exp) < EXPIRED_SWEEP_WINDOW_MS;
        });
        if (recentExpired.length > 0) {
            const animatable = recentExpired.filter(_isAnimatableTarget);
            let pool = _filterByDistance(animatable, ref, IDLE_LOCAL_RADIUS_MI);
            if (pool.length === 0) pool = _filterByDistance(animatable, ref, IDLE_MAX_RADIUS_MI);
            if (pool.length > 0) {
                const target = _pickBestTarget(pool, ref);
                _setSubmode("RECENT_HISTORY_SWEEP", target, "alert"); return;
            }
        }

        const envTargets = _getEnvironmentalTargets();
        if (envTargets.length > 0) {
            _setSubmode("ENVIRONMENTAL_FOCUS", envTargets[0], "feature"); return;
        }

        _patrolDriftFallback();
    }

    // NO DEAD STATES: guaranteed terminal — patrol → scan → drift
    function _patrolDriftFallback() {
        state.activeCategory = null;
        state.activeTargetId = null;
        const _pfMap = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        _clearFocusIndicator(_pfMap, "patrol_drift_fallback");
        _clearLocalMarkers(_pfMap);
        _clearLocationMarker(_pfMap);
        _cancelSweep();
        if (patrolNodes.length > 0) { _setSubmode("PATROL", null, "region"); return; }
        if (regionalScanNodes.length > 0) { _setSubmode("REGIONAL_SCAN", null, "region"); return; }
        _setSubmode("AMBIENT_DRIFT", null, null);
    }

    // Returns dispatch type string for live selection log
    function _dispatchIdleCandidate(candidate) {
        if (!candidate) { _patrolDriftFallback(); return "patrol_fallback"; }

        const policy = CATEGORY_POLICY[candidate.category];
        if (!policy) { _patrolDriftFallback(); return "patrol_fallback"; }

        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;

        // Camera dispatch: only if policy allows AND valid geometry AND camera is owned
        if (policy.canControlCamera && _canAnimate() && map) {
            if (candidate.geometryType === "polygon" || candidate.geometryType === "point") {
                // Build a target-like object for existing _focusOnAlert/_focusOnFeature
                const targetObj = {
                    id: candidate.id,
                    event: candidate.title,
                    headline: candidate.summary,
                    polygon: candidate.polygon,
                    distance_mi: candidate.distanceMi,
                };

                if (candidate.lat != null && candidate.lng != null) {
                    targetObj.center = { lat: candidate.lat, lon: candidate.lng };
                }

                if (candidate.bounds) {
                    targetObj._bounds = candidate.bounds;
                }

                let submode;
                if (candidate.metadata && candidate.metadata.subtype === "environmental") {
                    submode = "ENVIRONMENTAL_FOCUS";
                } else if (candidate.metadata && candidate.metadata.subtype === "recently_expired") {
                    submode = "RECENT_HISTORY_SWEEP";
                } else {
                    submode = "LOW_PRIORITY_FOCUS";
                }

                // Bounded camera dispatch log
                if (log) {
                    const now = Date.now();
                    if (now - _lastTargetLogAt >= CATEGORY_LOG_INTERVAL_MS) {
                        log.info("idle_camera_dispatch", {
                            category: candidate.category,
                            targetId: candidate.id ? String(candidate.id).slice(-12) : null,
                            geometryType: candidate.geometryType,
                            submode,
                        });
                    }
                }

                _setSubmode(submode, targetObj, candidate.category === "weather" ? "alert" : "feature");
                return "camera";
            }

            // No valid geometry for camera — log rejection
            if (log) {
                log.info("idle_target_rejected", {
                    category: candidate.category,
                    targetId: candidate.id ? String(candidate.id).slice(-12) : null,
                    reason: "no_valid_geometry",
                });
            }
        }

        // Card-only focus: category cannot control camera or no geometry
        if (!policy.canControlCamera || candidate.geometryType === "none") {
            if (log) {
                const now = Date.now();
                if (now - _lastTargetLogAt >= CATEGORY_LOG_INTERVAL_MS) {
                    log.info("idle_card_only_focus", {
                        category: candidate.category,
                        targetId: candidate.id ? String(candidate.id).slice(-12) : null,
                        title: candidate.title,
                    });
                }
            }

            state.activeCategory = candidate.category;
            state.activeTargetId = candidate.id;
            _setSubmode("LOW_PRIORITY_FOCUS", null, "card_only");
            return "card_only";
        }

        // Final fallback: patrol/drift — guaranteed terminal
        _patrolDriftFallback();
        return "patrol_fallback";
    }

    function _setSubmode(submode, target, targetType) {
        const prev = state.submode;
        state.submode = submode;
        state.lastSubmodeChangeAt = Date.now();

        const newTargetId = target ? (target.id || target.label || null) : null;
        if (newTargetId !== state.idleTargetId) {
            state.lastIdleTargetChangeAt = Date.now();
        }
        state.idleTargetId = newTargetId;
        state.idleTargetType = targetType;

        if (submode !== prev) {
            _dedupLog("idle_target_changed", {
                submode, nextTargetId: state.idleTargetId ? String(state.idleTargetId).slice(-12) : null,
                timestamp: Date.now(),
            });
        }

        _cancelMotion();
        const canAnim = _canAnimate();
        console.log("[IDLE] idle_submode_selected", { submode, targetId: state.idleTargetId, canAnimate: canAnim, cameraOwned: state.cameraOwned, dataStale: state.dataStale });
        if (canAnim) {
            _startMotion(submode, target);
        } else {
            console.log("[IDLE] idle_movement_blocked", { reason: !state.cameraOwned ? "no_camera" : state.dataStale ? "stale_data" : "mode_inactive" });
        }
        _updateInfoModel();
        _renderIdleUI();
        // Phase 2: run shadow selection for comparison (does not affect dispatch)
        _runShadowSelection();
    }

    function _getSubmodeDwell() {
        const d = { LOW_PRIORITY_FOCUS: FOCUS_DWELL_MS, RECENT_HISTORY_SWEEP: SWEEP_DWELL_MS,
            ENVIRONMENTAL_FOCUS: ENV_DWELL_MS, PATROL: PATROL_DWELL_MS,
            REGIONAL_SCAN: SCAN_DWELL_MS, AMBIENT_DRIFT: DRIFT_CYCLE_MS };
        return d[state.submode] || FOCUS_DWELL_MS;
    }

    // ── #5: Environmental Targets Hook ───────────────────────────

    // ── Environmental Target Discovery (radar-first) ───────────
    // Priority: radar-derived > injected > lightning > alert-derived
    //
    // Radar detection: probes IEM N0Q tiles at grid points around the user
    // to find where radar returns are strongest. Tile file size correlates
    // with echo intensity (empty ~334 bytes, moderate ~1-3KB, strong ~3-8KB).

    const ENV_MAX_TARGETS = 5;
    const ENV_MAX_DISTANCE_MI = 200;
    const RADAR_PROBE_GRID = 9;        // 3x3 grid of tiles around center
    const RADAR_EMPTY_THRESHOLD = 500;  // bytes — below this = no echo
    const RADAR_STRONG_THRESHOLD = 2500; // bytes — above this = strong returns
    const RADAR_PROBE_ZOOM = 8;

    // Base scores by source type (guarantee correct priority)
    const ENV_BASE_SCORES = {
        reflectivity_core: 100,
        precipitation_area: 80,
        lightning_cluster: 70,
        injected_feature: 60,
        weak_rotation: 25,
        mixed_phase: 25,
        weather_feature: 20,
    };

    // Cache radar probe results (refresh every 2 min)
    let radarProbeCache = [];
    let radarProbeCacheAt = 0;
    const RADAR_PROBE_CACHE_MS = 120000;

    // ── Stable Target Identity ─────────────────────────────────
    // Quantize position to 0.1° grid for stable ID across cycles.

    function _quantize(v) { return Math.round(v * 10) / 10; }

    function _generateStableEnvId(target) {
        // Alert-derived: use alert ID directly (already stable)
        if (target._alertId) return target._alertId;

        // Injected: use provided id or quantized position
        if (target._injected && target.id) return target.id;

        // Radar/computed: quantize position + kind
        if (target.center) {
            const qlat = _quantize(target.center.lat);
            const qlon = _quantize(target.center.lon);
            return `${target.kind}:${qlat}:${qlon}`;
        }

        // Fallback
        return `${target.kind}:${Date.now()}`;
    }

    // ── Temporal Trending ────────────────────────────────────────

    const ENV_HISTORY_MAX_AGE_MS = 180000;
    const ENV_HISTORY_MAX_SIZE = 50;
    const ENV_EMERGENCE_COOLDOWN_MS = 60000; // only "new" if unseen for 60s
    let envHistory = new Map();

    function _updateEnvHistory(targets) {
        const now = Date.now();
        for (const t of targets) {
            const existing = envHistory.get(t.id);
            envHistory.set(t.id, {
                lastIntensity: t.intensityScore,
                lastSeenAt: now,
                lastLat: t.center ? _quantize(t.center.lat) : null,
                lastLon: t.center ? _quantize(t.center.lon) : null,
                firstSeenAt: existing ? existing.firstSeenAt : now,
            });
        }
        // Prune: age + size cap
        for (const [id, h] of envHistory.entries()) {
            if (now - h.lastSeenAt > ENV_HISTORY_MAX_AGE_MS) envHistory.delete(id);
        }
        if (envHistory.size > ENV_HISTORY_MAX_SIZE) {
            // Remove oldest entries
            const sorted = [...envHistory.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
            for (let i = 0; i < sorted.length - ENV_HISTORY_MAX_SIZE; i++) {
                envHistory.delete(sorted[i][0]);
            }
        }
    }

    function _computeTrendScore(target) {
        const hist = envHistory.get(target.id);
        const now = Date.now();

        // Emergence: only if genuinely new (not seen within cooldown)
        if (!hist || (now - hist.lastSeenAt) > ENV_EMERGENCE_COOLDOWN_MS) {
            return 10; // new emergence bonus
        }

        let score = 0;

        // Intensity trend (requires time gap for meaningful comparison)
        if (now - hist.lastSeenAt < 120000) {
            const delta = target.intensityScore - hist.lastIntensity;
            if (delta > 2) score += 20;
            else if (delta < -2) score -= 10;
        }

        // Motion toward user
        if (target.center && hist.lastLat != null && hist.lastLon != null) {
            const loc = StormState.state.location;
            if (loc.lat && loc.lon && (now - hist.lastSeenAt) < 120000) {
                const currLat = _quantize(target.center.lat);
                const currLon = _quantize(target.center.lon);
                // Only compute if position actually changed on the grid
                if (currLat !== hist.lastLat || currLon !== hist.lastLon) {
                    const prevDist = _haversineMi(loc.lat, loc.lon, hist.lastLat, hist.lastLon);
                    const currDist = _haversineMi(loc.lat, loc.lon, currLat, currLon);
                    if (currDist < prevDist - 2) score += 15;
                }
            }
        }

        return score;
    }

    function _getEnvironmentalTargets() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        const bounds = map ? map.getBounds() : null;

        // Collect from all sources
        const radarTargets = _getRadarDerivedTargets(map, bounds);
        const injectedTargets = _getInjectedTargets(bounds);
        const alertTargets = _getAlertDerivedTargets(bounds);

        const all = [...radarTargets, ...injectedTargets, ...alertTargets];

        // Compute trend scores before ranking
        const now = Date.now();
        all.sort((a, b) => {
            const trendA = _computeTrendScore(a);
            const trendB = _computeTrendScore(b);
            const sa = (ENV_BASE_SCORES[a.kind] || 10) +
                (a.inViewport ? 50 : 0) +
                (a.distanceMiles != null ? Math.max(0, 30 - a.distanceMiles * 0.2) : 0) +
                a.intensityScore +
                (a.freshnessTs ? Math.max(0, 10 - (now - a.freshnessTs) / 3600000) : 0) +
                trendA;
            const sb = (ENV_BASE_SCORES[b.kind] || 10) +
                (b.inViewport ? 50 : 0) +
                (b.distanceMiles != null ? Math.max(0, 30 - b.distanceMiles * 0.2) : 0) +
                b.intensityScore +
                (b.freshnessTs ? Math.max(0, 10 - (now - b.freshnessTs) / 3600000) : 0) +
                trendB;
            return sb - sa;
        });

        // Update history after ranking
        _updateEnvHistory(all);

        // Log with trend info
        if (all.length > 0 && log) {
            const top = all[0];
            const trend = _computeTrendScore(top);
            const reason = trend >= 15 ? "approaching" : trend >= 10 ? "new" : trend >= 5 ? "growing" : "stable";
            _dedupLog("idle_env_source_used", {
                source: radarTargets.length > 0 ? "radar" : injectedTargets.length > 0 ? "injected" : "alert",
                kind: top.kind,
                score: (ENV_BASE_SCORES[top.kind] || 10) + top.intensityScore + trend,
                trend: reason,
            });
        }

        return all.slice(0, ENV_MAX_TARGETS);
    }

    // ── Radar-Derived Targets ────────────────────────────────────
    // Probes a grid of IEM N0Q tiles to find strongest reflectivity areas.

    function _getRadarDerivedTargets(map, bounds) {
        if (!map) return [];
        const now = Date.now();

        // Use cached results if fresh
        if (radarProbeCache.length > 0 && now - radarProbeCacheAt < RADAR_PROBE_CACHE_MS) {
            return radarProbeCache;
        }

        // Get current radar site
        const site = (typeof RadarManager !== "undefined" && RadarManager.getRadarSite)
            ? RadarManager.getRadarSite()
            : null;
        if (!site) return [];

        // Build probe grid around map center
        const center = map.getCenter();
        const loc = StormState.state.location;
        const probeLat = loc.lat || center.lat;
        const probeLon = loc.lon || center.lng;

        // Compute tile coords for a 3x3 grid at probe zoom
        const n = Math.pow(2, RADAR_PROBE_ZOOM);
        const centerX = Math.floor((probeLon + 180) / 360 * n);
        const centerY = Math.floor((1 - Math.log(Math.tan(probeLat * Math.PI / 180) + 1 / Math.cos(probeLat * Math.PI / 180)) / Math.PI) / 2 * n);

        // Fire async probes (non-blocking — results populate cache for next eval)
        _probeRadarGrid(site, centerX, centerY, bounds);

        return radarProbeCache;
    }

    async function _probeRadarGrid(site, cx, cy, bounds) {
        const results = [];
        const probes = [];

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = cx + dx;
                const y = cy + dy;
                probes.push({ x, y, dx, dy });
            }
        }

        try {
            const responses = await Promise.all(probes.map(p =>
                fetch(`/proxy/iem/ridge::${site}-N0Q-0/${RADAR_PROBE_ZOOM}/${p.x}/${p.y}.png`)
                    .then(r => r.blob().then(b => ({ ...p, size: b.size, ok: true })))
                    .catch(() => ({ ...p, size: 0, ok: false }))
            ));

            // Find strongest tiles
            let strongest = null;
            let broadCount = 0;

            for (const r of responses) {
                if (!r.ok || r.size < RADAR_EMPTY_THRESHOLD) continue;
                broadCount++;

                // Convert tile coords back to lat/lon (center of tile)
                const n = Math.pow(2, RADAR_PROBE_ZOOM);
                const lon = (r.x + 0.5) / n * 360 - 180;
                const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (r.y + 0.5) / n)));
                const lat = latRad * 180 / Math.PI;

                if (r.size >= RADAR_STRONG_THRESHOLD) {
                    if (!strongest || r.size > strongest.size) {
                        strongest = { lat, lon, size: r.size };
                    }
                }
            }

            const loc = StormState.state.location;

            // Strongest core — stable ID via quantized position
            if (strongest) {
                const center = { lat: strongest.lat, lon: strongest.lon };
                const dist = (loc.lat && loc.lon) ? _haversineMi(loc.lat, loc.lon, center.lat, center.lon) : null;
                const target = {
                    id: null, // assigned below
                    kind: "reflectivity_core",
                    label: "Monitoring strongest storm core nearby",
                    bounds: null,
                    center,
                    intensityScore: Math.min(50, Math.round(strongest.size / 100)),
                    distanceMiles: dist,
                    freshnessTs: Date.now(),
                    inViewport: bounds ? bounds.contains(L.latLng(center.lat, center.lon)) : false,
                };
                target.id = _generateStableEnvId(target);
                results.push(target);
            }

            // Broad precipitation area — stable ID via quantized centroid
            if (broadCount >= 3) {
                const activeTiles = responses.filter(r => r.size >= RADAR_EMPTY_THRESHOLD);
                const n2 = Math.pow(2, RADAR_PROBE_ZOOM);
                const avgLat = activeTiles.reduce((sum, r) =>
                    sum + Math.atan(Math.sinh(Math.PI * (1 - 2 * (r.y + 0.5) / n2))) * 180 / Math.PI, 0) / broadCount;
                const avgLon = activeTiles.reduce((sum, r) =>
                    sum + ((r.x + 0.5) / n2 * 360 - 180), 0) / broadCount;

                const center = { lat: avgLat, lon: avgLon };
                const dist = (loc.lat && loc.lon) ? _haversineMi(loc.lat, loc.lon, center.lat, center.lon) : null;
                const target = {
                    id: null,
                    kind: "precipitation_area",
                    label: "Watching active rain area",
                    bounds: null,
                    center,
                    intensityScore: broadCount * 5,
                    distanceMiles: dist,
                    freshnessTs: Date.now(),
                    inViewport: bounds ? bounds.contains(L.latLng(center.lat, center.lon)) : false,
                };
                target.id = _generateStableEnvId(target);
                results.push(target);
            }
        } catch (e) {
            // Probe failed — return empty
        }

        radarProbeCache = results;
        radarProbeCacheAt = Date.now();
    }

    function _haversineMi(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── Injected Targets ─────────────────────────────────────────

    function _getInjectedTargets(bounds) {
        const injected = window.__stormEnvFeatures || [];
        return injected.map(t => {
            const target = {
                ...t,
                _injected: true,
                kind: t.kind || "injected_feature",
                inViewport: bounds && t.center ? bounds.contains(L.latLng(t.center.lat, t.center.lon)) : false,
            };
            if (!target.id) target.id = _generateStableEnvId(target);
            return target;
        });
    }

    // ── Alert-Derived Targets (FALLBACK — lowest priority) ───────

    // Resilient severe-event taxonomy resolver — never crashes
    const _FALLBACK_SEVERE = new Set([
        "Tornado Warning", "Severe Thunderstorm Warning",
        "Flash Flood Warning", "Special Marine Warning",
    ]);
    let _severeLoggedOnce = false;

    function _resolveSevereEvents() {
        // Try camera-policy's authoritative set
        if (typeof CameraPolicy !== "undefined" && CameraPolicy._SEVERE_EVENTS) {
            return CameraPolicy._SEVERE_EVENTS;
        }
        // Fallback
        if (!_severeLoggedOnce) {
            _severeLoggedOnce = true;
            _dedupLog("idle_severe_taxonomy_fallback", { source: "idle-awareness", count: _FALLBACK_SEVERE.size });
        }
        return _FALLBACK_SEVERE;
    }

    const ENV_EVENTS = new Set([
        "Special Weather Statement", "Dense Fog Advisory", "Wind Advisory",
        "Flood Watch", "Flash Flood Watch", "Fire Weather Watch",
        "Winter Weather Advisory", "Frost Advisory", "Heat Advisory",
    ]);

    const ENV_KEYWORDS = {
        "rotation": { kind: "weak_rotation", label: "Weak rotation signature", bonus: 5 },
        "hail": { kind: "mixed_phase", label: "Hail activity area", bonus: 5 },
        "funnel": { kind: "weak_rotation", label: "Funnel cloud report", bonus: 5 },
        "lightning": { kind: "weather_feature", label: "Lightning noted in area", bonus: 3 },
        "flooding": { kind: "weather_feature", label: "Flood-prone area", bonus: 2 },
    };

    function _getAlertDerivedTargets(bounds) {
        try {
        const alerts = StormState.state.alerts.data || [];
        const severeEvents = _resolveSevereEvents();
        const targets = [];

        for (const a of alerts) {
            if (!a || !a.event) continue; // skip malformed entries
            if (severeEvents.has(a.event)) continue;
            if (!ENV_EVENTS.has(a.event)) continue;
            if (!a.polygon) continue;
            if (a.distance_mi != null && a.distance_mi > ENV_MAX_DISTANCE_MI) continue;

            let center = null;
            let alertBounds = null;
            try {
                const geo = JSON.parse(a.polygon);
                const layer = L.geoJSON(geo);
                const b = layer.getBounds();
                if (b && b.isValid()) {
                    center = { lat: b.getCenter().lat, lon: b.getCenter().lng };
                    alertBounds = b;
                }
            } catch (e) { continue; }
            if (!center) continue;

            let kind = "weather_feature";
            let label = a.event || "Unknown";
            let bonus = 0;
            const desc = (a.description || "").toLowerCase();
            for (const [kw, info] of Object.entries(ENV_KEYWORDS)) {
                if (desc.includes(kw)) { kind = info.kind; label = info.label; bonus = info.bonus; break; }
            }

            targets.push({
                id: a.id,
                _alertId: a.id, // stable: NWS alert IDs are permanent
                kind,
                label: label + (a.headline ? " — " + a.headline.slice(0, 30) : ""),
                bounds: alertBounds,
                center,
                intensityScore: 5 + bonus, // low base — alert-derived
                distanceMiles: a.distance_mi,
                freshnessTs: a.effective ? new Date(a.effective).getTime() : null,
                inViewport: bounds && alertBounds ? bounds.intersects(alertBounds) : false,
            });
        }

        return targets;
        } catch (e) {
            _dedupLog("idle_alert_target_derivation_error", { source: "idle-awareness", error: e.message });
            return [];
        }
    }

    // ── Camera Motion ────────────────────────────────────────────

    function _startMotion(submode, target) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { console.log("[IDLE] idle_movement_blocked", { reason: "no_map" }); return; }
        if (!_canAnimate()) { console.log("[IDLE] idle_movement_blocked", { reason: "canAnimate_false" }); return; }

        console.log("[IDLE] idle_route_generated", { submode, hasTarget: !!target, targetId: target?.id?.slice?.(-12) || target?.label || null });

        switch (submode) {
            case "LOW_PRIORITY_FOCUS":
            case "RECENT_HISTORY_SWEEP":
                _focusOnAlert(map, target); break;
            case "ENVIRONMENTAL_FOCUS":
                _focusOnFeature(map, target); break;
            case "PATROL": _startPatrol(map); break;
            case "REGIONAL_SCAN": _startRegionalScan(map); break;
            case "AMBIENT_DRIFT": _startDrift(map); break;
        }
    }

    // ── Geometry Resolution ────────────────────────────────────

    function _resolveTargetGeometry(target) {
        const result = { hasPolygon: false, bounds: null, centroid: null, hasPoint: false };
        if (!target) return result;

        // Priority A: polygon → bounds + centroid
        if (target.polygon) {
            try {
                const geo = JSON.parse(target.polygon);
                const layer = L.geoJSON(geo);
                const b = layer.getBounds();
                if (b && b.isValid()) {
                    result.hasPolygon = true;
                    result.bounds = b;
                    const c = b.getCenter();
                    result.centroid = { lat: c.lat, lng: c.lng };
                    result.hasPoint = true;
                }
            } catch (e) { /* fall through */ }
        }

        // Priority B: explicit lat/lon on target
        if (!result.hasPoint && target.lat != null && target.lon != null) {
            result.centroid = { lat: target.lat, lng: target.lon };
            result.hasPoint = true;
        }

        // Priority C: center field (from env targets)
        if (!result.hasPoint && target.center) {
            result.centroid = { lat: target.center.lat, lng: target.center.lon };
            result.hasPoint = true;
        }

        // Priority D: derive approximate point from county FIPS via county layer
        if (!result.hasPoint && target.county_fips && typeof StormMap !== "undefined") {
            const countyLayer = StormMap.getCountyLayer();
            if (countyLayer) {
                countyLayer.eachLayer(function (layer) {
                    if (result.hasPoint) return;
                    if (layer._fips && target.county_fips.includes(layer._fips)) {
                        const b = layer.getBounds();
                        if (b && b.isValid()) {
                            const c = b.getCenter();
                            result.centroid = { lat: c.lat, lng: c.lng };
                            result.bounds = b;
                            result.hasPoint = true;
                        }
                    }
                });
            }
        }

        return result;
    }

    function _isAnimatableTarget(target) {
        const geo = _resolveTargetGeometry(target);
        return geo.hasPolygon || geo.hasPoint;
    }

    function _focusOnAlert(map, target) {
        if (!target) { console.log("[IDLE] idle_movement_blocked", { reason: "no_target" }); return; }

        const geo = _resolveTargetGeometry(target);
        const dur = IDLE_SMOOTH_TRANSITION_SEC;
        const ease = IDLE_SMOOTH_EASING;
        const cat = state.activeCategory || "weather";

        // A: polygon — flyToBounds (only case that uses bounds)
        if (geo.hasPolygon && geo.bounds && geo.centroid) {
            const maxZ = _getTargetZoom(null, cat, true);
            console.log("[IDLE] idle_movement_dispatch", { type: "flyToBounds_poly", lat: geo.centroid.lat.toFixed(2), lng: geo.centroid.lng.toFixed(2), maxZoom: maxZ });
            Camera.move({ source: "idle", bounds: geo.bounds.pad(0.1), flyOptions: { maxZoom: maxZ, duration: dur, easeLinearity: ease }, reason: "idle_polygon_bounds" });
            _logZoomDecision(target, maxZ, "polygon_bounds");
            _startMicroDrift(map);
            return;
        }

        // B: point → check if near a saved location for reference framing
        if (geo.hasPoint && geo.centroid) {
            const refLoc = _getRelevantSavedLocationForTarget(geo.centroid.lat, geo.centroid.lng);
            if (refLoc) {
                // Frame both target + saved location
                const refBounds = _getTargetReferenceBounds(
                    geo.centroid.lat, geo.centroid.lng,
                    refLoc.loc.lat, refLoc.loc.lng, 0.25
                );
                const maxZ = _getTargetZoom(null, cat, false);
                _logCameraCommand("focus_in", "flyToBounds_ref", maxZ, geo.centroid.lat.toFixed(2), geo.centroid.lng.toFixed(2));
                Camera.move({ source: "idle", bounds: refBounds, flyOptions: { maxZoom: maxZ, duration: dur, easeLinearity: ease }, reason: "idle_ref_framing" });
                _logZoomDecision(target, maxZ, "point_ref_" + refLoc.slot);
                const now = Date.now();
                if (now - _lastRefFrameLogAt >= 10000) {
                    _lastRefFrameLogAt = now;
                    if (log) log.info("idle_target_reference_framing", {
                        targetId: target.id?.slice?.(-12), referenceSlot: refLoc.slot, includesReference: true,
                    });
                }
            } else {
                // Normal tight target framing
                const zoom = _getTargetZoom(null, cat, false);
                _logCameraCommand("focus_in", "flyTo", zoom, geo.centroid.lat.toFixed(2), geo.centroid.lng.toFixed(2));
                Camera.move({ source: "idle", center: [geo.centroid.lat, geo.centroid.lng], zoom, flyOptions: { duration: dur, easeLinearity: ease }, reason: "idle_focus_in" });
                _logZoomDecision(target, zoom, "point_flyTo");
            }
            _startMicroDrift(map);
            return;
        }

        // C: county centroid → flyTo
        if (geo.bounds) {
            const c = geo.bounds.getCenter();
            console.log("[IDLE] idle_movement_dispatch", { type: "flyTo_county", lat: c.lat.toFixed(2), lng: c.lng.toFixed(2), zoom: 12 });
            Camera.move({ source: "idle", center: [c.lat, c.lng], zoom: 12, flyOptions: { duration: dur, easeLinearity: ease }, reason: "idle_county_flyTo" });
            _logZoomDecision(target, 12, "county_flyTo");
            _startMicroDrift(map);
            return;
        }

        console.log("[IDLE] idle_target_rejected", { reason: "no_geometry", targetId: target.id?.slice?.(-12), submode: state.submode });
    }

    function _focusOnFeature(map, feature) {
        if (!feature) return;
        const dur = IDLE_SMOOTH_TRANSITION_SEC;
        const ease = IDLE_SMOOTH_EASING;
        const cat = state.activeCategory || "weather";

        if (feature.bounds && feature.bounds.isValid && feature.bounds.isValid()) {
            const maxZ = _getTargetZoom(null, cat, true);
            Camera.move({ source: "idle", bounds: feature.bounds.pad(0.1), flyOptions: { maxZoom: maxZ, duration: dur, easeLinearity: ease }, reason: "idle_feature_bounds" });
            _logZoomDecision(feature, maxZ, "polygon_bounds");
        } else if (feature.center) {
            const zoom = _getTargetZoom(null, cat, false);
            Camera.move({ source: "idle", center: [feature.center.lat, feature.center.lon], zoom, flyOptions: { duration: dur, easeLinearity: ease }, reason: "idle_feature_center" });
            _logZoomDecision(feature, zoom, "point_flyTo");
        } else if (feature.lat && feature.lon) {
            const zoom = _getTargetZoom(null, cat, false);
            Camera.move({ source: "idle", center: [feature.lat, feature.lon], zoom, flyOptions: { duration: dur, easeLinearity: ease }, reason: "idle_feature_point" });
            _logZoomDecision(feature, zoom, "point_flyTo");
        }
        _startMicroDrift(map);
    }

    // Part 3: Micro-drift — pan-only, no zoom, delayed, infrequent
    // Prevents static feel during long target holds without causing visible jitter.
    function _startMicroDrift(map) {
        _stopMicroDrift();
        if (!map) return;
        _microDriftLandedAt = Date.now();

        // First drift delayed by settle period + interval
        const firstDelay = IDLE_MICRO_DRIFT_SETTLE_MS + IDLE_MICRO_DRIFT_INTERVAL_MS;
        _microDriftTimer = setTimeout(function drift() {
            if (!_canAnimate() || state.mode !== "active") { _stopMicroDrift(); return; }

            // Guard: skip if still within settle period (e.g. after re-dispatch)
            const sinceArrival = Date.now() - _microDriftLandedAt;
            if (sinceArrival < IDLE_MICRO_DRIFT_SETTLE_MS) {
                _microDriftTimer = setTimeout(drift, IDLE_MICRO_DRIFT_SETTLE_MS - sinceArrival + 1000);
                return;
            }

            // Guard: skip if map is currently animating (flyTo in progress)
            if (map._flyToFrame || map._panAnim) {
                _microDriftTimer = setTimeout(drift, 5000); // retry in 5s
                return;
            }

            // Pan-only: tiny offset, NO zoom change
            const center = map.getCenter();
            const latDelta = (Math.random() - 0.5) * IDLE_MICRO_DRIFT_PAN * 2;
            const lngDelta = (Math.random() - 0.5) * IDLE_MICRO_DRIFT_PAN * 2;

            map.panTo([center.lat + latDelta, center.lng + lngDelta], {
                animate: true,
                duration: IDLE_MICRO_DRIFT_DURATION_SEC,
                easeLinearity: 0.05,
                noMoveStart: true,
            });

            _microDriftTimer = setTimeout(drift, IDLE_MICRO_DRIFT_INTERVAL_MS);
        }, firstDelay);
    }

    function _stopMicroDrift() {
        if (_microDriftTimer) { clearTimeout(_microDriftTimer); _microDriftTimer = null; }
    }

    function _startPatrol(map) {
        if (patrolNodes.length === 0) { console.log("[IDLE] idle_movement_blocked", { reason: "no_patrol_nodes" }); return; }
        let idx = 0;
        function next() {
            if (!_canAnimate() || state.submode !== "PATROL") return;
            const node = patrolNodes[idx % patrolNodes.length];
            console.log("[IDLE] idle_movement_dispatch", { type: "patrol", label: node.label, lat: node.lat.toFixed(2), lon: node.lon.toFixed(2), zoom: node.zoom });
            Camera.move({ source: "idle", center: [node.lat, node.lon], zoom: node.zoom || 7, flyOptions: { duration: SCAN_TRANSITION_MS / 1000, easeLinearity: 0.25 }, reason: "idle_patrol" });
            idx++;
            dwellTimer = setTimeout(next, PATROL_DWELL_MS + SCAN_TRANSITION_MS);
        }
        next();
    }

    // #4: Regional scan — smooth path, no sharp pivots
    function _startRegionalScan(map) {
        if (regionalScanNodes.length === 0) return;
        let idx = 0;
        function next() {
            if (!_canAnimate() || state.submode !== "REGIONAL_SCAN") return;
            const node = regionalScanNodes[idx % regionalScanNodes.length];
            // Longer transition for smoothness
            Camera.move({ source: "idle", center: [node.lat, node.lon], zoom: node.zoom || 7, flyOptions: { duration: 3.0, easeLinearity: 0.15 }, reason: "idle_regional_scan" });
            idx++;
            dwellTimer = setTimeout(next, SCAN_DWELL_MS + 3000);
        }
        next();
    }

    function _startDrift(map) {
        function drift() {
            if (!_canAnimate() || state.submode !== "AMBIENT_DRIFT") return;
            const center = map.getCenter();
            const bounds = map.getBounds();
            const latSpan = bounds.getNorth() - bounds.getSouth();
            const lngSpan = bounds.getEast() - bounds.getWest();
            const newLat = center.lat + (Math.random() - 0.5) * latSpan * DRIFT_PAN_FRACTION;
            const newLng = center.lng + (Math.random() - 0.5) * lngSpan * DRIFT_PAN_FRACTION;
            const newZoom = Math.max(5, Math.min(8, map.getZoom() + (Math.random() - 0.5) * DRIFT_ZOOM_DELTA * 2));
            console.log("[IDLE] idle_movement_dispatch", { type: "drift", lat: newLat.toFixed(2), lng: newLng.toFixed(2), zoom: newZoom.toFixed(1) });
            Camera.move({ source: "idle", center: [newLat, newLng], zoom: newZoom, flyOptions: { duration: (DRIFT_CYCLE_MS * 0.6) / 1000, easeLinearity: 0.15 }, reason: "idle_drift" });
            driftTimer = setTimeout(drift, DRIFT_CYCLE_MS);
        }
        driftTimer = setTimeout(drift, 2000);
    }

    // ── Focus Indicator — Semantic Icon System ─────────────────
    // Primary target gets a category-colored icon marker with semantic emoji.
    // Polygon targets also get a highlighted outline.

    let _focusLayer = null;
    let _focusTargetId = null;
    let _focusPane = null;
    let _lastFocusLogAt = 0;
    const FOCUS_LOG_INTERVAL_MS = 10000;

    const FOCUS_COLORS = {
        weather:  { bg: "#1e40af", border: "#60a5fa", glow: "rgba(96,165,250,0.4)" },
        traffic:  { bg: "#92400e", border: "#fbbf24", glow: "rgba(251,191,36,0.4)" },
        air:      { bg: "#065f46", border: "#34d399", glow: "rgba(52,211,153,0.4)" },
        ambient:  { bg: "#334155", border: "#94a3b8", glow: "rgba(148,163,184,0.3)" },
    };

    // Icon mapping: source/kind/advisoryType → emoji
    const FOCUS_ICONS = {
        // Weather
        reflectivity_core:   "\u26C8\uFE0F",   // ⛈️
        precipitation_area:  "\uD83C\uDF27\uFE0F", // 🌧️
        lightning_cluster:   "\u26A1",           // ⚡
        weak_rotation:       "\uD83C\uDF00",     // 🌀
        mixed_phase:         "\uD83C\uDF28\uFE0F", // 🌨️
        weather_feature:     "\u26A0\uFE0F",     // ⚠️
        low_priority:        "\u26A0\uFE0F",     // ⚠️
        recently_expired:    "\u23F0",           // ⏰
        // Traffic
        construction_zone:   "\uD83D\uDEA7",     // 🚧
        accident_report:     "\uD83D\uDE97",     // 🚗
        road_closure:        "\u26D4",           // ⛔
        road_hazard:         "\u26A0\uFE0F",     // ⚠️
        weather_hazard:      "\uD83C\uDF27\uFE0F", // 🌧️
        // Air
        air_good:            "\uD83C\uDF3F",     // 🌿
        air_moderate:        "\uD83C\uDF3F",     // 🌿
        air_unhealthy:       "\uD83D\uDE37",     // 😷
        // Ambient
        ambient_default:     "\uD83D\uDCCD",     // 📍
    };

    // Category fallback icons
    const FOCUS_FALLBACK_ICONS = {
        weather: "\u26C5",      // ⛅
        traffic: "\uD83D\uDE97", // 🚗
        air:     "\uD83C\uDF3F", // 🌿
        ambient: "\uD83D\uDCCD", // 📍
    };

    function _resolveIcon(candidate) {
        if (!candidate) return "\u2022"; // bullet

        const meta = candidate.metadata || {};
        const src = candidate.source || "";
        const cat = candidate.category;

        if (cat === "weather") {
            const kind = meta.kind || meta.subtype || "";
            if (FOCUS_ICONS[kind]) return FOCUS_ICONS[kind];
            if (src.includes("reflectivity_core")) return FOCUS_ICONS.reflectivity_core;
            if (src.includes("precipitation_area")) return FOCUS_ICONS.precipitation_area;
            if (src.includes("low_priority")) return FOCUS_ICONS.low_priority;
            if (src.includes("recently_expired")) return FOCUS_ICONS.recently_expired;
        }

        if (cat === "traffic") {
            const advType = meta.advisoryType || "";
            if (FOCUS_ICONS[advType]) return FOCUS_ICONS[advType];
        }

        if (cat === "air") {
            const aqi = meta.aqi;
            if (aqi != null && aqi >= 100) return FOCUS_ICONS.air_unhealthy;
            if (aqi != null && aqi >= 50) return FOCUS_ICONS.air_moderate;
            return FOCUS_ICONS.air_good;
        }

        if (cat === "ambient") return FOCUS_ICONS.ambient_default;

        return FOCUS_FALLBACK_ICONS[cat] || "\u2022";
    }

    function _ensureFocusPane(map) {
        if (_focusPane) return _focusPane;
        _focusPane = map.createPane("idleFocusPane");
        _focusPane.style.zIndex = 550;
        _focusPane.style.pointerEvents = "none";
        return _focusPane;
    }

    function _renderFocusIndicator(candidate) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        if (candidate && candidate.id === _focusTargetId && _focusLayer) return;

        _clearFocusIndicator(map, "target_change");
        if (!candidate) return;

        _ensureFocusPane(map);
        const colors = FOCUS_COLORS[candidate.category] || FOCUS_COLORS.weather;
        const icon = _resolveIcon(candidate);
        let focusType = "none";
        let iconType = icon;

        // Polygon targets: highlight outline + icon at centroid
        if (candidate.polygon) {
            try {
                const geo = JSON.parse(candidate.polygon);
                const polyLayer = L.geoJSON(geo, {
                    pane: "idleFocusPane",
                    style: {
                        color: colors.border,
                        weight: 3,
                        opacity: 0.8,
                        fillColor: colors.bg,
                        fillOpacity: 0.12,
                        dashArray: "8 5",
                        className: "idle-focus-polygon",
                    },
                    interactive: false,
                });

                // Add icon marker at polygon centroid
                const bounds = polyLayer.getBounds();
                const centroid = bounds.isValid() ? bounds.getCenter() : null;
                const layers = [polyLayer];

                if (centroid) {
                    const iconMarker = _createIconMarker(centroid.lat, centroid.lng, icon, colors);
                    layers.push(iconMarker);
                }

                _focusLayer = L.layerGroup(layers).addTo(map);
                focusType = "polygon";
            } catch (e) { /* fall through to point */ }
        }

        // Point targets: icon marker only
        if (!_focusLayer && candidate.lat != null && candidate.lng != null) {
            _focusLayer = _createIconMarker(candidate.lat, candidate.lng, icon, colors).addTo(map);
            focusType = "point";
        }

        _focusTargetId = candidate.id;

        // Log
        const now = Date.now();
        if (now - _lastFocusLogAt >= FOCUS_LOG_INTERVAL_MS) {
            _lastFocusLogAt = now;
            if (log) log.info("idle_focus_icon_rendered", {
                targetId: candidate.id ? String(candidate.id).slice(-12) : null,
                category: candidate.category,
                iconType: iconType.codePointAt(0).toString(16),
            });
        }
    }

    function _createIconMarker(lat, lng, icon, _colors) {
        const size = 34;
        const html = `<span class="idle-focus-icon idle-focus-icon-primary">${icon}</span>`;

        const divIcon = L.divIcon({
            className: "idle-focus-icon-wrapper",
            html: html,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
        });

        return L.marker([lat, lng], {
            icon: divIcon,
            pane: "idleFocusPane",
            interactive: false,
            keyboard: false,
        });
    }

    function _clearFocusIndicator(map, reason) {
        const prevId = _focusTargetId;
        if (_focusLayer) {
            if (map) map.removeLayer(_focusLayer);
            _focusLayer = null;
        }
        _focusTargetId = null;
        if (prevId && log) {
            const now = Date.now();
            if (now - _lastFocusLogAt >= FOCUS_LOG_INTERVAL_MS) {
                log.info("idle_focus_layer_cleared", {
                    targetId: prevId ? String(prevId).slice(-12) : null,
                    reason: reason || "unknown",
                });
            }
        }
    }

    // ── Local Awareness Markers ─────────────────────────────────
    // Renders all eligible targets within 30mi as smaller markers on map.
    // Primary remains visually strongest. Location marker always present.

    let _localMarkerGroup = null;    // L.layerGroup for non-primary markers
    let _locationMarkerLayer = null; // separate layer for user location
    let _trafficLabelGroup = null;   // L.layerGroup for traffic road labels
    let _localSweepTimer = null;
    let _lastLocalMarkerLogAt = 0;
    let _lastTrafficLabelLogAt = 0;
    const LOCAL_LOG_INTERVAL_MS = 15000;

    function _createSmallIconMarker(lat, lng, icon, colors, isPrimary) {
        const size = isPrimary ? 34 : 24;
        const pulseClass = isPrimary ? " idle-focus-icon-primary" : "";
        const opacity = isPrimary ? "" : " style=\"opacity:0.6\"";

        const html = `<span class="idle-focus-icon${pulseClass}"${opacity}>${icon}</span>`;

        return L.marker([lat, lng], {
            icon: L.divIcon({
                className: "idle-focus-icon-wrapper",
                html: html,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            }),
            pane: "idleFocusPane",
            interactive: false,
            keyboard: false,
        });
    }

    // Collision layout: offset markers that are too close on screen
    const MARKER_COLLISION_PX = 30; // min pixel separation
    const MARKER_OFFSET_DEG = 0.015; // ~1mi offset for collisions
    let _lastLayoutLogAt = 0;

    function _layoutLocalMarkerPositions(candidates, map) {
        if (!map || candidates.length <= 1) return candidates;

        const placed = [];
        let collidedCount = 0;

        for (const c of candidates) {
            if (c.lat == null || c.lng == null) { placed.push(c); continue; }

            const pt = map.latLngToContainerPoint([c.lat, c.lng]);
            let collides = false;

            for (const p of placed) {
                if (p._screenPt) {
                    const dx = pt.x - p._screenPt.x;
                    const dy = pt.y - p._screenPt.y;
                    if (Math.sqrt(dx * dx + dy * dy) < MARKER_COLLISION_PX) {
                        collides = true;
                        break;
                    }
                }
            }

            if (collides) {
                // Offset: push in deterministic direction based on index
                const angle = (placed.length * 1.2) % (2 * Math.PI);
                const offset = {
                    lat: c.lat + Math.cos(angle) * MARKER_OFFSET_DEG,
                    lng: c.lng + Math.sin(angle) * MARKER_OFFSET_DEG,
                };
                placed.push({ ...c, lat: offset.lat, lng: offset.lng, _screenPt: map.latLngToContainerPoint([offset.lat, offset.lng]) });
                collidedCount++;
            } else {
                placed.push({ ...c, _screenPt: pt });
            }
        }

        // Bounded log
        if (collidedCount > 0) {
            const now = Date.now();
            if (now - _lastLayoutLogAt >= LOCAL_LOG_INTERVAL_MS) {
                _lastLayoutLogAt = now;
                if (log) log.info("idle_marker_layout_applied", { count: placed.length, collidedCount });
            }
        }

        return placed;
    }

    function _renderLocalMarkers() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map || state.mode !== "active") return;

        _ensureFocusPane(map);

        // Clear previous non-primary markers
        if (_localMarkerGroup) { map.removeLayer(_localMarkerGroup); _localMarkerGroup = null; }
        if (_trafficLabelGroup) { map.removeLayer(_trafficLabelGroup); _trafficLabelGroup = null; }

        const ref = state.referencePoint || _getIdleReferencePoint();
        if (!ref) return;

        const candidates = state.candidates || [];
        const primaryId = state.activeTargetId;

        // Filter: within 30mi, has location, meaningful score, not ambient unless primary
        const eligible = candidates.filter(c => {
            if (c.lat == null || c.lng == null) return false;
            if (c.distanceMi != null && c.distanceMi > LOCAL_MARKER_RADIUS_MI) return false;
            if (c.id === primaryId) return false; // primary handled by _renderFocusIndicator
            if (c.score < LOCAL_MARKER_MIN_SCORE) return false;
            if (c.category === "ambient") return false; // ambient adds no map value
            return true;
        });

        // Sort by score, cap at max, apply collision layout
        eligible.sort((a, b) => b.score - a.score);
        const capped = eligible.slice(0, LOCAL_MARKER_MAX - 1);
        const laid = _layoutLocalMarkerPositions(capped, map);

        const layers = [];
        const labelLayers = [];
        const markerIds = [];
        const zoom = map.getZoom();

        for (const c of laid) {
            const colors = FOCUS_COLORS[c.category] || FOCUS_COLORS.weather;
            const icon = _resolveIcon(c);
            layers.push(_createSmallIconMarker(c.lat, c.lng, icon, colors, false));
            markerIds.push(c.id ? String(c.id).slice(-12) : "?");

            // Traffic labels for major incidents at high zoom
            // Traffic labels: closures, major accidents, or construction with meaningful delay (>120s)
            const meta = c.metadata || {};
            const labelEligible = c.category === "traffic" && zoom >= TRAFFIC_LABEL_MIN_ZOOM && (
                c.score >= TRAFFIC_LABEL_MIN_SCORE ||
                meta.advisoryType === "road_closure" ||
                meta.advisoryType === "accident_report" ||
                (meta.delay && meta.delay > 120)
            );
            if (labelEligible) {
                const roadName = (c.metadata && c.metadata.roadName) || "";
                if (roadName) {
                    const truncated = roadName.slice(0, 18);
                    const labelIcon = L.divIcon({
                        className: "idle-traffic-label-wrapper",
                        html: `<div class="idle-traffic-label">${_esc(truncated)}</div>`,
                        iconSize: [80, 14],
                        iconAnchor: [40, -14], // above the icon
                    });
                    labelLayers.push(L.marker([c.lat, c.lng], {
                        icon: labelIcon,
                        pane: "idleFocusPane",
                        interactive: false,
                        keyboard: false,
                    }));

                    // Log traffic label (bounded)
                    const now = Date.now();
                    if (now - _lastTrafficLabelLogAt >= LOCAL_LOG_INTERVAL_MS) {
                        _lastTrafficLabelLogAt = now;
                        if (log) log.info("idle_traffic_label_rendered", {
                            targetId: c.id ? String(c.id).slice(-12) : null,
                            roadName: truncated,
                            zoom: Math.round(zoom),
                        });
                    }
                }
            }
        }

        if (layers.length > 0) {
            _localMarkerGroup = L.layerGroup(layers).addTo(map);
        }
        if (labelLayers.length > 0) {
            _trafficLabelGroup = L.layerGroup(labelLayers).addTo(map);
        }

        state.visibleLocalMarkers = markerIds;

        // Bounded log
        const now = Date.now();
        if (now - _lastLocalMarkerLogAt >= LOCAL_LOG_INTERVAL_MS && markerIds.length > 0) {
            _lastLocalMarkerLogAt = now;
            if (log) log.info("idle_local_markers_rendered", {
                count: markerIds.length + 1, // +1 for primary
                primaryTargetId: primaryId ? String(primaryId).slice(-12) : null,
                markerIds: markerIds.slice(0, 6),
            });
        }
    }

    function _clearLocalMarkers(map) {
        if (_localMarkerGroup) { if (map) map.removeLayer(_localMarkerGroup); _localMarkerGroup = null; }
        if (_trafficLabelGroup) { if (map) map.removeLayer(_trafficLabelGroup); _trafficLabelGroup = null; }
        state.visibleLocalMarkers = [];
    }

    // ── Location Marker ──────────────────────────────────────────
    // Always shows user's location with a distinct "you are here" icon.

    let _lastLocMarkerLogAt = 0;

    function _renderLocationMarker(map) {
        if (!map) return;
        _clearLocationMarker(map);

        const ref = state.referencePoint || _getIdleReferencePoint();
        if (!ref || ref.lat == null || ref.lng == null) return;

        _ensureFocusPane(map);

        const html = `<span class="idle-location-icon">\uD83C\uDFE0</span>`; // 🏠

        _locationMarkerLayer = L.marker([ref.lat, ref.lng], {
            icon: L.divIcon({
                className: "idle-location-wrapper",
                html: html,
                iconSize: [22, 22],
                iconAnchor: [11, 11],
            }),
            pane: "idleFocusPane",
            interactive: false,
            keyboard: false,
            zIndexOffset: -100, // below target markers
        }).addTo(map);

        state.locationMarker = { lat: ref.lat, lng: ref.lng, source: ref.source };

        const now = Date.now();
        if (now - _lastLocMarkerLogAt >= LOCAL_LOG_INTERVAL_MS) {
            _lastLocMarkerLogAt = now;
            if (log) log.info("idle_location_marker_rendered", {
                lat: ref.lat.toFixed(2), lng: ref.lng.toFixed(2), source: ref.source,
            });
        }
    }

    function _clearLocationMarker(map) {
        if (_locationMarkerLayer) { if (map) map.removeLayer(_locationMarkerLayer); _locationMarkerLayer = null; }
        state.locationMarker = null;
    }

    // ── Local Sweep ──────────────────────────────────────────────
    // On primary target change: show target → zoom out to 30mi radius → hold 5s → return.

    function _triggerLocalSweep(targetId) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map || !_canAnimate()) return;

        const now = Date.now();

        // Cooldown check
        if (state.localSweepLastAt && (now - state.localSweepLastAt) < IDLE_LOCAL_SWEEP_COOLDOWN_MS) {
            if (log) log.info("idle_local_sweep_skipped", { reason: "cooldown" });
            return;
        }

        // Already sweeping
        if (state.localSweepActive) {
            if (log) log.info("idle_local_sweep_skipped", { reason: "already_active" });
            return;
        }

        const ref = state.referencePoint || _getIdleReferencePoint();
        if (!ref) return;

        // Find target location
        const candidate = (state.candidates || []).find(c => c.id === targetId);
        const targetLat = candidate ? candidate.lat : null;
        const targetLng = candidate ? candidate.lng : null;

        // Skip sweep if target is effectively at home (within ~2mi)
        if (targetLat != null && targetLng != null) {
            const homeDist = _haversineMi(ref.lat, ref.lng, targetLat, targetLng);
            if (homeDist < 2) {
                if (log) log.info("idle_local_sweep_skipped", { reason: "target_at_home" });
                return;
            }
        }

        state.localSweepActive = true;
        state.localSweepLastAt = now;
        state.localSweepReturnTargetId = targetId;

        if (log) log.info("idle_local_sweep_started", {
            primaryTargetId: targetId ? String(targetId).slice(-12) : null,
            radiusMi: LOCAL_MARKER_RADIUS_MI,
        });

        // Dynamic context bounds: show just enough to keep home + target visible
        let sweepBounds;
        if (targetLat != null && targetLng != null) {
            sweepBounds = _getHomeTargetContextBounds(ref.lat, ref.lng, targetLat, targetLng, 0.35);
        } else {
            // Fallback: 30mi radius from home
            const radiusDeg = LOCAL_MARKER_RADIUS_MI / 69.0;
            sweepBounds = L.latLngBounds(
                [ref.lat - radiusDeg, ref.lng - radiusDeg],
                [ref.lat + radiusDeg, ref.lng + radiusDeg]
            );
        }

        if (log) log.info("idle_context_zoom_out_bounds", {
            targetId: targetId ? String(targetId).slice(-12) : null,
            includesHome: true,
            includesTarget: targetLat != null,
            method: targetLat != null ? "home_target" : "radius_fallback",
        });

        Camera.move({ source: "idle", bounds: sweepBounds, flyOptions: { padding: [40, 40], maxZoom: 12, duration: IDLE_SMOOTH_TRANSITION_SEC, easeLinearity: IDLE_SMOOTH_EASING }, reason: "idle_sweep" });

        // After hold, return to primary
        if (_localSweepTimer) clearTimeout(_localSweepTimer);
        _localSweepTimer = setTimeout(() => {
            _completeSweep(map);
        }, (IDLE_SMOOTH_TRANSITION_SEC * 1000) + IDLE_LOCAL_SWEEP_HOLD_MS);
    }

    function _completeSweep(map) {
        state.localSweepActive = false;
        const returnId = state.localSweepReturnTargetId;
        state.localSweepReturnTargetId = null;

        if (log) log.info("idle_local_sweep_completed", {
            primaryTargetId: returnId ? String(returnId).slice(-12) : null,
        });

        // Return to primary target using existing dispatch
        if (!_canAnimate() || state.mode !== "active") return;

        const candidate = (state.candidates || []).find(c => c.id === returnId);
        if (candidate && candidate.lat != null && candidate.lng != null) {
            const cat = candidate.category || "weather";
            const zoom = _getTargetZoom(null, cat, false);
            Camera.move({ source: "idle", center: [candidate.lat, candidate.lng], zoom, flyOptions: { duration: IDLE_SMOOTH_TRANSITION_SEC, easeLinearity: IDLE_SMOOTH_EASING }, reason: "idle_sweep_return" });
            if (log) log.info("idle_target_zoom_in_bounds", {
                targetId: returnId ? String(returnId).slice(-12) : null,
                radiusMi: 3,
                method: "sweep_return_flyTo",
            });
        }
    }

    function _cancelSweep() {
        if (_localSweepTimer) { clearTimeout(_localSweepTimer); _localSweepTimer = null; }
        state.localSweepActive = false;
        state.localSweepReturnTargetId = null;
    }

    // ── Master render: called after dispatch to update all map layers ──

    function _renderAllMapLayers() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map || state.mode !== "active") return;
        _renderSavedLocationMarkers(map);
        _renderGpsBlueDot(map);
        _fetchCommuteRoutes(); // async — non-blocking
        _fetchCommuteFlow();  // async — non-blocking, 5 min interval
        _renderCommuteRoutes(map);
        _applyFlowColoring(map);
        _renderCorridorDebug(map);
        _renderLocationMarker(map);
        _renderLocalMarkers();
    }

    function _clearAllMapLayers(map) {
        _clearFocusIndicator(map, "idle_exit");
        _clearLocalMarkers(map);
        _clearLocationMarker(map);
        // Do NOT clear saved location markers — they persist across modes
        // Do NOT clear commute routes — they persist across modes
        _clearGpsBlueDot(map);
        if (_corridorDebugLayer) { if (map) map.removeLayer(_corridorDebugLayer); _corridorDebugLayer = null; }
        _cancelSweep();
    }

    // Public: render saved-location markers (callable from app.js for cross-mode persistence)
    function renderSavedLocations() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (map) _renderSavedLocationMarkers(map);
    }

    function _cancelMotion() {
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        if (driftTimer) { clearTimeout(driftTimer); driftTimer = null; }
        _stopMicroDrift();
    }

    // ── Semantic Nodes ───────────────────────────────────────────

    function _buildPatrolNodes() {
        patrolNodes = [];
        const loc = StormState.state.location;
        if (!loc.lat || !loc.lon) return;
        patrolNodes.push({ lat: loc.lat, lon: loc.lon, zoom: 8, label: "Home area" });
        patrolNodes.push({ lat: loc.lat, lon: loc.lon, zoom: 7, label: "Local metro" });
        const alerts = StormState.state.alerts.data || [];
        const seen = new Set();
        for (const a of alerts.slice(0, 5)) {
            if (!a.polygon || seen.has(a.id)) continue;
            seen.add(a.id);
            try {
                const geo = JSON.parse(a.polygon);
                const layer = L.geoJSON(geo);
                const b = layer.getBounds();
                if (b.isValid()) {
                    const c = b.getCenter();
                    patrolNodes.push({ lat: c.lat, lon: c.lng, zoom: 7.5, label: "Alert area" });
                }
            } catch (e) { /* skip */ }
            if (patrolNodes.length >= 5) break;
        }
        patrolNodes.push({ lat: loc.lat, lon: loc.lon, zoom: 6.5, label: "Regional overview" });
    }

    function _buildRegionalScanNodes() {
        regionalScanNodes = [];
        const loc = StormState.state.location;
        if (!loc.lat || !loc.lon) return;
        // Ordered for smooth path (clockwise): N → E → S → W → overview
        regionalScanNodes.push({ lat: loc.lat + 1.0, lon: loc.lon, zoom: 7, label: "North" });
        regionalScanNodes.push({ lat: loc.lat + 0.5, lon: loc.lon + 1.0, zoom: 7, label: "NE" });
        regionalScanNodes.push({ lat: loc.lat - 0.5, lon: loc.lon + 1.0, zoom: 7, label: "SE" });
        regionalScanNodes.push({ lat: loc.lat - 1.0, lon: loc.lon, zoom: 7, label: "South" });
        regionalScanNodes.push({ lat: loc.lat - 0.5, lon: loc.lon - 1.0, zoom: 7, label: "SW" });
        regionalScanNodes.push({ lat: loc.lat + 0.5, lon: loc.lon - 1.0, zoom: 7, label: "NW" });
        regionalScanNodes.push({ lat: loc.lat, lon: loc.lon, zoom: 6, label: "Regional" });
    }

    // ── Info Model ───────────────────────────────────────────────

    // ── Category Display Labels ─────────────────────────────────

    const CATEGORY_CARD_LABELS = {
        weather:  "Storm activity nearby",
        traffic:  "Road issue nearby",
        air:      "Air quality",
        ambient:  "Current conditions",
    };

    // Display priority: lower index = higher priority
    const CATEGORY_DISPLAY_ORDER = ["weather", "traffic", "air", "ambient"];

    const TRAFFIC_DISPLAY_LABELS = {
        road_closure:       "Road closure",
        accident_report:    "Accident",
        construction_zone:  "Construction",
        weather_hazard:     "Road weather hazard",
        road_hazard:        "Road hazard",
    };

    // Part 4: Trust signals — human-readable reason for why this target is shown
    function _getTargetReason(candidate) {
        if (!candidate) return null;
        const dist = candidate.distanceMi;
        const cat = candidate.category;

        if (cat === "weather") {
            if (dist != null && dist <= 30) return "Closest activity";
            if (dist != null && dist <= 100) return "Most active nearby";
            return "Monitoring area";
        }
        if (cat === "traffic") {
            if (dist != null && dist <= 5) return "Near you";
            if (dist != null && dist <= 15) return "Closest issue";
            return "Nearby road issue";
        }
        if (cat === "air") return "Local air quality";
        if (cat === "ambient") return "Area conditions";
        return null;
    }

    const AIR_DISPLAY_BANDS = [
        { max: 50,       label: "Good" },
        { max: 100,      label: "Moderate" },
        { max: 150,      label: "Unhealthy for Sensitive Groups" },
        { max: 200,      label: "Unhealthy" },
        { max: 300,      label: "Very Unhealthy" },
        { max: Infinity, label: "Hazardous" },
    ];

    let _lastCardRenderLogAt = 0;
    const CARD_RENDER_LOG_INTERVAL_MS = 10000;

    // ── Context Strip: WHY + ETA + DIRECTION ────────────────────

    let _lastContextLogAt = 0;
    const CONTEXT_LOG_INTERVAL_MS = 15000;

    function _buildPrimaryReason(target, allCandidates) {
        if (!target) return "Monitoring area";
        const cat = target.category;
        const meta = target.metadata || {};
        const src = target.source || "";

        if (cat === "weather") {
            const evt = meta.event || "";
            if (evt === "Tornado Warning") return "Tornado warning \u2014 highest priority";
            if (evt === "Severe Thunderstorm Warning") return "Severe storm nearby";
            if (evt === "Flash Flood Warning" || evt === "Flood Warning") return "Flood warning active";
            if (evt.includes("Watch")) return "Watch area \u2014 conditions favorable";
            if (src.includes("reflectivity_core")) return "Strongest storm activity nearby";
            if (src.includes("precipitation_area")) return "Closest active rain area";
            if (meta.subtype === "recently_expired") return "Recently expired alert area";
            return "Weather activity detected";
        }
        if (cat === "traffic") {
            const adv = meta.advisoryType || "";
            const delay = meta.delay || 0;
            if (adv === "road_closure") return "Road closure \u2014 high impact";
            if (adv === "accident_report") return "Accident reported \u2014 potential delay";
            if (adv === "construction_zone" && delay > 0) return "Construction \u2014 delay " + Math.round(delay / 60) + " min";
            if (adv === "construction_zone") return "Construction zone nearby";
            return "Traffic incident nearby";
        }
        if (cat === "air") {
            const aqi = meta.aqi;
            if (aqi != null && aqi >= 100) return "Air quality alert \u2014 unhealthy conditions";
            if (aqi != null && aqi >= 50) return "Air quality moderate nearby";
            return "Local air quality update";
        }
        if (cat === "ambient") return "Current local conditions";
        return "Most relevant local event";
    }

    function _computeETA(target, ref) {
        if (!target || !ref) return null;
        if (target.category !== "weather") return null;

        // Attempt to extract motion from NWS description (if alert-derived)
        const meta = target.metadata || {};
        const desc = meta.description || "";

        // Pattern: "moving east at 35 mph" or "motion...25 kt"
        let speedMph = null;
        const mphMatch = desc.match(/(\d+)\s*mph/i);
        if (mphMatch) speedMph = parseInt(mphMatch[1]);
        if (!speedMph) {
            const ktMatch = desc.match(/(\d+)\s*kt/i);
            if (ktMatch) speedMph = Math.round(parseInt(ktMatch[1]) * 1.151);
        }

        if (!speedMph || speedMph < 1) return null;

        const dist = target.distanceMi;
        if (dist == null || dist < 0.5) return null;

        const eta = Math.round(dist / speedMph * 60);
        if (eta < 0 || eta > 60) return null;
        return eta;
    }

    function _getDirectionFromUser(target, ref) {
        if (!target || !ref) return null;
        if (target.lat == null || target.lng == null) return null;
        if (ref.lat == null || ref.lng == null) return null;

        const dLat = target.lat - ref.lat;
        const dLng = target.lng - ref.lng;
        if (Math.abs(dLat) < 0.005 && Math.abs(dLng) < 0.005) return null; // too close

        const angle = Math.atan2(dLng, dLat) * 180 / Math.PI; // 0=N, 90=E
        const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        const idx = Math.round(((angle + 360) % 360) / 45) % 8;
        return dirs[idx];
    }

    function _buildPrimaryContext(target, allCandidates) {
        if (!target) { state.primaryContext = null; return; }

        const ref = state.referencePoint || _getIdleReferencePoint();
        const reason = _buildPrimaryReason(target, allCandidates);
        const etaMinutes = _computeETA(target, ref);
        const direction = _getDirectionFromUser(target, ref);

        // Build single-line context string
        const icon = _resolveIcon(target);
        const parts = [reason];
        if (target.distanceMi != null && target.distanceMi > 0.5) {
            parts.push(Math.round(target.distanceMi) + " mi");
        }
        if (etaMinutes != null) {
            parts.push("arriving in ~" + etaMinutes + " min");
        }
        if (direction) {
            parts.push(direction + " of you");
        }
        const contextLine = icon + " " + parts.join(" \u00B7 ");

        state.primaryContext = { reason, etaMinutes, direction, contextLine };

        // Bounded log
        const now = Date.now();
        if (now - _lastContextLogAt >= CONTEXT_LOG_INTERVAL_MS) {
            _lastContextLogAt = now;
            if (log) log.info("idle_context_built", {
                targetId: target.id ? String(target.id).slice(-12) : null,
                reason,
                etaMinutes,
                direction,
            });
        }
    }

    // Build a clean, human-readable card from the active candidate
    function _buildCardContent(candidate) {
        if (!candidate) return null;

        const cat = candidate.category;
        let cardLabel = CATEGORY_CARD_LABELS[cat] || "Monitoring";
        let title = "";
        let summary = "";

        switch (cat) {
            case "weather": {
                title = candidate.title || "Weather activity";
                summary = candidate.summary || "";
                if (candidate.distanceMi != null && candidate.distanceMi > 0) {
                    summary += (summary ? " · " : "") + Math.round(candidate.distanceMi) + " mi away";
                }
                // More specific label for weather sub-types (useful for secondary differentiation)
                const src = candidate.source || "";
                if (src.includes("reflectivity_core")) cardLabel = "Storm activity nearby";
                else if (src.includes("precipitation_area")) cardLabel = "Rain area nearby";
                else if (src.includes("low_priority")) cardLabel = "Weather advisory";
                else if (src.includes("recently_expired")) cardLabel = "Recent weather";
                break;
            }
            case "traffic": {
                const meta = candidate.metadata || {};
                const typeLabel = TRAFFIC_DISPLAY_LABELS[meta.advisoryType] || "Traffic incident";
                const road = meta.roadName || "";
                title = road ? typeLabel + " on " + road : typeLabel;

                const parts = [];
                if (candidate.distanceMi != null) parts.push(Math.round(candidate.distanceMi) + " mi");
                if (meta.delay && meta.delay > 0) parts.push(Math.round(meta.delay / 60) + " min delay");
                if (meta.lengthMeters && meta.lengthMeters > 100) parts.push((meta.lengthMeters / 1609.34).toFixed(1) + " mi affected");
                summary = parts.join(" · ");
                break;
            }
            case "air": {
                const meta = candidate.metadata || {};
                const aqi = meta.aqi;
                let band = "Unknown";
                if (aqi != null) {
                    for (const b of AIR_DISPLAY_BANDS) {
                        if (aqi <= b.max) { band = b.label; break; }
                    }
                }
                title = "AQI " + (aqi != null ? Math.round(aqi) : "—") + " · " + band;
                const parts = [];
                if (meta.pm25 != null) parts.push("PM2.5 " + meta.pm25.toFixed(1));
                if (meta.ozone != null) parts.push("Ozone " + meta.ozone.toFixed(0));
                summary = parts.join(" · ");
                break;
            }
            case "ambient": {
                title = candidate.title || "Quiet conditions";
                summary = candidate.summary || "No significant activity nearby";
                break;
            }
            default: {
                title = candidate.title || "Monitoring";
                summary = candidate.summary || "";
            }
        }

        const reason = _getTargetReason(candidate);
        return { cardLabel, title, summary, category: cat, reason };
    }

    // ── Secondary Card Selection ─────────────────────────────────
    // Picks up to 2 compact secondary cards that add distinct value.
    // Quality over quantity: 0 or 1 secondary is fine if 2 would be redundant.

    const SECONDARY_MAX = 2;
    const SECONDARY_MIN_SCORE = 15;
    const SECONDARY_VALUE_DELTA_MIN = 15;       // min score gap from primary to justify showing
    const SECONDARY_SAME_CAT_DISTANCE_MI = 25;  // min spatial separation for same-category cards
    let _lastSecondaryLogAt = 0;
    let _lastSecondaryRejectLogAt = 0;
    const SECONDARY_LOG_INTERVAL_MS = 15000;

    function _buildSecondaryCards() {
        const candidates = state.candidates || [];
        const primaryId = state.activeTargetId;
        const primaryCat = state.activeCategory;
        if (!primaryId || candidates.length < 2) { state.secondaryTargets = []; return; }

        const primary = candidates.find(c => c.id === primaryId);
        const primaryScore = primary ? primary.score : 0;
        const primaryDist = primary ? (primary.distanceMi || 0) : 0;
        const primarySource = primary ? (primary.source || "") : "";
        const rejections = {};

        // Eligible: not the primary, meets min score, within radius
        const eligible = candidates.filter(c => {
            if (c.id === primaryId) return false;
            if (c.score < SECONDARY_MIN_SCORE) {
                rejections.low_score = (rejections.low_score || 0) + 1;
                return false;
            }
            const pol = CATEGORY_POLICY[c.category];
            if (pol && c.distanceMi != null && c.distanceMi > pol.localRadiusMi) {
                rejections.outside_radius = (rejections.outside_radius || 0) + 1;
                return false;
            }
            return true;
        });

        if (eligible.length === 0) { state.secondaryTargets = []; _logSecondaryRejections(rejections); return; }

        eligible.sort((a, b) => b.score - a.score);

        const picked = [];
        const pickedCats = new Set();

        for (const c of eligible) {
            if (picked.length >= SECONDARY_MAX) break;

            // Part 2: Value delta — reject if too close in score to primary (redundant feel)
            if (c.category === primaryCat && Math.abs(primaryScore - c.score) < SECONDARY_VALUE_DELTA_MIN) {
                rejections.low_value_delta = (rejections.low_value_delta || 0) + 1;
                continue;
            }

            // Part 1 + 4: Same-category suppression
            if (c.category === primaryCat) {
                const validSameCat = _isMeaningfullySameCategory(c, primary);
                if (!validSameCat) {
                    rejections.duplicate_category = (rejections.duplicate_category || 0) + 1;
                    continue;
                }
            }

            // Also check against already-picked secondaries for diversity
            if (pickedCats.has(c.category)) {
                // Already have one of this category — suppress unless truly different
                const existingPick = picked.find(p => p.category === c.category);
                if (existingPick) {
                    const dist = _candidateDistance(c, existingPick);
                    if (dist < SECONDARY_SAME_CAT_DISTANCE_MI) {
                        rejections.same_cluster = (rejections.same_cluster || 0) + 1;
                        continue;
                    }
                }
            }

            picked.push(c);
            pickedCats.add(c.category);
        }

        // Part 3: Don't force 2 — quality over quantity
        // (no second pass to fill remaining slots with lower-quality same-category cards)

        state.secondaryTargets = picked.map(c => {
            const card = _buildCardContent(c);
            return card ? { ...card, id: c.id, score: c.score } : null;
        }).filter(Boolean);

        _logSecondaryRejections(rejections);

        // Selection log
        const now = Date.now();
        if (now - _lastSecondaryLogAt >= SECONDARY_LOG_INTERVAL_MS) {
            _lastSecondaryLogAt = now;
            if (log) log.info("idle_secondary_selection", {
                primary: primaryCat,
                secondaryIds: state.secondaryTargets.map(s => s.category + ":" + (s.id ? String(s.id).slice(-12) : "?")),
                rejected: Object.keys(rejections).length > 0 ? rejections : undefined,
            });
        }
    }

    // Part 1: Is a same-category candidate meaningfully different from primary?
    function _isMeaningfullySameCategory(candidate, primary) {
        if (!candidate || !primary) return false;

        if (candidate.category === "weather") {
            // Different phenomenon? (e.g. reflectivity_core vs precipitation_area)
            const cSource = candidate.source || "";
            const pSource = primary.source || "";
            const differentPhenomenon = cSource !== pSource;

            // Spatial separation
            const dist = _candidateDistance(candidate, primary);
            const spatiallyDistinct = dist > SECONDARY_SAME_CAT_DISTANCE_MI;

            // Clearly different severity
            const severityDiff = candidate.severity !== primary.severity;

            // Allow if: different phenomenon AND spatially separated, OR clearly different severity
            if (differentPhenomenon && spatiallyDistinct) return true;
            if (severityDiff) return true;
            return false;
        }

        if (candidate.category === "traffic") {
            // Different road / different type
            const cRoad = (candidate.metadata && candidate.metadata.roadName) || "";
            const pRoad = (primary.metadata && primary.metadata.roadName) || "";
            if (cRoad && pRoad && cRoad.toLowerCase() === pRoad.toLowerCase()) return false;

            const dist = _candidateDistance(candidate, primary);
            if (dist < 5) return false; // same area
            return true;
        }

        // Other categories: don't allow same-category duplication
        return false;
    }

    // Distance between two candidates (miles)
    function _candidateDistance(a, b) {
        if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
            return _haversineMi(a.lat, a.lng, b.lat, b.lng);
        }
        // Fallback: use distanceMi difference as rough proxy
        if (a.distanceMi != null && b.distanceMi != null) {
            return Math.abs(a.distanceMi - b.distanceMi);
        }
        return 0;
    }

    function _logSecondaryRejections(rejections) {
        if (Object.keys(rejections).length === 0) return;
        const now = Date.now();
        if (now - _lastSecondaryRejectLogAt < SECONDARY_LOG_INTERVAL_MS) return;
        _lastSecondaryRejectLogAt = now;
        if (log) log.info("idle_secondary_rejected", rejections);
    }

    function _updateInfoModel() {
        const alerts = StormState.state.alerts.data || [];
        const now = Date.now();
        const recent1h = alerts.filter(a => a.effective && (now - new Date(a.effective).getTime()) < RECENT_ALERT_WINDOW_MS);

        let nearestWarning = null;
        for (const a of alerts) {
            if (a.event && a.event.includes("Warning") && a.distance_mi != null) {
                if (!nearestWarning || a.distance_mi < nearestWarning.distance_mi) nearestWarning = a;
            }
        }
        const nearestText = nearestWarning
            ? `Nearest warning: ${nearestWarning.event} (${Math.round(nearestWarning.distance_mi)} mi)`
            : null;

        // Submode labels (for non-category-driven paths / fallback)
        const submodeLabels = {
            LOW_PRIORITY_FOCUS: "Monitoring advisory", RECENT_HISTORY_SWEEP: "Reviewing recent activity",
            ENVIRONMENTAL_FOCUS: "Observing weather feature", PATROL: "Scanning region",
            REGIONAL_SCAN: "Regional scan", AMBIENT_DRIFT: "Ambient monitoring",
        };

        // Category-aware card: find the active candidate
        let cardContent = null;
        let activeCand = null;
        if (state.activeCategory && state.activeTargetId) {
            activeCand = (state.candidates || []).find(c => c.id === state.activeTargetId) || null;
            if (activeCand) {
                cardContent = _buildCardContent(activeCand);
            }
        }

        // Fallback: old-style target label from alerts
        let targetLabel = null;
        if (!cardContent && state.idleTargetId) {
            const a = alerts.find(x => x.id === state.idleTargetId);
            if (a) targetLabel = a.event + (a.headline ? " — " + a.headline.slice(0, 40) : "");
        }

        // Environmental feature context (secondary line)
        let envFeatureText = null;
        if (state.submode === "ENVIRONMENTAL_FOCUS" && state.idleTargetId) {
            const envTargets = _getEnvironmentalTargets();
            const active = envTargets.find(t => t.id === state.idleTargetId);
            if (active) envFeatureText = active.label;
        } else {
            const envTargets = _getEnvironmentalTargets();
            if (envTargets.length > 0) envFeatureText = envTargets[0].label;
        }

        infoModel = {
            quietMode: true,
            statusLabel: state.dataStale ? "Data stale — holding view" : "No severe alerts nearby",
            submodeLabel: cardContent ? cardContent.cardLabel : (submodeLabels[state.submode] || "Monitoring"),
            targetLabel: cardContent ? cardContent.title : targetLabel,
            summaryLine1: cardContent ? cardContent.summary : (recent1h.length > 0 ? `${recent1h.length} alert(s) in last hour` : "No recent alerts"),
            summaryLine2: `${alerts.length} total active`,
            recentActivityCount1h: recent1h.length,
            nearestRecentWarningText: nearestText,
            localRiskBadge: null,
            nearestInterestingFeature: envFeatureText,
            // Category card metadata
            cardCategory: cardContent ? cardContent.category : null,
            cardLabel: cardContent ? cardContent.cardLabel : null,
            cardReason: cardContent ? cardContent.reason : null,
            // Secondary cards
            secondaryCards: [],
            // Context strip
            contextLine: state.primaryContext ? state.primaryContext.contextLine : null,
        };

        // Build context for primary target (only recompute on target change)
        const ctxTargetId = state.primaryContext ? state.primaryContext._targetId : null;
        if (activeCand && ctxTargetId !== activeCand.id) {
            _buildPrimaryContext(activeCand, state.candidates || []);
            if (state.primaryContext) state.primaryContext._targetId = activeCand.id;
            infoModel.contextLine = state.primaryContext ? state.primaryContext.contextLine : null;
        }

        // Build secondary cards after infoModel is set (needs primary to be resolved)
        _buildSecondaryCards();
        infoModel.secondaryCards = state.secondaryTargets.slice(0, SECONDARY_MAX);
    }

    // ── UI ────────────────────────────────────────────────────────

    function _renderIdleUI() {
        const strip = document.getElementById("idle-info-strip");
        if (!strip) return;
        if (state.mode !== "active") {
            strip.classList.add("hidden");
            return;
        }

        const m = infoModel;
        const ctx = m.nearestInterestingFeature || m.nearestRecentWarningText || m.summaryLine2;

        strip.classList.remove("hidden");

        // Primary card with context strip
        const catClass = m.cardCategory ? " idle-cat-" + m.cardCategory : "";
        let html = `
            <div class="idle-primary-card">
                ${m.contextLine ? `<div class="idle-context-strip">${_esc(m.contextLine)}</div>` : ""}
                <div class="idle-card-label${catClass}">${_esc(m.submodeLabel)}</div>
                ${m.targetLabel ? `<div class="idle-card-title">${_esc(m.targetLabel)}</div>` : ""}
                ${m.summaryLine1 ? `<div class="idle-card-summary">${_esc(m.summaryLine1)}</div>` : ""}
            </div>
        `;

        // Secondary cards (compact)
        const secs = m.secondaryCards || [];
        if (secs.length > 0) {
            html += `<div class="idle-secondary-cards">`;
            for (const sc of secs) {
                const sCatClass = sc.category ? " idle-cat-" + sc.category : "";
                html += `
                    <div class="idle-secondary-card">
                        <span class="idle-sec-label${sCatClass}">${_esc(sc.cardLabel)}</span>
                        <span class="idle-sec-title">${_esc(sc.title)}</span>
                    </div>
                `;
            }
            html += `</div>`;
        }

        strip.innerHTML = html;

        // Bounded card render log
        const now = Date.now();
        if (now - _lastCardRenderLogAt >= CARD_RENDER_LOG_INTERVAL_MS) {
            _lastCardRenderLogAt = now;
            if (log) log.info("idle_card_rendered", {
                category: m.cardCategory || state.submode,
                title: (m.targetLabel || "").slice(0, 60),
                summary: (m.summaryLine1 || "").slice(0, 60),
                secondaryCount: secs.length,
            });
        }
    }

    function _esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    // ══════════════════════════════════════════════════════════════
    // IDLE INTELLIGENCE ENGINE (V1)
    // Deterministic signal→attention→target→camera pipeline
    // ══════════════════════════════════════════════════════════════

    const INTEL_CYCLE_MS = 10000;      // decision cycle interval
    const INTEL_DEBOUNCE_CYCLES = 2;   // require N stable cycles before attention change
    const INTEL_TARGET_HOLD_MS = 30000;
    const INTEL_CAMERA_THROTTLE_MS = 5000;
    const INTEL_STALE_ALERT_MS = 3600000; // ignore alerts > 60 min old

    const _intelState = {
        mode: "idle",
        attentionLevel: "normal",
        signals: { tornado: false, severe: false, alertCount: 0, nearestDistanceMi: null, routeThreat: false },
        focusTarget: { type: null, id: null, lat: null, lng: null },
        timers: { lastDecisionTs: 0, lastCameraMoveTs: 0 },
        // Debounce
        _pendingAttention: null,
        _pendingAttentionCycles: 0,
        _currentTargetSetAt: 0,
    };

    // Expose as window global for external read access
    window.IdleIntelState = _intelState;

    let _intelTimer = null;
    let _lastIntelLogAt = 0;
    const INTEL_LOG_INTERVAL_MS = 15000;

    // ── Signal Extraction ────────────────────────────────────────

    function _computeSignals(alerts) {
        const sl = state.savedLocations;
        const home = sl.home;
        const now = Date.now();

        const signals = { tornado: false, severe: false, alertCount: 0, nearestDistanceMi: Infinity, routeThreat: false };

        for (const a of alerts) {
            if (!a || !a.event) continue;

            // Stale guard
            if (a.effective) {
                const age = now - new Date(a.effective).getTime();
                if (age > INTEL_STALE_ALERT_MS) continue;
            }

            // Tornado
            if (a.event === "Tornado Warning") signals.tornado = true;

            // Severe
            if (a.event === "Severe Thunderstorm Warning") signals.severe = true;

            // Count alerts in zone
            if (_isAlertInZone(a)) signals.alertCount++;

            // Nearest distance
            if (a.distance_mi != null && a.distance_mi < signals.nearestDistanceMi) {
                signals.nearestDistanceMi = a.distance_mi;
            }

            // Route threat: check if alert polygon intersects route buffer
            if (a.polygon) {
                try {
                    const geo = JSON.parse(a.polygon);
                    const layer = L.geoJSON(geo);
                    const bounds = layer.getBounds();
                    if (bounds.isValid()) {
                        const c = bounds.getCenter();
                        if (_isNearHighlightedRoute(c.lat, c.lng, COMMUTE_ROUTE_NEAR_MI)) {
                            signals.routeThreat = true;
                        }
                    }
                } catch (e) { /* skip */ }
            }
        }

        if (signals.nearestDistanceMi === Infinity) signals.nearestDistanceMi = null;
        return signals;
    }

    function _isAlertInZone(alert) {
        if (!alert) return false;
        // Use pre-computed distance or centroid
        if (alert.distance_mi != null && alert.distance_mi <= 30) return true;
        if (alert.polygon) {
            try {
                const geo = JSON.parse(alert.polygon);
                const layer = L.geoJSON(geo);
                const bounds = layer.getBounds();
                if (bounds.isValid()) {
                    const c = bounds.getCenter();
                    return _isWithinLocalAwarenessZone(c.lat, c.lng);
                }
            } catch (e) { /* skip */ }
        }
        return false;
    }

    // ── Attention Model ──────────────────────────────────────────

    function _computeAttention(signals) {
        if (signals.tornado) return "critical";
        if (signals.severe && signals.nearestDistanceMi != null && signals.nearestDistanceMi <= 20) return "elevated";
        if (signals.alertCount >= 3) return "elevated";
        return "normal";
    }

    // ── Focus Target Selection ───────────────────────────────────

    function _selectFocusTarget(alerts, signals) {
        const now = Date.now();
        const sl = state.savedLocations;

        // Priority 1: Closest Tornado Warning
        if (signals.tornado) {
            const tor = alerts.filter(a => a.event === "Tornado Warning" && a.distance_mi != null)
                .sort((a, b) => a.distance_mi - b.distance_mi);
            if (tor.length > 0) {
                const t = tor[0];
                const geo = _getAlertCentroid(t);
                if (geo) return { type: "alert", id: t.id, lat: geo.lat, lng: geo.lng, event: t.event };
            }
        }

        // Priority 2: Closest Severe Warning within 30mi
        if (signals.severe) {
            const svr = alerts.filter(a => a.event === "Severe Thunderstorm Warning" && a.distance_mi != null && a.distance_mi <= 30)
                .sort((a, b) => a.distance_mi - b.distance_mi);
            if (svr.length > 0) {
                const t = svr[0];
                const geo = _getAlertCentroid(t);
                if (geo) return { type: "alert", id: t.id, lat: geo.lat, lng: geo.lng, event: t.event };
            }
        }

        // Priority 3: Route threat
        if (signals.routeThreat) {
            for (const a of alerts) {
                if (!a.polygon) continue;
                const geo = _getAlertCentroid(a);
                if (geo && _isNearHighlightedRoute(geo.lat, geo.lng, COMMUTE_ROUTE_NEAR_MI)) {
                    return { type: "route", id: a.id, lat: geo.lat, lng: geo.lng, event: a.event };
                }
            }
        }

        // Priority 4: Home fallback
        if (sl.home && sl.home.lat != null) {
            return { type: "home", id: "home", lat: sl.home.lat, lng: sl.home.lng, event: null };
        }

        return { type: null, id: null, lat: null, lng: null, event: null };
    }

    function _getAlertCentroid(alert) {
        if (!alert || !alert.polygon) return null;
        try {
            const geo = JSON.parse(alert.polygon);
            const layer = L.geoJSON(geo);
            const bounds = layer.getBounds();
            if (bounds.isValid()) {
                const c = bounds.getCenter();
                return { lat: c.lat, lng: c.lng };
            }
        } catch (e) {}
        return null;
    }

    // ── Decision Engine ──────────────────────────────────────────

    function _runIntelDecisionCycle() {
        if (state.mode !== "active") return;
        const now = Date.now();
        const alerts = StormState.state.alerts.data || [];

        // 1. Compute signals
        const signals = _computeSignals(alerts);
        _intelState.signals = signals;

        // 2. Compute attention with debounce
        const rawAttention = _computeAttention(signals);
        if (rawAttention !== _intelState.attentionLevel) {
            if (_intelState._pendingAttention === rawAttention) {
                _intelState._pendingAttentionCycles++;
            } else {
                _intelState._pendingAttention = rawAttention;
                _intelState._pendingAttentionCycles = 1;
            }
            // Require INTEL_DEBOUNCE_CYCLES stable before changing (except critical — immediate)
            if (_intelState._pendingAttentionCycles >= INTEL_DEBOUNCE_CYCLES || rawAttention === "critical") {
                const prev = _intelState.attentionLevel;
                _intelState.attentionLevel = rawAttention;
                _intelState._pendingAttention = null;
                _intelState._pendingAttentionCycles = 0;
                if (now - _lastIntelLogAt >= INTEL_LOG_INTERVAL_MS) {
                    _lastIntelLogAt = now;
                    if (log) log.info("idle_attention_change", { from: prev, to: rawAttention, alertCount: signals.alertCount });
                }
            }
        } else {
            _intelState._pendingAttention = null;
            _intelState._pendingAttentionCycles = 0;
        }

        // 3. Select focus target with stickiness
        const newTarget = _selectFocusTarget(alerts, signals);
        const currentTarget = _intelState.focusTarget;
        const targetAge = now - _intelState._currentTargetSetAt;

        const shouldSwitch =
            newTarget.id !== currentTarget.id &&
            (targetAge >= INTEL_TARGET_HOLD_MS || _isHigherPriority(newTarget, currentTarget));

        if (shouldSwitch && newTarget.type) {
            const prevId = currentTarget.id;
            _intelState.focusTarget = newTarget;
            _intelState._currentTargetSetAt = now;
            if (now - _lastIntelLogAt >= INTEL_LOG_INTERVAL_MS) {
                _lastIntelLogAt = now;
                if (log) log.info("idle_target_change", {
                    from: prevId, to: newTarget.id,
                    type: newTarget.type, event: newTarget.event,
                });
            }
        }

        _intelState.timers.lastDecisionTs = now;

        // 4. Execute camera behavior
        _executeIntelCamera(now);

        // Decision log (bounded)
        if (now - _lastIntelLogAt >= INTEL_LOG_INTERVAL_MS) {
            _lastIntelLogAt = now;
            if (log) log.info("idle_decision", {
                attentionLevel: _intelState.attentionLevel,
                targetType: _intelState.focusTarget.type,
                targetId: _intelState.focusTarget.id ? String(_intelState.focusTarget.id).slice(-12) : null,
                alertCount: signals.alertCount,
                nearest: signals.nearestDistanceMi,
                routeThreat: signals.routeThreat,
            });
        }
    }

    function _isHigherPriority(newTarget, currentTarget) {
        const PRIO = { alert: 3, route: 2, home: 1 };
        return (PRIO[newTarget.type] || 0) > (PRIO[currentTarget.type] || 0);
    }

    // ── Camera Behavior Engine ───────────────────────────────────

    function _executeIntelCamera(now) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map || !_canAnimate()) return;

        // Throttle
        if (now - _intelState.timers.lastCameraMoveTs < INTEL_CAMERA_THROTTLE_MS) return;

        const target = _intelState.focusTarget;
        const attention = _intelState.attentionLevel;

        if (attention === "critical" && target.lat != null) {
            // Lock to target, high zoom
            const zoom = Math.max(10, Math.min(12, map.getZoom()));
            Camera.move({ source: "idle", center: [target.lat, target.lng], zoom, flyOptions: { duration: 2.0, easeLinearity: 0.2 }, reason: "idle_intel_critical" });
            _intelState.timers.lastCameraMoveTs = now;
            if (log) log.info("idle_camera_move", { attention, type: target.type, zoom, mode: "lock" });
            return;
        }

        if (attention === "elevated" && target.lat != null) {
            // Bias toward target, moderate zoom
            const zoom = Math.max(8, Math.min(10, map.getZoom()));
            Camera.move({ source: "idle", center: [target.lat, target.lng], zoom, flyOptions: { duration: 3.0, easeLinearity: 0.15 }, reason: "idle_intel_elevated" });
            _intelState.timers.lastCameraMoveTs = now;
            if (log) log.info("idle_camera_move", { attention, type: target.type, zoom, mode: "bias" });
            return;
        }

        // Normal: existing idle behavior handles camera
        // (no override — let existing patrol/drift/focus continue)
    }

    // ── Integration: Hook into eval loop ─────────────────────────

    function _startIntelEngine() {
        if (_intelTimer) clearInterval(_intelTimer);
        _intelTimer = setInterval(_runIntelDecisionCycle, INTEL_CYCLE_MS);
    }

    function _stopIntelEngine() {
        if (_intelTimer) { clearInterval(_intelTimer); _intelTimer = null; }
        _intelState.attentionLevel = "normal";
        _intelState.focusTarget = { type: null, id: null, lat: null, lng: null, event: null };
    }

    // Wire into entry/exit
    const _origEnter = _enter;
    const _origExit = _exit;

    // Patch _enter to start intel engine
    // (Can't reassign const, so hook via the eval loop instead)

    function getState() {
        return {
            ...state,
            intel: { ..._intelState, signals: { ..._intelState.signals }, focusTarget: { ..._intelState.focusTarget } },
        };
    }
    function getInfoModel() { return { ...infoModel }; }

    function destroy() {
        if (evalTimer) clearInterval(evalTimer);
        _stopIntelEngine();
        _releaseCamera();
        state.mode = "inactive";
    }

    return { init, getState, getInfoModel, destroy, setSavedLocation, renderSavedLocations, enterPinMode: _enterLocationPickMode };
})();
