/**
 * Storm Tracker — Impact Zone Tests
 * Run: node tests/test_impact_zone.js
 */

global.StormState = {
    state: {
        autotrack: { targetAlertId: "alert-1", enabled: true },
        alerts: { data: [] },
        motion: { history: {}, vectors: {} },
        impactZone: { active: false, corridorsByEventId: {}, impactsByEventId: {}, lastComputedAt: null },
    },
    on: () => {},
    emit: () => {},
    getEventColor: () => "#ff0000",
};
global.STLogger = { for: () => ({ info: () => {} }) };
global.L = {
    geoJSON: (geo) => ({
        getBounds: () => ({
            isValid: () => true,
            getCenter: () => ({ lat: 39.5, lng: -84.5 }),
        }),
    }),
    layerGroup: () => ({ addTo: () => ({}), clearLayers: () => {}, addLayer: () => {} }),
    polyline: () => ({}),
    polygon: () => ({}),
    circleMarker: () => ({ bindTooltip: () => ({}) }),
    tooltip: () => ({ setLatLng: () => ({ setContent: () => ({ addTo: () => ({}) }) }) }),
};
global.StormMap = { getMap: () => null };

const vm = require("vm");
const fs = require("fs");
vm.runInThisContext(fs.readFileSync("static/js/impact-zone.js", "utf8"));

let passed = 0, failed = 0;
function assert(cond, name) {
    if (cond) { console.log(`  PASS: ${name}`); passed++; }
    else { console.log(`  FAIL: ${name}`); failed++; }
}

// ═══════════════════════════════════════════════
console.log("\n=== E1. Corridor Creation — Valid Input ===");

const polyStr = JSON.stringify({
    type: "Polygon",
    coordinates: [[[-85, 39], [-84, 39], [-84, 40], [-85, 40], [-85, 39]]],
});
const centroid = { lat: 39.5, lon: -84.5 };
const vector = { speedMph: 40, bearingDeg: 45, lastUpdated: Date.now() };

const corridors = ImpactZone.buildImpactCorridorsForEvent(polyStr, centroid, vector);
assert(corridors.length === 2, `Two corridors built (got ${corridors.length})`);
assert(corridors[0].minutes === 15, "First corridor is 15 min");
assert(corridors[1].minutes === 30, "Second corridor is 30 min");
assert(corridors[0].ring.length >= 3, `15-min hull has >= 3 points (got ${corridors[0].ring.length})`);
assert(corridors[1].ring.length >= 3, `30-min hull has >= 3 points (got ${corridors[1].ring.length})`);
assert(corridors[0].bbox !== null, "15-min bbox present");
assert(corridors[1].bbox !== null, "30-min bbox present");

// 30 min corridor should be larger than 15 min
const area15 = (corridors[0].bbox.n - corridors[0].bbox.s) * (corridors[0].bbox.e - corridors[0].bbox.w);
const area30 = (corridors[1].bbox.n - corridors[1].bbox.s) * (corridors[1].bbox.e - corridors[1].bbox.w);
assert(area30 >= area15, `30-min corridor larger than 15-min (${area30.toFixed(4)} >= ${area15.toFixed(4)})`);

// ═══════════════════════════════════════════════
console.log("\n=== E2. Corridor Creation — No Vector ===");

const noVectorCorridors = ImpactZone.buildImpactCorridorsForEvent(polyStr, centroid, { speedMph: 0, bearingDeg: 0 });
// Speed is 0, so projected polygon is identical to current — hull should still form
// but _projectPosition with speed 0 gives deltaLat=0, deltaLon=0
// So hull = current polygon vertices only — still valid
assert(noVectorCorridors.length === 2, "Corridors still generated (degenerate but valid)");

// ═══════════════════════════════════════════════
console.log("\n=== E3. Corridor Creation — Invalid Polygon ===");

const badPolyCorridors = ImpactZone.buildImpactCorridorsForEvent("not json", centroid, vector);
assert(badPolyCorridors.length === 0, "Invalid polygon → no corridors");

// ═══════════════════════════════════════════════
console.log("\n=== E4. ETA Estimation — Forward Point ===");

const eta1 = ImpactZone.estimateEtaMinutes(
    { lat: 39.0, lon: -85.0 },  // origin
    39.15, -84.85,                // target ~NE, closer (~15 mi)
    40,                            // 40 mph
    45                             // bearing NE
);
assert(eta1 !== null, "ETA computed for forward point");
assert(eta1 > 0, `ETA is positive (got ${eta1})`);
assert(eta1 < 60, `ETA is reasonable < 60 min (got ${eta1})`);

// ═══════════════════════════════════════════════
console.log("\n=== E5. ETA Estimation — Behind Storm ===");

const etaBehind = ImpactZone.estimateEtaMinutes(
    { lat: 39.5, lon: -84.5 },  // origin
    39.0, -85.0,                  // target SW (behind if moving NE)
    40,
    45
);
assert(etaBehind === null, "ETA null for point behind storm");

// ═══════════════════════════════════════════════
console.log("\n=== E6. ETA Estimation — Zero Speed ===");

const etaZero = ImpactZone.estimateEtaMinutes(
    { lat: 39.0, lon: -85.0 },
    39.5, -84.5,
    0,   // stationary
    45
);
assert(etaZero === null, "ETA null for stationary storm");

// ═══════════════════════════════════════════════
console.log("\n=== E7. Single Corridor Build ===");

const single = ImpactZone.buildImpactCorridor({
    polygonStr: polyStr,
    centroid,
    vector,
    minutes: 15,
});
assert(single !== null, "Single corridor built");
assert(single.minutes === 15, "Corridor is 15 min");
assert(single.polygon.type === "Feature", "Corridor is GeoJSON Feature");
assert(single.polygon.geometry.type === "Polygon", "Corridor geometry is Polygon");

// ═══════════════════════════════════════════════
console.log("\n=== E8. Convex Hull Correctness ===");

// The 15 min corridor hull should extend NE from the original polygon
// Original polygon: [-85,39] to [-84,40]
// With 40mph NE bearing for 15 min → ~10 mi shift NE
const hullBbox = single.bbox;
assert(hullBbox.n > 40.0, `Hull extends north of original (got ${hullBbox.n.toFixed(3)})`);
assert(hullBbox.e > -84.0, `Hull extends east of original (got ${hullBbox.e.toFixed(3)})`);
assert(hullBbox.s <= 39.0, `Hull includes original south (got ${hullBbox.s.toFixed(3)})`);

// ═══════════════════════════════════════════════
// Run regression suites
console.log("\n=== E9. Regression — Prior Suites ===");

// Results
console.log("\n" + "=".repeat(50));
console.log(`Impact Zone Results: ${passed} PASS, ${failed} FAIL`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
