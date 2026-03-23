/**
 * Storm Tracker — Prediction Card (Phase 1.5 Hardened)
 *
 * Displays "Next 15-60 min" prediction for the tracked storm.
 * Fetches from GET /api/prediction/summary.
 *
 * Hardened:
 * - Prediction age label
 * - Plain-language ETA wording
 * - Persistent disclaimer
 * - Full lifecycle cleanup on target loss/change/expire
 * - Suppressed predictions emit null to clear overlay
 * - Debug suppression reasons to console
 */
const PredictionCard = (function () {

    const POLL_INTERVAL = 15000;
    let pollTimer = null;
    let lastStormId = null;

    function init() {
        StormState.on("autotrackTargetChanged", onTargetChanged);
        StormState.on("autotrackChanged", onModeChanged);
    }

    function onTargetChanged(targetId) {
        // Full cleanup on ANY target change (including switch between storms)
        hide();

        if (!targetId) {
            stopPoll();
            lastStormId = null;
            return;
        }

        // New target — start fresh
        lastStormId = targetId;
        startPoll();
        fetchPrediction();
    }

    function onModeChanged(data) {
        if (data.mode === "off") {
            hide();
            stopPoll();
            lastStormId = null;
        }
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(fetchPrediction, POLL_INTERVAL);
    }

    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function fetchPrediction() {
        const at = StormState.state.autotrack;
        if (at.mode === "off" || !at.targetAlertId) {
            hide();
            return;
        }

        const loc = StormState.state.location;
        const lat = loc.lat || 39.5;
        const lon = loc.lon || -84.5;

        try {
            const resp = await fetch(`/api/prediction/summary?lat=${lat}&lon=${lon}`);
            if (!resp.ok) {
                hide();
                return;
            }
            const data = await resp.json();

            if (!data.prediction) {
                // No prediction — log reason to console for debug
                if (data.reason) {
                    console.debug(`[Prediction] Suppressed: ${data.reason} — ${data.message || ""}`);
                }
                hide();
                return;
            }

            const pred = data.prediction;

            // Check top-level suppression
            if (pred.suppressed) {
                console.debug(`[Prediction] Suppressed: ${pred.suppress_reason}`);
                hide();
                return;
            }

            // Check confidence suppression
            if (pred.quality && pred.quality.confidence_grade === "suppressed") {
                console.debug(`[Prediction] Suppressed: confidence_grade=suppressed`);
                hide();
                return;
            }

            render(pred);
        } catch (e) {
            // Silent — don't break UI
            hide();
        }
    }

    function render(pred) {
        const card = document.getElementById("prediction-card");
        if (!card) return;

        card.classList.remove("hidden");

        const proj = pred.projection;
        const eta = pred.eta;
        const sev = pred.severity_trend;
        const qual = pred.quality;

        // Grade badge
        const gradeClass = {
            high: "pred-high",
            moderate: "pred-moderate",
            low: "pred-low",
            very_low: "pred-vlow",
        }[qual.confidence_grade] || "pred-low";

        // Prediction age (how old is the underlying data)
        const ageSec = pred.data_age_sec || 0;
        const ageText = ageSec < 60 ? `${Math.round(ageSec)}s ago`
            : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago`
            : "stale";

        // Path horizons
        let pathHtml = "";
        if (!proj.suppressed && proj.points && proj.points.length > 0) {
            pathHtml = `<div class="pred-row">
                <span class="pred-label">Path</span>
                <span class="pred-val">${proj.points.map(p =>
                    `<span class="pred-horizon">${p.minutes}m <span class="pred-conf">${Math.round(p.confidence * 100)}%</span></span>`
                ).join(" ")}</span>
            </div>`;
        }

        // ETA — plain language
        let etaHtml = "";
        if (!eta.suppressed && eta.eta_minutes != null) {
            const mins = Math.round(eta.eta_minutes);
            let etaText;
            if (eta.eta_window) {
                const lo = Math.round(eta.eta_window.min);
                const hi = Math.round(eta.eta_window.max);
                etaText = `Arrives in roughly ${lo} to ${hi} min`;
            } else {
                etaText = `Arrives in ~${mins} min`;
            }
            etaHtml = `<div class="pred-row">
                <span class="pred-label">ETA</span>
                <span class="pred-val pred-eta">${etaText}</span>
            </div>`;
        }

        // CPA
        let cpaHtml = "";
        if (eta.cpa_distance_mi != null) {
            const cpaMin = Math.round(eta.cpa_time_minutes);
            const impactLabel = (eta.impact_type || "").replace(/_/g, " ");
            cpaHtml = `<div class="pred-row">
                <span class="pred-label">Closest</span>
                <span class="pred-val">${eta.cpa_distance_mi} mi in ~${cpaMin}m · ${impactLabel}</span>
            </div>`;
        }

        // Severity trend
        let sevHtml = "";
        if (sev && !sev.suppressed) {
            const trendIcon = {
                rapidly_intensifying: "\u2B06\u2B06",
                intensifying: "\u2B06",
                steady: "\u2194",
                weakening: "\u2B07",
                unknown: "?",
            }[sev.state] || "?";
            const stateLabel = (sev.state || "unknown").replace(/_/g, " ");
            sevHtml = `<div class="pred-row">
                <span class="pred-label">Trend</span>
                <span class="pred-val pred-trend-${sev.state}">${trendIcon} ${stateLabel}</span>
            </div>`;
            if (sev.signals && sev.signals.length > 0) {
                sevHtml += `<div class="pred-signals">${sev.signals.join(" · ")}</div>`;
            }
        }

        // Supporting signals (Phase 3)
        let contextHtml = "";
        const envCtx = pred.environment_context;
        const ltgCtx = pred.lightning_context;
        const drivers = qual.confidence_drivers || [];

        const contextParts = [];
        if (envCtx && !envCtx.suppressed && envCtx.category !== "unknown") {
            const envClass = envCtx.category === "favorable" ? "pred-ctx-good"
                : envCtx.category === "unfavorable" ? "pred-ctx-bad" : "pred-ctx-neutral";
            contextParts.push(`<span class="${envClass}">Env: ${envCtx.category}</span>`);
        }
        if (ltgCtx && !ltgCtx.suppressed && ltgCtx.state !== "unknown") {
            const ltgClass = ltgCtx.state === "increasing" ? "pred-ctx-good"
                : ltgCtx.state === "decreasing" ? "pred-ctx-bad" : "pred-ctx-neutral";
            contextParts.push(`<span class="${ltgClass}">Ltg: ${ltgCtx.state}</span>`);
        }
        if (contextParts.length > 0 || drivers.length > 0) {
            contextHtml = `<div class="pred-ctx">
                ${contextParts.join(" ")}
                ${drivers.length > 0 ? `<span class="pred-ctx-drivers">${drivers.join(" · ")}</span>` : ""}
            </div>`;
        }

        // Enriched confidence display
        const enrichedScore = qual.enriched_score != null ? qual.enriched_score : qual.confidence_score;
        const confPct = Math.round(enrichedScore * 100);

        card.innerHTML = `
            <div class="pred-header">
                <span class="pred-title">PROJECTION</span>
                <span class="pred-grade ${gradeClass}">${qual.confidence_grade} ${confPct}%</span>
                <span class="pred-age">${ageText}</span>
            </div>
            <div class="pred-body">
                ${pathHtml}
                ${etaHtml}
                ${cpaHtml}
                ${sevHtml}
                ${contextHtml}
            </div>
            <div class="pred-footer">
                <div class="pred-disclaimer-bar">App estimate — not an official NWS forecast</div>
                <div class="pred-quality">${qual.explanation || ""}</div>
            </div>
        `;

        // Emit for map overlay
        StormState.emit("predictionUpdated", pred);
    }

    function hide() {
        const card = document.getElementById("prediction-card");
        if (card) {
            card.classList.add("hidden");
            card.innerHTML = "";  // Full cleanup — no stale content
        }
        // Always clear overlay on hide
        StormState.emit("predictionUpdated", null);
    }

    return { init };
})();
