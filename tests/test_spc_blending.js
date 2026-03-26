/**
 * Storm Tracker — SPC Risk Blending Tests
 * Run: node tests/test_spc_blending.js
 */

// Minimal shims
global.StormState = {
    state: {
        autotrack: { enabled: true, targetAlertId: "alert-1", mode: "track" },
        alerts: { data: [] },
        userPrefs: { flashPolygons: true, polygonFlashCriticalOnly: true, spcEscalationEnabled: true, spcMode: "auto_most_severe", spcManualDay: null, multiAlertColorMode: "stable_palette" },
        contextZoomRuntime: { active: false },
        spcAuto: { activeDay: null, authority: "auto_track" },
        spcVisual: { activeDay: null, categoryMap: {}, lastComputedAt: 0 },
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
            getSouthWest: () => ({ lat: 39.0, lng: -85.0 }),
            getNorthEast: () => ({ lat: 40.0, lng: -84.0 }),
            contains: (pt) => pt.lat >= 39.0 && pt.lat <= 40.0 && pt.lng >= -85.0 && pt.lng <= -84.0,
        }),
    }),
    latLngBounds: (sw, ne) => ({
        getSouthWest: () => sw, getNorthEast: () => ne,
        isValid: () => true, extend: () => {}, getCenter: () => ({ lat: 39.5, lng: -84.5 }),
        pad: () => ({ getSouthWest: () => sw, getNorthEast: () => ne, isValid: () => true }),
        intersects: () => true, contains: () => true,
    }),
};
global.StormMap = { getMap: () => null };
global.Camera = { move: () => true };
global.AlertRenderer = { renderPolygons: () => {} };

const vm = require("vm");
const fs = require("fs");
vm.runInThisContext(fs.readFileSync("static/js/severity-model.js", "utf8"));
vm.runInThisContext(fs.readFileSync("static/js/polygon-visuals.js", "utf8"));

let passed = 0, failed = 0;
function assert(cond, name) {
    if (cond) { console.log(`  PASS: ${name}`); passed++; }
    else { console.log(`  FAIL: ${name}`); failed++; }
}

// ═══════════════════════════════════════════════
console.log("\n=== C1. SPC Blending — No Features ===");

assert(PolygonVisuals.isSpcBlendingActive() === false, "No SPC features → blending inactive");
assert(PolygonVisuals.getSpcCategory("test-1") === null, "No features → null category");

// ═══════════════════════════════════════════════
console.log("\n=== C2. SPC Blending — Load Features ===");

// ENH polygon covering lat 38-41, lon -86 to -83
const enhFeature = {
    type: "Feature",
    geometry: {
        type: "Polygon",
        coordinates: [[[-86, 38], [-83, 38], [-83, 41], [-86, 41], [-86, 38]]],
    },
    properties: { LABEL: "ENH" },
};

// SLGT polygon covering lat 36-39, lon -90 to -87
const slgtFeature = {
    type: "Feature",
    geometry: {
        type: "Polygon",
        coordinates: [[[-90, 36], [-87, 36], [-87, 39], [-90, 39], [-90, 36]]],
    },
    properties: { LABEL: "SLGT" },
};

PolygonVisuals.setSpcFeatures([enhFeature, slgtFeature]);
assert(PolygonVisuals.isSpcBlendingActive() === true, "Features loaded → blending active");

// ═══════════════════════════════════════════════
console.log("\n=== C3. Intersection — Polygon Inside ENH ===");

// Alert polygon centroid at 39.5, -84.5 → inside ENH
const alertGeoInside = {
    type: "Polygon",
    coordinates: [[[-85, 39], [-84, 39], [-84, 40], [-85, 40], [-85, 39]]],
};
const cat1 = PolygonVisuals.getSpcCategoryForPolygon(alertGeoInside);
assert(cat1 === "ENH", "Polygon inside ENH → returns ENH");

// ═══════════════════════════════════════════════
console.log("\n=== C4. Intersection — Polygon Outside SPC ===");

// Alert polygon centroid at 45, -70 → outside both
// Need to override L.geoJSON for this test
const origGeoJSON = global.L.geoJSON;
global.L.geoJSON = (geo) => ({
    getBounds: () => ({
        isValid: () => true,
        getCenter: () => ({ lat: 45.0, lng: -70.0 }),
    }),
});
const alertGeoOutside = {
    type: "Polygon",
    coordinates: [[[-71, 44], [-69, 44], [-69, 46], [-71, 46], [-71, 44]]],
};
const cat2 = PolygonVisuals.getSpcCategoryForPolygon(alertGeoOutside);
assert(cat2 === null, "Polygon outside SPC → null");
global.L.geoJSON = origGeoJSON;

// ═══════════════════════════════════════════════
console.log("\n=== C5. Intersection — Highest Category Wins ===");

// Polygon at 39.5, -84.5 is inside both ENH (covers 38-41) and could be inside SLGT (36-39)
// But 39.5 is above SLGT's 39 upper bound → only ENH
// ENH score (4) > SLGT score (3) → ENH wins regardless
assert(cat1 === "ENH", "Highest SPC category returned (ENH > SLGT)");

// ═══════════════════════════════════════════════
console.log("\n=== C6. computeSpcIntersections — Full Pipeline ===");

StormState.state.alerts.data = [
    { id: "alert-inside", polygon: JSON.stringify(alertGeoInside), event: "Tornado Warning" },
    { id: "alert-no-poly", event: "Tornado Watch" },
];

PolygonVisuals.computeSpcIntersections();
const map = StormState.state.spcVisual.categoryMap;
assert(map["alert-inside"] === "ENH", "alert-inside mapped to ENH");
assert(map["alert-no-poly"] === undefined, "alert without polygon → not mapped");
assert(StormState.state.spcVisual.lastComputedAt > 0, "lastComputedAt updated");

// ═══════════════════════════════════════════════
console.log("\n=== C7. getSpcCategory ===");

assert(PolygonVisuals.getSpcCategory("alert-inside") === "ENH", "getSpcCategory returns ENH for mapped alert");
assert(PolygonVisuals.getSpcCategory("unknown") === null, "getSpcCategory returns null for unknown");

// ═══════════════════════════════════════════════
console.log("\n=== C8. Clear Features ===");

PolygonVisuals.setSpcFeatures([]);
assert(PolygonVisuals.isSpcBlendingActive() === false, "After clear → blending inactive");

// Results
console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} PASS, ${failed} FAIL`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
