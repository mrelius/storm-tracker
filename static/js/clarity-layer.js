/**
 * Storm Tracker — Interpretation Layer (v5 — hardened semantics)
 *
 * All interpretation surfaces consume one authoritative context selector:
 * getPrimaryContextEvent().
 *
 * Resolution rules:
 *   1. pulse active + primaryInViewEventId → resolve by ID from canonical store
 *   2. autotrack enabled + targetAlertId   → resolve by ID from canonical store
 *   3. else                                → null
 *
 * During active pulse, NO fallback to autotrack target.
 * During active autotrack (no pulse), NO fallback to alerts[0].
 *
 * Banner semantics:
 *   The banner is a PASSIVE AMBIENT AWARENESS surface (type B).
 *   When the context selector returns an event, banner sourceMode = "context".
 *   When the selector returns null but alerts exist, banner falls back to
 *   alerts[0] with sourceMode = "passive" — ambient awareness only.
 *   When no alerts exist, sourceMode = "none" and banner shows calm state.
 *
 *   All other surfaces (ETA, confidence, narrative) are STRICT CONTEXT
 *   surfaces (type A) — they only render when the selector returns an event.
 *
 * Only context-pulse.js computes and publishes the ranked in-frame primary.
 * ClarityLayer consumes, never derives.
 *
 * Performance: banner max 1/sec, ETA max 1/12s, narrative immediate on
 * source change + 1s throttle for drift-only updates.
 */
