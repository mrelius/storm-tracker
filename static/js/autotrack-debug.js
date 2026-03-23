/**
 * Storm Tracker — Auto-Track Debug Panel
 *
 * Hidden by default. Toggle with Shift+Alt+D or Ctrl+Shift+.
 * Shows real-time autotrack internals: state, last decision, candidate scoring.
 *
 * Zero production UX impact when hidden.
 * Updates on every autotrackDebug event (eval tick, mode change, pause, target switch, etc).
 */
const AutoTrackDebug = (function () {

    let panel = null;
    let visible = false;

    function init() {
        // Keyboard shortcuts
        document.addEventListener("keydown", (e) => {
            // Shift+Alt+D
            if (e.shiftKey && e.altKey && e.key === "D") {
                e.preventDefault();
                toggle();
                return;
            }
            // Ctrl+Shift+.
            if (e.ctrlKey && e.shiftKey && e.key === ">") {
                e.preventDefault();
                toggle();
                return;
            }
        });

        // Listen for debug events from AutoTrack and AudioFollow
        StormState.on("autotrackDebug", render);
        StormState.on("audioFollowDebug", onAudioFollowDebug);
    }

    let lastAudioFollowDbg = null;

    function onAudioFollowDebug(dbg) {
        lastAudioFollowDbg = dbg;
        // If visible, re-render with latest autotrack state
        if (visible) {
            try {
                render(AutoTrack.getDebugState());
            } catch (e) { /* ok */ }
        }
    }

    function toggle() {
        visible = !visible;
        ensurePanel();
        panel.classList.toggle("hidden", !visible);
        if (visible) {
            // Render immediately with current state
            try {
                render(AutoTrack.getDebugState());
            } catch (e) {
                // AutoTrack may not have state yet
            }
        }
    }

    function ensurePanel() {
        if (panel) return;
        panel = document.getElementById("autotrack-debug-panel");
        if (!panel) {
            panel = document.createElement("div");
            panel.id = "autotrack-debug-panel";
            panel.className = "at-debug-panel hidden";
            document.getElementById("app").appendChild(panel);
        }
    }

    function render(dbg) {
        if (!visible) return;
        ensurePanel();
        if (!dbg) return;

        const s = dbg.state;
        const t = dbg.timers;
        const d = dbg.decision;
        const th = dbg.thresholds;

        let html = "";

        // ── Section: Camera Ownership ──
        if (typeof Camera !== "undefined") {
            const cd = Camera.getDebugState();
            const ownerColor = {
                idle: "at-dbg-dim", gps: "at-dbg-ok",
                autotrack: "at-dbg-purple", pulse: "at-dbg-warn",
            }[cd.owner] || "at-dbg-dim";
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title" style="color:#60a5fa;">CAMERA</div>`;
            html += row("owner", `<span class="${ownerColor}">${cd.owner}</span> (${cd.since})`);
            html += row("pulse", StormState.state.camera.contextPulseActive
                ? `<span class="at-dbg-warn">active</span>` : `<span class="at-dbg-dim">idle</span>`);
            html += row("last", `${cd.lastOwner} → ${cd.owner}`);
            html += row("reason", `<span class="at-dbg-dim">${esc(cd.reason)}</span>`);
            html += `</div>`;
        }

        // ── Section: Current State ──
        html += `<div class="at-dbg-section">`;
        html += `<div class="at-dbg-title">CURRENT STATE</div>`;
        html += row("mode", modeLabel(s.mode));
        html += row("target", s.targetAlertId
            ? `<span class="at-dbg-hi">${esc(s.targetEvent)}</span> <span class="at-dbg-dim">…${esc(s.targetAlertId)}</span>`
            : `<span class="at-dbg-dim">none</span>`);
        html += row("score", s.targetScore);
        html += row("ranking", s.rankingMode === "distance"
            ? `<span class="at-dbg-warn">distance</span>`
            : s.rankingMode === "severity_fallback"
            ? `<span class="at-dbg-warn">severity (dist fallback)</span>`
            : `<span class="at-dbg-dim">severity</span>`);
        html += row("followPaused", flagLabel(s.followPaused));
        html += row("radarPaused", flagLabel(s.radarPaused));
        html += row("radarSite", s.radarSite || `<span class="at-dbg-dim">none</span>`);
        html += row("autoAdded", s.autoAddedLayers.length > 0
            ? s.autoAddedLayers.join(", ")
            : `<span class="at-dbg-dim">none</span>`);
        html += row("activeLayers", s.activeLayers.length > 0
            ? s.activeLayers.join(", ")
            : `<span class="at-dbg-dim">none</span>`);
        html += row("evalCount", s.evalCount);
        html += `</div>`;

        // ── Section: Timers ──
        html += `<div class="at-dbg-section">`;
        html += `<div class="at-dbg-title">TIMERS</div>`;
        html += row("targetHold", timerLabel(t.targetHoldRemain, th.targetHold));
        html += row("reframeCd", timerLabel(t.reframeCooldownRemain, th.reframeCooldown));
        html += row("radarHold", timerLabel(t.radarSiteHoldRemain, th.radarSiteHold));
        html += row("followPause", t.followPauseRemain !== "—" ? `<span class="at-dbg-warn">active</span> (${th.userPause})` : `<span class="at-dbg-dim">—</span>`);
        html += `</div>`;

        // ── Section: Region Filter ──
        if (dbg.filter) {
            const f = dbg.filter;
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title">FILTER</div>`;
            html += row("eligible", `<span class="at-dbg-ok">${f.eligible}</span> / ${f.total + f.noSpatial}`);
            if (f.outOfRegion > 0) html += row("out of region", `<span class="at-dbg-warn">${f.outOfRegion}</span>`);
            if (f.noRadar > 0) html += row("no radar", `<span class="at-dbg-warn">${f.noRadar}</span>`);
            if (f.noSpatial > 0) html += row("no spatial", `<span class="at-dbg-dim">${f.noSpatial}</span>`);
            if (dbg.region) {
                const r = dbg.region;
                html += `<div class="at-dbg-factors" style="margin-top:2px;">region: ${r.south}–${r.north}N ${r.west}–${r.east}W</div>`;
            }
            html += `</div>`;
        }

        // ── Section: Last Decision ──
        html += `<div class="at-dbg-section">`;
        html += `<div class="at-dbg-title">LAST DECISION</div>`;
        html += row("action", decisionLabel(d.action));
        html += `<div class="at-dbg-reason">${esc(d.reason)}</div>`;
        html += `<div class="at-dbg-age">${esc(d.age)}</div>`;
        html += `</div>`;

        // ── Section: Top Candidates ──
        html += `<div class="at-dbg-section">`;
        html += `<div class="at-dbg-title">TOP CANDIDATES (${dbg.candidates.length})</div>`;

        if (dbg.candidates.length === 0) {
            html += `<div class="at-dbg-dim" style="padding:2px 0;">No scored candidates</div>`;
        }

        for (const c of dbg.candidates) {
            const isCurrent = s.targetAlertId && c.alertId === s.targetAlertId;
            html += `<div class="at-dbg-candidate${isCurrent ? " at-dbg-current" : ""}">`;
            html += `<div class="at-dbg-cand-header">`;
            html += `<span class="at-dbg-rank">#${c.rank}</span> `;
            html += `<span class="at-dbg-hi">${esc(c.event)}</span> `;
            html += `<span class="at-dbg-score">${c.score}</span>`;
            if (c.distanceMi != null) {
                const distCls = c.distanceValid ? "at-dbg-ok" : "at-dbg-warn";
                html += ` <span class="${distCls}" style="font-size:7px;">${c.distanceMi}mi</span>`;
            }
            if (isCurrent) html += ` <span class="at-dbg-active-tag">ACTIVE</span>`;
            html += `</div>`;
            html += `<div class="at-dbg-dim" style="font-size:8px;">…${esc(c.alertId)}</div>`;

            // Factor breakdown
            const b = c.breakdown;
            html += `<div class="at-dbg-factors">`;
            html += factor("sev", b.sev);
            html += factor("cert", b.cert);
            html += factor("evt", b.evt);
            html += factor("dist", b.dist);
            html += factor("rec", b.rec);
            html += factor("mot", b.mot);
            html += `</div>`;

            // Phase 2: motion detail
            if (b.mot_detail) {
                html += `<div class="at-dbg-dim" style="font-size:7px;margin-top:1px;">motion: ${esc(b.mot_detail)}</div>`;
            }

            // Phase 2: bridge match info
            if (c.bridgeMatch) {
                const bm = c.bridgeMatch;
                const method = bm.matchMethod || "?";
                const methodColor = method === "source_id" ? "at-dbg-ok" : "at-dbg-warn";
                const dist = bm.matchMethod === "centroid" && bm.matchDistance != null ? ` @ ${bm.matchDistance}mi` : "";
                const nwsId = bm.nwsAlertId ? ` nws:…${esc(bm.nwsAlertId.slice(-12))}` : "";
                html += `<div class="at-dbg-dim" style="font-size:7px;">bridge: <span class="${methodColor}">${esc(method)}</span> ${esc(bm.stormType)}${dist}${nwsId}</div>`;
                html += `<div class="at-dbg-dim" style="font-size:7px;">storm: ${esc(bm.stormAlertId || "?")}</div>`;
            }
            if (c.hasMotion) {
                html += `<span class="at-dbg-factor" style="color:#22c55e;font-size:7px;">MOT</span>`;
            }
            if (c.hasProjection) {
                html += `<span class="at-dbg-factor" style="color:#f59e0b;font-size:7px;">PATH</span>`;
            }

            // Rejection reason
            if (c.rejection) {
                html += `<div class="at-dbg-rejection">${esc(c.rejection)}</div>`;
            }

            html += `</div>`;
        }

        html += `</div>`;

        // ── Section: Bridge Stats (Phase 2) ──
        if (dbg.bridge) {
            const br = dbg.bridge;
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title">BRIDGE</div>`;
            html += row("stormAlerts", br.stormAlertCount || 0);
            html += row("matched", `<span class="at-dbg-ok">${br.matched}</span>`);
            html += row("unmatched", br.unmatched > 0 ? `<span class="at-dbg-warn">${br.unmatched}</span>` : `<span class="at-dbg-dim">${br.unmatched}</span>`);
            if (br.byMethod) {
                html += row("by method", `id:${br.byMethod.source_id || 0} ctr:${br.byMethod.centroid || 0} none:${br.byMethod.none || 0}`);
            }
            html += row("cacheAge", br.cacheAge != null ? `${br.cacheAge}s` : `<span class="at-dbg-dim">—</span>`);
            if (br.mismatches && br.mismatches.length > 0) {
                html += `<div class="at-dbg-dim" style="font-size:7px;margin-top:2px;">`;
                for (const m of br.mismatches.slice(0, 3)) {
                    html += `${esc(m.event)} …${esc(m.nwsId)}: ${esc(m.reason)}<br>`;
                }
                html += `</div>`;
            }
            html += `</div>`;
        }

        // ── Section: Radar Selection (Phase 2 — interrogation transparency) ──
        if (dbg.radarSelection) {
            const rs = dbg.radarSelection;
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title">RADAR SELECTION</div>`;
            html += row("selected", `<span class="at-dbg-purple">${esc(rs.selected)}</span>`);
            html += row("reason", esc(rs.reason));
            if (rs.centroid) {
                html += row("centroid", `${rs.centroid.lat.toFixed(2)}, ${rs.centroid.lon.toFixed(2)}`);
            }
            if (rs.candidates) {
                html += `<div class="at-dbg-factors" style="margin-top:2px;">`;
                for (const c of rs.candidates) {
                    const isSel = c.site_id === rs.selected;
                    html += `<span class="at-dbg-factor${isSel ? ' at-dbg-purple' : ''}">${c.site_id}: ${c.distance_km}km</span>`;
                }
                html += `</div>`;
            }
            html += `</div>`;
        }

        // ── Section: Session Stats ──
        if (dbg.session) {
            const ss = dbg.session;
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title">SESSION</div>`;
            html += row("duration", `${ss.durationSec || 0}s`);
            html += row("evals", ss.evalCount || 0);
            html += row("scored", ss.total_alerts_scored || 0);
            html += row("id matches", ss.source_id > 0 ? `<span class="at-dbg-ok">${ss.source_id}</span>` : `<span class="at-dbg-dim">0</span>`);
            html += row("ctr matches", ss.centroid > 0 ? `<span class="at-dbg-ok">${ss.centroid}</span>` : `<span class="at-dbg-dim">0</span>`);
            html += row("ambig reject", ss.ambiguous_rejected > 0 ? `<span class="at-dbg-warn">${ss.ambiguous_rejected}</span>` : `<span class="at-dbg-dim">0</span>`);
            html += row("unmatched", `<span class="at-dbg-dim">${ss.unmatched || 0}</span>`);
            html += `</div>`;
        }

        // ── Section: Audio Follow ──
        const afd = lastAudioFollowDbg || (typeof AudioFollow !== "undefined" ? AudioFollow.getDebugState() : null);
        if (afd) {
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title" style="color:#3b82f6;">AUDIO FOLLOW</div>`;
            html += row("enabled", afd.enabled ? `<span class="at-dbg-ok">true</span>` : `<span class="at-dbg-dim">false</span>`);
            html += row("owner", afd.owner ? (afd.owner === "manual" ? `<span class="at-dbg-warn">${afd.owner}</span>` : `<span class="at-dbg-ok">${afd.owner}</span>`) : `<span class="at-dbg-dim">none</span>`);
            html += row("source", afd.currentSource ? `<span class="at-dbg-hi">${afd.currentSource}</span>` : `<span class="at-dbg-dim">none</span>`);
            html += row("targetEvent", afd.targetEvent || `<span class="at-dbg-dim">none</span>`);
            html += row("status", audioFollowStatusLabel(afd.status));
            html += row("manualOverride", flagLabel(afd.manualOverride));
            html += row("preferred", afd.preferredSource || `<span class="at-dbg-dim">—</span>`);
            html += row("fallback", afd.fallbackSource || `<span class="at-dbg-dim">—</span>`);
            html += row("actual", afd.actualSource || `<span class="at-dbg-dim">—</span>`);

            // Timers
            html += `<div class="at-dbg-factors" style="margin-top:3px;">`;
            html += `stab: ${afd.stabilityRemain || 0}s · deb: ${afd.debounceRemain || 0}s · cd: ${afd.cooldownRemain || 0}s · grace: ${afd.graceRemain || 0}s`;
            html += `</div>`;

            // Stream health
            if (afd.streamHealth) {
                html += `<div class="at-dbg-factors" style="margin-top:2px;">`;
                html += `noaa: ${streamHealthLabel(afd.streamHealth.noaa)} · spotter: ${streamHealthLabel(afd.streamHealth.spotter || "unchecked")} · scanner: ${streamHealthLabel(afd.streamHealth.scanner)}`;
                html += `</div>`;
            }

            // Last decision
            if (afd.lastDecision) {
                const ld = afd.lastDecision;
                const age = ld.timestamp ? Math.round((Date.now() - ld.timestamp) / 1000) + "s" : "?";
                html += `<div class="at-dbg-reason" style="margin-top:3px;font-size:8px;">`;
                html += `${esc(ld.reason || "?")} → ${esc(ld.chosen || "none")} (${age} ago)`;
                if (ld.targetEvent) html += ` [${esc(ld.targetEvent)}]`;
                html += `</div>`;
            }

            // Pending switch
            if (afd.pendingSwitch) {
                html += `<div class="at-dbg-dim" style="font-size:8px;">pending: ${esc(afd.pendingSwitch.source)} (${esc(afd.pendingSwitch.reason)})</div>`;
            }

            html += `</div>`;
        }

        // ── Section: Switch Sound ──
        const ssd = typeof ATSwitchSound !== "undefined" ? ATSwitchSound.getDebugState() : null;
        if (ssd) {
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title" style="color:#f59e0b;">SWITCH SOUND</div>`;
            html += row("enabled", ssd.enabled ? `<span class="at-dbg-ok">true</span>` : `<span class="at-dbg-dim">false</span>`);
            html += row("current", ssd.currentTargetId || `<span class="at-dbg-dim">none</span>`);
            html += row("previous", ssd.previousTargetId || `<span class="at-dbg-dim">none</span>`);
            html += row("lastSound", ssd.lastSoundAge || `<span class="at-dbg-dim">never</span>`);
            html += row("cooldown", ssd.cooldownRemain > 0 ? `<span class="at-dbg-warn">${ssd.cooldownRemain}s</span>` : `<span class="at-dbg-dim">0</span>`);
            html += row("suppressed", ssd.suppressed ? `<span class="at-dbg-warn">${ssd.suppressReason}</span>` : `<span class="at-dbg-dim">false</span>`);
            html += `</div>`;
        }

        // ── Section: Context Pulse ──
        const cpd = typeof ContextPulse !== "undefined" ? ContextPulse.getDebugState() : null;
        if (cpd) {
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title" style="color:#818cf8;">CONTEXT PULSE</div>`;
            html += row("enabled", cpd.enabled ? `<span class="at-dbg-ok">true</span>` : `<span class="at-dbg-dim">false</span>`);
            const phaseColor = cpd.phase === "idle" ? "at-dbg-dim" : "at-dbg-warn";
            html += row("phase", `<span class="${phaseColor}">${cpd.phase}</span>`);
            html += row("session", cpd.sessionId ? `<span class="at-dbg-ok">${cpd.sessionId.slice(-12)}</span>` : `<span class="at-dbg-dim">null</span>`);
            if (cpd.startedAt) html += row("started", `<span class="at-dbg-dim">${cpd.startedAt}</span>`);
            html += row("cooldown", cpd.cooldownRemaining > 0 ? `<span class="at-dbg-warn">${cpd.cooldownRemaining}s</span>` : `<span class="at-dbg-dim">0</span>`);
            html += row("preZoom", cpd.prePulseZoom != null ? cpd.prePulseZoom : `<span class="at-dbg-dim">—</span>`);
            html += row("pulseZoom", cpd.pulseTargetZoom != null ? cpd.pulseTargetZoom : `<span class="at-dbg-dim">—</span>`);
            html += row("camMode", cpd.cameraMode ? `<span class="at-dbg-ok">${cpd.cameraMode}</span>` : `<span class="at-dbg-dim">none</span>`);
            html += row("sysMotion", cpd.systemMotionActive ? `<span class="at-dbg-warn">${cpd.systemMotionSource}</span>` : `<span class="at-dbg-dim">idle</span>`);
            html += row("scheduler", cpd.schedulerNextRun ? `<span class="at-dbg-dim">${cpd.schedulerNextRun}</span>` : `<span class="at-dbg-dim">off</span>`);
            html += row("stability", cpd.stabilityOk ? `<span class="at-dbg-ok">ok</span>` : `<span class="at-dbg-warn">unstable</span>`);
            html += row("suppress", cpd.lastSuppressReason ? `<span class="at-dbg-warn">${cpd.lastSuppressReason}</span>` : `<span class="at-dbg-dim">none</span>`);
            html += row("interval", cpd.intervalRunning ? `<span class="at-dbg-ok">running</span>` : `<span class="at-dbg-dim">stopped</span>`);
            html += row("ctxPolicy", cpd.contextRankingPolicy ? `<span class="at-dbg-ok">${cpd.contextRankingPolicy}</span>` : `<span class="at-dbg-dim">—</span>`);
            html += row("inView", (cpd.inViewEventIds || []).length > 0 ? `<span class="at-dbg-ok">${cpd.inViewEventIds.length} (${(cpd.newlyInViewEventIds || []).length} new)</span>` : `<span class="at-dbg-dim">0</span>`);
            html += row("baseline", (cpd.lastPulseInViewEventIds || []).length > 0 ? `<span class="at-dbg-dim">${cpd.lastPulseInViewEventIds.length}</span>` : `<span class="at-dbg-dim">0</span>`);
            if (cpd.topRankedScores && cpd.topRankedScores.length > 0) {
                const scoreStr = cpd.topRankedScores.map(s => `${s.id}:${s.score}`).join(" · ");
                html += row("topScores", `<span class="at-dbg-dim">${scoreStr}</span>`);
            }
            html += `</div>`;
        }

        // ── Section: Interpretation Layer ──
        const cld = typeof ClarityLayer !== "undefined" && ClarityLayer.getDebugState ? ClarityLayer.getDebugState() : null;
        if (cld) {
            html += `<div class="at-dbg-section">`;
            html += `<div class="at-dbg-title" style="color:#38bdf8;">INTERPRETATION</div>`;
            const ctxColor = cld.primaryContextMode === "pulse" ? "at-dbg-purple" : cld.primaryContextMode === "tracking" ? "at-dbg-ok" : "at-dbg-dim";
            html += row("contextMode", `<span class="${ctxColor}">${cld.primaryContextMode}</span>`);
            html += row("contextEventId", cld.primaryContextEventId ? `<span class="at-dbg-ok">${cld.primaryContextEventId.slice(-12)}</span>` : `<span class="at-dbg-dim">null</span>`);
            const bColor = cld.bannerSourceMode === "context" ? "at-dbg-ok" : cld.bannerSourceMode === "passive" ? "at-dbg-warn" : "at-dbg-dim";
            html += row("bannerMode", `<span class="${bColor}">${cld.bannerSourceMode}</span>`);
            html += row("bannerEventId", cld.bannerSourceEventId ? `<span class="at-dbg-ok">${cld.bannerSourceEventId.slice(-12)}</span>` : `<span class="at-dbg-dim">null</span>`);
            html += `</div>`;
        }

        // ── Section: Thresholds (collapsed) ──
        html += `<div class="at-dbg-section at-dbg-thresholds">`;
        html += `<div class="at-dbg-title at-dbg-dim">THRESHOLDS</div>`;
        html += `<div class="at-dbg-factors">`;
        html += `targetSwitch: ${th.targetSwitch} · radarSwitch: ${th.radarSwitch} · hold: ${th.targetHold} · cd: ${th.reframeCooldown} · radar: ${th.radarSiteHold} · pause: ${th.userPause}`;
        html += `</div>`;
        html += `</div>`;

        panel.innerHTML = html;
    }

    // ── Helpers ──

    function row(label, value) {
        return `<div class="at-dbg-row"><span class="at-dbg-label">${label}</span><span class="at-dbg-val">${value}</span></div>`;
    }

    function factor(label, value) {
        return `<span class="at-dbg-factor">${label}: ${esc(String(value))}</span>`;
    }

    function modeLabel(mode) {
        const colors = { off: "at-dbg-dim", track: "at-dbg-ok", interrogate: "at-dbg-purple" };
        return `<span class="${colors[mode] || ""}">${mode}</span>`;
    }

    function flagLabel(val) {
        return val
            ? `<span class="at-dbg-warn">true</span>`
            : `<span class="at-dbg-dim">false</span>`;
    }

    function timerLabel(remain, total) {
        if (remain === "—" || remain === 0) return `<span class="at-dbg-dim">— (${total})</span>`;
        return `<span class="at-dbg-warn">${remain}s</span> <span class="at-dbg-dim">(${total})</span>`;
    }

    function decisionLabel(action) {
        const cls = {
            target_switch: "at-dbg-ok",
            same_target: "at-dbg-dim",
            hold_block: "at-dbg-warn",
            hysteresis_block: "at-dbg-warn",
            no_target: "at-dbg-warn",
            follow_paused: "at-dbg-warn",
            follow_resumed: "at-dbg-ok",
            radar_paused: "at-dbg-warn",
            radar_resumed: "at-dbg-ok",
            radar_switch: "at-dbg-purple",
            mode_change: "at-dbg-ok",
            mode_off: "at-dbg-dim",
            init: "at-dbg-dim",
        };
        return `<span class="${cls[action] || ""}">${action}</span>`;
    }

    function audioFollowStatusLabel(status) {
        const cls = {
            idle: "at-dbg-dim",
            live: "at-dbg-ok",
            pending: "at-dbg-warn",
            unavailable: "at-dbg-warn",
            grace: "at-dbg-warn",
        };
        return `<span class="${cls[status] || "at-dbg-dim"}">${status || "idle"}</span>`;
    }

    function streamHealthLabel(health) {
        const cls = {
            ok: "at-dbg-ok",
            degraded: "at-dbg-warn",
            failed: "at-dbg-warn",
            unchecked: "at-dbg-dim",
            unknown: "at-dbg-dim",
        };
        return `<span class="${cls[health] || "at-dbg-dim"}">${health || "?"}</span>`;
    }

    function esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init };
})();
