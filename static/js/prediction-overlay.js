/**
 * Storm Tracker — Prediction Map Overlay
 *
 * Draws uncertainty cone and projected path on the Leaflet map.
 * Listens to "predictionUpdated" events from PredictionCard.
 * Visually distinct from official alert polygons.
 */
const PredictionOverlay = (function () {

    let coneLayer = null;
    let pathLayer = null;
    let labelsLayer = null;

    const CONE_COLOR = "#f59e0b";        // amber — distinct from alert red/gold
    const CONE_FILL_OPACITY = 0.06;
    const PATH_COLOR = "#f59e0b";
    const PATH_OPACITY = 0.5;

    function init() {
        StormState.on("predictionUpdated", onPredictionUpdated);
    }

    function onPredictionUpdated(pred) {
        clearOverlay();
        if (!pred) return;

        const proj = pred.projection;
        if (proj.suppressed || !proj.points || proj.points.length === 0) return;

        const map = StormMap.getMap();
        if (!map) return;

        const stormPos = [pred.projection.points[0]?.lat, pred.projection.points[0]?.lon];
        // Use the actual storm position from the first point's origin
        // The storm is at the source, projection points are future positions

        drawCone(map, proj);
        drawPath(map, proj);
        drawLabels(map, proj);
    }

    function drawCone(map, proj) {
        const points = proj.points;
        if (points.length < 2) return;

        // Build cone polygon: storm → left edges → tip → right edges (reversed) → storm
        // Storm origin estimated as the position before the first projection
        const p0 = points[0];
        // Estimate storm position by reversing the first projection
        const heading_rad = (proj.heading_deg || 0) * Math.PI / 180;
        const speed = proj.speed_mph || 0;
        const dist15 = speed * (15 / 60);
        const cos_lat = Math.cos((p0.lat || 39.5) * Math.PI / 180);
        const deg_per_mi = 1 / 69.0;
        const storm_lat = p0.lat - dist15 * Math.cos(heading_rad) * deg_per_mi;
        const storm_lon = p0.lon - dist15 * Math.sin(heading_rad) * deg_per_mi / Math.max(cos_lat, 0.01);

        const leftEdge = points.map(p => [p.cone_left.lat, p.cone_left.lon]);
        const rightEdge = points.map(p => [p.cone_right.lat, p.cone_right.lon]).reverse();

        const coneCoords = [[storm_lat, storm_lon], ...leftEdge, ...rightEdge, [storm_lat, storm_lon]];

        coneLayer = L.polygon(coneCoords, {
            color: CONE_COLOR,
            weight: 1,
            opacity: 0.3,
            fillColor: CONE_COLOR,
            fillOpacity: CONE_FILL_OPACITY,
            dashArray: "4,4",
            interactive: false,
            className: "prediction-cone",
        }).addTo(map);
    }

    function drawPath(map, proj) {
        const points = proj.points;
        if (points.length === 0) return;

        const pathCoords = points.map(p => [p.lat, p.lon]);

        pathLayer = L.polyline(pathCoords, {
            color: PATH_COLOR,
            weight: 2,
            opacity: PATH_OPACITY,
            dashArray: "6,4",
            interactive: false,
            className: "prediction-path",
        }).addTo(map);
    }

    function drawLabels(map, proj) {
        const points = proj.points;
        if (points.length === 0) return;

        const markers = [];
        for (const p of points) {
            const confPct = Math.round(p.confidence * 100);
            const marker = L.circleMarker([p.lat, p.lon], {
                radius: 3,
                color: CONE_COLOR,
                fillColor: CONE_COLOR,
                fillOpacity: 0.5,
                weight: 1,
                interactive: false,
            });

            // Tooltip with time + confidence
            marker.bindTooltip(`${p.minutes}m · ${confPct}%`, {
                permanent: false,
                direction: "right",
                className: "pred-tooltip",
                offset: [6, 0],
            });

            markers.push(marker);
        }

        labelsLayer = L.layerGroup(markers).addTo(map);
    }

    function clearOverlay() {
        const map = StormMap.getMap();
        if (!map) return;
        if (coneLayer) { map.removeLayer(coneLayer); coneLayer = null; }
        if (pathLayer) { map.removeLayer(pathLayer); pathLayer = null; }
        if (labelsLayer) { map.removeLayer(labelsLayer); labelsLayer = null; }
    }

    return { init };
})();
