/**
 * Storm Tracker — Alert Renderer
 * Handles county coloring and warning polygon overlays on the map.
 */
const AlertRenderer = (function () {
    let map = null;
    let polygonLayer = null;  // L.layerGroup for warning polygons

    function init(leafletMap) {
        map = leafletMap;
        polygonLayer = L.layerGroup().addTo(map);
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

        for (const alert of alerts) {
            if (!alert.polygon) continue;

            try {
                const geojson = JSON.parse(alert.polygon);
                const color = StormState.getEventColor(alert.event);

                L.geoJSON(geojson, {
                    style: {
                        color: color,
                        weight: 2,
                        opacity: 0.8,
                        fillColor: color,
                        fillOpacity: 0.15,
                        dashArray: "5,5",
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
