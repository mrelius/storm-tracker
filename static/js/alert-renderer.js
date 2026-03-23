/**
 * Storm Tracker — Alert Renderer
 * Handles county coloring and warning polygon overlays on the map.
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
                const color = StormState.getEventColor(alert.event);
                const isTracked = trackedId && alert.id === trackedId;

                L.geoJSON(geojson, {
                    style: {
                        color: color,
                        weight: isTracked ? 3 : 1,
                        opacity: isTracked ? 1.0 : 0.3,
                        fillColor: color,
                        fillOpacity: isTracked ? 0.25 : 0.05,
                        dashArray: isTracked ? "" : "5,5",
                    },
                }).bindPopup(buildPopupHtml(alert))
                  .addTo(polygonLayer);
            } catch (e) {
                // Invalid polygon JSON — skip
            }
        }
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