const ClarityLayer = (function () {

    const BANNER_THROTTLE_MS = 1000;
    const ETA_INTERVAL_MS = 12000;
    const CONFIDENCE_DEBOUNCE_MS = 5000;
    const HIDE_DISTANCE_MI = 100;
    const NARRATIVE_DRIFT_THROTTLE_MS = 1000;

    let etaTimer = null;
    let lastBannerTime = 0;
    let lastConfidence = null;
    let lastConfidenceTime = 0;
    let simpleModeEnabled = false;

    // Source transition tracking (shared across all surfaces)
    let lastSourceId = null;
    let lastSourceContext = null;  // "pulse" | "tracking" | "none"
    let lastNarrativeRenderTime = 0;

    // Banner source mode tracking
    let bannerSourceMode = "none";     // "context" | "passive" | "none"
    let bannerSourceEventId = null;
    let lastBannerSourceMode = null;   // for transition logging
    let lastBannerSourceEventId = null;

    let log = null;

    function init() {
        if (typeof STLogger !== "undefined") {
            log = STLogger.for("clarity_layer");
        }

        simpleModeEnabled = localStorage.getItem("simple_mode") === "true";
        _applySimpleMode();

        StormState.on("autotrackTargetChanged", _throttledUpdate);
        StormState.on("alertsUpdated", _throttledUpdate);
        StormState.on("locationChanged", _throttledUpdate);

        etaTimer = setInterval(_updateETA, ETA_INTERVAL_MS);
        _update();
    }

    // ── Simple Mode ─────────────────────────────────────────────

    function toggleSimpleMode() {
        simpleModeEnabled = !simpleModeEnabled;
        localStorage.setItem("simple_mode", simpleModeEnabled);
        _applySimpleMode();
        _update();
    }

    function _applySimpleMode() {
        const app = document.getElementById("app");
        if (app) app.classList.toggle("simple-mode", simpleModeEnabled);
        const btn = document.getElementById("btn-simple-mode");
        if (btn) {
            btn.classList.toggle("active", simpleModeEnabled);
            btn.title = simpleModeEnabled ? "Simple Mode: ON" : "Simple Mode: OFF";
        }
    }

    // ── Context Selector (delegates to shared ContextSelector) ──

    function getPrimaryContextEvent() {
        return ContextSelector.getPrimaryContextEvent();
    }

    // ── Source Transition Logging ────────────────────────────────
    // One log per actual ID/context change, shared across all surfaces.

    function _checkSourceTransition(result) {
        const newContext = result ? result.context : "none";
        const newId = result ? result.event.id : null;

        if (newContext === lastSourceContext && newId === lastSourceId) return;

        if (log) {
            log.info("context_source_change", {
                context: newContext,
                event_id: newId ? newId.slice(-12) : null,
                prev_context: lastSourceContext,
                prev_event_id: lastSourceId ? lastSourceId.slice(-12) : null,
            });
        }

        lastSourceContext = newContext;
        lastSourceId = newId;
    }

    // Banner source mode transition logging — emits only on mode or event ID change
    function _checkBannerTransition(mode, eventId) {
        if (mode === lastBannerSourceMode && eventId === lastBannerSourceEventId) return;

        if (log) {
            log.info("banner_source_change", {
                mode: mode,
                event_id: eventId ? eventId.slice(-12) : null,
                prev_mode: lastBannerSourceMode,
                prev_event_id: lastBannerSourceEventId ? lastBannerSourceEventId.slice(-12) : null,
            });
        }

        lastBannerSourceMode = mode;
        lastBannerSourceEventId = eventId;
    }

    // ── Throttled Update ────────────────────────────────────────

    function _throttledUpdate() {
        const now = Date.now();
        if (now - lastBannerTime < BANNER_THROTTLE_MS) return;
        lastBannerTime = now;
        _update();
    }

    function _update() {
        const alerts = StormState.state.alerts.data || [];
        const loc = StormState.state.location;

        // Single selector call — all surfaces consume the same result
        const result = getPrimaryContextEvent();

        // Log context source transitions once (not per-surface)
        _checkSourceTransition(result);

        const primary = result ? result.event : null;

        // Banner: passive ambient awareness surface (type B)
        // Falls back to alerts[0] when context selector returns null
        let bannerEvent;
        if (primary) {
            bannerEvent = primary;
            bannerSourceMode = "context";
            bannerSourceEventId = primary.id;
        } else if (alerts.length > 0) {
            bannerEvent = alerts[0];
            bannerSourceMode = "passive";
            bannerSourceEventId = alerts[0].id;
        } else {
            bannerEvent = null;
            bannerSourceMode = "none";
            bannerSourceEventId = null;
        }

        _checkBannerTransition(bannerSourceMode, bannerSourceEventId);
        _renderBanner(bannerEvent, alerts, loc);

        // ETA, confidence, narrative: strict context surfaces (type A)
        // Only render for context events — null = hide
        _renderETA(primary, loc);
        _renderConfidence(primary);
        _renderNarrative(result, loc);
    }

    function _updateETA() {
        const loc = StormState.state.location;
        const result = getPrimaryContextEvent();
        const primary = result ? result.event : null;
        _renderETA(primary, loc);
    }

    // ── 1. Status Banner (type B: passive ambient awareness) ────
    // Format: [TYPE] — [DISTANCE] — [DIRECTION] — optional motion

    function _renderBanner(primary, alerts, loc) {
        const el = document.getElementById("clarity-banner");
        if (!el) return;

        if (!primary || alerts.length === 0) {
            el.textContent = "No active threats in your area";
            el.className = "clarity-banner cb-idle";
            return;
        }

        const parts = [];

        // Type
        parts.push(primary.event || "Alert");

        // Distance + direction
        if (primary.polygon && loc.lat && loc.lon) {
            try {
                const geo = JSON.parse(primary.polygon);
                const layer = L.geoJSON(geo);
                const b = layer.getBounds();
                if (b.isValid()) {
                    const c = b.getCenter();
                    const dist = _haversineMi(loc.lat, loc.lon, c.lat, c.lng);
                    const bearing = _bearing(loc.lat, loc.lon, c.lat, c.lng);
                    const dir = _cardinal(bearing);

                    if (dist < 3) {
                        parts.push("IN YOUR AREA");
                    } else {
                        parts.push(`${Math.round(dist)} mi ${dir}`);
                    }
                }
            } catch (e) {}
        } else if (primary.distance_mi != null) {
            parts.push(`${Math.round(primary.distance_mi)} mi`);
        }

        // Motion (if available from description)
        if (primary.description) {
            const motionMatch = primary.description.match(/moving\s+(north|south|east|west|northeast|northwest|southeast|southwest)\w*\s+at\s+(\d+)\s*mph/i);
            if (motionMatch) {
                parts.push(`Moving ${motionMatch[1]} at ${motionMatch[2]} mph`);
            }
        }

        const urgency = _getUrgency(primary);
        el.textContent = parts.join(" \u2014 ");
        el.className = `clarity-banner cb-${urgency}`;
    }

    function _getUrgency(alert) {
        if (!alert) return "idle";
        const evt = (alert.event || "").toLowerCase();
        if (evt.includes("tornado") && evt.includes("warning")) return "critical";
        if (evt.includes("severe") && evt.includes("thunderstorm") && evt.includes("warning")) return "high";
        if (evt.includes("tornado") && evt.includes("watch")) return "elevated";
        if (evt.includes("warning")) return "elevated";
        return "low";
    }

    // ── 2. ETA Engine (type A: strict context) ──────────────────

    function _renderETA(primary, loc) {
        const el = document.getElementById("clarity-eta");
        if (!el) return;

        if (!primary || !primary.polygon || !loc.lat || !loc.lon) {
            el.textContent = "";
            return;
        }

        try {
            const geo = JSON.parse(primary.polygon);
            const layer = L.geoJSON(geo);
            const b = layer.getBounds();
            if (!b.isValid()) { el.textContent = ""; return; }
            const c = b.getCenter();
            const dist = _haversineMi(loc.lat, loc.lon, c.lat, c.lng);

            // Hide if > threshold
            if (dist > HIDE_DISTANCE_MI) { el.textContent = ""; return; }

            // Try to extract motion for time-based ETA
            let etaMin = null;
            if (primary.description) {
                const motionMatch = primary.description.match(/moving\s+\w+\s+at\s+(\d+)\s*mph/i);
                if (motionMatch) {
                    const speed = parseInt(motionMatch[1]);
                    if (speed > 0 && dist > 3) {
                        etaMin = Math.round((dist / speed) * 60);
                    }
                }
            }

            if (dist < 3) {
                el.textContent = "IN YOUR AREA NOW";
                el.className = "clarity-eta ce-immediate";
            } else if (etaMin !== null && etaMin <= 90) {
                el.textContent = `ETA ~${etaMin}min`;
                el.className = etaMin <= 15 ? "clarity-eta ce-immediate" : etaMin <= 30 ? "clarity-eta ce-near" : "clarity-eta ce-far";
            } else {
                el.textContent = `${Math.round(dist)} mi`;
                el.className = dist < 20 ? "clarity-eta ce-near" : "clarity-eta ce-far";
            }
        } catch (e) {
            el.textContent = "";
        }
    }

    // ── 3. Confidence (type A: strict context) ──────────────────

    function _renderConfidence(primary) {
        const el = document.getElementById("clarity-confidence");
        if (!el) return;

        if (!primary) { el.textContent = ""; el.className = "clarity-confidence"; return; }

        const score = primary.priority_score || 0;
        let grade;
        if (score >= 80) grade = "HIGH";
        else if (score >= 40) grade = "MEDIUM";
        else grade = "LOW";

        const now = Date.now();
        if (grade === lastConfidence && now - lastConfidenceTime < CONFIDENCE_DEBOUNCE_MS) return;
        lastConfidence = grade;
        lastConfidenceTime = now;

        el.textContent = grade;
        el.className = `clarity-confidence cc-${grade.toLowerCase()}`;
    }

    // ── 4. Narrative (type A: strict context) ───────────────────

    function _renderNarrative(result, loc) {
        const el = document.getElementById("clarity-narrative");
        if (!el) return;

        // No source → hide immediately, no stale text
        if (!result) {
            el.textContent = "";
            return;
        }

        const { event: alert, context } = result;
        const eventId = alert.id;
        const now = Date.now();

        // Source change → immediate render
        const sourceChanged = eventId !== lastSourceId || context !== lastSourceContext;

        if (!sourceChanged && now - lastNarrativeRenderTime < NARRATIVE_DRIFT_THROTTLE_MS) {
            // Throttle drift-only updates
            return;
        }
        lastNarrativeRenderTime = now;

        // Build narrative with context prefix
        const prefix = context === "pulse" ? "[IN VIEW] " : "[TRACKING] ";
        const narrative = generateNarrative(alert, loc);

        if (!narrative) {
            el.textContent = "";
            return;
        }

        el.textContent = prefix + narrative;
    }

    function generateNarrative(alert, loc) {
        if (!alert) return "";
        const parts = [];

        // Direction from user
        if (alert.polygon && loc && loc.lat && loc.lon) {
            try {
                const geo = JSON.parse(alert.polygon);
                const layer = L.geoJSON(geo);
                const b = layer.getBounds();
                if (b.isValid()) {
                    const c = b.getCenter();
                    const dir = _cardinal(_bearing(loc.lat, loc.lon, c.lat, c.lng));
                    const dist = _haversineMi(loc.lat, loc.lon, c.lat, c.lng);
                    if (dist < 3) parts.push("Storm is over your location");
                    else parts.push(`Storm is ${Math.round(dist)} mi to your ${dir}`);
                }
            } catch (e) {}
        }

        // Hazard
        if (alert.description) {
            const hail = alert.description.match(/(\d[\d.]*)\s*inch\s*hail/i);
            const wind = alert.description.match(/(\d+)\s*mph\s*wind/i);
            if (hail) parts.push(`${hail[1]} inch hail reported`);
            if (wind) parts.push(`${wind[1]} mph winds`);

            const motion = alert.description.match(/moving\s+(north|south|east|west|northeast|northwest|southeast|southwest)\w*\s+at\s+(\d+)\s*mph/i);
            if (motion) parts.push(`Moving ${motion[1]} at ${motion[2]} mph`);
        }

        // Intensity from event type
        const evt = (alert.event || "").toLowerCase();
        if (evt.includes("tornado") && evt.includes("warning")) parts.push("Take shelter immediately");
        else if (evt.includes("severe")) parts.push("Seek shelter");

        return parts.join(". ") + (parts.length ? "." : "");
    }

    // ── 5. Notification Formatter ───────────────────────────────

    function formatNotification(alert, loc) {
        if (!alert) return "";
        const parts = [alert.event || "Alert"];
        if (alert.distance_mi != null) parts.push(`${Math.round(alert.distance_mi)} mi`);
        if (alert.description) {
            const hail = alert.description.match(/(\d[\d.]*)\s*inch\s*hail/i);
            const wind = alert.description.match(/(\d+)\s*mph/i);
            if (hail) parts.push(`${hail[1]}" hail`);
            if (wind) parts.push(`${wind[1]} mph`);
        }
        return parts.join(" · ");
    }

    // ── 6. Debug Surface ────────────────────────────────────────
    // Exposes derived state for the Shift+Alt+D debug panel.

    function getDebugState() {
        const result = getPrimaryContextEvent();
        return {
            primaryContextEventId: result ? result.event.id : null,
            primaryContextMode: result ? result.context : "none",
            bannerSourceEventId: bannerSourceEventId,
            bannerSourceMode: bannerSourceMode,
        };
    }

    // ── Helpers ─────────────────────────────────────────────────

    function _haversineMi(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    function _bearing(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1*Math.PI/180)*Math.sin(lat2*Math.PI/180) - Math.sin(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.cos(dLon);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    function _cardinal(deg) {
        const dirs = ["N","NE","E","SE","S","SW","W","NW"];
        return dirs[Math.round(deg / 45) % 8];
    }

    return { init, toggleSimpleMode, generateNarrative, formatNotification, getPrimaryContextEvent, getDebugState };
})();
