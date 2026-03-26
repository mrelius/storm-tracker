/**
 * Storm Tracker — Alert Renderer
 * Handles county coloring and warning polygon overlays on the map.
 * Integrates with PolygonVisuals for context zoom cluster differentiation.
 */
const AlertRenderer = (function () {
    let map = null;
    let polygonLayer = null;

    // Alert layer visibility (set by Settings)
    let layerVis = { showPrimary: true, showSecondary: true, showWarnings: true, showMarine: false };

    function init(leafletMap) {
        map = leafletMap;
        polygonLayer = L.layerGroup().addTo(map);

        StormState.on("alertLayerVisibilityChanged", (vis) => {
            layerVis = vis;
            renderPolygons();
        });

        // Re-render on tracked target change to update highlight
        StormState.on("autotrackTargetChanged", () => renderPolygons());
    }

    async function fetchAndRender() {
        await Promise.all([
            renderCountyColors(),
            renderPolygons(),
        ]);
    }

    async function renderCountyColors() {
        try {
            const resp = await fetch("/api/alerts/counties");
            if (!resp.ok) return;
            const data = await resp.json();
            StormMap.colorCounties(data.counties || {});
        } catch (e) {
            console.error("Failed to fetch county colors:", e);
        }
    }

    async function renderPolygons() {
        polygonLayer.clearLayers();
        const alerts = StormState.state.alerts.data;
        const trackedId = StormState.state.autotrack.targetAlertId;
        const polyVisualsActive = typeof PolygonVisuals !== "undefined" && PolygonVisuals.isActive();

        for (const alert of alerts) {
            if (!alert.polygon) continue;

            // Category visibility filter
            const cat = alert.category || "";
            if (cat === "primary" && !layerVis.showPrimary) continue;
            if (cat === "secondary" && !layerVis.showSecondary) continue;
            const isMarine = /marine|coastal|surf|rip current|small craft|gale|seas/i.test(alert.event);
            if (isMarine && !layerVis.showMarine) continue;

            try {
                const geojson = JSON.parse(alert.polygon);
                const isTracked = trackedId && alert.id === trackedId;

                // Check for context zoom visual overrides
                const ctxStyle = polyVisualsActive ? PolygonVisuals.getPolygonStyle(alert.id) : null;

                // Check SPC intersection for glow enhancement
                const spcCat = (typeof PolygonVisuals !== "undefined" && PolygonVisuals.isSpcBlendingActive())
                    ? PolygonVisuals.getSpcCategory(alert.id)
                    : null;

                let style;
                let classes = [];

                if (ctxStyle) {
                    // Context zoom cluster styling
                    const color = ctxStyle.isPrimary
                        ? StormState.getEventColor(alert.event)
                        : ctxStyle.hexColor;

                    style = {
                        color: color,
                        weight: ctxStyle.weight,
                        opacity: ctxStyle.opacity,
                        fillColor: color,
                        fillOpacity: ctxStyle.fillOpacity,
                        dashArray: ctxStyle.isPrimary ? "" : "",
                    };
                    classes.push(_buildPolygonClasses(ctxStyle));
                } else {
                    // Standard styling
                    const color = StormState.getEventColor(alert.event);
                    style = {
                        color: color,
                        weight: isTracked ? 3 : 1,
                        opacity: isTracked ? 1.0 : 0.3,
                        fillColor: color,
                        fillOpacity: isTracked ? 0.25 : 0.05,
                        dashArray: isTracked ? "" : "5,5",
                    };
                }

                // SPC blending: intensify polygons inside SPC risk areas
                if (spcCat) {
                    classes.push("polygon--spc-intersect");
                    classes.push(`polygon--spc-${spcCat.toLowerCase()}`);

                    // Boost fill opacity for polygons inside higher-risk SPC areas
                    const spcBoost = { "ENH": 0.04, "MDT": 0.06, "HIGH": 0.08 };
                    const boost = spcBoost[spcCat] || 0.02;
                    style.fillOpacity = Math.min(0.35, (style.fillOpacity || 0.05) + boost);
                }

                if (classes.length > 0) {
                    style.className = classes.join(" ");
                }

                L.geoJSON(geojson, { style })
                    .bindPopup(buildPopupHtml(alert))
                    .addTo(polygonLayer);
            } catch (e) {
                // Invalid polygon JSON — skip
            }
        }
    }

    /**
     * Build CSS class string for context zoom polygon styling.
     */
    function _buildPolygonClasses(ctxStyle) {
        const classes = [];
        if (ctxStyle.isPrimary) {
            classes.push("polygon--primary");
        } else {
            classes.push("polygon--secondary");
            classes.push(`polygon-color--${ctxStyle.colorToken}`);
        }
        if (ctxStyle.isFlashing) {
            classes.push(ctxStyle.isPrimary ? "polygon--flash" : "polygon--flash-secondary");
        }
        return classes.join(" ");
    }

    function buildPopupHtml(alert) {
        const color = StormState.getEventColor(alert.event);
        return `<div style="max-width:250px;font-size:12px;">
            <strong style="color:${color}">${alert.event}</strong><br>
            <span style="color:#94a3b8">${alert.headline || ""}</span><br>
            <small>Expires: ${formatTime(alert.expires)}</small>
        </div>`;
    }

    function formatTime(isoStr) {
        if (!isoStr) return "--";
        try {
            return new Date(isoStr).toLocaleString([], {
                month: "short", day: "numeric",
                hour: "2-digit", minute: "2-digit",
            });
        } catch (e) {
            return isoStr;
        }
    }

    return { init, fetchAndRender, renderCountyColors, renderPolygons };
})();
