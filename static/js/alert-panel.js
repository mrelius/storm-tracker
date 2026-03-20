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
        // Panel toggle
        document.getElementById("btn-toggle-panel").addEventListener("click", () => {
            StormState.togglePanel();
        });

        StormState.on("panelToggled", (open) => {
            const panel = document.getElementById("alert-panel");
            panel.classList.toggle("panel-open", open);
            panel.classList.toggle("panel-closed", !open);
        });

        // Sort controls
        document.getElementById("sort-field").addEventListener("change", (e) => {
            StormState.setAlertSort(e.target.value);
            fetchAlerts();
        });

        document.getElementById("btn-sort-order").addEventListener("click", () => {
            const current = StormState.state.alerts.sortOrder;
            const next = current === "desc" ? "asc" : "desc";
            StormState.setAlertSort(StormState.state.alerts.sortBy, next);
            document.getElementById("btn-sort-order").textContent = next === "desc" ? "\u25BC" : "\u25B2";
            fetchAlerts();
        });

        // Filter controls
        document.querySelectorAll(".filter-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                StormState.setAlertCategory(btn.dataset.category || null);
                fetchAlerts();
            });
        });

        // Warnings-only toggle
        const warnBtn = document.getElementById("btn-warnings-toggle");
        if (warnBtn) {
            warnBtn.addEventListener("click", () => {
                StormState.state.alerts.warningsOnly = !StormState.state.alerts.warningsOnly;
                warnBtn.classList.toggle("active", StormState.state.alerts.warningsOnly);
                fetchAlerts();
            });
        }

        // Marine toggle
        const marineBtn = document.getElementById("btn-marine-toggle");
        if (marineBtn) {
            marineBtn.addEventListener("click", () => {
                StormState.state.alerts.showMarine = !StormState.state.alerts.showMarine;
                marineBtn.classList.toggle("active", StormState.state.alerts.showMarine);
                fetchAlerts();
            });
        }

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

        // Initial fetch + periodic refresh
        fetchAlerts();
        refreshTimer = setInterval(fetchAlerts, REFRESH_INTERVAL);
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

        // Update category count badges
        updateCategoryBadges(alerts);

        if (alerts.length === 0) {
            list.innerHTML = '<div class="alert-empty">No active alerts matching filter</div>';
            return;
        }

        list.innerHTML = alerts.map(a => buildAlertCard(a)).join("");

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
        const distText = alert.distance_km != null ? `${Math.round(alert.distance_km)} km` : "";
        const countdown = formatCountdown(alert.expires);
        const issued = formatTimeShort(alert.issued);
        const hasFocus = alert.polygon || (alert.county_fips && alert.county_fips.length > 0);

        return `<div class="alert-card ${cssClass}" data-alert-id="${escapeHtml(alert.id)}">
            <div class="alert-card-header">
                <span class="alert-event ${cssClass}">${escapeHtml(alert.event)}</span>
                <span class="alert-card-right">
                    ${distText ? `<span class="alert-distance">${distText}</span>` : ""}
                    ${hasFocus ? `<button class="alert-focus-btn" title="Focus on map">&#8982;</button>` : ""}
                </span>
            </div>
            <div class="alert-headline">${escapeHtml(alert.headline || "")}</div>
            <div class="alert-meta">
                <span>Issued: ${issued}</span>
                <span class="alert-countdown ${countdown.urgent ? 'countdown-urgent' : ''}">${countdown.text}</span>
            </div>
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
Counties: ${alert.county_fips.length} affected${alert.distance_km != null ? `\nDistance: ${Math.round(alert.distance_km)} km` : ""}</div>
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
