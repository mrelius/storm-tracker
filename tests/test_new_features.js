/**
 * Storm Tracker — Test Suite for AT+ContextZoom+SPC Integration
 * Spec Section 16 — Required Tests
 *
 * Run: node tests/test_new_features.js
 */

// ── Minimal shims for Node.js execution ────────────────────────
global.StormState = {
    state: {
        autotrack: { enabled: true, targetAlertId: "alert-1", mode: "track" },
        alerts: { data: [] },
        userPrefs: {
            flashPolygons: true,
            polygonFlashCriticalOnly: true,
            spcEscalationEnabled: true,
            spcMode: "auto_most_severe",
            spcManualDay: null,
            multiAlertColorMode: "stable_palette",
        },
        contextZoomRuntime: { active: false, reason: null, zoomMode: null },
        spcAuto: { activeDay: null, selectedCategory: null, authority: "auto_track" },
    },
    on: () => {},
    emit: () => {},
    getEventColor: (evt) => "#ff0000",
};
global.STLogger = { for: () => ({ info: () => {} }) };
global.L = {
    geoJSON: () => ({ getBounds: () => ({ isValid: () => true, getCenter: () => ({ lat: 39.5, lng: -84.5 }), getSouthWest: () => ({ lat: 39, lng: -85 }), getNorthEast: () => ({ lat: 40, lng: -84 }) }) }),
    latLngBounds: (sw, ne) => ({
        getSouthWest: () => sw, getNorthEast: () => ne,
        isValid: () => true,
        extend: () => {},
        getCenter: () => ({ lat: 39.5, lng: -84.5 }),
        pad: () => ({ getSouthWest: () => sw, getNorthEast: () => ne, isValid: () => true }),
        intersects: () => true,
    }),
};
global.StormMap = { getMap: () => null };
global.Camera = { move: () => true };
global.AlertRenderer = { renderPolygons: () => {} };

// Load modules — IIFE assigns to global const, eval in global scope
const vm = require("vm");
const fs = require("fs");
vm.runInThisContext(fs.readFileSync("static/js/severity-model.js", "utf8"), { filename: "severity-model.js" });
vm.runInThisContext(fs.readFileSync("static/js/polygon-visuals.js", "utf8"), { filename: "polygon-visuals.js" });

// ── Test Runner ────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(cond, name) {
    if (cond) {
        console.log(`  PASS: ${name}`);
        passed++;
    } else {
        console.log(`  FAIL: ${name}`);
        failed++;
    }
}

// ════════════════════════════════════════════════════════════════
// A. UNIT TESTS
// ════════════════════════════════════════════════════════════════

console.log("\n=== A1. Severity Normalization ===");

const torWarn = { event: "Tornado Warning", severity: "Extreme", description: "TORNADO WARNING" };
const torWarnPDS = { event: "Tornado Warning", severity: "Extreme", description: "PARTICULARLY DANGEROUS SITUATION" };
const svrWarn = { event: "Severe Thunderstorm Warning", severity: "Severe", description: "hail size 1.5 inch" };
const svrDestructive = { event: "Severe Thunderstorm Warning", severity: "Severe", description: "DESTRUCTIVE hail up to tennis ball" };
const ffWarn = { event: "Flash Flood Warning", severity: "Severe", description: "flash flooding" };
const torWatch = { event: "Tornado Watch", severity: "Moderate", description: "" };

assert(SeverityModel.deriveSeverityTierForAlert(torWarn) === "significant", "Tornado Warning → significant");
assert(SeverityModel.deriveSeverityTierForAlert(torWarnPDS) === "critical", "Tornado Warning PDS → critical");
assert(SeverityModel.deriveSeverityTierForAlert(svrWarn) === "severe", "SVR TS Warning → severe");
assert(SeverityModel.deriveSeverityTierForAlert(svrDestructive) === "significant", "SVR TS Destructive → significant");
assert(SeverityModel.deriveSeverityTierForAlert(ffWarn) === "severe", "Flash Flood Warning → severe");
assert(SeverityModel.deriveSeverityTierForAlert(torWatch) === "elevated", "Tornado Watch → elevated");
assert(SeverityModel.deriveSeverityTierForAlert(null) === "low", "null → low");
assert(SeverityModel.deriveSeverityTierForAlert({}) === "low", "empty → low");

console.log("\n=== A2. Cluster Severity ===");

assert(SeverityModel.deriveClusterSeverity([torWarn, svrWarn]) === "significant", "TOR+SVR cluster → significant");
assert(SeverityModel.deriveClusterSeverity([torWarnPDS, svrWarn]) === "critical", "PDS TOR+SVR cluster → critical");
assert(SeverityModel.deriveClusterSeverity([svrWarn, ffWarn]) === "severe", "SVR+FF cluster → severe");
assert(SeverityModel.deriveClusterSeverity([]) === "low", "empty cluster → low");

console.log("\n=== A3. Tier Comparison ===");

