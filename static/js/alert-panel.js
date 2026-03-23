/**
 * Storm Tracker — Alert Side Panel (v2)
 * Collapsible panel with sorting, filtering, category counts,
 * alert-to-map focus, expiration countdown, and live distance updates.
 */
const AlertPanel = (function () {
    const REFRESH_INTERVAL = 30000;
    const DISTANCE_DEBOUNCE = 1500;
    let refreshTimer = null;
    let distanceDebounce = null;

    function init() {
        // Panel toggle (whole-panel open/close only)
        document.getElementById("btn-toggle-panel").addEventListener("click", () => {
            StormState.togglePanel();
        });

        StormState.on("panelToggled", (open) => {
            const panel = document.getElementById("alert-panel");
            panel.classList.toggle("panel-open", open);
            panel.classList.toggle("panel-closed", !open);
            // Shift legends and other right-anchored elements
            document.getElementById("app").classList.toggle("panel-is-closed", !open);
            updateCollapsedRail();
        });

        // Alert detail close
        document.getElementById("btn-detail-close").addEventListener("click", closeDetail);

        // Listen for alerts data updates
        StormState.on("alertsUpdated", renderAlertList);

        // Distance sort: re-fetch when map moves (debounced)
        StormMap.onMoveEnd(() => {
            if (StormState.state.alerts.sortBy === "distance") {
                clearTimeout(distanceDebounce);
                distanceDebounce = setTimeout(fetchAlerts, DISTANCE_DEBOUNCE);
            }
        });

        // Autotrack target highlight + collapsed rail
        StormState.on("autotrackTargetChanged", onAutotrackTarget);
        StormState.on("autotrackChanged", onAutotrackModeChange);

        // Collapsed rail click → reopen panel
        const rail = document.getElementById("at-collapsed-rail");
        if (rail) {
            rail.addEventListener("click", () => {
                if (!StormState.state.alerts.panelOpen) {
                    StormState.togglePanel();
                }
            });
        }

        // Initial fetch + periodic refresh
        fetchAlerts();
        refreshTimer = setInterval(fetchAlerts, REFRESH_INTERVAL);
    }

    // ── Collapsed Rail ──────────────────────────────────────────────────

    function onAutotrackTarget(alertId) {
        highlightTrackedAlert(alertId);
        updateCollapsedRail();
    }

    function onAutotrackModeChange(data) {
        updateCollapsedRail();
    }

    function updateCollapsedRail() {
        const rail = document.getElementById("at-collapsed-rail");
        if (!rail) return;

        const at = StormState.state.autotrack;
        const panelOpen = StormState.state.alerts.panelOpen;

        const appEl = document.getElementById("app");

        // Show rail only when: panel closed AND autotrack active AND has target
        if (panelOpen || at.mode === "off" || !at.targetAlertId) {
            rail.classList.add("hidden");
            if (appEl) appEl.classList.remove("rail-visible");
            return;
        }

        // Find the tracked alert in data
        const alert = StormState.state.alerts.data.find(a => a.id === at.targetAlertId);
        if (!alert) {
            rail.classList.add("hidden");
            if (appEl) appEl.classList.remove("rail-visible");
            return;
        }

        rail.classList.remove("hidden");
        if (appEl) appEl.classList.add("rail-visible");

        // Set bar background tint to match alert color
        const cssClass = getEventCssClass(alert.event);
        rail.className = "at-collapsed-rail at-bar-" + cssClass;
        const color = StormState.getEventColor(alert.event);
        const countdown = formatCountdown(alert.expires);
        const shortEvent = abbreviateEvent(alert.event);

        // Build scrolling ticker content from alert fields
        const tickerParts = [];
        if (alert.headline) tickerParts.push(alert.headline);
        if (alert.description) {
            // First ~200 chars of description for ticker
            const desc = alert.description.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
            tickerParts.push(desc.length > 200 ? desc.substring(0, 197) + "..." : desc);
        }
        if (alert.instruction) {
            const instr = alert.instruction.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
            tickerParts.push("ACTION: " + (instr.length > 150 ? instr.substring(0, 147) + "..." : instr));
        }
        const tickerText = tickerParts.join("  \u2014  ");  // em dash separator

        rail.innerHTML = `
            <div class="at-rail-fixed" style="border-left-color:${color}">
                <span class="at-rail-event ${cssClass}">${shortEvent}</span>
                <span class="at-rail-tracking">TRACKING</span>
                <span class="at-rail-meta">${countdown.text}</span>
            </div>
            <div class="at-rail-ticker">
                <span class="at-rail-ticker-text">${escapeHtml(tickerText)}</span>
            </div>
        `;
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

    /**
     * Highlight the autotrack-targeted alert in the panel list.
     * Scrolls to the card and adds a visual emphasis class.
     */
    function highlightTrackedAlert(alertId) {
        const list = document.getElementById("alert-list");
        if (!list) return;

        // Remove existing highlight and entry animation
        list.querySelectorAll(".alert-card.at-tracked").forEach(el => {
            el.classList.remove("at-tracked", "at-tracked-enter");
        });

        if (!alertId) return;

        // Find and highlight the matching card
        const card = list.querySelector(`.alert-card[data-alert-id="${CSS.escape(alertId)}"]`);
        if (!card) return;

        card.classList.add("at-tracked", "at-tracked-enter");

        // Remove entry animation class after it completes
        card.addEventListener("animationend", () => {
            card.classList.remove("at-tracked-enter");
        }, { once: true });

        // Only scroll into view when panel is open — scrollIntoView on a
        // translateX(100%) panel forces it visible, breaking collapsed state
        if (StormState.state.alerts.panelOpen) {
            card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }

    async function fetchAlerts() {
        const s = StormState.state;
        const params = new URLSearchParams({
            sort: s.alerts.sortBy,
            order: s.alerts.sortOrder,
            active: "true",
            marine: s.alerts.showMarine ? "true" : "false",
            warnings_only: s.alerts.warningsOnly ? "true" : "false",
        });

        if (s.alerts.category) {
            params.set("category", s.alerts.category);
        }

        // For distance sort, use map center; otherwise use user location
        if (s.alerts.sortBy === "distance") {
            const center = StormMap.getCenter();
            if (center) {
                params.set("lat", center.lat.toFixed(4));
                params.set("lon", center.lon.toFixed(4));
            }
        } else if (s.location.lat != null && s.location.lon != null) {
            params.set("lat", s.location.lat);
            params.set("lon", s.location.lon);
        }

        try {
            const resp = await fetch(`/api/alerts?${params}`);
            if (!resp.ok) throw new Error(`API error: ${resp.status}`);
            const data = await resp.json();
            StormState.setAlerts(data);
        } catch (e) {
            console.error("Failed to fetch alerts:", e);
        }
    }

    function renderAlertList(alerts) {
        const list = document.getElementById("alert-list");
        const countEl = document.getElementById("alert-count");
        countEl.textContent = alerts.length;

        // Toggle NWS section visibility based on data
        const nwsSection = document.getElementById("nws-alert-section");
        if (nwsSection) nwsSection.classList.toggle("hidden", alerts.length === 0);

        // Toggle section divider: visible only when both sections have data
        const divider = document.getElementById("panel-section-divider");
        const stormSection = document.getElementById("storm-alert-section");
        const stormHasData = stormSection && !stormSection.classList.contains("hidden");
        if (divider) divider.classList.toggle("hidden", !(stormHasData && alerts.length > 0));

        // Unified empty state: show only when neither section has data
        const emptyState = document.getElementById("panel-empty-state");
        if (emptyState) emptyState.classList.toggle("hidden", stormHasData || alerts.length > 0);

        if (alerts.length === 0) {
            list.innerHTML = "";
            return;
        }

        // Pin tracked alert to top of list
        const trackedId = StormState.state.autotrack.targetAlertId;
        let orderedAlerts = alerts;
        if (trackedId) {
            const tracked = alerts.find(a => a.id === trackedId);
            if (tracked) {
                orderedAlerts = [tracked, ...alerts.filter(a => a.id !== trackedId)];
            }
        }

        list.innerHTML = orderedAlerts.map(a => buildAlertCard(a)).join("");

        // Attach click handlers
        list.querySelectorAll(".alert-card").forEach((card) => {
            const id = card.dataset.alertId;
            const alert = alerts.find(a => a.id === id);
            if (!alert) return;

            // Click card body → show detail
            card.addEventListener("click", (e) => {
                if (e.target.closest(".alert-focus-btn")) return; // don't trigger on focus button
                showDetail(alert);
            });

            // Focus button → zoom map to alert
            const focusBtn = card.querySelector(".alert-focus-btn");
            if (focusBtn) {
                focusBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    StormMap.focusOnAlert(alert);
                });
            }
        });

        // Update map overlays
        AlertRenderer.fetchAndRender();

        // Re-apply autotrack highlight after DOM rebuild
        if (trackedId) {
            highlightTrackedAlert(trackedId);
        }
    }

    function updateCategoryBadges(alerts) {
        // Count unfiltered alerts by category
        const allAlerts = StormState.state.alerts.category ? null : alerts;

        document.querySelectorAll(".filter-btn").forEach((btn) => {
            const cat = btn.dataset.category;
            let badge = btn.querySelector(".cat-count");
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "cat-count";
                btn.appendChild(badge);
            }

            if (!cat) {
                // "All" button — show total
                badge.textContent = alerts.length || "";
            } else if (allAlerts) {
                // When showing all, count per category
                const count = allAlerts.filter(a => a.category === cat).length;
                badge.textContent = count || "";
            } else {
                badge.textContent = "";
            }
        });
    }

    function buildAlertCard(alert) {
        const cssClass = getEventCssClass(alert.event);
        const distText = alert.distance_mi != null ? `${Math.round(alert.distance_mi)} mi` : "";
        const countdown = formatCountdown(alert.expires);
        const issued = formatTimeShort(alert.issued);
        const hasFocus = alert.polygon || (alert.county_fips && alert.county_fips.length > 0);

        // Per-card expiry bar
        let expiryBar = "";
        if (alert.expires) {
            try {
                const expMs = new Date(alert.expires).getTime();
                const nowMs = Date.now();
                const remainMs = expMs - nowMs;
                if (remainMs > 0) {
                    const pct = Math.min(100, Math.max(2, (remainMs / (60 * 60000)) * 100));
                    const urgClass = remainMs < 300000 ? "ate-urgent" : remainMs < 900000 ? "ate-warning" : "";
                    expiryBar = `<div class="card-expiry-bar"><div class="card-expiry-fill ${urgClass}" style="width:${pct}%"></div></div>`;
                }
            } catch (e) { /* ok */ }
        }

        // Check if alert is currently in-view during pulse (visual hint only, does not alter ranking)
        const inViewIds = StormState.state.pulse.inViewEventIds || [];
        const isInView = StormState.state.camera.contextPulseActive && inViewIds.includes(alert.id);
        const inViewBadge = isInView ? '<span class="alert-in-view-badge">IN VIEW</span>' : '';

        return `<div class="alert-card ${cssClass}${isInView ? ' alert-in-view' : ''}" data-alert-id="${escapeHtml(alert.id)}">
            <div class="alert-card-header">
                <span class="alert-event ${cssClass}">${escapeHtml(alert.event)}</span>
                ${inViewBadge}
                <span class="alert-card-right">
                    ${distText ? `<span class="alert-distance">${distText}</span>` : ""}
                    <span class="alert-countdown ${countdown.urgent ? 'countdown-urgent' : ''}">${countdown.text}</span>
                    ${hasFocus ? `<button class="alert-focus-btn" title="Focus on map">&#8982;</button>` : ""}
                </span>
            </div>
            <div class="alert-headline">${escapeHtml(alert.headline || "")}</div>
            ${expiryBar}
        </div>`;
    }

    function showDetail(alert) {
        const detail = document.getElementById("alert-detail");
        const content = document.getElementById("detail-content");
        const color = StormState.getEventColor(alert.event);
        const countdown = formatCountdown(alert.expires);
        const hasFocus = alert.polygon || (alert.county_fips && alert.county_fips.length > 0);

        content.innerHTML = `
            <h3 style="color:${color}">${escapeHtml(alert.event)}</h3>
            ${hasFocus ? `<button class="detail-focus-btn" id="detail-focus-map">Focus on Map &#8982;</button>` : ""}
            <div class="detail-section">
                <div class="detail-label">Headline</div>
                <div class="detail-text">${escapeHtml(alert.headline || "N/A")}</div>
            </div>
            <div class="detail-section">
                <div class="detail-label">Description</div>
                <div class="detail-text">${escapeHtml(alert.description || "N/A")}</div>
            </div>
            ${alert.instruction ? `
            <div class="detail-section">
                <div class="detail-label">Instructions</div>
                <div class="detail-text">${escapeHtml(alert.instruction)}</div>
            </div>` : ""}
            <div class="detail-section">
                <div class="detail-label">Details</div>
                <div class="detail-text">Severity: ${alert.severity}
Urgency: ${alert.urgency}
Certainty: ${alert.certainty}
Issued: ${formatTimeLong(alert.issued)}
Expires: ${formatTimeLong(alert.expires)} (${countdown.text})
Sender: ${escapeHtml(alert.sender || "N/A")}
Counties: ${alert.county_fips.length} affected${alert.distance_mi != null ? `\nDistance: ${Math.round(alert.distance_mi)} mi` : ""}</div>
            </div>`;

        // Wire focus button
        const focusBtn = document.getElementById("detail-focus-map");
        if (focusBtn) {
            focusBtn.addEventListener("click", () => StormMap.focusOnAlert(alert));
        }

        detail.classList.remove("hidden");
    }

    function closeDetail() {
        document.getElementById("alert-detail").classList.add("hidden");
    }

    function formatCountdown(isoExpires) {
        if (!isoExpires) return { text: "--", urgent: false };
        try {
            const exp = new Date(isoExpires);
            const now = Date.now();
            const diffMs = exp.getTime() - now;

            if (diffMs <= 0) return { text: "EXPIRED", urgent: true };

            const mins = Math.floor(diffMs / 60000);
            const hrs = Math.floor(mins / 60);
            const remMins = mins % 60;

            if (hrs > 0) {
                return { text: `${hrs}h ${remMins}m left`, urgent: hrs < 1 };
            }
            return { text: `${mins}m left`, urgent: mins < 30 };
        } catch (e) {
            return { text: "--", urgent: false };
        }
    }

    function getEventCssClass(event) {
        switch (event) {
            case "Tornado Warning": return "tor-warn";
            case "Severe Thunderstorm Warning": return "svr-warn";
            case "Tornado Watch": return "tor-watch";
            case "Flood Warning":
            case "Flash Flood Warning": return "flood";
            case "Winter Storm Warning":
            case "Winter Weather Advisory": return "winter";
            default: return "info";
        }
    }

    function formatTimeShort(iso) {
        if (!iso) return "--";
        try {
            return new Date(iso).toLocaleString([], {
                month: "short", day: "numeric",
                hour: "2-digit", minute: "2-digit",
            });
        } catch (e) { return iso; }
    }

    function formatTimeLong(iso) {
        if (!iso) return "--";
        try { return new Date(iso).toLocaleString(); }
        catch (e) { return iso; }
    }

    function escapeHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    return { init, fetchAlerts };
})();
