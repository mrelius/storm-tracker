/**
 * Storm Tracker — Motion Engine Tests
 * Run: node tests/test_motion_engine.js
 */

global.StormState = {
    state: {
        autotrack: { targetAlertId: "alert-1", enabled: true },
        alerts: { data: [] },
        motion: { history: {}, vectors: {} },
    },
    on: () => {},
    emit: () => {},
    getEventColor: () => "#ff0000",
};
global.STLogger = { for: () => ({ info: () => {} }) };
global.L = {
    geoJSON: () => ({ getBounds: () => ({ isValid: () => true, getCenter: () => ({ lat: 39.5, lng: -84.5 }) }) }),
    layerGroup: () => ({ addTo: () => ({}), clearLayers: () => {}, addLayer: () => {} }),
    polyline: () => ({}),
    polygon: () => ({}),
    circleMarker: () => ({ bindTooltip: () => ({}) }),
    tooltip: () => ({ setLatLng: () => ({ setContent: () => ({ addTo: () => ({}) }) }) }),
};
global.StormMap = { getMap: () => null };

const vm = require("vm");
const fs = require("fs");
vm.runInThisContext(fs.readFileSync("static/js/motion-engine.js", "utf8"));

let passed = 0, failed = 0;
function assert(cond, name) {
    if (cond) { console.log(`  PASS: ${name}`); passed++; }
    else { console.log(`  FAIL: ${name}`); failed++; }
}

// ═══════════════════════════════════════════════
console.log("\n=== D1. computeMotionVector — 2 points ===");

const now = Date.now();
const h2 = [
    { lat: 39.0, lon: -85.0, ts: now - 600000 },  // 10 min ago
    { lat: 39.1, lon: -84.9, ts: now },             // now
];
const v2 = MotionEngine.computeMotionVector(h2);
assert(v2 !== null, "Vector computed from 2 points");
assert(v2.speedMph > 0, `Speed > 0 (got ${v2.speedMph})`);
assert(v2.bearingDeg >= 0 && v2.bearingDeg < 360, `Bearing valid (got ${v2.bearingDeg})`);

// ═══════════════════════════════════════════════
console.log("\n=== D2. computeMotionVector — 3 points (smoothing) ===");

const h3 = [
    { lat: 39.0, lon: -85.0, ts: now - 1200000 },  // 20 min ago
    { lat: 39.05, lon: -84.95, ts: now - 600000 },  // 10 min ago
    { lat: 39.1, lon: -84.9, ts: now },              // now
];
const v3 = MotionEngine.computeMotionVector(h3);
assert(v3 !== null, "Vector computed from 3 points (smoothed)");
assert(v3.speedMph > 0, `Smoothed speed > 0 (got ${v3.speedMph})`);

// ═══════════════════════════════════════════════
console.log("\n=== D3. computeMotionVector — jitter filter ===");

const hJitter = [
    { lat: 39.0, lon: -85.0, ts: now - 600000 },
    { lat: 39.0001, lon: -85.0001, ts: now },  // ~0.01 mi movement
];
const vJitter = MotionEngine.computeMotionVector(hJitter);
assert(vJitter === null, "Jittery movement → null (filtered)");

// ═══════════════════════════════════════════════
console.log("\n=== D4. computeMotionVector — insufficient data ===");

assert(MotionEngine.computeMotionVector([]) === null, "Empty history → null");
assert(MotionEngine.computeMotionVector([{ lat: 39, lon: -85, ts: now }]) === null, "1 point → null");
assert(MotionEngine.computeMotionVector(null) === null, "null → null");

// ═══════════════════════════════════════════════
console.log("\n=== D5. projectPosition — northward ===");

const proj = MotionEngine.projectPosition(39.0, -85.0, 0, 60, 30);
assert(proj.lat > 39.0, `Projected lat moved north (got ${proj.lat.toFixed(4)})`);
assert(Math.abs(proj.lon - (-85.0)) < 0.01, "Lon roughly unchanged for due-north");
// 60 mph * 0.5 hr = 30 mi. 30 * DEG_PER_MI ≈ 0.435 degrees
const expectedDeltaLat = 30 * (1/69.0);
assert(Math.abs(proj.lat - 39.0 - expectedDeltaLat) < 0.01, `Delta lat ≈ ${expectedDeltaLat.toFixed(3)}`);

// ═══════════════════════════════════════════════
console.log("\n=== D6. projectPosition — eastward ===");

const projE = MotionEngine.projectPosition(39.0, -85.0, 90, 60, 30);
assert(Math.abs(projE.lat - 39.0) < 0.01, "Lat roughly unchanged for due-east");
assert(projE.lon > -85.0, `Lon moved east (got ${projE.lon.toFixed(4)})`);

// ═══════════════════════════════════════════════
console.log("\n=== D7. projectPolygon — shift geometry ===");

const poly = {
    type: "Polygon",
    coordinates: [[[-85, 39], [-84, 39], [-84, 40], [-85, 40], [-85, 39]]],
};
const shifted = MotionEngine.projectPolygon(poly, 0.5, 0.3);
assert(shifted.coordinates[0][0][0] === -84.7, `First lon shifted (-85 + 0.3 = -84.7)`);
assert(shifted.coordinates[0][0][1] === 39.5, `First lat shifted (39 + 0.5 = 39.5)`);
// Verify original not mutated
assert(poly.coordinates[0][0][0] === -85, "Original polygon not mutated");

// ═══════════════════════════════════════════════
console.log("\n=== D8. pruneMotionHistory ===");

StormState.state.motion.history = {
    "old-alert": [{ lat: 39, lon: -85, ts: Date.now() - 700000 }],  // >10 min old
    "fresh-alert": [{ lat: 39, lon: -85, ts: Date.now() - 5000 }],  // 5s old
};
MotionEngine.pruneMotionHistory();
assert(StormState.state.motion.history["old-alert"] === undefined, "Old entry pruned");
assert(StormState.state.motion.history["fresh-alert"] !== undefined, "Fresh entry kept");

// Results
console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} PASS, ${failed} FAIL`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