assert(SeverityModel.tierGte("critical", "significant") === true, "critical >= significant");
assert(SeverityModel.tierGte("significant", "critical") === false, "significant >= critical → false");
assert(SeverityModel.tierGte("severe", "severe") === true, "severe >= severe");
assert(SeverityModel.maxTier("severe", "significant") === "significant", "max(severe, significant) → significant");

console.log("\n=== A4. Stable Color Assignment ===");

const eventIds = ["urn:alert:1", "urn:alert:2", "urn:alert:3", "urn:alert:4"];
const color1a = PolygonVisuals.getStablePolygonColorToken("urn:alert:1", eventIds);
const color1b = PolygonVisuals.getStablePolygonColorToken("urn:alert:1", eventIds);
assert(color1a === color1b, "Same event ID → same color across calls");

const color2 = PolygonVisuals.getStablePolygonColorToken("urn:alert:2", eventIds);
// Colors should be from palette (don't need to be different if hash doesn't collide)
assert(typeof color1a === "string" && color1a.startsWith("ctx-"), "Color token is valid palette token");
assert(typeof color2 === "string" && color2.startsWith("ctx-"), "Second color token is valid");

console.log("\n=== A5. Cluster Color Assignments ===");

const events = [
    { id: "primary-1", event: "Tornado Warning" },
    { id: "secondary-2", event: "Severe Thunderstorm Warning" },
    { id: "secondary-3", event: "Flash Flood Warning" },
];
const assignments = PolygonVisuals.buildClusterColorAssignments(events, "primary-1");
assert(assignments["primary-1"] === "primary", "Primary event gets 'primary' token");
assert(assignments["secondary-2"] !== "primary", "Secondary event does not get 'primary'");
assert(typeof assignments["secondary-3"] === "string", "Third event gets a color token");

console.log("\n=== A6. Flash Selection Cap ===");

const criticalAlerts = [
    { id: "a1", event: "Tornado Warning", description: "PDS" },
    { id: "a2", event: "Tornado Warning", description: "DESTRUCTIVE" },
    { id: "a3", event: "Tornado Warning", description: "CONSIDERABLE" },
    { id: "a4", event: "Tornado Warning", description: "PDS" },
    { id: "a5", event: "Tornado Warning", description: "PDS" },
];
const flashIds = PolygonVisuals.computeFlashingEventIds(criticalAlerts, "a1", "critical");
assert(flashIds.length <= 2, `Max 2 flashing polygons (got ${flashIds.length})`);
assert(flashIds.includes("a1"), "Primary always flashes");

console.log("\n=== A7. Flash — non-critical cluster ===");

const nonCritFlash = PolygonVisuals.computeFlashingEventIds(
    [{ id: "x1", event: "Severe Thunderstorm Warning" }, { id: "x2", event: "Flash Flood Warning" }],
    "x1",
    "severe"
);
assert(nonCritFlash.length === 1, "Non-critical: only primary flashes");
assert(nonCritFlash[0] === "x1", "Non-critical: primary is the flashing one");

// ════════════════════════════════════════════════════════════════
// B. INTEGRATION-LEVEL TESTS (logic verification)
// ════════════════════════════════════════════════════════════════

console.log("\n=== B1. Polygon Style Getter — No Active Cluster ===");

assert(PolygonVisuals.getPolygonStyle("some-id") === null, "No active cluster → null style");

console.log("\n=== B2. Polygon Style Getter — With Active Cluster ===");

PolygonVisuals.updateContextPolygonVisuals({
    clusterEvents: events,
    primaryEventId: "primary-1",
    clusterSeverity: "significant",
    flashingEnabled: true,
});

const primaryStyle = PolygonVisuals.getPolygonStyle("primary-1");
assert(primaryStyle !== null, "Primary polygon has style");
assert(primaryStyle.isPrimary === true, "Primary flagged as primary");
assert(primaryStyle.weight === 4, "Primary weight is 4");
assert(primaryStyle.isFlashing === true, "Primary is flashing");

const secondaryStyle = PolygonVisuals.getPolygonStyle("secondary-2");
assert(secondaryStyle !== null, "Secondary polygon has style");
assert(secondaryStyle.isPrimary === false, "Secondary not flagged as primary");
assert(secondaryStyle.weight === 2, "Secondary weight is 2");
assert(secondaryStyle.fillOpacity === 0.10, "Secondary fill opacity is 0.10");

const unknownStyle = PolygonVisuals.getPolygonStyle("unknown-99");
assert(unknownStyle === null, "Unknown polygon returns null");

console.log("\n=== B3. isActive State ===");

assert(PolygonVisuals.isActive() === true, "isActive true after updateContextPolygonVisuals");

PolygonVisuals.updateContextPolygonVisuals({
    clusterEvents: [],
    primaryEventId: null,
    clusterSeverity: "low",
    flashingEnabled: false,
});
assert(PolygonVisuals.isActive() === false, "isActive false after clear");

// ════════════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════════════

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} PASS, ${failed} FAIL`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
