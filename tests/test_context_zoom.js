/**
 * Storm Tracker — Context Zoom Resolver Tests
 *
 * Validates: bounds resolution, SPC report filtering, safe-area handling,
 * zoom clamping, and edge protection.
 *
 * Note: Requires Leaflet (L) to be loaded. Run in browser context.
 */
(function () {
    const results = [];
    let passed = 0;
    let failed = 0;

    function assert(condition, name) {
        if (condition) {
            results.push({ name, result: "PASS" });
            passed++;
        } else {
            results.push({ name, result: "FAIL" });
            failed++;
            console.error(`FAIL: ${name}`);
        }
    }

    function assertInRange(value, min, max, name) {
        const ok = value >= min && value <= max;
        if (!ok) console.error(`FAIL: ${name} — ${value} not in [${min}, ${max}]`);
        assert(ok, name);
    }

    // Check dependencies
    if (typeof L === "undefined" || typeof ContextZoomResolver === "undefined") {
        console.warn("Context Zoom tests require Leaflet and ContextZoomResolver. Skipping.");
        return;
    }

    // ── Helpers ────────────────────────────────────────────────────

    function makeBounds(latMin, latMax, lonMin, lonMax) {
        return L.latLngBounds(L.latLng(latMin, lonMin), L.latLng(latMax, lonMax));
    }

    function makeFeature(lat, lon, sizeDeg) {
        const half = sizeDeg / 2;
        return {
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [[[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half]]],
            },
            properties: { LABEL: "ENH" },
        };
    }

    // ── Test 1: Polygon Only ──────────────────────────────────────

    (function testPolygonOnly() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { results.push({ name: "Polygon only (no map)", result: "SKIP" }); return; }

        const polyBounds = makeBounds(39.3, 39.7, -84.7, -84.3);
        const result = ContextZoomResolver.resolveContextZoomBounds({
            highlightedPolygonBounds: polyBounds,
            highlightedPolygonId: "test-poly-1",
            spcReports: [],
            spcOutlookBounds: null,
            viewport: { width: 1200, height: 800 },
            safeAreaInsets: { top: 52, bottom: 30, left: 0, right: 0 },
            map: map,
        });

        assert(result !== null, "Polygon only: result not null");
        assert(result.bounds.isValid(), "Polygon only: bounds valid");
        assert(result.bounds.contains(polyBounds.getCenter()), "Polygon only: polygon center in bounds");
        assert(result.reason.includes("polygon"), "Polygon only: reason mentions polygon");
        assertInRange(result.zoom, 5, 12, "Polygon only: zoom in valid range");
    })();

    // ── Test 2: Polygon + Nearby SPC Reports ──────────────────────

    (function testPolygonPlusSpc() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { results.push({ name: "Polygon + SPC (no map)", result: "SKIP" }); return; }

        const polyBounds = makeBounds(39.3, 39.7, -84.7, -84.3);
        const spcFeatures = [
            makeFeature(39.8, -84.0, 0.5),
            makeFeature(39.2, -85.0, 0.3),
        ];

        const result = ContextZoomResolver.resolveContextZoomBounds({
            highlightedPolygonBounds: polyBounds,
            highlightedPolygonId: "test-poly-2",
            spcReports: spcFeatures,
            spcOutlookBounds: null,
            viewport: { width: 1200, height: 800 },
            safeAreaInsets: { top: 52, bottom: 30, left: 0, right: 0 },
            map: map,
        });

        assert(result !== null, "Polygon + SPC: result not null");
        assert(result.usedSpcExtent === true, "Polygon + SPC: used SPC extent");
        assert(result.spcReportCount === 2, "Polygon + SPC: 2 reports included");
        assert(result.reason.includes("spc"), "Polygon + SPC: reason mentions SPC");

        // Both SPC features should be within the resolved bounds
        for (const f of spcFeatures) {
            const center = L.geoJSON(f).getBounds().getCenter();
            assert(result.bounds.contains(center), "Polygon + SPC: SPC report center in bounds");
        }

        // Polygon still in bounds
        assert(result.bounds.contains(polyBounds.getCenter()), "Polygon + SPC: polygon center in bounds");
    })();

    // ── Test 3: Wide SPC Cluster ──────────────────────────────────

    (function testWideSpcCluster() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { results.push({ name: "Wide SPC cluster (no map)", result: "SKIP" }); return; }

        const polyBounds = makeBounds(39.3, 39.7, -84.7, -84.3);
        const spcFeatures = [
            makeFeature(38.5, -86.0, 1.0),
            makeFeature(40.5, -83.0, 0.8),
            makeFeature(39.0, -82.5, 0.6),
        ];

        const result = ContextZoomResolver.resolveContextZoomBounds({
            highlightedPolygonBounds: polyBounds,
            highlightedPolygonId: "test-poly-3",
            spcReports: spcFeatures,
            spcOutlookBounds: null,
            viewport: { width: 1200, height: 800 },
            safeAreaInsets: { top: 52, bottom: 30, left: 0, right: 0 },
            map: map,
        });

        assert(result !== null, "Wide cluster: result not null");
        // Zoom should be wider for larger cluster
        assertInRange(result.zoom, 5, 9, "Wide cluster: zoom accommodates spread");
        assert(result.bounds.contains(polyBounds.getCenter()), "Wide cluster: polygon still in bounds");
    })();

    // ── Test 4: Safe-Area Handling ─────────────────────────────────

    (function testSafeAreaHandling() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { results.push({ name: "Safe-area handling (no map)", result: "SKIP" }); return; }

        const polyBounds = makeBounds(39.3, 39.7, -84.7, -84.3);

        // Without safe area
        const resultNoSafe = ContextZoomResolver.resolveContextZoomBounds({
            highlightedPolygonBounds: polyBounds,
            highlightedPolygonId: "test-safe-1",
            spcReports: [],
            spcOutlookBounds: null,
            viewport: { width: 1200, height: 800 },
            safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
            map: map,
        });

        // With large safe area (simulating open panel)
        const resultWithSafe = ContextZoomResolver.resolveContextZoomBounds({
            highlightedPolygonBounds: polyBounds,
            highlightedPolygonId: "test-safe-2",
            spcReports: [],
            spcOutlookBounds: null,
            viewport: { width: 1200, height: 800 },
            safeAreaInsets: { top: 52, bottom: 30, left: 0, right: 380 },
            map: map,
        });

        assert(resultNoSafe !== null, "Safe area: no-safe result not null");
        assert(resultWithSafe !== null, "Safe area: with-safe result not null");

        // Both should contain polygon
        assert(resultNoSafe.bounds.contains(polyBounds.getCenter()), "Safe area: no-safe contains polygon");
        assert(resultWithSafe.bounds.contains(polyBounds.getCenter()), "Safe area: with-safe contains polygon");
    })();

    // ── Test 5: Zoom Clamp ────────────────────────────────────────

    (function testZoomClamp() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { results.push({ name: "Zoom clamp (no map)", result: "SKIP" }); return; }

        // Very small polygon
        const tinyBounds = makeBounds(39.49, 39.51, -84.51, -84.49);
        const result = ContextZoomResolver.resolveContextZoomBounds({
            highlightedPolygonBounds: tinyBounds,
            highlightedPolygonId: "test-tiny",
            spcReports: [],
            spcOutlookBounds: null,
            viewport: { width: 1200, height: 800 },
            safeAreaInsets: { top: 52, bottom: 30, left: 0, right: 0 },
            map: map,
        });

        assert(result !== null, "Zoom clamp: result not null");
        assert(result.zoom <= 12, "Zoom clamp: not above max");
        assert(result.zoom >= 5, "Zoom clamp: not below min");
    })();

    // ── Test 6: SPC Report Filtering by Distance ──────────────────

    (function testSpcFiltering() {
        const polyBounds = makeBounds(39.3, 39.7, -84.7, -84.3);

        // Near report (within 150mi)
        const nearReport = makeFeature(39.5, -83.5, 0.3);
        // Far report (well beyond 150mi)
        const farReport = makeFeature(30.0, -80.0, 0.3);

        const filtered = ContextZoomResolver.filterRelevantSpcReports(
            [nearReport, farReport],
            polyBounds
        );

        assert(filtered.length === 1, "SPC filtering: only near report included");
    })();

    // ── Test 7: Null/Invalid Input Handling ────────────────────────

    (function testNullHandling() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;

        const result1 = ContextZoomResolver.resolveContextZoomBounds({
            highlightedPolygonBounds: null,
            highlightedPolygonId: null,
            spcReports: [],
            spcOutlookBounds: null,
            viewport: { width: 1200, height: 800 },
            safeAreaInsets: null,
            map: map,
        });

        assert(result1 === null, "Null polygon: returns null");
    })();

    // ── Print Summary ─────────────────────────────────────────────

    console.log("\n══════ CONTEXT ZOOM RESOLVER TEST RESULTS ══════");
    for (const r of results) {
        const icon = r.result === "PASS" ? "✓" : r.result === "FAIL" ? "✗" : "○";
        console.log(`  ${icon} ${r.name}: ${r.result}`);
    }
    console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
    console.log("═════════════════════════════════════════════════\n");
})();
