/**
 * Storm Tracker — Auto-Track with Interrogation Assist (Phase 1 + Phase 2)
 *
 * Modes: off | track | interrogate
 *
 * Phase 1 (frozen): target scoring, hysteresis, pause scopes, layer ownership.
 * Phase 2 (additive): unified targets, motion scoring, projected path framing,
 *                      interrogation transparency.
 *
 * All scoring/framing operates on UnifiedTarget objects from the normalization layer.
 * When motion data is unavailable, behavior is identical to Phase 1.
 *
 * Additive only. When off, zero side effects on manual controls.
 * Fail-safe to manual on any error.
 */
const AutoTrack = (function () {

    // ── Phase 1 timing constants (FROZEN) ─────────────────────────────
    const TARGET_HOLD_MS       = 12000;
    const REFRAME_COOLDOWN_MS  = 4000;
    const USER_PAUSE_MS        = 15000;
    const RADAR_SITE_HOLD_MS   = 20000;
    const DEBOUNCE_MS          = 500;
    const EVAL_INTERVAL_MS     = 3000;

    // ── Phase 1 scoring weights (FROZEN) ──────────────────────────────
    const SEVERITY_SCORES  = { "Extreme": 40, "Severe": 30, "Moderate": 15, "Minor": 5 };
    const CERTAINTY_SCORES = { "Observed": 25, "Likely": 20, "Possible": 10 };
    const EVENT_SCORES     = {
        "Tornado Warning": 30,
        "Severe Thunderstorm Warning": 20,
        "Tornado Watch": 10,
        "Flash Flood Warning": 8,
        "Flood Warning": 5,
        "Winter Storm Warning": 3,
    };
    const DISTANCE_MAX_PTS = 25;
    const DISTANCE_HORIZON_MI = 500;
    const RECENCY_MAX_PTS = 15;
    const RECENCY_HORIZON_MIN = 120;
    const MOTION_MAX_PTS = 20;

    // ── Phase 1 hysteresis thresholds (FROZEN) ────────────────────────
    const TARGET_SWITCH_THRESHOLD = 12;
    const RADAR_SWITCH_THRESHOLD  = 30;

    // ── Phase 2: motion scoring constants ─────────────────────────────
    const MOTION_SPEED_CAP_MPH = 60;

    // ── Phase 2: path framing constants ───────────────────────────────
    const PATH_ARROW_COLOR = "#f59e0b";

    // ── Region filter: Midwest + Ohio Valley ──────────────────────────
    const REGION = { west: -97, east: -78, north: 46, south: 34 };
    const REGION_GRACE_DEG = 1.0;  // current target may exceed region by this much
    const RADAR_VIABILITY_KM = 230;  // NEXRAD velocity range — alerts beyond this are not interrogable
    const PATH_ARROW_OPACITY = 0.7;

    // ── Internal state ────────────────────────────────────────────────
    let evalTimer = null;
    let debounceTimer = null;
    let followPauseTimer = null;
    let lastReframeTime = 0;
    let lastTargetSelectTime = 0;
    let lastRadarSwitchTime = 0;
    let currentTargetId = null;
    let currentTargetScore = 0;
    let currentAutoRadarSite = null;

    // Phase 2: storm alert fetch
    let stormAlertFetchTimer = null;
    const STORM_ALERT_FETCH_INTERVAL = 10000;  // 10s

    // Phase 2: path overlay
    let pathArrowLayer = null;

    // Interrogation layer gates — synchronous flags prevent async re-entry spam.
    // Set BEFORE any async work; cleared only on site change, mode change, or success.
    let ccEnableFailed = false;
    let srvEnableFailed = false;

    // Panel auto-collapse: track if AT collapsed the panel so we can restore on mode off
    let panelAutoCollapsed = false;

    // ── Debug state ───────────────────────────────────────────────────
    let lastDecision = { action: "init", reason: "Waiting for first evaluation", time: Date.now() };
    let lastCandidates = [];
    let evalCount = 0;
    let lastRadarSelection = null;
    let lastFilterStats = { total: 0, eligible: 0, outOfRegion: 0, noRadar: 0, noSpatial: 0 };
    let lastRankingMode = "severity";  // "severity" | "distance"

    // ── Init ──────────────────────────────────────────────────────────

    function init() {
        const btn = document.getElementById("btn-autotrack");
        if (btn) btn.addEventListener("click", onButtonClick);

        StormState.on("autotrackChanged", onModeChanged);
        StormState.on("alertsUpdated", onAlertsUpdated);
        StormState.on("userMapInteraction", onUserMapInteraction);

        const siteSelector = document.getElementById("radar-site-selector");
        if (siteSelector) {
            siteSelector.addEventListener("change", onManualSiteSelection);
        }

        updateBadge();
    }

    // ── Button handler ────────────────────────────────────────────────

    function onButtonClick() {
        StormState.cycleAutoTrack();
    }

    // ── Mode change ───────────────────────────────────────────────────

    function onModeChanged(data) {
        const { mode, prev } = data;

        if (mode === "off") {
            if (typeof Camera !== "undefined") Camera.release("autotrack"); // CameraPolicy manages ownership
            stopEvalLoop();
            stopStormAlertFetch();
            clearFollowPause();
            clearPathArrow();

            const autoAdded = StormState.state.autotrack.autoAddedLayers.splice(0);
            if (autoAdded.length > 0) {
                RadarManager.disableLayers(autoAdded);
            }

            if (currentAutoRadarSite) {
                const select = document.getElementById("radar-site-selector");
                if (select) select.value = "auto";
            }

            currentTargetId = null;
            currentTargetScore = 0;
            currentAutoRadarSite = null;
            lastReframeTime = 0;
            lastTargetSelectTime = 0;
            lastRadarSwitchTime = 0;
            lastCandidates = [];
            lastRadarSelection = null;
            lastFilterStats = { total: 0, eligible: 0, outOfRegion: 0, noRadar: 0, noSpatial: 0 };
            ccEnableFailed = false;
            srvEnableFailed = false;

            UnifiedTarget.resetSession();
            StormState.emit("autotrackTargetChanged", null);
            setDecision("mode_off", `Mode changed: ${prev} → off`);

            // Reopen panel if AT collapsed it
            if (panelAutoCollapsed && !StormState.state.alerts.panelOpen) {
                StormState.togglePanel();
            }
            panelAutoCollapsed = false;
        } else {
            if (typeof CameraPolicy !== "undefined" && CameraPolicy.requestMode) { CameraPolicy.requestMode("AUTO_TRACK"); } else if (typeof Camera !== "undefined") { Camera.claim("autotrack", "mode " + mode); }
            // Auto-collapse panel when AT activates (only from off → on)
            if (prev === "off" && StormState.state.alerts.panelOpen) {
                StormState.togglePanel();
                panelAutoCollapsed = true;
            }

            UnifiedTarget.resetSession();
            startEvalLoop();
            startStormAlertFetch();
            if (prev === "track" && mode === "interrogate") {
                evaluateTargets();
            }
            setDecision("mode_change", `Mode changed: ${prev} → ${mode}`);
        }

        updateButton();
        updateBadge();
        emitDebug();
    }

    // ── Alert updates (debounced) ─────────────────────────────────────

    function onAlertsUpdated() {
        if (StormState.state.autotrack.mode === "off") return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(evaluateTargets, DEBOUNCE_MS);
    }

    // ── User interaction → pause follow ───────────────────────────────

    function onUserMapInteraction() {
        const at = StormState.state.autotrack;
        if (at.mode === "off") return;

        at.followPaused = true;
        setDecision("follow_paused", "Map follow paused by user interaction");
        updateBadge();
        emitDebug();

        if (followPauseTimer) clearTimeout(followPauseTimer);
        const pauseTargetId = currentTargetId;
        followPauseTimer = setTimeout(() => {
            if (StormState.state.autotrack.targetAlertId !== pauseTargetId) return;
            at.followPaused = false;
            followPauseTimer = null;
            setDecision("follow_resumed", `Map follow resumed after ${USER_PAUSE_MS / 1000}s`);
            updateBadge();
            emitDebug();
            evaluateTargets();
        }, USER_PAUSE_MS);
    }

    function clearFollowPause() {
        const at = StormState.state.autotrack;
        at.followPaused = false;
        if (followPauseTimer) {
            clearTimeout(followPauseTimer);
            followPauseTimer = null;
        }
    }

    // ── Manual radar site selection → pause radar auto ────────────────

    function onManualSiteSelection() {
        const at = StormState.state.autotrack;
        if (at.mode !== "interrogate") return;

        const select = document.getElementById("radar-site-selector");
        if (!select) return;

        if (select.value === "auto") {
            at.radarPaused = false;
            setDecision("radar_resumed", "Radar auto resumed — user selected Auto");
        } else {
            at.radarPaused = true;
            setDecision("radar_paused", `Radar auto paused — user selected ${select.value}`);
        }
        updateBadge();
        emitDebug();
    }

    // ── Phase 2: Storm alert fetching ─────────────────────────────────

    function startStormAlertFetch() {
        stopStormAlertFetch();
        fetchStormAlerts();
        stormAlertFetchTimer = setInterval(fetchStormAlerts, STORM_ALERT_FETCH_INTERVAL);
    }

    function stopStormAlertFetch() {
        if (stormAlertFetchTimer) {
            clearInterval(stormAlertFetchTimer);
            stormAlertFetchTimer = null;
        }
    }

    async function fetchStormAlerts() {
        const loc = StormState.state.location;
        const params = new URLSearchParams();
        if (loc.lat != null) params.set("lat", loc.lat);
        if (loc.lon != null) params.set("lon", loc.lon);

        try {
            const resp = await fetch(`/api/storm-alerts?${params}`);
            if (!resp.ok) return;
            const data = await resp.json();
            UnifiedTarget.setStormAlerts(data.alerts || []);
        } catch (e) {
            // Fail safe — stale or empty storm alerts, NWS-only scoring continues
        }
    }

    // ── Eval loop ─────────────────────────────────────────────────────

    function startEvalLoop() {
        stopEvalLoop();
        evaluateTargets();
        evalTimer = setInterval(evaluateTargets, EVAL_INTERVAL_MS);
    }

    function stopEvalLoop() {
        if (evalTimer) { clearInterval(evalTimer); evalTimer = null; }
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    }

    // ── Target selection (operates on UnifiedTarget) ──────────────────

    function evaluateTargets() {
        const at = StormState.state.autotrack;
        if (at.mode === "off") return;
        evalCount++;

        const alerts = StormState.state.alerts.data;
        if (!alerts || alerts.length === 0) {
            lastCandidates = [];
            setNoTarget("no_alerts", "No alerts in data");
            clearPathArrow();
            emitDebug();
            return;
        }

        // Phase 2: build unified targets
        const targets = UnifiedTarget.buildTargets(alerts);

        // ── Region + radar viability filter (applied BEFORE scoring) ──
        const filterResult = filterEligibleTargets(targets);
        lastFilterStats = filterResult.stats;
        const eligible = filterResult.eligible;

        if (eligible.length === 0) {
            lastCandidates = [];
            const reason = filterResult.stats.total === 0 ? "No alerts with spatial data"
                : filterResult.stats.outOfRegion > 0 ? `No eligible alerts (${filterResult.stats.outOfRegion} outside region)`
                : "No eligible alerts";
            setNoTarget("no_eligible", reason);
            clearPathArrow();
            emitDebug();
            return;
        }

        // Score eligible targets
        const scored = [];
        for (const target of eligible) {
            const breakdown = scoreTargetDetailed(target);
            scored.push({ target, score: breakdown.total, breakdown });
        }

        // ── Ranking mode selection ────────────────────────────────
        // Distance mode: when NWS sort = distance AND GPS is available AND
        //   at least one candidate has a valid distance (not null/NaN/>=9999).
        // If all distances are invalid, auto-fallback to severity ranking.
        //
        // Valid distance: number, finite, >= 0, < 9999
        //   (9999 is a sentinel used by the API when distance cannot be computed)
        const sortMode = StormState.state.alerts.sortBy;
        const loc = StormState.state.location;
        const wantDistanceRanking = sortMode === "distance" && loc.lat != null && loc.lon != null;

        const isValidDist = (d) => d != null && isFinite(d) && d >= 0 && d < 9999;

        const hasAnyValidDistance = wantDistanceRanking &&
            scored.some(s => isValidDist(s.target.distance_mi));

        const useDistanceRanking = wantDistanceRanking && hasAnyValidDistance;
        lastRankingMode = useDistanceRanking ? "distance"
            : (wantDistanceRanking ? "severity_fallback" : "severity");

        if (useDistanceRanking) {
            // Distance-first ranking.
            // a) Valid distance always beats invalid distance
            // b) Among valid: nearest wins
            // c) Tie within 1mi: higher event class wins
            // d) Still tied: newer update time wins
            scored.sort((a, b) => {
                const validA = isValidDist(a.target.distance_mi);
                const validB = isValidDist(b.target.distance_mi);

                // Valid distances always rank ahead of invalid
                if (validA && !validB) return -1;
                if (!validA && validB) return 1;
                if (!validA && !validB) {
                    // Both invalid: fall back to severity score
                    return b.score - a.score;
                }

                // Both valid: nearest wins
                const distDiff = a.target.distance_mi - b.target.distance_mi;
                if (Math.abs(distDiff) > 1) return distDiff;

                // Tied within 1mi: higher event class wins
                const evtA = EVENT_SCORES[a.target.event] || 0;
                const evtB = EVENT_SCORES[b.target.event] || 0;
                if (evtA !== evtB) return evtB - evtA;

                // Still tied: newer alert wins
                const timeA = a.target.issued ? new Date(a.target.issued).getTime() : 0;
                const timeB = b.target.issued ? new Date(b.target.issued).getTime() : 0;
                return timeB - timeA;
            });
        } else {
            scored.sort((a, b) => b.score - a.score);
        }

        // Store top-3 for debug
        lastCandidates = scored.slice(0, 3).map((s, rank) => ({
            rank: rank + 1,
            alertId: s.target.id,
            event: s.target.event,
            score: Math.round(s.score * 10) / 10,
            distanceMi: s.target.distance_mi != null ? Math.round(s.target.distance_mi) : null,
            distanceValid: isValidDist(s.target.distance_mi),
            breakdown: s.breakdown,
            rejection: null,
            hasMotion: s.target.hasMotion,
            hasProjection: s.target.hasProjection,
            bridgeMatch: s.target.bridgeMatch,
        }));

        const best = scored[0];

        // Phase 1 hysteresis (FROZEN)
        const now = Date.now();
        const holdElapsed = now - lastTargetSelectTime >= TARGET_HOLD_MS;
        const holdRemainMs = Math.max(0, TARGET_HOLD_MS - (now - lastTargetSelectTime));

        if (currentTargetId && currentTargetId === best.target.id) {
            currentTargetScore = best.score;
            at.targetScore = best.score;
            setDecision("same_target", `Staying on current target (score: ${fmtScore(best.score)})`);
            reframeToTarget(best.target);
            handleInterrogation(best.target);
            updateBadge();
            emitDebug();
            return;
        }

        const scoreDelta = best.score - currentTargetScore;

        if (currentTargetId && !holdElapsed) {
            if (lastCandidates.length > 0) {
                lastCandidates[0].rejection = `hold_timer: ${Math.round(holdRemainMs / 1000)}s remaining`;
            }
            setDecision("hold_block", `New target blocked by hold timer (${Math.round(holdRemainMs / 1000)}s left, delta: ${fmtScore(scoreDelta)})`);
            reframeToCurrentTarget();
            emitDebug();
            return;
        }

        if (currentTargetId && scoreDelta < TARGET_SWITCH_THRESHOLD) {
            if (lastCandidates.length > 0) {
                lastCandidates[0].rejection = `hysteresis: delta ${fmtScore(scoreDelta)} < threshold ${TARGET_SWITCH_THRESHOLD}`;
            }
            setDecision("hysteresis_block", `New target blocked by hysteresis (delta: ${fmtScore(scoreDelta)}, need: ${TARGET_SWITCH_THRESHOLD})`);
            reframeToCurrentTarget();
            emitDebug();
            return;
        }

        const prevId = currentTargetId;
        selectTarget(best.target, best.score);
        setDecision("target_switch", `Switched target: ${prevId ? prevId.slice(-8) : "none"} → ${best.target.id.slice(-8)} (${best.target.event}, score: ${fmtScore(best.score)}, delta: ${fmtScore(scoreDelta)})`);

        // Phase 5: structured logging for target changes
        if (typeof STLogger !== "undefined") {
            STLogger.for("autotrack").info("autotrack_target_changed", {
                from: prevId ? prevId.slice(-12) : null,
                to: best.target.id.slice(-12),
                event: best.target.event,
                score: Math.round(best.score * 10) / 10,
                delta: Math.round(scoreDelta * 10) / 10,
                ranking: lastRankingMode,
            });
        }
        emitDebug();
    }

    function setNoTarget(reason, detail) {
        const at = StormState.state.autotrack;
        const hadTarget = !!currentTargetId;
        currentTargetId = null;
        currentTargetScore = 0;
        at.targetAlertId = null;
        at.targetEvent = null;
        at.targetScore = 0;
        if (hadTarget) {
            setDecision("no_target", detail || "Target lost");
            StormState.emit("autotrackTargetChanged", null);
        } else {
            setDecision("no_target", detail || "No target available");
        }
        updateBadge();
    }

    function selectTarget(target, score) {
        const at = StormState.state.autotrack;
        const prevId = currentTargetId;
        currentTargetId = target.id;
        currentTargetScore = score;
        lastTargetSelectTime = Date.now();

        at.targetAlertId = target.id;
        at.targetEvent = target.event;
        at.targetScore = score;

        reframeToTarget(target);
        handleInterrogation(target);
        updateBadge();

        // Badge acquisition pulse on new target
        if (prevId !== target.id) {
            const badge = document.getElementById("autotrack-badge");
            if (badge) {
                badge.classList.remove("at-badge-acquire");
                // Force reflow to restart animation
                void badge.offsetWidth;
                badge.classList.add("at-badge-acquire");
                badge.addEventListener("animationend", () => {
                    badge.classList.remove("at-badge-acquire");
                }, { once: true });
            }
        }

        // Emit target change for panel highlighting
        if (prevId !== target.id) {
            StormState.emit("autotrackTargetChanged", target.id);
        }
    }

    function reframeToCurrentTarget() {
        if (!currentTargetId) return;
        // Re-build unified targets to get latest motion data
        const alerts = StormState.state.alerts.data;
        const nwsAlert = alerts.find(a => a.id === currentTargetId);
        if (!nwsAlert) {
            setNoTarget("target_expired", "Current target disappeared from alert data");
            clearPathArrow();
            emitDebug();
            return;
        }
        const targets = UnifiedTarget.buildTargets([nwsAlert]);
        if (targets.length > 0) {
            reframeToTarget(targets[0]);
            handleInterrogation(targets[0]);
        }
    }

    // ── Scoring engine (operates on UnifiedTarget) ────────────────────

    /**
     * Score a UnifiedTarget with full factor breakdown.
     * Phase 1 factors: severity, certainty, event_type, distance, recency (FROZEN).
     * Phase 2 factor: motion toward focus (additive, capped at MOTION_MAX_PTS).
     */
    function scoreTargetDetailed(target) {
        // Phase 1 factors (FROZEN)
        const severity = SEVERITY_SCORES[target.severity] || 0;
        const certainty = CERTAINTY_SCORES[target.certainty] || 0;
        const event_type = EVENT_SCORES[target.event] || 0;

        let distance = 0;
        let distMi = null;
        if (target.distance_mi != null && target.distance_mi >= 0) {
            distMi = target.distance_mi;
            const ratio = Math.min(target.distance_mi / DISTANCE_HORIZON_MI, 1);
            distance = DISTANCE_MAX_PTS * (1 - ratio);
        }

        let recency = 0;
        let ageMin = null;
        if (target.issued) {
            ageMin = (Date.now() - new Date(target.issued).getTime()) / 60000;
            if (ageMin >= 0) {
                const ratio = Math.min(ageMin / RECENCY_HORIZON_MIN, 1);
                recency = RECENCY_MAX_PTS * (1 - ratio);
            }
        }

        // Phase 2: motion scoring using real data from UnifiedTarget
        const motionResult = scoreMotionTowardFocus(target);
        const motion = motionResult.score;

        const total = severity + certainty + event_type + distance + recency + motion;

        return {
            total,
            severity, certainty, event_type, distance, recency, motion,
            factors: {
                sev_input: target.severity || "—",
                cert_input: target.certainty || "—",
                evt_input: target.event || "—",
                dist_mi: distMi != null ? Math.round(distMi) : "—",
                age_min: ageMin != null ? Math.round(ageMin) : "—",
                motion_data: motionResult.source,
                motion_detail: motionResult.detail,
            },
        };
    }

    /**
     * Phase 2: Score motion toward the user's focus point using real storm alert data.
     *
     * Returns { score: 0-20, source: string, detail: string }.
     *
     * Scoring formula:
     *   score = MOTION_MAX_PTS * speed_factor * alignment_factor
     *
     *   speed_factor = min(speed_mph / MOTION_SPEED_CAP_MPH, 1.0)
     *   alignment_factor:
     *     closing  → 1.0
     *     steady   → 0.3
     *     departing → 0.0
     *     unknown  → 0.0
     *
     * Gate: only when hasMotion=true (motion_confidence ≥ 0.3, speed ≥ 2mph).
     * Fallback: 0 (Phase 1 behavior preserved).
     */
    function scoreMotionTowardFocus(target) {
        if (!target.hasMotion || !target.motion) {
            return { score: 0, source: "unavailable", detail: "no motion data" };
        }

        const m = target.motion;
        const trend = m.trend || "unknown";
        const speed = m.speed_mph || 0;

        // Alignment factor
        let alignment;
        if (trend === "closing") {
            alignment = 1.0;
        } else if (trend === "steady") {
            alignment = 0.3;
        } else {
            alignment = 0.0;
        }

        // Speed factor (capped)
        const speedFactor = Math.min(speed / MOTION_SPEED_CAP_MPH, 1.0);

        const score = MOTION_MAX_PTS * speedFactor * alignment;

        const detail = `${trend} ${Math.round(speed)}mph mc=${m.motion_confidence.toFixed(2)}`;
        const source = alignment > 0 ? "storm_alert" : `storm_alert (${trend})`;

        return { score: Math.round(score * 10) / 10, source, detail };
    }

    // ── Region + radar viability filter ─────────────────────────────

    /**
     * Filter targets to eligible-only before scoring.
     * Checks: spatial data, region bounds, radar viability.
     * Current tracked target gets a grace buffer to avoid dropping it
     * on minor boundary oscillation.
     */
    function filterEligibleTargets(targets) {
        const stats = { total: 0, eligible: 0, outOfRegion: 0, noRadar: 0, noSpatial: 0 };
        const eligible = [];

        for (const target of targets) {
            // Must have spatial data
            if (!target.polygon && (!target.county_fips || target.county_fips.length === 0)) {
                stats.noSpatial++;
                continue;
            }
            stats.total++;

            const centroid = getTargetCentroid(target);
            if (!centroid) {
                stats.noSpatial++;
                continue;
            }

            // Region check (with grace buffer for current target)
            const isCurrentTarget = currentTargetId && target.id === currentTargetId;
            const grace = isCurrentTarget ? REGION_GRACE_DEG : 0;

            if (centroid.lat > REGION.north + grace || centroid.lat < REGION.south - grace ||
                centroid.lon > REGION.east + grace || centroid.lon < REGION.west - grace) {
                stats.outOfRegion++;
                continue;
            }

            // Radar viability check (skip for non-interrogate or if radar paused)
            if (StormState.state.autotrack.mode === "interrogate" && !StormState.state.autotrack.radarPaused) {
                const radarOk = checkRadarViability(centroid);
                if (!radarOk) {
                    stats.noRadar++;
                    continue;
                }
            }

            stats.eligible++;
            eligible.push(target);
        }

        return { eligible, stats };
    }

    /**
     * Check if a target centroid is within NEXRAD velocity range of any known radar site.
     * Uses cached radar site list from the site selector dropdown.
     * Returns true if viable, false if no radar can cover this target.
     */
    function checkRadarViability(centroid) {
        // Use the site selector options as a lightweight radar catalog
        const select = document.getElementById("radar-site-selector");
        if (!select || select.options.length <= 1) return true;  // can't check — assume viable

        // Check if the currently selected/auto site covers this target
        // We use a simple approach: fetch nearest radar distance from the API response cache
        // For now, use the current radar site if known
        const currentSite = RadarManager.getRadarSite();
        if (currentSite && currentSite.lat && currentSite.lon) {
            const dist = haversineMi(centroid.lat, centroid.lon, currentSite.lat, currentSite.lon);
            const distKm = dist * 1.60934;
            if (distKm <= RADAR_VIABILITY_KM) return true;
        }

        // If current site doesn't cover it, we can't cheaply check all sites
        // without an API call. Be permissive — only reject if we KNOW it's out of range.
        // The selectBestRadarForTarget() call during interrogation will handle site switching.
        return true;
    }

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

    // ── Phase 2: Map reframe with projected path ──────────────────────

    // ── Camera easing profiles ─────────────────────────────────────
    // Tornado override: faster snap (700ms) with tighter ease
    // Normal tracking: smooth glide (1000ms) with gentle ease-in-out
    // Reframe (same target): subtle drift (1200ms), very gentle
    const CAMERA_PROFILES = {
        tornado:  { duration: 0.7,  easeLinearity: 0.35 },
        normal:   { duration: 1.0,  easeLinearity: 0.25 },
        reframe:  { duration: 1.2,  easeLinearity: 0.2  },
    };

    // Respect prefers-reduced-motion
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function getCameraProfile(target, isNewTarget) {
        if (prefersReducedMotion) return { duration: 0.01, easeLinearity: 0.5 };
        if (!isNewTarget) return CAMERA_PROFILES.reframe;
        const evt = (target.event || "").toLowerCase();
        if (evt.includes("tornado") && evt.includes("warning")) return CAMERA_PROFILES.tornado;
        return CAMERA_PROFILES.normal;
    }

    function reframeToTarget(target) {
        const at = StormState.state.autotrack;
        if (at.followPaused) return;

        // Suspend autotrack camera writes during active pulse session
        if (StormState.state.camera.contextPulseActive) return;

        // Camera ownership check — only move if AT can
        if (typeof Camera !== "undefined" && !Camera.canMove("autotrack")) return;

        const now = Date.now();
        if (now - lastReframeTime < REFRAME_COOLDOWN_MS) return;

        const map = StormMap.getMap();
        if (!map) return;

        const bounds = getTargetBounds(target);
        if (!bounds) return;

        // Phase 2: extend bounds to include projected path
        const frameBounds = extendBoundsWithProjection(bounds, target);

        const zoom = computeZoom(frameBounds, map);

        // Context-aware camera easing
        const isNewTarget = target.id !== currentTargetId ||
                            (now - lastTargetSelectTime < TARGET_HOLD_MS + 1000);
        const camProfile = getCameraProfile(target, isNewTarget);

        // Route through Camera controller
        if (typeof Camera !== "undefined") {
            Camera.move({
                source: "autotrack",
                bounds: frameBounds,
                flyOptions: {
                    padding: [60, 60],
                    maxZoom: zoom,
                    duration: camProfile.duration,
                    easeLinearity: camProfile.easeLinearity,
                },
                reason: isNewTarget ? "new_target" : "reframe",
            });
        } else {
            Camera.move({
                source: "autotrack",
                bounds: frameBounds,
                flyOptions: {
                    padding: [60, 60],
                    maxZoom: zoom,
                    duration: camProfile.duration,
                    easeLinearity: camProfile.easeLinearity,
                },
                reason: "reframe_fallback",
            });
        }

        // Phase 2: draw path arrow
        drawPathArrow(target, map);

        lastReframeTime = now;
    }

    /**
     * Phase 2: Extend bounds to include the projected storm position.
     * Biases the frame forward along the motion vector.
     */
    function extendBoundsWithProjection(bounds, target) {
        if (!target.hasProjection || !target.projection) return bounds;

        const p = target.projection;
        if (!p.predicted_lat || !p.predicted_lon) return bounds;

        // Create extended bounds that include both current polygon and predicted position
        const extended = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
        extended.extend(L.latLng(p.predicted_lat, p.predicted_lon));

        // Also include the storm's current position (centroid)
        if (p.storm_lat && p.storm_lon) {
            extended.extend(L.latLng(p.storm_lat, p.storm_lon));
        }

        return extended;
    }

    /**
     * Phase 2: Draw a motion vector arrow from storm centroid to predicted position.
     */
    function drawPathArrow(target, map) {
        clearPathArrow();

        if (!target.hasProjection || !target.projection) return;

        const p = target.projection;
        if (!p.storm_lat || !p.storm_lon || !p.predicted_lat || !p.predicted_lon) return;

        const start = [p.storm_lat, p.storm_lon];
        const end = [p.predicted_lat, p.predicted_lon];

        // Main path line — with draw-in animation class
        const line = L.polyline([start, end], {
            color: PATH_ARROW_COLOR,
            weight: 2,
            opacity: PATH_ARROW_OPACITY,
            dashArray: "8,6",
            interactive: false,
            className: "at-path-draw-in",
        });

        // Arrowhead at the end
        const arrowHead = createArrowHead(start, end);

        // Predicted position circle — with subtle shimmer
        const predCircle = L.circleMarker(end, {
            radius: 5,
            color: PATH_ARROW_COLOR,
            fillColor: PATH_ARROW_COLOR,
            fillOpacity: 0.4,
            weight: 1.5,
            opacity: PATH_ARROW_OPACITY,
            interactive: false,
            className: "at-pred-circle-shimmer",
        });

        // Time label
        const timeLabel = L.tooltip({
            permanent: true,
            direction: "right",
            className: "at-path-tooltip",
            offset: [8, 0],
        }).setLatLng(end).setContent(`~${p.prediction_minutes}min`);

        pathArrowLayer = L.layerGroup([line, arrowHead, predCircle]).addTo(map);
        timeLabel.addTo(map);
        // Store tooltip ref on the layer group for cleanup
        pathArrowLayer._timeLabel = timeLabel;
    }

    function createArrowHead(start, end) {
        const dx = end[1] - start[1];
        const dy = end[0] - start[0];
        const angle = Math.atan2(dx, dy);  // bearing in radians

        const headLen = 0.03;  // degrees — small arrowhead
        const headAngle = Math.PI / 6;  // 30 degrees

        const left = [
            end[0] - headLen * Math.cos(angle - headAngle),
            end[1] - headLen * Math.sin(angle - headAngle),
        ];
        const right = [
            end[0] - headLen * Math.cos(angle + headAngle),
            end[1] - headLen * Math.sin(angle + headAngle),
        ];

        return L.polygon([end, left, right], {
            color: PATH_ARROW_COLOR,
            fillColor: PATH_ARROW_COLOR,
            fillOpacity: PATH_ARROW_OPACITY,
            weight: 1,
            opacity: PATH_ARROW_OPACITY,
            interactive: false,
        });
    }

    function clearPathArrow() {
        if (pathArrowLayer) {
            const map = StormMap.getMap();
            if (map) {
                map.removeLayer(pathArrowLayer);
                if (pathArrowLayer._timeLabel) {
                    map.removeLayer(pathArrowLayer._timeLabel);
                }
            }
            pathArrowLayer = null;
        }
    }

    function getTargetBounds(target) {
        if (target.polygon) {
            try {
                const geojson = JSON.parse(target.polygon);
                const layer = L.geoJSON(geojson);
                const b = layer.getBounds();
                if (b.isValid()) return b;
            } catch (e) { /* fall through */ }
        }

        if (target.county_fips && target.county_fips.length > 0) {
            const countyLayer = StormMap.getCountyLayer();
            if (countyLayer) {
                const b = L.latLngBounds([]);
                countyLayer.eachLayer((layer) => {
                    if (target.county_fips.includes(layer._fips)) {
                        b.extend(layer.getBounds());
                    }
                });
                if (b.isValid()) return b;
            }
        }

        return null;
    }

    function computeZoom(bounds, map) {
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const latSpan = Math.abs(ne.lat - sw.lat);
        const lonSpan = Math.abs(ne.lng - sw.lng);
        const maxSpan = Math.max(latSpan, lonSpan);

        // Cap at 10 — SRV/IEM tiles don't exist above zoom 10
        if (maxSpan < 0.2) return 10;
        if (maxSpan < 0.5) return 10;
        if (maxSpan < 1.0) return 9;
        if (maxSpan < 2.0) return 8;
        return 7;
    }

    // ── Radar interrogation ───────────────────────────────────────────

    async function handleInterrogation(target) {
        const at = StormState.state.autotrack;
        if (at.mode !== "interrogate") return;

        // Await site selection BEFORE enabling layers — site switch resets layer gates
        await selectBestRadarForTarget(target);
        await enableInterrogationLayers();
    }

    async function selectBestRadarForTarget(target) {
        const at = StormState.state.autotrack;
        if (at.radarPaused) return;

        const now = Date.now();
        if (now - lastRadarSwitchTime < RADAR_SITE_HOLD_MS && currentAutoRadarSite) return;

        const centroid = getTargetCentroid(target);
        if (!centroid) return;

        try {
            const resp = await fetch(
                `/api/radar/nexrad/nearest?lat=${centroid.lat}&lon=${centroid.lon}&count=3`
            );
            if (!resp.ok) return;
            const data = await resp.json();
            const sites = data.sites || [];
            if (sites.length === 0) return;

            const bestSite = sites[0];

            // Phase 2: store selection details for transparency
            lastRadarSelection = {
                centroid,
                candidates: sites.map(s => ({
                    site_id: s.site_id,
                    distance_km: Math.round(s.distance_km),
                    name: s.name,
                })),
                selected: bestSite.site_id,
                reason: `nearest to target centroid (${Math.round(bestSite.distance_km)}km)`,
            };

            if (currentAutoRadarSite && currentAutoRadarSite === bestSite.site_id) return;

            if (currentAutoRadarSite && sites.length >= 2) {
                const currentInResults = sites.find(s => s.site_id === currentAutoRadarSite);
                if (currentInResults) {
                    const improvement = currentInResults.distance_km - bestSite.distance_km;
                    if (improvement < RADAR_SWITCH_THRESHOLD) return;
                }
            }

            const ok = await RadarManager.setSiteForAutoTrack(bestSite.site_id);
            if (ok) {
                const prevSite = currentAutoRadarSite;
                currentAutoRadarSite = bestSite.site_id;
                at.radarSite = bestSite.site_id;
                lastRadarSwitchTime = now;
                // Reset layer gates — new site may have different availability
                ccEnableFailed = false;
                srvEnableFailed = false;
                setDecision("radar_switch", `Radar site: ${prevSite || "none"} → ${bestSite.site_id} (${Math.round(bestSite.distance_km)}km from target)`);
                updateBadge();
                emitDebug();
            }
        } catch (e) {
            console.warn("[AutoTrack] Radar site selection failed:", e);
        }
    }

    function getTargetCentroid(target) {
        if (target.polygon) {
            try {
                const geojson = JSON.parse(target.polygon);
                const layer = L.geoJSON(geojson);
                const b = layer.getBounds();
                if (b.isValid()) {
                    const c = b.getCenter();
                    return { lat: c.lat, lon: c.lng };
                }
            } catch (e) { /* fall through */ }
        }

        const loc = StormState.state.location;
        if (loc.lat && loc.lon) return { lat: loc.lat, lon: loc.lon };
        return null;
    }

    async function enableInterrogationLayers() {
        const at = StormState.state.autotrack;
        if (at.mode !== "interrogate") return;

        // SRV: skip if already active or previously failed for this context
        if (!StormState.state.radar.activeLayers.includes("srv") && !srvEnableFailed) {
            srvEnableFailed = true;  // gate BEFORE async — prevents all re-entry
            const ok = await RadarManager.enableSRV();
            if (ok) {
                srvEnableFailed = false;  // success — allow future checks
                if (!at.autoAddedLayers.includes("srv")) {
                    at.autoAddedLayers.push("srv");
                }
            }
            // on failure: srvEnableFailed stays true until site/mode reset
        }

        // CC: skip if already active or previously failed for this context
        if (!StormState.state.radar.activeLayers.includes("cc") && !ccEnableFailed) {
            ccEnableFailed = true;  // gate BEFORE async — prevents all re-entry
            const ok = await RadarManager.enableCC();
            if (ok) {
                ccEnableFailed = false;  // success — allow future checks
                if (!at.autoAddedLayers.includes("cc")) {
                    at.autoAddedLayers.push("cc");
                }
            }
            // on failure: ccEnableFailed stays true until site/mode reset
        }

        updateBadge();
    }

    // ── UI: Button ────────────────────────────────────────────────────

    function updateButton() {
        const btn = document.getElementById("btn-autotrack");
        if (!btn) return;

        const mode = StormState.state.autotrack.mode;
        btn.classList.remove("at-off", "at-track", "at-interrogate");
        btn.classList.add(`at-${mode}`);

        if (mode === "off") {
            btn.textContent = "AT";
            btn.title = "Auto Track: Off — click to enable";
        } else if (mode === "track") {
            btn.textContent = "AT";
            btn.title = "Auto Track: Following — click for interrogation";
        } else {
            btn.textContent = "AT+R";
            btn.title = "Auto Track + Interrogate — click to disable";
        }
    }

    // ── UI: Status badge ──────────────────────────────────────────────

    function updateBadge() {
        const badge = document.getElementById("autotrack-badge");
        if (!badge) return;

        const at = StormState.state.autotrack;

        if (at.mode === "off") {
            badge.classList.add("hidden");
            badge.removeAttribute("data-mode");
            return;
        }

        badge.classList.remove("hidden");
        badge.setAttribute("data-mode", at.mode);
        const lines = [];

        if (at.targetEvent) {
            const shortEvent = abbreviateEvent(at.targetEvent);
            const modeTag = lastRankingMode === "distance" ? " [DIST]"
                : lastRankingMode === "severity_fallback" ? " [DIST\u2192SEV]" : "";
            lines.push(`Tracking: ${shortEvent}${modeTag}`);
        } else {
            lines.push("Auto Track active \u00b7 No target");
        }

        if (at.mode === "interrogate") {
            const layers = StormState.state.radar.activeLayers;
            const hasSRV = layers.includes("srv");
            const hasCC = layers.includes("cc");
            const layerStr = [hasSRV ? "SRV" : null, hasCC ? "CC" : null].filter(Boolean).join("+");
            const siteStr = at.radarSite || "\u2014";
            // Phase 2: interrogation transparency — show why this site
            if (layerStr && lastRadarSelection) {
                lines.push(`Interrogating \u00b7 ${layerStr} \u00b7 ${siteStr} (${lastRadarSelection.candidates[0]?.distance_km || "?"}km)`);
            } else if (layerStr) {
                lines.push(`Interrogating \u00b7 ${layerStr} \u00b7 ${siteStr}`);
            } else {
                lines.push(`Interrogating \u00b7 ${siteStr}`);
            }
        }

        if (at.followPaused) {
            lines.push("Map follow paused by interaction");
        }
        if (at.radarPaused) {
            lines.push("Radar auto paused by manual site");
        }

        badge.innerHTML = lines
            .map((l, i) => `<div class="at-badge-line${i === 0 ? " at-badge-primary" : ""}">${l}</div>`)
            .join("");
    }

    function abbreviateEvent(event) {
        const abbrevs = {
            "Tornado Warning": "TOR WRN",
            "Severe Thunderstorm Warning": "SVR TSW",
            "Tornado Watch": "TOR WCH",
            "Flash Flood Warning": "FFW",
            "Flood Warning": "FLW",
            "Winter Storm Warning": "WSW",
            "Winter Weather Advisory": "WWA",
            "Special Weather Statement": "SPS",
        };
        return abbrevs[event] || event;
    }

    // ── Debug infrastructure ──────────────────────────────────────────

    function setDecision(action, reason) {
        lastDecision = { action, reason, time: Date.now() };
    }

    function emitDebug() {
        StormState.emit("autotrackDebug", getDebugState());
    }

    function fmtScore(n) {
        return (Math.round(n * 10) / 10).toString();
    }

    function getDebugState() {
        const at = StormState.state.autotrack;
        const now = Date.now();

        // Phase 2: bridge stats
        const bridge = UnifiedTarget.getBridgeStats();

        return {
            state: {
                mode: at.mode,
                targetAlertId: currentTargetId ? currentTargetId.slice(-12) : null,
                targetEvent: at.targetEvent,
                targetScore: currentTargetScore ? fmtScore(currentTargetScore) : "—",
                followPaused: at.followPaused,
                radarPaused: at.radarPaused,
                radarSite: currentAutoRadarSite,
                autoAddedLayers: [...at.autoAddedLayers],
                activeLayers: [...StormState.state.radar.activeLayers],
                evalCount,
                rankingMode: lastRankingMode,
            },

            timers: {
                targetHoldRemain: lastTargetSelectTime
                    ? Math.max(0, Math.round((TARGET_HOLD_MS - (now - lastTargetSelectTime)) / 1000))
                    : "—",
                reframeCooldownRemain: lastReframeTime
                    ? Math.max(0, Math.round((REFRAME_COOLDOWN_MS - (now - lastReframeTime)) / 1000))
                    : "—",
                radarSiteHoldRemain: lastRadarSwitchTime
                    ? Math.max(0, Math.round((RADAR_SITE_HOLD_MS - (now - lastRadarSwitchTime)) / 1000))
                    : "—",
                followPauseRemain: (at.followPaused && followPauseTimer)
                    ? "active" : "—",
            },

            decision: {
                action: lastDecision.action,
                reason: lastDecision.reason,
                age: Math.round((now - lastDecision.time) / 1000) + "s ago",
            },

            candidates: lastCandidates.map(c => ({
                rank: c.rank,
                alertId: c.alertId ? c.alertId.slice(-12) : "—",
                event: c.event,
                score: c.score,
                breakdown: {
                    sev: `${fmtScore(c.breakdown.severity)}/${SEVERITY_SCORES.Extreme || 40} (${c.breakdown.factors.sev_input})`,
                    cert: `${fmtScore(c.breakdown.certainty)}/${CERTAINTY_SCORES.Observed || 25} (${c.breakdown.factors.cert_input})`,
                    evt: `${fmtScore(c.breakdown.event_type)}/${EVENT_SCORES["Tornado Warning"] || 30} (${c.breakdown.factors.evt_input})`,
                    dist: `${fmtScore(c.breakdown.distance)}/${DISTANCE_MAX_PTS} (${c.breakdown.factors.dist_mi}mi)`,
                    rec: `${fmtScore(c.breakdown.recency)}/${RECENCY_MAX_PTS} (${c.breakdown.factors.age_min}m)`,
                    mot: `${fmtScore(c.breakdown.motion)}/${MOTION_MAX_PTS} (${c.breakdown.factors.motion_data})`,
                    mot_detail: c.breakdown.factors.motion_detail || "",
                },
                rejection: c.rejection,
                // Phase 2 debug fields
                hasMotion: c.hasMotion || false,
                hasProjection: c.hasProjection || false,
                bridgeMatch: c.bridgeMatch,
            })),

            thresholds: {
                targetSwitch: TARGET_SWITCH_THRESHOLD,
                radarSwitch: RADAR_SWITCH_THRESHOLD + "km",
                targetHold: TARGET_HOLD_MS / 1000 + "s",
                reframeCooldown: REFRAME_COOLDOWN_MS / 1000 + "s",
                radarSiteHold: RADAR_SITE_HOLD_MS / 1000 + "s",
                userPause: USER_PAUSE_MS / 1000 + "s",
            },

            // Phase 2: bridge and radar details
            bridge,
            session: UnifiedTarget.getSessionStats(),
            radarSelection: lastRadarSelection,

            // Region filter stats
            filter: lastFilterStats,
            region: REGION,
            radarViabilityKm: RADAR_VIABILITY_KM,
        };
    }

    // ── Public API ────────────────────────────────────────────────────

    return { init, getDebugState };
})();
