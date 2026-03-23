/**
 * Storm Tracker — Unified Target Normalization Layer (Phase 2, Hardened)
 *
 * Produces UnifiedTarget objects by combining:
 * - NWS alert data (always present)
 * - Storm Alert motion data (when available from detection engine)
 *
 * Matching strategy (ordered by reliability):
 * 1. Primary: source nws_alert_id (exact match)
 * 2. Fallback: centroid proximity + event type compatibility
 * 3. Ambiguity rejection: if multiple proximity candidates are too close in
 *    distance, reject the match rather than guess
 *
 * When no match is found, falls back to NWS-only behavior (Phase 1 identical).
 */
const UnifiedTarget = (function () {

    // ── Matching thresholds ───────────────────────────────────────────
    const MATCH_RADIUS_MI = 50;        // max distance for centroid matching
    const AMBIGUITY_MARGIN_MI = 5;     // if 2nd-best is within this of best, reject

    // Event type compatibility groups for centroid fallback matching
    const EVENT_GROUPS = {
        "Tornado Warning": "severe",
        "Severe Thunderstorm Warning": "severe",
        "Tornado Watch": "watch",
        "Flash Flood Warning": "flood",
        "Flood Warning": "flood",
        "Winter Storm Warning": "winter",
        "Winter Weather Advisory": "winter",
    };

    // Storm alert type → NWS event group compatibility
    const STORM_TYPE_GROUPS = {
        "storm_proximity": ["severe", "flood"],
        "strong_storm": ["severe"],
        "rotation": ["severe"],
        "debris_signature": ["severe"],
    };

    // ── Motion data gating thresholds ──────────────────────────────────
    const MIN_MOTION_CONFIDENCE = 0.3;
    const MIN_SPEED_MPH = 2;

    // ── Internal state ────────────────────────────────────────────────
    let stormAlerts = [];
    let lastFetchTime = 0;
    // Per-eval stats (reset each buildTargets call)
    let bridgeStats = { matched: 0, unmatched: 0, mismatches: [],
                        byMethod: { source_id: 0, centroid: 0, none: 0 } };
    // Session stats (accumulate across entire autotrack session, reset on resetSession)
    let sessionStats = newSessionStats();

    function newSessionStats() {
        return {
            startTime: Date.now(),
            evalCount: 0,
            source_id: 0,
            centroid: 0,
            ambiguous_rejected: 0,
            unmatched: 0,
            total_alerts_scored: 0,
        };
    }

    // ── Public: build unified targets from NWS alerts ─────────────────

    function buildTargets(nwsAlerts) {
        bridgeStats = { matched: 0, unmatched: 0, mismatches: [],
                        byMethod: { source_id: 0, centroid: 0, none: 0 } };

        const targets = nwsAlerts.map(nws => {
            const match = findMotionMatch(nws);
            return createUnified(nws, match);
        });

        // Accumulate session stats
        sessionStats.evalCount++;
        sessionStats.source_id += bridgeStats.byMethod.source_id;
        sessionStats.centroid += bridgeStats.byMethod.centroid;
        sessionStats.unmatched += bridgeStats.byMethod.none;
        sessionStats.total_alerts_scored += nwsAlerts.length;

        return targets;
    }

    function setStormAlerts(alerts) {
        stormAlerts = alerts || [];
        lastFetchTime = Date.now();
    }

    function getStormAlerts() {
        return stormAlerts;
    }

    function resetSession() {
        sessionStats = newSessionStats();
    }

    function getSessionStats() {
        return {
            ...sessionStats,
            durationSec: Math.round((Date.now() - sessionStats.startTime) / 1000),
        };
    }

    function getBridgeStats() {
        return {
            ...bridgeStats,
            stormAlertCount: stormAlerts.length,
            cacheAge: lastFetchTime ? Math.round((Date.now() - lastFetchTime) / 1000) : null,
        };
    }

    // ── Three-tier matching engine ────────────────────────────────────

    function findMotionMatch(nwsAlert) {
        if (stormAlerts.length === 0) {
            bridgeStats.unmatched++;
            bridgeStats.byMethod.none++;
            return null;
        }

        // ── Tier 1: match by source nws_alert_id (exact) ──
        const idMatch = findBySourceId(nwsAlert);
        if (idMatch) {
            bridgeStats.matched++;
            bridgeStats.byMethod.source_id++;
            return idMatch;
        }

        // ── Tier 2: match by centroid proximity + event compatibility ──
        const centroidMatch = findByCentroid(nwsAlert);
        if (centroidMatch) {
            bridgeStats.matched++;
            bridgeStats.byMethod.centroid++;
            return centroidMatch;
        }

        // ── No match ──
        bridgeStats.unmatched++;
        bridgeStats.byMethod.none++;
        return null;
    }

    /**
     * Tier 1: Exact match on nws_alert_id.
     * Storm alerts carry nws_alert_id from the detection pipeline.
     * This is the most reliable match — no ambiguity possible.
     */
    function findBySourceId(nwsAlert) {
        const nwsId = nwsAlert.id;
        if (!nwsId) return null;

        for (const sa of stormAlerts) {
            if (sa.nws_alert_id && sa.nws_alert_id === nwsId) {
                return {
                    stormAlert: sa,
                    matchMethod: "source_id",
                    matchDistance: 0,
                };
            }
        }
        return null;
    }

    /**
     * Tier 2: Centroid proximity matching with event type compatibility
     * and ambiguity rejection.
     *
     * Rules:
     * - Must be within MATCH_RADIUS_MI (50mi)
     * - Must have compatible event type group
     * - If two candidates are within AMBIGUITY_MARGIN_MI (5mi) of each other,
     *   reject the match (ambiguous — can't determine which is correct)
     */
    function findByCentroid(nwsAlert) {
        const nwsCentroid = computeAlertCentroid(nwsAlert);
        if (!nwsCentroid) {
            logMismatch(nwsAlert, "no_centroid");
            return null;
        }

        const nwsGroup = EVENT_GROUPS[nwsAlert.event] || null;

        // Score all compatible storm alerts by distance
        const candidates = [];
        for (const sa of stormAlerts) {
            if (!sa.lat || !sa.lon) continue;

            // Check event type compatibility
            const saGroups = STORM_TYPE_GROUPS[sa.type] || [];
            if (nwsGroup && saGroups.length > 0 && !saGroups.includes(nwsGroup)) continue;

            const dist = haversineMi(nwsCentroid.lat, nwsCentroid.lon, sa.lat, sa.lon);
            if (dist <= MATCH_RADIUS_MI) {
                candidates.push({ stormAlert: sa, distance: dist });
            }
        }

        if (candidates.length === 0) {
            logMismatch(nwsAlert, "no_proximity_match");
            return null;
        }

        // Sort by distance ascending
        candidates.sort((a, b) => a.distance - b.distance);

        // Ambiguity check: if 2nd-best is too close to best, reject
        if (candidates.length >= 2) {
            const bestDist = candidates[0].distance;
            const secondDist = candidates[1].distance;
            if (secondDist - bestDist < AMBIGUITY_MARGIN_MI) {
                logMismatch(nwsAlert, `ambiguous: best=${bestDist.toFixed(1)}mi, 2nd=${secondDist.toFixed(1)}mi`);
                sessionStats.ambiguous_rejected++;
                return null;
            }
        }

        return {
            stormAlert: candidates[0].stormAlert,
            matchMethod: "centroid",
            matchDistance: Math.round(candidates[0].distance * 10) / 10,
        };
    }

    function logMismatch(nwsAlert, reason) {
        bridgeStats.mismatches.push({
            nwsId: nwsAlert.id ? nwsAlert.id.slice(-12) : "?",
            event: nwsAlert.event,
            reason,
        });
        if (bridgeStats.mismatches.length > 10) bridgeStats.mismatches.shift();
    }

    function computeAlertCentroid(nwsAlert) {
        if (nwsAlert.polygon) {
            try {
                const geojson = JSON.parse(nwsAlert.polygon);
                const layer = L.geoJSON(geojson);
                const b = layer.getBounds();
                if (b.isValid()) {
                    const c = b.getCenter();
                    return { lat: c.lat, lon: c.lng };
                }
            } catch (e) { /* fall through */ }
        }
        return null;
    }

    // ── UnifiedTarget factory ─────────────────────────────────────────

    function createUnified(nws, motionMatch) {
        const target = {
            // ── NWS core (always present) ──
            id: nws.id,
            event: nws.event,
            severity: nws.severity,
            urgency: nws.urgency,
            certainty: nws.certainty,
            category: nws.category,
            headline: nws.headline,
            polygon: nws.polygon,
            onset: nws.onset,
            expires: nws.expires,
            issued: nws.issued,
            priority_score: nws.priority_score,
            county_fips: nws.county_fips,
            distance_mi: nws.distance_mi,

            // ── Motion data (from storm alert, gated) ──
            hasMotion: false,
            motion: null,

            // ── Path projection (from storm alert, gated) ──
            hasProjection: false,
            projection: null,

            // ── Bridge metadata ──
            bridgeMatch: motionMatch ? {
                stormAlertId: motionMatch.stormAlert.alert_id,
                nwsAlertId: motionMatch.stormAlert.nws_alert_id || null,
                matchMethod: motionMatch.matchMethod,
                matchDistance: motionMatch.matchDistance,
                stormType: motionMatch.stormAlert.type,
            } : null,
        };

        // Enrich with motion data if matched and gated
        if (motionMatch) {
            const sa = motionMatch.stormAlert;
            const mc = sa.motion_confidence || 0;
            const speed = sa.speed_mph || 0;

            if (mc >= MIN_MOTION_CONFIDENCE && speed >= MIN_SPEED_MPH) {
                target.hasMotion = true;
                target.motion = {
                    speed_mph: sa.speed_mph,
                    heading_deg: sa.heading_deg,
                    trend: sa.trend || "unknown",
                    eta_min: sa.eta_min,
                    motion_confidence: mc,
                    track_confidence: sa.track_confidence || 0,
                    trend_confidence: sa.trend_confidence || 0,
                    impact: sa.impact || "uncertain",
                    impact_description: sa.impact_description || "",
                    cpa_distance_mi: sa.cpa_distance_mi,
                    time_to_cpa_min: sa.time_to_cpa_min,
                    intensity_trend: sa.intensity_trend || "unknown",
                };
            }

            // Projection requires motion + predicted position
            const predLat = sa.predicted_lat || 0;
            const predLon = sa.predicted_lon || 0;
            if (target.hasMotion && predLat !== 0 && predLon !== 0) {
                target.hasProjection = true;
                target.projection = {
                    predicted_lat: predLat,
                    predicted_lon: predLon,
                    prediction_minutes: sa.prediction_minutes || 10,
                    storm_lat: sa.lat,
                    storm_lon: sa.lon,
                    heading_deg: sa.heading_deg,
                    speed_mph: sa.speed_mph,
                };
            }
        }

        return target;
    }

    // ── Haversine ─────────────────────────────────────────────────────

    function haversineMi(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── Public API ────────────────────────────────────────────────────

    return {
        buildTargets,
        setStormAlerts,
        getStormAlerts,
        getBridgeStats,
        getSessionStats,
        resetSession,
    };
})();
