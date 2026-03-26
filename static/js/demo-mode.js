/**
 * Storm Tracker — Demo / Verification Mode
 *
 * Visible in-UI harness to test all major features.
 * Injects synthetic data through production renderers.
 * Fully isolated from live data — clearing restores normal state.
 *
 * Toggle: DEMO button in radar controls, or Shift+Alt+V
 */
const DemoMode = (function () {

    // ── Demo State ─────────────────────────────────────────────────
    let _state = {
        enabled: false,
        activeScenarioId: null,
        runAllActive: false,
        runAllIndex: -1,
        runAllPaused: false,
        startedAt: null,
        syntheticDataActive: false,
    };

    let _runAllTimer = null;
    let _savedAlerts = null;
    let _demoLayers = [];    // Leaflet layers to clean up
    let _demoTooltips = [];  // tooltips on map
    let _scenarioTimers = []; // owned timers for timed scenarios — cleaned on clear
    let log = null;

    function _scheduleStep(fn, delayMs) {
        const t = setTimeout(fn, delayMs);
        _scenarioTimers.push(t);
        return t;
    }

    function _clearScenarioTimers() {
        for (const t of _scenarioTimers) clearTimeout(t);
        _scenarioTimers = [];
    }

    const RUN_ALL_STEP_MS = 7000;

    // ── Demo Region (Ohio Valley centered) ─────────────────────────
    const CENTER = { lat: 39.5, lon: -84.5 };

    // ── Synthetic Alert Factory ────────────────────────────────────

    function _makeAlert(id, event, lat, lon, sizeDeg, opts = {}) {
        const half = sizeDeg / 2;
        const polygon = {
            type: "Polygon",
            coordinates: [[
                [lon - half, lat - half],
                [lon + half, lat - half],
                [lon + half, lat + half],
                [lon - half, lat + half],
                [lon - half, lat - half],
            ]],
        };
        return {
            id: `demo-${id}`,
            event,
            headline: opts.headline || `Demo ${event}`,
            description: opts.description || "",
            severity: opts.severity || "Severe",
            urgency: "Immediate",
            category: "primary",
            polygon: JSON.stringify(polygon),
            county_fips: [],
            distance_mi: opts.distance || 5,
            bearing: 0,
            issued: new Date().toISOString(),
            expires: new Date(Date.now() + 3600000).toISOString(),
            area: "Demo Area",
            areas: ["Demo County"],
        };
    }

    function _makeSpcFeature(category, latMin, latMax, lonMin, lonMax) {
        return {
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [[[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax], [lonMin, latMin]]],
            },
            properties: { LABEL: category },
        };
    }

    // ── Scenario Definitions ───────────────────────────────────────

    const SCENARIOS = [
        {
            id: "multi_alert_colors",
            label: "Multi-Alert Colors",
            description: "Primary + 3 secondary polygons with stable distinct colors",
            checklist: [
                "Primary polygon: thick bright border",
                "3 secondary polygons: distinct stable colors",
                "Tracked target highlighted",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("tor-1", "Tornado Warning", 39.5, -84.5, 0.3, { description: "TORNADO WARNING", severity: "Extreme" }),
                    _makeAlert("svr-2", "Severe Thunderstorm Warning", 39.6, -84.2, 0.25),
                    _makeAlert("svr-3", "Severe Thunderstorm Warning", 39.35, -84.7, 0.25),
                    _makeAlert("ff-4", "Flash Flood Warning", 39.7, -84.6, 0.2),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-tor-1";
                StormState.state.autotrack.enabled = true;

                // Trigger polygon visuals
                if (typeof PolygonVisuals !== "undefined" && typeof SeverityModel !== "undefined") {
                    PolygonVisuals.updateContextPolygonVisuals({
                        clusterEvents: alerts,
                        primaryEventId: "demo-tor-1",
                        clusterSeverity: SeverityModel.deriveClusterSeverity(alerts),
                        flashingEnabled: false,
                    });
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.45, 9);
            },
        },
        {
            id: "flash_test",
            label: "Flash Test",
            description: "Primary polygon flashing + bounded secondary flash",
            checklist: [
                "Primary polygon: pulsing glow animation",
                "Max 1 secondary flashing (if critical)",
                "Flash cap = 2 total",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("tor-f1", "Tornado Warning", 39.5, -84.5, 0.3, { description: "PARTICULARLY DANGEROUS SITUATION", severity: "Extreme" }),
                    _makeAlert("tor-f2", "Tornado Warning", 39.6, -84.3, 0.25, { description: "DESTRUCTIVE tornado", severity: "Extreme" }),
                    _makeAlert("svr-f3", "Severe Thunderstorm Warning", 39.4, -84.7, 0.2),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-tor-f1";
                StormState.state.autotrack.enabled = true;

                if (typeof PolygonVisuals !== "undefined" && typeof SeverityModel !== "undefined") {
                    PolygonVisuals.updateContextPolygonVisuals({
                        clusterEvents: alerts,
                        primaryEventId: "demo-tor-f1",
                        clusterSeverity: "critical",
                        flashingEnabled: true,
                    });
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.5, 9);
            },
        },
        {
            id: "context_zoom",
            label: "Context Zoom",
            description: "Multi-alert cluster triggers zoom-out framing",
            checklist: [
                "Camera zoomed out to fit cluster",
                "Multiple polygons visible in frame",
                "Distinct colors applied",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("cz-1", "Tornado Warning", 39.5, -84.5, 0.25, { distance: 10 }),
                    _makeAlert("cz-2", "Severe Thunderstorm Warning", 39.7, -84.2, 0.2, { distance: 15 }),
                    _makeAlert("cz-3", "Severe Thunderstorm Warning", 39.3, -84.8, 0.2, { distance: 18 }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-cz-1";
                StormState.state.autotrack.enabled = true;

                if (typeof PolygonVisuals !== "undefined" && typeof SeverityModel !== "undefined") {
                    PolygonVisuals.updateContextPolygonVisuals({
                        clusterEvents: alerts,
                        primaryEventId: "demo-cz-1",
                        clusterSeverity: SeverityModel.deriveClusterSeverity(alerts),
                        flashingEnabled: false,
                    });
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                // Zoom out to show cluster
                _flyTo(39.5, -84.5, 8);
            },
        },
        {
            id: "spc_auto_day",
            label: "SPC Auto Day",
            description: "Day 2 is most severe → auto-selects Day 2, badge reflects it",
            checklist: [
                "SPC overlay visible",
                "Badge shows 'SPC Day 2 MDT' or similar",
                "Legend says 'SPC Day 2 Outlook'",
            ],
            apply: function () {
                if (typeof SPCMultiDay === "undefined") return;
                // Feed synthetic SPC features: Day 1 SLGT, Day 2 MDT, Day 3 MRGL
                const features1 = [_makeSpcFeature("SLGT", 38.5, 40.5, -86, -83)];
                const features2 = [_makeSpcFeature("MDT", 38.5, 40.5, -86, -83)];
                const features3 = [_makeSpcFeature("MRGL", 38.5, 40.5, -86, -83)];

                // Directly render Day 2 to show the visual
                if (typeof PolygonVisuals !== "undefined") PolygonVisuals.setSpcFeatures(features2);

                const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
                if (map) {
                    const layer = L.geoJSON({ type: "FeatureCollection", features: features2 }, {
                        style: { fillColor: "#FF0000", fillOpacity: 0.16, weight: 0.5, color: "#FF0000", opacity: 0.15, interactive: false, className: "spc-field" },
                    }).addTo(map);
                    _demoLayers.push(layer);
                }

                // Update badge manually
                const badge = document.getElementById("spc-day-badge");
                if (badge) {
                    badge.textContent = "SPC Day 2 MDT";
                    badge.classList.remove("hidden");
                }

                // Show legend
                const legend = document.getElementById("spc-legend");
                if (legend) {
                    legend.classList.remove("hidden");
                    const title = legend.querySelector(".spc-legend-title");
                    if (title) title.textContent = "SPC Day 2 Outlook";
                }

                _flyTo(39.5, -84.5, 7);
            },
        },
        {
            id: "spc_manual",
            label: "SPC Manual Flyout",
            description: "Verify SPC day flyout menu works — try clicking SPC button",
            checklist: [
                "Hover/click SPC button → menu expands upward",
                "Auto / Day 1 / Day 2 / Day 3 options visible",
                "Selecting Day 3 → badge shows 'SPC Manual Day 3'",
            ],
            apply: function () {
                // Just frame the map and remind user to interact
                const badge = document.getElementById("spc-day-badge");
                if (badge) {
                    badge.textContent = "Try SPC flyout →";
                    badge.classList.remove("hidden");
                }
                _flyTo(39.5, -84.5, 8);
            },
        },
        {
            id: "spc_escalation",
            label: "SPC Context Escalation",
            description: "Significant cluster + SPC overlap → wider zoom + SPC visible",
            checklist: [
                "Tornado warning polygon visible",
                "SPC risk field visible (blurred)",
                "Camera zoomed wider than normal",
                "Polygon glows (SPC intersection)",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("esc-1", "Tornado Warning", 39.5, -84.5, 0.3, { description: "PARTICULARLY DANGEROUS SITUATION", severity: "Extreme", distance: 8 }),
                    _makeAlert("esc-2", "Severe Thunderstorm Warning", 39.65, -84.25, 0.25, { distance: 12 }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-esc-1";
                StormState.state.autotrack.enabled = true;

                // SPC field
                const spcFeatures = [_makeSpcFeature("ENH", 38.5, 40.5, -86, -83)];
                if (typeof PolygonVisuals !== "undefined") {
                    PolygonVisuals.setSpcFeatures(spcFeatures);
                    PolygonVisuals.computeSpcIntersections();
                }

                const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
                if (map) {
                    const layer = L.geoJSON({ type: "FeatureCollection", features: spcFeatures }, {
                        style: { fillColor: "#FF6600", fillOpacity: 0.14, weight: 0.5, color: "#FF6600", opacity: 0.15, interactive: false, className: "spc-field" },
                    }).addTo(map);
                    _demoLayers.push(layer);
                }

                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.4, 7);
            },
        },
        {
            id: "motion_projection",
            label: "Motion + Ghost Polygons",
            description: "Tracked storm with motion vector → arrow, path, ghost polygons",
            checklist: [
                "White arrow at polygon centroid",
                "Dashed amber trajectory path",
                "15 min ghost polygon (faded)",
                "30 min ghost polygon (fainter)",
                "Speed label near arrow",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("mot-1", "Tornado Warning", 39.5, -84.5, 0.25, { severity: "Extreme" }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-mot-1";
                StormState.state.autotrack.enabled = true;

                // Inject motion vector
                StormState.state.motion.vectors["demo-mot-1"] = {
                    speedMph: 35,
                    bearingDeg: 45,  // NE
                    lastUpdated: Date.now(),
                };

                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                // Manually render motion visuals using the engine's public interface
                _renderDemoMotion("demo-mot-1", alerts[0], { lat: 39.5, lon: -84.5 }, { speedMph: 35, bearingDeg: 45 });

                _flyTo(39.55, -84.35, 9);
            },
        },
        {
            id: "impact_zone",
            label: "Impact Zone Shading",
            description: "Projected path corridor with impacted places",
            checklist: [
                "15 min corridor (stronger shading)",
                "30 min corridor (lighter, wider)",
                "Place labels ahead of storm path",
                "ETA values on labels",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("imp-1", "Tornado Warning", 39.3, -84.7, 0.25, { severity: "Extreme" }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-imp-1";
                StormState.state.autotrack.enabled = true;

                StormState.state.motion.vectors["demo-imp-1"] = {
                    speedMph: 40,
                    bearingDeg: 45,
                    lastUpdated: Date.now(),
                };

                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                // Render motion
                _renderDemoMotion("demo-imp-1", alerts[0], { lat: 39.3, lon: -84.7 }, { speedMph: 40, bearingDeg: 45 });

                // Render impact corridors
                if (typeof ImpactZone !== "undefined") {
                    const corridors = ImpactZone.buildImpactCorridorsForEvent(
                        alerts[0].polygon,
                        { lat: 39.3, lon: -84.7 },
                        { speedMph: 40, bearingDeg: 45 }
                    );

                    const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
                    if (map && corridors.length > 0) {
                        for (const c of corridors) {
                            if (!c.polygon) continue;
                            const is15 = c.minutes === 15;
                            const layer = L.geoJSON(c.polygon, {
                                style: {
                                    fillColor: is15 ? "rgba(255, 0, 60, 0.12)" : "rgba(255, 0, 60, 0.07)",
                                    fillOpacity: is15 ? 0.85 : 0.55,
                                    color: is15 ? "rgba(255, 0, 60, 0.25)" : "rgba(255, 0, 60, 0.15)",
                                    weight: is15 ? 1 : 0.5,
                                    dashArray: is15 ? "" : "4,3",
                                    interactive: false,
                                    className: `impact-zone impact-zone--${c.minutes}`,
                                },
                            }).addTo(map);
                            _demoLayers.push(layer);
                        }

                        // Add demo place labels along the path
                        const demoPlaces = [
                            { name: "Fairfield", lat: 39.45, lon: -84.55, eta: 8 },
                            { name: "Mason", lat: 39.55, lon: -84.35, eta: 18 },
                            { name: "Lebanon", lat: 39.62, lon: -84.22, eta: 26 },
                        ];
                        for (const p of demoPlaces) {
                            const isImminent = p.eta <= 15;
                            const marker = L.circleMarker([p.lat, p.lon], {
                                radius: isImminent ? 4 : 3,
                                color: isImminent ? "#ff4444" : "#f59e0b",
                                fillColor: isImminent ? "#ff4444" : "#f59e0b",
                                fillOpacity: isImminent ? 0.7 : 0.5,
                                weight: 1, interactive: false,
                            }).addTo(map);
                            _demoLayers.push(marker);

                            const tt = L.tooltip({
                                permanent: true, direction: "right",
                                className: `impact-place-label ${isImminent ? "impact-place-label--imminent" : ""}`,
                                offset: [6, 0],
                            }).setLatLng([p.lat, p.lon]).setContent(`${p.name} ${p.eta}m`);
                            tt.addTo(map);
                            _demoTooltips.push(tt);
                        }
                    }
                }

                _flyTo(39.45, -84.45, 9);
            },
        },
        {
            id: "storm_viz_severe",
            label: "Storm Viz — Severe",
            description: "Severe thunderstorm polygon with emphasis + elevated styling",
            checklist: [
                "Tracked polygon has strong orange border",
                "Subtle pulse animation",
                "No motion vector (low confidence)",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("sv-1", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-sv-1";
                StormState.state.autotrack.enabled = true;
                if (typeof StormViz !== "undefined") {
                    StormViz.renderStormVisualization(alerts[0], "elevated", { enabled: false });
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.5, 9);
            },
        },
        {
            id: "storm_viz_tornado",
            label: "Storm Viz — Tornado + Motion",
            description: "Tornado warning with motion vector and critical emphasis",
            checklist: [
                "Tracked polygon has red border + halo",
                "Pulse animation visible",
                "White motion arrow at centroid",
                "Speed label visible",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("tv-1", "Tornado Warning", 39.5, -84.5, 0.25, { description: "TORNADO WARNING", severity: "Extreme" }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-tv-1";
                StormState.state.autotrack.enabled = true;
                StormState.state.motion.vectors["demo-tv-1"] = { speedMph: 35, bearingDeg: 45, lastUpdated: Date.now() };
                if (typeof StormViz !== "undefined") {
                    const motion = { enabled: true, headingDeg: 45, speedMph: 35, confidence: "high" };
                    StormViz.renderStormVisualization(alerts[0], "tornado", motion);
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.5, 9);
            },
        },
        {
            id: "camera_centroid",
            label: "Camera — Centroid Framing",
            description: "Camera centers on tracked severe polygon centroid (no motion lead)",
            checklist: [
                "Camera smoothly centers on polygon",
                "No motion lead (no vector)",
                "Zoom matches medium polygon size",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("cc-1", "Severe Thunderstorm Warning", 39.5, -84.5, 0.4),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-cc-1";
                StormState.state.autotrack.enabled = true;
                if (typeof StormViz !== "undefined") StormViz.renderStormVisualization(alerts[0], "severe", { enabled: false });
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.5, 10);
            },
        },
        {
            id: "camera_motion_lead",
            label: "Camera — Tornado Motion Lead",
            description: "Camera leads ahead of tornado motion (NE direction)",
            checklist: [
                "Camera offset slightly NE of polygon",
                "Motion arrow visible at centroid",
                "Tighter zoom for tornado intensity",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("cm-1", "Tornado Warning", 39.5, -84.5, 0.2, { description: "TORNADO WARNING", severity: "Extreme" }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-cm-1";
                StormState.state.autotrack.enabled = true;
                StormState.state.motion.vectors["demo-cm-1"] = { speedMph: 40, bearingDeg: 45, lastUpdated: Date.now() };
                if (typeof StormViz !== "undefined") {
                    StormViz.renderStormVisualization(alerts[0], "tornado", { enabled: true, headingDeg: 45, speedMph: 40, confidence: "high" });
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                // Camera should lead NE — let StormCamera handle it, but also show approximate target
                if (typeof StormCamera !== "undefined") {
                    const lead = StormCamera.computeStormLeadPoint({ lat: 39.5, lon: -84.5 }, 45, 40, "tornado");
                    _flyTo(lead.lat, lead.lon, 10.5);
                } else {
                    _flyTo(39.52, -84.47, 10.5);
                }
            },
        },
        {
            id: "camera_large_zoom",
            label: "Camera — Large Polygon Zoom",
            description: "Large polygon causes wider zoom level",
            checklist: [
                "Camera zooms out further for large polygon",
                "Entire polygon visible in frame",
                "Zoom ~9 range",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("cl-1", "Severe Thunderstorm Warning", 39.5, -84.5, 1.2),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-cl-1";
                StormState.state.autotrack.enabled = true;
                if (typeof StormViz !== "undefined") StormViz.renderStormVisualization(alerts[0], "elevated", { enabled: false });
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.5, 9);
            },
        },

        // ── SPC Context Zoom Scenarios ────────────────────────────────

        {
            id: "spc_single_cluster",
            label: "SPC: Single Cluster Zoom",
            description: "Highlighted polygon + nearby SPC reports — zoom-out frames both",
            checklist: [
                "Highlighted polygon visible in frame",
                "SPC report markers visible",
                "Geographic reference (cities/roads) visible around cluster",
                "Zoom level shows full cluster extent",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("spc-tor-1", "Tornado Warning", 39.5, -84.5, 0.3, { severity: "Extreme" }),
                    _makeAlert("spc-svr-2", "Severe Thunderstorm Warning", 39.6, -84.3, 0.25),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-spc-tor-1";
                StormState.state.autotrack.enabled = true;

                // Add SPC features
                const spcFeatures = [
                    _makeSpcFeature("ENH", 39.0, 40.0, -85.0, -84.0),
                ];
                if (typeof PolygonVisuals !== "undefined") {
                    PolygonVisuals.setSpcFeatures(spcFeatures);
                    PolygonVisuals.updateContextPolygonVisuals({
                        clusterEvents: alerts,
                        primaryEventId: "demo-spc-tor-1",
                        clusterSeverity: typeof SeverityModel !== "undefined" ? SeverityModel.deriveClusterSeverity(alerts) : "high",
                        flashingEnabled: false,
                    });
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                // Use resolver if available
                _applySpcContextZoomDemo(alerts[0], spcFeatures, 39.5, -84.5);
            },
        },
        {
            id: "spc_wide_cluster",
            label: "SPC: Wide Cluster Zoom",
            description: "Highlighted polygon + geographically spread SPC reports",
            checklist: [
                "Highlighted polygon visible (may be small at this zoom)",
                "All SPC report features visible",
                "Zoom expands to include full cluster spread",
                "Geographic reference context clear",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("spc-tor-w", "Tornado Warning", 39.5, -84.5, 0.3, { severity: "Extreme" }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-spc-tor-w";
                StormState.state.autotrack.enabled = true;

                const spcFeatures = [
                    _makeSpcFeature("MDT", 38.5, 40.5, -86.0, -83.0),
                    _makeSpcFeature("SLGT", 38.0, 41.0, -87.0, -82.0),
                ];
                if (typeof PolygonVisuals !== "undefined") {
                    PolygonVisuals.setSpcFeatures(spcFeatures);
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                _applySpcContextZoomDemo(alerts[0], spcFeatures, 39.5, -84.5);
            },
        },
        {
            id: "spc_sparse",
            label: "SPC: Sparse Distant Reports",
            description: "Highlighted polygon with sparse but relevant distant SPC reports",
            checklist: [
                "Highlighted polygon visible",
                "Distant SPC features included in frame",
                "No excessive zoom-out beyond meaningful extent",
                "Location reference adequate",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("spc-svr-s", "Severe Thunderstorm Warning", 39.5, -84.5, 0.25),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-spc-svr-s";
                StormState.state.autotrack.enabled = true;

                const spcFeatures = [
                    _makeSpcFeature("MRGL", 38.8, 39.2, -85.5, -85.0),
                    _makeSpcFeature("SLGT", 40.0, 40.5, -83.5, -83.0),
                ];
                if (typeof PolygonVisuals !== "undefined") {
                    PolygonVisuals.setSpcFeatures(spcFeatures);
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                _applySpcContextZoomDemo(alerts[0], spcFeatures, 39.5, -84.5);
            },
        },
        {
            id: "spc_edge_case",
            label: "SPC: Near Map Edge",
            description: "Highlighted polygon near map edge with SPC reports",
            checklist: [
                "Highlighted polygon stays in frame",
                "SPC reports visible",
                "Edge handling does not drop polygon",
                "No projection artifacts",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("spc-edge", "Tornado Warning", 47.5, -90.0, 0.3, { severity: "Extreme" }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-spc-edge";
                StormState.state.autotrack.enabled = true;

                const spcFeatures = [
                    _makeSpcFeature("ENH", 46.5, 48.5, -91.5, -88.5),
                ];
                if (typeof PolygonVisuals !== "undefined") {
                    PolygonVisuals.setSpcFeatures(spcFeatures);
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                _applySpcContextZoomDemo(alerts[0], spcFeatures, 47.5, -90.0);
            },
        },
        {
            id: "spc_with_ui_overlay",
            label: "SPC: With UI Overlays",
            description: "Polygon + SPC reports + all UI overlays active",
            checklist: [
                "Full SPC reporting visible",
                "Polygon not hidden behind UI overlays",
                "Safe-area-aware framing accounts for header/dock/panels",
                "Clear location reference despite overlays",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("spc-ui-1", "Tornado Warning", 39.5, -84.5, 0.3, { severity: "Extreme" }),
                    _makeAlert("spc-ui-2", "Severe Thunderstorm Warning", 39.7, -84.2, 0.25),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-spc-ui-1";
                StormState.state.autotrack.enabled = true;

                const spcFeatures = [
                    _makeSpcFeature("ENH", 39.0, 40.0, -85.0, -83.5),
                ];
                if (typeof PolygonVisuals !== "undefined") {
                    PolygonVisuals.setSpcFeatures(spcFeatures);
                    PolygonVisuals.updateContextPolygonVisuals({
                        clusterEvents: alerts,
                        primaryEventId: "demo-spc-ui-1",
                        clusterSeverity: typeof SeverityModel !== "undefined" ? SeverityModel.deriveClusterSeverity(alerts) : "high",
                        flashingEnabled: true,
                    });
                }
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                // Open panel to test overlay-safe framing
                if (!StormState.state.alerts.panelOpen) StormState.togglePanel();

                _applySpcContextZoomDemo(alerts[0], spcFeatures, 39.5, -84.5);
            },
        },

        // ── Subsystem Verification Scenarios ────────────────────────────

        {
            id: "audio_follow_source_switch",
            label: "Audio Follow: Source Switch",
            description: "Switch between NOAA streams — verify audio-follow rebind",
            checklist: [
                "Audio follow strip visible with source label",
                "Source changes from NOAA to Scanner",
                "Status indicator updates on each switch",
                "Strip returns to idle on cleanup",
            ],
            apply: function () {
                const af = StormState.state.audioFollow;
                const _saved = { enabled: af.enabled, currentSource: af.currentSource, status: af.status, owner: af.owner, targetEvent: af.targetEvent, policy: af.policy };

                // Inject alert to make AF strip visible
                const alerts = [
                    _makeAlert("af-tor", "Tornado Warning", 39.5, -84.5, 0.3, { severity: "Extreme" }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-af-tor";
                StormState.state.autotrack.enabled = true;
                StormState.state.autotrack.mode = "track";
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                if (log) log.info("demo_scenario_phase", { scenario: "audio_follow_source_switch", phase: "start" });

                // Phase 1: Enable AF + bind source A (NOAA)
                af.enabled = true;
                af.currentSource = "noaa";
                af.owner = "auto-follow";
                af.targetEvent = "tornado_warning";
                af.status = "live";
                af.policy = "noaa_preferred";
                StormState.emit("audioFollowChanged", { source: "noaa", status: "live" });
                if (log) log.info("demo_scenario_phase", { scenario: "audio_follow_source_switch", phase: "source_a_bind", source: "noaa" });

                // Show the strip
                const strip = document.getElementById("audio-follow-strip");
                if (strip) { strip.classList.remove("hidden"); strip.textContent = "AF: NOAA — TOR — Live"; }

                _flyTo(39.5, -84.5, 9);

                // Phase 2: Switch to scanner after 2.5s
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== "audio_follow_source_switch") return;
                    af.currentSource = "scanner";
                    af.status = "pending";
                    StormState.emit("audioFollowChanged", { source: "scanner", status: "pending" });
                    if (strip) strip.textContent = "AF: Scanner — TOR — Pending";
                    if (log) log.info("demo_scenario_phase", { scenario: "audio_follow_source_switch", phase: "source_b_bind", source: "scanner" });

                    _scheduleStep(() => {
                        if (_state.activeScenarioId !== "audio_follow_source_switch") return;
                        af.status = "live";
                        StormState.emit("audioFollowChanged", { source: "scanner", status: "live" });
                        if (strip) strip.textContent = "AF: Scanner — TOR — Live";
                        if (log) log.info("demo_scenario_phase", { scenario: "audio_follow_source_switch", phase: "rebind_success", source: "scanner" });
                    }, 1500);
                }, 2500);

                // Phase 3: Switch back to NOAA after 5.5s
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== "audio_follow_source_switch") return;
                    af.currentSource = "noaa";
                    af.status = "live";
                    af.policy = "noaa_preferred";
                    StormState.emit("audioFollowChanged", { source: "noaa", status: "live" });
                    if (strip) strip.textContent = "AF: NOAA — TOR — Live";
                    if (log) log.info("demo_scenario_phase", { scenario: "audio_follow_source_switch", phase: "source_a_rebind", source: "noaa" });

                    _scheduleStep(() => {
                        if (log) log.info("demo_scenario_phase", { scenario: "audio_follow_source_switch", phase: "complete" });
                    }, 1000);
                }, 5500);
            },
        },
        {
            id: "context_pulse_cycle",
            label: "Context Pulse Cycle",
            description: "Trigger pulse → hold → release — verify camera + cards sync",
            checklist: [
                "Camera zooms out on pulse start",
                "Pulse cards appear during hold phase",
                "Camera zooms back to original position",
                "Cards cleared after pulse return",
            ],
            apply: function () {
                // Setup: inject alerts + enable AT + enable pulse
                const alerts = [
                    _makeAlert("cp-tor", "Tornado Warning", 39.5, -84.5, 0.25, { severity: "Extreme", distance: 8 }),
                    _makeAlert("cp-svr", "Severe Thunderstorm Warning", 39.7, -84.2, 0.2, { distance: 20 }),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-cp-tor";
                StormState.state.autotrack.enabled = true;
                StormState.state.autotrack.mode = "track";
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                if (log) log.info("demo_scenario_phase", { scenario: "context_pulse_cycle", phase: "start" });

                // Frame on the tracked alert
                _flyTo(39.5, -84.5, 10);

                // Phase 1: Trigger pulse after camera settles (1.5s)
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== "context_pulse_cycle") return;
                    if (log) log.info("demo_scenario_phase", { scenario: "context_pulse_cycle", phase: "pulse_begin" });

                    const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
                    const cam = StormState.state.camera;

                    // Snapshot pre-pulse state
                    if (map) {
                        const c = map.getCenter();
                        cam.prePulseCameraSnapshot = { centerLat: c.lat, centerLon: c.lng, zoom: map.getZoom() };
                    }

                    // Set pulse state
                    cam.contextPulseActive = true;
                    cam.contextPulsePhase = "zooming_out";
                    cam.contextPulseSessionId = "demo_ps_" + Date.now();
                    cam.contextPulseStartedAt = Date.now();
                    cam.systemCameraMotionActive = true;
                    cam.systemCameraMotionSource = "pulse";

                    // Zoom out
                    Camera.move({ source: "pulse", center: [39.55, -84.4], zoom: 7, flyOptions: { duration: 0.9 }, reason: "demo_pulse_zoom_out" });

                    // Phase 2: Hold (after zoom-out animation)
                    _scheduleStep(() => {
                        if (_state.activeScenarioId !== "context_pulse_cycle") return;
                        cam.contextPulsePhase = "holding";
                        if (log) log.info("demo_scenario_phase", { scenario: "context_pulse_cycle", phase: "hold_begin" });

                        // Show pulse cards
                        StormState.state.pulse.primaryInViewEventId = "demo-cp-tor";
                        StormState.state.pulse.inViewCount = 2;
                        StormState.state.pulse.inViewEventIds = ["demo-cp-tor", "demo-cp-svr"];
                        if (typeof PulseCards !== "undefined") StormState.emit("alertsUpdated", alerts);

                        if (log) log.info("demo_scenario_phase", { scenario: "context_pulse_cycle", phase: "cards_sync", cardCount: 2 });

                        // Phase 3: Return (after hold)
                        _scheduleStep(() => {
                            if (_state.activeScenarioId !== "context_pulse_cycle") return;
                            cam.contextPulsePhase = "zooming_back";
                            if (log) log.info("demo_scenario_phase", { scenario: "context_pulse_cycle", phase: "release_begin" });

                            // Zoom back to pre-pulse
                            const snap = cam.prePulseCameraSnapshot;
                            if (snap) {
                                Camera.move({ source: "pulse", center: [snap.centerLat, snap.centerLon], zoom: snap.zoom, flyOptions: { duration: 0.9 }, reason: "demo_pulse_return" });
                            }

                            if (log) log.info("demo_scenario_phase", { scenario: "context_pulse_cycle", phase: "camera_sync", result: "returned" });

                            // Phase 4: Cleanup after return animation
                            _scheduleStep(() => {
                                if (_state.activeScenarioId !== "context_pulse_cycle") return;
                                cam.contextPulseActive = false;
                                cam.contextPulsePhase = "idle";
                                cam.contextPulseSessionId = null;
                                cam.systemCameraMotionActive = false;
                                cam.systemCameraMotionSource = null;
                                StormState.state.pulse.primaryInViewEventId = null;
                                StormState.state.pulse.inViewCount = 0;
                                StormState.state.pulse.inViewEventIds = [];

                                if (log) log.info("demo_scenario_phase", { scenario: "context_pulse_cycle", phase: "complete" });
                            }, 1200);
                        }, 3000);
                    }, 1200);
                }, 1500);
            },
        },
        {
            id: "idle_grace_transition",
            label: "Idle → AT → Grace → Idle",
            description: "Full lifecycle: idle → storm → AT → clear → cooldown → idle",
            checklist: [
                "System starts in idle mode",
                "Storm appears — mode shifts to AT",
                "Storm clears — grace/cooldown begins",
                "Cooldown timer visible in status strip",
                "System returns to idle after cooldown",
            ],
            apply: function () {
                if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "start" });

                // Phase 1: Ensure idle state
                StormState.setAutoTrackMode("off");
                if (typeof CameraPolicy !== "undefined") CameraPolicy.setPreference("AUTO");

                const ssMode = document.getElementById("ss-mode");
                const ssAt = document.getElementById("ss-at");
                const titleEl = document.getElementById("app-title");

                // Show idle state
                if (ssMode) { ssMode.textContent = "IDLE"; ssMode.className = "ss-badge ss-mode-idle"; }
                if (ssAt) { ssAt.textContent = "AT OFF"; ssAt.className = "ss-badge ss-dim"; }
                if (titleEl) titleEl.textContent = "LOCAL NEWS";

                _flyTo(39.5, -84.5, 7);
                if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "idle_confirmed" });

                // Phase 2: Storm appears (3s)
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== "idle_grace_transition") return;

                    const alerts = [
                        _makeAlert("ig-tor", "Tornado Warning", 39.5, -84.5, 0.3, { severity: "Extreme", distance: 15 }),
                    ];
                    _injectAlerts(alerts);
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "storm_injected", event: "Tornado Warning" });

                    // Phase 3: AT enters (1s after storm)
                    _scheduleStep(() => {
                        if (_state.activeScenarioId !== "idle_grace_transition") return;

                        StormState.state.autotrack.targetAlertId = "demo-ig-tor";
                        StormState.state.autotrack.enabled = true;
                        StormState.state.autotrack.mode = "track";
                        StormState.emit("autotrackChanged", { mode: "track", prev: "off" });

                        if (ssMode) { ssMode.textContent = "AT"; ssMode.className = "ss-badge ss-mode-tracking"; }
                        if (ssAt) { ssAt.textContent = "AT TOR"; ssAt.className = "ss-badge ss-at-tor"; }
                        if (titleEl) titleEl.textContent = "STORM TRACKER";

                        _flyTo(39.5, -84.5, 10);
                        if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "at_entered" });

                        // Phase 4: Storm clears (4s after AT)
                        _scheduleStep(() => {
                            if (_state.activeScenarioId !== "idle_grace_transition") return;

                            // Clear storm data
                            _restoreAlerts();
                            _injectAlerts([]);
                            StormState.state.autotrack.targetAlertId = null;
                            StormState.state.autotrack.enabled = false;
                            StormState.state.autotrack.mode = "off";
                            StormState.emit("autotrackChanged", { mode: "off", prev: "track" });
                            if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                            if (ssAt) { ssAt.textContent = "AT OFF"; ssAt.className = "ss-badge ss-dim"; }
                            if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "storm_cleared" });

                            // Phase 5: Cooldown visible (immediate)
                            if (ssMode) { ssMode.textContent = "GRACE"; ssMode.className = "ss-badge ss-mode-grace"; }
                            if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "cooldown_active", duration_ms: 4000 });

                            // Animate cooldown countdown
                            let countdown = 4;
                            const countdownTimer = setInterval(() => {
                                countdown--;
                                if (ssMode && countdown > 0) ssMode.textContent = `GRACE ${countdown}s`;
                            }, 1000);
                            _scenarioTimers.push(countdownTimer);

                            // Phase 6: Return to idle after grace (4s)
                            _scheduleStep(() => {
                                if (_state.activeScenarioId !== "idle_grace_transition") return;
                                clearInterval(countdownTimer);

                                if (ssMode) { ssMode.textContent = "IDLE"; ssMode.className = "ss-badge ss-mode-idle"; }
                                if (titleEl) titleEl.textContent = "LOCAL NEWS";

                                _flyTo(39.5, -84.5, 7);
                                if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "idle_restored" });

                                _scheduleStep(() => {
                                    if (log) log.info("demo_scenario_phase", { scenario: "idle_grace_transition", phase: "complete" });
                                }, 500);
                            }, 4000);
                        }, 4000);
                    }, 1000);
                }, 3000);
            },
        },
        {
            id: "multi_layer_crossfade",
            label: "Multi-Layer Crossfade",
            description: "SRV/CC layer transitions — verify smooth visual swap",
            checklist: [
                "SRV button activates + legend appears",
                "CC button activates on top of SRV",
                "CC layer visually overlays SRV",
                "CC deactivates smoothly, SRV remains",
                "SRV deactivates, map clean",
            ],
            apply: function () {
                if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "start" });

                // Frame on a radar-rich area
                _flyTo(39.5, -84.5, 8);

                // Phase 1: Enable SRV (1s)
                _scheduleStep(async () => {
                    if (_state.activeScenarioId !== "multi_layer_crossfade") return;
                    if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "srv_activating" });

                    const srvOk = await RadarManager.enableSRV();
                    if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "source_layer_active", layer: "srv", success: srvOk });

                    // Phase 2: Enable CC on top (3s after SRV)
                    _scheduleStep(async () => {
                        if (_state.activeScenarioId !== "multi_layer_crossfade") return;
                        if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "crossfade_start", from: "srv_only", to: "srv+cc" });

                        const ccOk = await RadarManager.enableCC();
                        if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "target_layer_active", layer: "cc", success: ccOk });

                        // Phase 3: Remove CC (3s after CC)
                        _scheduleStep(() => {
                            if (_state.activeScenarioId !== "multi_layer_crossfade") return;
                            if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "crossfade_start", from: "srv+cc", to: "srv_only" });

                            RadarManager.disableLayers(["cc"]);
                            if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "crossfade_complete", result: "cc_removed" });

                            // Phase 4: Remove SRV (2.5s after CC removed)
                            _scheduleStep(() => {
                                if (_state.activeScenarioId !== "multi_layer_crossfade") return;
                                if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "crossfade_start", from: "srv_only", to: "none" });

                                RadarManager.disableLayers(["srv"]);
                                if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "crossfade_complete", result: "all_removed" });

                                _scheduleStep(() => {
                                    if (log) log.info("demo_scenario_phase", { scenario: "multi_layer_crossfade", phase: "complete" });
                                }, 500);
                            }, 2500);
                        }, 3000);
                    }, 3000);
                }, 1000);
            },
        },
        {
            id: "storm_viz_engine",
            label: "Storm Viz: All Intensity Levels",
            description: "Cycles through low → moderate → high → extreme intensity with motion + impact",
            checklist: [
                "Low intensity: static polygon, no pulse",
                "Moderate intensity: slow pulse visible",
                "High intensity: fast pulse + flash",
                "Extreme intensity: fast pulse + halo glow + motion arrow",
                "Impact corridor with flow animation",
            ],
            apply: function () {
                if (log) log.info("demo_scenario_phase", { scenario: "storm_viz_engine", phase: "start" });

                // Force viz enabled
                if (typeof StormVizState !== "undefined") StormVizState.setEnabled(true);

                // Phase 1: Low — advisory alert
                const alertLow = _makeAlert("viz-low", "Winter Storm Warning", 39.5, -84.5, 0.25, { severity: "Minor" });
                _injectAlerts([alertLow]);
                StormState.state.autotrack.targetAlertId = "demo-viz-low";
                StormState.state.autotrack.enabled = true;
                StormState.state.autotrack.mode = "track";
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                if (typeof StormViz !== "undefined") StormViz.renderStormVisualization(alertLow, "advisory", { enabled: false });
                _flyTo(39.5, -84.5, 9);
                if (log) log.info("demo_scenario_phase", { scenario: "storm_viz_engine", phase: "viz_intensity", level: "low" });

                // Phase 2: Moderate (3s)
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== "storm_viz_engine") return;
                    const alertMod = _makeAlert("viz-mod", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3);
                    _restoreAlerts();
                    _injectAlerts([alertMod]);
                    StormState.state.autotrack.targetAlertId = "demo-viz-mod";
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    if (typeof StormViz !== "undefined") StormViz.renderStormVisualization(alertMod, "elevated", { enabled: false });
                    if (log) log.info("demo_scenario_phase", { scenario: "storm_viz_engine", phase: "viz_intensity", level: "moderate" });
                }, 3000);

                // Phase 3: High (6s)
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== "storm_viz_engine") return;
                    const alertHigh = _makeAlert("viz-high", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3, { description: "DESTRUCTIVE hail", severity: "Extreme" });
                    _restoreAlerts();
                    _injectAlerts([alertHigh]);
                    StormState.state.autotrack.targetAlertId = "demo-viz-high";
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    if (typeof StormViz !== "undefined") StormViz.renderStormVisualization(alertHigh, "severe", { enabled: false });
                    if (log) log.info("demo_scenario_phase", { scenario: "storm_viz_engine", phase: "viz_intensity", level: "high" });
                }, 6000);

                // Phase 4: Extreme + motion (9s)
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== "storm_viz_engine") return;
                    const alertExtreme = _makeAlert("viz-ext", "Tornado Warning", 39.5, -84.5, 0.25, { description: "PARTICULARLY DANGEROUS SITUATION", severity: "Extreme" });
                    _restoreAlerts();
                    _injectAlerts([alertExtreme]);
                    StormState.state.autotrack.targetAlertId = "demo-viz-ext";
                    StormState.state.motion.vectors["demo-viz-ext"] = { speedMph: 45, bearingDeg: 45, lastUpdated: Date.now() };
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    const motion = { enabled: true, headingDeg: 45, speedMph: 45, confidence: "high" };
                    if (typeof StormViz !== "undefined") StormViz.renderStormVisualization(alertExtreme, "critical", motion);
                    _renderDemoMotion("demo-viz-ext", alertExtreme, { lat: 39.5, lon: -84.5 }, { speedMph: 45, bearingDeg: 45 });
                    if (log) log.info("demo_scenario_phase", { scenario: "storm_viz_engine", phase: "viz_intensity", level: "extreme" });

                    _scheduleStep(() => {
                        if (log) log.info("demo_scenario_phase", { scenario: "storm_viz_engine", phase: "complete" });
                    }, 3000);
                }, 9000);
            },
        },
        {
            id: "spoken_alert_demo",
            label: "Spoken Alert: Full Verification",
            description: "Part 10: unlock, overlap prevention, escalation voice differentiation, rapid events",
            checklist: [
                "Audio unlocks on scenario start (gesture-initiated)",
                "Speech status indicator shows READY after unlock",
                "Target acquired: normal voice (rate 1.0, pitch 0.9)",
                "Rapid events: no overlap, cancel-replace logged",
                "Escalation: distinct voice (rate 1.1, pitch 1.1, 'Attention.' prefix)",
                "Tornado warning: urgent voice (rate 1.3, pitch 1.4, 'Alert.' prefix)",
                "Status indicator updates throughout",
            ],
            apply: function () {
                const SN = "spoken_alert_demo";
                if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "start" });

                // Ensure audio enabled + reset state
                StormState.state.audioEnabled = true;
                if (typeof AlertState !== "undefined") { AlertState.setEnabled(true); AlertState.reset(); }

                // Phase 0: Force audio unlock (this apply runs from a user click)
                if (typeof AlertEngine !== "undefined") AlertEngine.forceUnlock();
                if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "unlock_attempted" });

                // Phase 1: Target acquisition (2s) — normal voice
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== SN) return;
                    const alert1 = _makeAlert("sp-svr", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3);
                    _injectAlerts([alert1]);
                    StormState.state.autotrack.targetAlertId = "demo-sp-svr";
                    StormState.state.autotrack.enabled = true;
                    StormState.state.autotrack.mode = "track";
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    _flyTo(39.5, -84.5, 9);

                    StormState.emit("vizTargetChanged", { prevTarget: null, currentTarget: "demo-sp-svr", intensity: "moderate" });
                    if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "target_acquired", expectedVoice: "rate=1.0 pitch=0.9" });
                }, 2000);

                // Phase 2: Rapid overlap test (6s) — fire 3 events in 500ms
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== SN) return;
                    if (typeof AlertState !== "undefined") AlertState.reset();
                    if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "rapid_events_start" });

                    // Event A: immediately
                    StormState.emit("vizTargetChanged", { prevTarget: null, currentTarget: "demo-sp-svr", intensity: "moderate" });

                    // Event B: 200ms later (should cancel A)
                    _scheduleStep(() => {
                        if (_state.activeScenarioId !== SN) return;
                        if (typeof AlertState !== "undefined") AlertState.reset();
                        StormState.emit("vizIntensityChanged", { prevIntensity: "moderate", currentIntensity: "high", targetId: "demo-sp-svr" });
                    }, 200);

                    // Event C: 400ms later (should cancel B — escalation)
                    _scheduleStep(() => {
                        if (_state.activeScenarioId !== SN) return;
                        if (typeof AlertState !== "undefined") AlertState.reset();
                        StormState.emit("vizIntensityChanged", { prevIntensity: "high", currentIntensity: "extreme", targetId: "demo-sp-svr" });
                        if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "rapid_events_done", expectedResult: "only_last_event_audible" });
                    }, 400);
                }, 6000);

                // Phase 3: Escalation — distinct voice (12s)
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== SN) return;
                    if (typeof AlertState !== "undefined") AlertState.reset();

                    StormState.emit("vizIntensityChanged", { prevIntensity: "moderate", currentIntensity: "high", targetId: "demo-sp-svr" });
                    if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "escalation", expectedVoice: "rate=1.1 pitch=1.1 prefix=Attention" });
                }, 12000);

                // Phase 4: Tornado warning — urgent voice (18s)
                _scheduleStep(() => {
                    if (_state.activeScenarioId !== SN) return;
                    if (typeof AlertState !== "undefined") AlertState.reset();

                    const torAlert = _makeAlert("sp-tor", "Tornado Warning", 39.5, -84.5, 0.25, { severity: "Extreme", description: "TORNADO WARNING" });
                    _restoreAlerts();
                    _injectAlerts([torAlert]);
                    StormState.state.autotrack.targetAlertId = "demo-sp-tor";
                    StormState.state.motion.vectors["demo-sp-tor"] = { speedMph: 40, bearingDeg: 45, lastUpdated: Date.now() };
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                    StormState.emit("vizTargetChanged", { prevTarget: "demo-sp-svr", currentTarget: "demo-sp-tor", intensity: "extreme" });
                    if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "tornado_warning", expectedVoice: "rate=1.3 pitch=1.4 prefix=Alert" });

                    _scheduleStep(() => {
                        // Log final status
                        const status = typeof AlertEngine !== "undefined" ? AlertEngine.getStatus() : {};
                        if (log) log.info("demo_scenario_phase", { scenario: SN, phase: "complete", speechStatus: status });
                    }, 4000);
                }, 18000);
            },
        },
        // ── AI Advisory Demo Scenarios ──────────────────────────────
        {
            id: "ai_summary",
            label: "AI Summary",
            description: "Trigger AI storm summary generation and display",
            checklist: [
                "AI panel visible with status",
                "Summary generated and displayed",
                "AI status badge shows connected or offline",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("ai-tor", "Tornado Warning", 39.5, -84.5, 0.3, {
                        description: "A confirmed tornado was located 5 miles southwest of downtown, moving northeast at 35 mph.",
                        severity: "Extreme", headline: "Tornado Warning for Montgomery County"
                    }),
                    _makeAlert("ai-svr", "Severe Thunderstorm Warning", 39.6, -84.2, 0.25, {
                        description: "Large hail up to golf ball size and winds of 70 mph expected.",
                        severity: "Severe", headline: "SVR Warning for Warren County"
                    }),
                ];
                _injectAlerts(alerts);

                // Show AI panel
                const panel = document.getElementById("ai-panel");
                if (panel) panel.classList.remove("hidden");

                // Trigger summary
                if (typeof AIPanel !== "undefined") {
                    AIPanel.triggerSummary();
                }

                if (log) log.info("demo_ai_summary", { alerts: 2 });
            },
        },
        {
            id: "ai_narration",
            label: "AI Narration + TTS",
            description: "Generate AI narration and speak via browser TTS",
            checklist: [
                "AI generates narration text",
                "Browser speaks the narration",
                "Narration displayed in AI panel",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("ai-nar-tor", "Tornado Warning", 39.5, -84.5, 0.3, {
                        description: "Confirmed tornado moving northeast at 40 mph through populated area.",
                        severity: "Extreme", headline: "Tornado Warning for Butler County"
                    }),
                ];
                _injectAlerts(alerts);

                const panel = document.getElementById("ai-panel");
                if (panel) panel.classList.remove("hidden");

                if (typeof AIPanel !== "undefined") {
                    AIPanel.triggerNarration();
                    // Speak after brief delay to let generation happen
                    _scheduleStep(() => AIPanel.speakLastNarration(), 5000);
                }

                if (log) log.info("demo_ai_narration", { alerts: 1 });
            },
        },
        {
            id: "ai_offline",
            label: "AI Offline Fallback",
            description: "Verify system works when AI is unavailable",
            checklist: [
                "AI status shows offline/unhealthy",
                "Storm tracker continues functioning",
                "Alert rendering and map unaffected",
                "No UI freeze or errors",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("ai-off-svr", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3, {
                        severity: "Severe", headline: "SVR Warning — AI offline test"
                    }),
                ];
                _injectAlerts(alerts);

                // Temporarily disable AI
                if (typeof AIPanel !== "undefined") {
                    StormState.state.ai.enabled = false;
                    StormState.state.ai.healthy = false;
                }

                const ssAi = document.getElementById("ss-ai");
                if (ssAi) {
                    ssAi.textContent = "AI !";
                    ssAi.className = "ss-badge ss-ai-err";
                }

                if (log) log.info("demo_ai_offline", { enabled: false });
            },
        },
        // ── Audio Toggle Demo Scenarios ─────────────────────────────
        {
            id: "ai_only_mode",
            label: "AI-Only Speech",
            description: "AI audio ON, legacy OFF — AI handles all spoken alerts",
            checklist: [
                "AI toggle ON in settings",
                "Legacy toggle OFF in settings",
                "Status strip shows AI ON",
                "Spoken alerts use AI voice (slower, lower pitch)",
            ],
            apply: function () {
                if (typeof AIPanel !== "undefined") {
                    if (!AIPanel.isEnabled()) AIPanel.toggleEnabled();
                }
                if (typeof AlertEngine !== "undefined") {
                    AlertEngine.setLegacyEnabled(false);
                }
                const alerts = [
                    _makeAlert("aim-tor", "Tornado Warning", 39.5, -84.5, 0.3, {
                        severity: "Extreme", headline: "Tornado Warning — AI only mode test"
                    }),
                ];
                _injectAlerts(alerts);
                if (log) log.info("demo_ai_only_mode", { ai: true, legacy: false });
            },
        },
        {
            id: "legacy_only_mode",
            label: "Legacy-Only Speech",
            description: "AI audio OFF, legacy ON — original alert voice active",
            checklist: [
                "AI toggle OFF in settings",
                "Legacy toggle ON in settings",
                "Status strip shows LEG",
                "Spoken alerts use legacy voice (faster, higher pitch)",
            ],
            apply: function () {
                if (typeof AIPanel !== "undefined") {
                    if (AIPanel.isEnabled()) AIPanel.toggleEnabled();
                }
                if (typeof AlertEngine !== "undefined") {
                    AlertEngine.setLegacyEnabled(true);
                }
                const alerts = [
                    _makeAlert("leg-svr", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3, {
                        severity: "Severe", headline: "SVR Warning — Legacy only mode test"
                    }),
                ];
                _injectAlerts(alerts);
                if (log) log.info("demo_legacy_only_mode", { ai: false, legacy: true });
            },
        },
        {
            id: "both_disabled",
            label: "Both Speech OFF",
            description: "AI OFF + Legacy OFF — no spoken output, tones only",
            checklist: [
                "Both toggles OFF",
                "Status strip shows MUTE",
                "No spoken alerts occur",
                "Pre-attention tones still play",
            ],
            apply: function () {
                if (typeof AIPanel !== "undefined") {
                    if (AIPanel.isEnabled()) AIPanel.toggleEnabled();
                }
                if (typeof AlertEngine !== "undefined") {
                    AlertEngine.setLegacyEnabled(false);
                }
                const alerts = [
                    _makeAlert("mute-svr", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3, {
                        severity: "Severe", headline: "SVR Warning — Mute mode test"
                    }),
                ];
                _injectAlerts(alerts);
                if (log) log.info("demo_both_disabled", { ai: false, legacy: false });
            },
        },
        {
            id: "ai_failover_to_legacy",
            label: "AI Failover → Legacy",
            description: "AI enabled but unhealthy → falls back to legacy voice",
            checklist: [
                "AI toggle ON, legacy toggle ON",
                "AI marked unhealthy",
                "Status strip shows AI ! with fallback note",
                "Spoken alerts use legacy voice",
            ],
            apply: function () {
                if (typeof AIPanel !== "undefined") {
                    if (!AIPanel.isEnabled()) AIPanel.toggleEnabled();
                    // Simulate unhealthy
                    StormState.state.ai.healthy = false;
                }
                if (typeof AlertEngine !== "undefined") {
                    AlertEngine.setLegacyEnabled(true);
                }
                const ssAi = document.getElementById("ss-ai");
                if (ssAi) {
                    ssAi.textContent = "AI !";
                    ssAi.className = "ss-badge ss-ai-err";
                    ssAi.title = "AI: Offline — Legacy fallback active";
                }
                const alerts = [
                    _makeAlert("fail-svr", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3, {
                        severity: "Severe", headline: "SVR Warning — AI failover test"
                    }),
                ];
                _injectAlerts(alerts);
                if (log) log.info("demo_ai_failover", { ai: true, aiHealthy: false, legacy: true });
            },
        },

        // ── New Demo Scenarios (2026-03-26) ──────────────────────────────

        {
            id: "multi_polygon_cluster",
            label: "Multi-Polygon Cluster",
            description: "5-10 mixed alerts — verify rendering, selection, and polygon cap",
            checklist: [
                "All polygons render with correct colors",
                "Primary (TOR) has thick bright border",
                "No visual overlap glitches",
                "Polygon count logged correctly",
                "Camera frames the cluster",
            ],
            apply: function () {
                const alerts = [
                    _makeAlert("mpc-tor1", "Tornado Warning", 39.5, -84.5, 0.25, { severity: "Extreme", description: "TORNADO WARNING for Hamilton County" }),
                    _makeAlert("mpc-tor2", "Tornado Warning", 39.55, -84.3, 0.2, { severity: "Extreme", description: "TORNADO WARNING PDS" }),
                    _makeAlert("mpc-svr1", "Severe Thunderstorm Warning", 39.6, -84.6, 0.3, { description: "80 mph winds and 2 inch hail" }),
                    _makeAlert("mpc-svr2", "Severe Thunderstorm Warning", 39.4, -84.2, 0.25, { description: "60 mph wind gusts" }),
                    _makeAlert("mpc-svr3", "Severe Thunderstorm Warning", 39.7, -84.4, 0.2),
                    _makeAlert("mpc-ffw1", "Flash Flood Warning", 39.35, -84.7, 0.3),
                    _makeAlert("mpc-ffw2", "Flash Flood Warning", 39.65, -84.8, 0.25),
                    _makeAlert("mpc-sws1", "Special Weather Statement", 39.8, -84.5, 0.2),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-mpc-tor1";
                StormState.state.autotrack.enabled = true;
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                if (typeof PolygonEngine !== "undefined") PolygonEngine.processAlerts(alerts);
                _flyTo(39.55, -84.5, 8);
                if (log) log.info("demo_scenario_applied", { scenario: "multi_polygon_cluster", alert_count: alerts.length });
            },
        },
        {
            id: "tornado_priority_override",
            label: "Tornado Priority Override",
            description: "SVR active → TOR appears → verify primary switches to TOR",
            checklist: [
                "SVR starts as primary target",
                "TOR appears after 3s",
                "Primary switches to TOR immediately",
                "Camera re-centers on TOR polygon",
                "Log shows primary_selected change",
            ],
            apply: function () {
                // Phase 1: SVR only
                var svrAlerts = [
                    _makeAlert("tpo-svr1", "Severe Thunderstorm Warning", 39.5, -84.5, 0.3, { description: "70 mph winds" }),
                    _makeAlert("tpo-svr2", "Severe Thunderstorm Warning", 39.6, -84.3, 0.25),
                ];
                _injectAlerts(svrAlerts);
                StormState.state.autotrack.targetAlertId = "demo-tpo-svr1";
                StormState.state.autotrack.enabled = true;
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.5, 9);
                if (log) log.info("demo_tpo_phase1", { primary: "svr1", count: 2 });

                // Phase 2: TOR appears after 3s
                _scheduleStep(function () {
                    var allAlerts = svrAlerts.concat([
                        _makeAlert("tpo-tor1", "Tornado Warning", 39.45, -84.45, 0.2, { severity: "Extreme", description: "TORNADO WARNING confirmed tornado" }),
                    ]);
                    _injectAlerts(allAlerts);
                    StormState.state.autotrack.targetAlertId = "demo-tpo-tor1";
                    StormState.emit("autotrackTargetChanged", { currentTarget: "demo-tpo-tor1", previousTarget: "demo-tpo-svr1" });
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    _flyTo(39.45, -84.45, 10);
                    if (log) log.info("demo_tpo_phase2", { primary: "tor1", count: 3, override: true });
                }, 3000);
            },
        },
        {
            id: "motion_tracking",
            label: "Motion Tracking",
            description: "Polygon moves NE over time — verify camera follows motion",
            checklist: [
                "Polygon position updates every 2s",
                "Motion vector arrow visible",
                "Camera tracks the moving storm",
                "Ghost polygons show projected positions",
                "Speed label updates",
            ],
            apply: function () {
                var lat = 39.3, lon = -84.7;
                var speedMph = 45;
                var bearingDeg = 45; // NE

                function updatePosition(step) {
                    lat += 0.02;
                    lon += 0.02;
                    var alerts = [
                        _makeAlert("mt-tor1", "Tornado Warning", lat, lon, 0.2, {
                            severity: "Extreme",
                            description: "TORNADO WARNING moving northeast at 45 mph",
                        }),
                    ];
                    // Inject motion data
                    alerts[0]._unifiedMotion = {
                        speed_mph: speedMph,
                        heading_deg: bearingDeg,
                        motion_confidence: 0.9,
                    };
                    _injectAlerts(alerts);
                    StormState.state.autotrack.targetAlertId = "demo-mt-tor1";
                    StormState.state.autotrack.enabled = true;
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    _flyTo(lat, lon, 10);
                    if (log) log.info("demo_motion_step", { step: step, lat: lat.toFixed(3), lon: lon.toFixed(3) });
                }

                updatePosition(0);
                for (var i = 1; i <= 5; i++) {
                    (function (idx) {
                        _scheduleStep(function () { updatePosition(idx); }, idx * 2000);
                    })(i);
                }
            },
        },
        {
            id: "rapid_update_stress",
            label: "Rapid Update Stress",
            description: "10 alert updates in 5s — verify no flicker, lag, or crash",
            checklist: [
                "UI remains responsive during rapid updates",
                "No polygon flickering",
                "No console errors",
                "Update throttle engages (logged)",
                "Final state is correct",
            ],
            apply: function () {
                var updateCount = 0;
                var startTime = Date.now();

                function rapidUpdate() {
                    updateCount++;
                    var jitter = (Math.random() - 0.5) * 0.1;
                    var alerts = [
                        _makeAlert("rus-tor1", "Tornado Warning", 39.5 + jitter, -84.5 + jitter, 0.2 + Math.random() * 0.1, { severity: "Extreme" }),
                        _makeAlert("rus-svr1", "Severe Thunderstorm Warning", 39.6 + jitter, -84.3 + jitter, 0.25),
                        _makeAlert("rus-svr2", "Severe Thunderstorm Warning", 39.4 + jitter, -84.7 + jitter, 0.2),
                    ];
                    _injectAlerts(alerts);
                    StormState.state.autotrack.targetAlertId = "demo-rus-tor1";
                    StormState.state.autotrack.enabled = true;
                    StormState.emit("alertsUpdated");
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

                    if (log) log.info("demo_rapid_update", {
                        update: updateCount,
                        elapsed_ms: Date.now() - startTime,
                    });
                }

                // Fire 10 updates over 5 seconds (every 500ms)
                rapidUpdate();
                for (var i = 1; i < 10; i++) {
                    (function (idx) {
                        _scheduleStep(rapidUpdate, idx * 500);
                    })(i);
                }

                _flyTo(39.5, -84.5, 9);
            },
        },
        {
            id: "clear_all_return_idle",
            label: "Clear All → Idle",
            description: "Active alerts clear — verify clean return to idle mode",
            checklist: [
                "Alerts populate first (3s)",
                "All alerts clear simultaneously",
                "Camera returns to default position",
                "Auto Track disengages",
                "No orphaned polygons on map",
                "UI shows no active threats",
            ],
            apply: function () {
                // Phase 1: Active alerts
                var alerts = [
                    _makeAlert("cai-tor1", "Tornado Warning", 39.5, -84.5, 0.25, { severity: "Extreme" }),
                    _makeAlert("cai-svr1", "Severe Thunderstorm Warning", 39.6, -84.3, 0.3),
                    _makeAlert("cai-ffw1", "Flash Flood Warning", 39.4, -84.7, 0.2),
                ];
                _injectAlerts(alerts);
                StormState.state.autotrack.targetAlertId = "demo-cai-tor1";
                StormState.state.autotrack.enabled = true;
                if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                _flyTo(39.5, -84.5, 9);
                if (log) log.info("demo_cai_phase1", { count: alerts.length });

                // Phase 2: Clear all after 3s
                _scheduleStep(function () {
                    _injectAlerts([]);
                    StormState.state.autotrack.targetAlertId = null;
                    StormState.state.autotrack.enabled = false;
                    StormState.emit("alertsUpdated");
                    StormState.emit("autotrackTargetChanged", { currentTarget: null, previousTarget: "demo-cai-tor1" });
                    if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();
                    if (typeof CameraController !== "undefined") CameraController.setMode("idle");
                    _flyTo(CENTER.lat, CENTER.lon, 7);
                    if (log) log.info("demo_cai_phase2", { cleared: true, idle: true });
                }, 3000);
            },
        },
    ];

    // ── SPC Context Zoom Demo Helper ───────────────────────────────

    function _applySpcContextZoomDemo(trackedAlert, spcFeatures, lat, lon) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) { _flyTo(lat, lon, 8); return; }

        // PARITY ASSERTION: Demo MUST use the same resolver as live mode.
        // If ContextZoomResolver is available in live, it must be used here.
        // This prevents demo/live camera divergence.
        if (typeof ContextZoomResolver !== "undefined") {
            let polygonBounds = null;
            try {
                const geo = JSON.parse(trackedAlert.polygon);
                polygonBounds = L.geoJSON(geo).getBounds();
            } catch (e) { /* fallback */ }

            if (polygonBounds && polygonBounds.isValid()) {
                // Use the SAME resolveContextZoomBounds function as live mode
                // Safe area is dynamically measured by the resolver (PATCH 4)
                const result = ContextZoomResolver.resolveContextZoomBounds({
                    highlightedPolygonBounds: polygonBounds,
                    highlightedPolygonId: trackedAlert.id,
                    spcReports: spcFeatures,
                    spcOutlookBounds: null,
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    safeAreaInsets: null, // Let resolver measure dynamically
                    map: map,
                });

                if (result) {
                    Camera.move({ source: "idle", bounds: result.bounds, flyOptions: { duration: 1.0, maxZoom: result.zoom, padding: [20, 20] }, reason: "demo_context_zoom" });
                    return;
                }
            }
        }

        // Fallback: manual bounds calculation
        let bounds = null;
        try {
            const geo = JSON.parse(trackedAlert.polygon);
            bounds = L.geoJSON(geo).getBounds();
        } catch (e) { /* ok */ }

        if (bounds) {
            for (const f of spcFeatures) {
                try {
                    const fb = L.geoJSON(f).getBounds();
                    if (fb.isValid()) bounds.extend(fb);
                } catch (e) { /* ok */ }
            }
            Camera.move({ source: "idle", bounds: bounds.pad(0.2), flyOptions: { duration: 1.0, maxZoom: 10 }, reason: "demo_fallback_bounds" });
        } else {
            _flyTo(lat, lon, 8);
        }
    }

    // ── Demo Motion Renderer (standalone) ──────────────────────────

    function _renderDemoMotion(eventId, alert, centroid, vector) {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        const color = StormState.getEventColor(alert.event);
        const bearingRad = vector.bearingDeg * Math.PI / 180;
        const cosLat = Math.max(Math.cos(centroid.lat * Math.PI / 180), 0.01);

        // Arrow
        const arrowLen = 0.04;
        const endLat = centroid.lat + arrowLen * Math.cos(bearingRad);
        const endLon = centroid.lon + arrowLen * Math.sin(bearingRad) / cosLat;
        const shaft = L.polyline([[centroid.lat, centroid.lon], [endLat, endLon]], {
            color: "#ffffff", weight: 2.5, opacity: 0.9, interactive: false,
        }).addTo(map);
        _demoLayers.push(shaft);

        // Arrowhead
        const headLen = 0.015, headAngle = Math.PI / 6;
        const left = [endLat - headLen * Math.cos(bearingRad - headAngle), endLon - headLen * Math.sin(bearingRad - headAngle) / cosLat];
        const right = [endLat - headLen * Math.cos(bearingRad + headAngle), endLon - headLen * Math.sin(bearingRad + headAngle) / cosLat];
        const head = L.polygon([[endLat, endLon], left, right], {
            color: "#ffffff", fillColor: "#ffffff", fillOpacity: 0.9, weight: 1, interactive: false,
        }).addTo(map);
        _demoLayers.push(head);

        // Speed label
        const speedTT = L.tooltip({ permanent: true, direction: "right", className: "motion-speed-label", offset: [12, 0] })
            .setLatLng([centroid.lat, centroid.lon]).setContent(`${Math.round(vector.speedMph)} mph`);
        speedTT.addTo(map);
        _demoTooltips.push(speedTT);

        // Ghost polygons at 15 and 30 min
        for (const minutes of [15, 30]) {
            const proj = _project(centroid.lat, centroid.lon, vector.bearingDeg, vector.speedMph, minutes);
            const deltaLat = proj.lat - centroid.lat;
            const deltaLon = proj.lon - centroid.lon;

            // Trajectory path
            const path = L.polyline([[centroid.lat, centroid.lon], [proj.lat, proj.lon]], {
                color: "#f59e0b", weight: 2, opacity: minutes === 15 ? 0.5 : 0.3,
                dashArray: "6,4", interactive: false,
            }).addTo(map);
            _demoLayers.push(path);

            // Ghost polygon
            try {
                const geo = JSON.parse(alert.polygon);
                const shifted = JSON.parse(JSON.stringify(geo));
                _shiftCoords(shifted.coordinates, deltaLat, deltaLon);
                const ghostOpacity = minutes === 15 ? 0.18 : 0.10;
                const ghost = L.geoJSON(shifted, {
                    style: { color, weight: 1, opacity: ghostOpacity + 0.1, fillColor: color, fillOpacity: ghostOpacity, dashArray: "4,4", interactive: false, className: `polygon--future polygon--future-${minutes}` },
                }).addTo(map);
                _demoLayers.push(ghost);

                // Time label
                const timeTT = L.tooltip({ permanent: true, direction: "center", className: "motion-time-label" })
                    .setLatLng([proj.lat, proj.lon]).setContent(`${minutes}m`);
                timeTT.addTo(map);
                _demoTooltips.push(timeTT);
            } catch (e) { /* skip */ }
        }
    }

    function _project(lat, lon, bearingDeg, speedMph, minutes) {
        const distMi = speedMph * (minutes / 60);
        const br = bearingDeg * Math.PI / 180;
        const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.01);
        const DEG = 1 / 69.0;
        return { lat: lat + distMi * Math.cos(br) * DEG, lon: lon + distMi * Math.sin(br) * DEG / cosLat };
    }

    function _shiftCoords(coords, dLat, dLon) {
        if (typeof coords[0] === "number") { coords[0] += dLon; coords[1] += dLat; }
        else { for (const c of coords) _shiftCoords(c, dLat, dLon); }
    }

    // ── Data Injection ─────────────────────────────────────────────

    function _injectAlerts(alerts) {
        _savedAlerts = [...(StormState.state.alerts.data || [])];
        StormState.state.alerts.data = alerts;
        _state.syntheticDataActive = true;
    }

    function _restoreAlerts() {
        if (_savedAlerts !== null) {
            StormState.state.alerts.data = _savedAlerts;
            _savedAlerts = null;
        }
        _state.syntheticDataActive = false;
    }

    function _flyTo(lat, lon, zoom) {
        if (typeof Camera !== "undefined") Camera.move({ source: "idle", center: [lat, lon], zoom, flyOptions: { duration: 0.8 }, reason: "demo_flyTo" });
    }

    // ── Core Functions ─────────────────────────────────────────────

    function enableDemoMode() {
        _state.enabled = true;
        _state.startedAt = Date.now();
        _showPanel();
        _showDemoLabel();
        if (log) log.info("demo_mode_enabled", { scenario_count: SCENARIOS.length });
    }

    function disableDemoMode() {
        stopRunAll();
        clearDemoScenario();
        // Disable audio demo
        if (typeof AudioDemoController !== "undefined") AudioDemoController.disableAudioDemo();
        _state.enabled = false;
        _state.startedAt = null;
        _hidePanel();
        _hideDemoLabel();
        if (log) log.info("demo_mode_disabled", {});
    }

    function applyDemoScenario(id) {
        clearDemoScenario();
        const scenario = SCENARIOS.find(s => s.id === id);
        if (!scenario) return;

        _state.activeScenarioId = id;
        scenario.apply();
        _updatePanel();

        if (log) log.info("demo_scenario_applied", { scenario_id: id });
    }

    function clearDemoScenario() {
        // Clear timed scenario steps first
        _clearScenarioTimers();

        // Remove all demo layers from map
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        for (const layer of _demoLayers) {
            if (map) map.removeLayer(layer);
        }
        _demoLayers = [];
        for (const tt of _demoTooltips) {
            if (map) map.removeLayer(tt);
        }
        _demoTooltips = [];

        // Restore alerts
        _restoreAlerts();

        // Clear polygon visuals
        if (typeof PolygonVisuals !== "undefined") {
            PolygonVisuals.updateContextPolygonVisuals({ clusterEvents: [], primaryEventId: null, clusterSeverity: "low", flashingEnabled: false });
            PolygonVisuals.setSpcFeatures([]);
        }

        // Clear storm viz
        if (typeof StormViz !== "undefined") StormViz.clearStormVisualization();

        // Clear impact zone
        if (typeof ImpactZone !== "undefined") ImpactZone.clearImpactZones();

        // Clear audio demo state
        if (typeof AudioDemoController !== "undefined") AudioDemoController.cleanupAudioDemo();

        // Reset AT state
        StormState.state.autotrack.targetAlertId = null;
        StormState.state.autotrack.enabled = false;
        StormState.state.autotrack.mode = "off";
        StormState.state.motion.vectors = {};

        // Reset pulse state (context_pulse_cycle cleanup)
        const cam = StormState.state.camera;
        cam.contextPulseActive = false;
        cam.contextPulsePhase = "idle";
        cam.contextPulseSessionId = null;
        cam.contextPulseStartedAt = null;
        cam.systemCameraMotionActive = false;
        cam.systemCameraMotionSource = null;
        cam.prePulseCameraSnapshot = null;
        StormState.state.pulse.primaryInViewEventId = null;
        StormState.state.pulse.inViewCount = 0;
        StormState.state.pulse.inViewEventIds = [];

        // Reset audio-follow strip (audio_follow_source_switch cleanup)
        const afStrip = document.getElementById("audio-follow-strip");
        if (afStrip) afStrip.classList.add("hidden");
        const af = StormState.state.audioFollow;
        af.currentSource = null;
        af.status = "idle";
        af.owner = null;
        af.targetEvent = null;

        // Reset status strip (idle_grace_transition cleanup)
        const ssMode = document.getElementById("ss-mode");
        if (ssMode) { ssMode.textContent = "IDLE"; ssMode.className = "ss-badge ss-mode-idle"; }

        // Re-render clean
        if (typeof AlertRenderer !== "undefined") AlertRenderer.renderPolygons();

        // Hide demo SPC badge
        const badge = document.getElementById("spc-day-badge");
        if (badge) badge.classList.add("hidden");

        const prev = _state.activeScenarioId;
        _state.activeScenarioId = null;
        _updatePanel();

        if (prev && log) log.info("demo_scenario_cleared", { scenario_id: prev });
    }

    // ── Run All ────────────────────────────────────────────────────

    function runAll() {
        _state.runAllActive = true;
        _state.runAllPaused = false;
        _state.runAllIndex = 0;
        _applyRunAllStep();
        if (log) log.info("demo_run_all_started", {});
    }

    function _applyRunAllStep() {
        if (!_state.runAllActive || _state.runAllPaused) return;
        if (_state.runAllIndex >= SCENARIOS.length) {
            _state.runAllActive = false;
            _updatePanel();
            if (log) log.info("demo_run_all_completed", {});
            return;
        }
        applyDemoScenario(SCENARIOS[_state.runAllIndex].id);
        _runAllTimer = setTimeout(() => {
            _state.runAllIndex++;
            _applyRunAllStep();
        }, RUN_ALL_STEP_MS);
    }

    function pauseRunAll() {
        _state.runAllPaused = true;
        if (_runAllTimer) { clearTimeout(_runAllTimer); _runAllTimer = null; }
        _updatePanel();
    }

    function resumeRunAll() {
        if (!_state.runAllActive) return;
        _state.runAllPaused = false;
        _state.runAllIndex++;
        _applyRunAllStep();
    }

    function stopRunAll() {
        _state.runAllActive = false;
        _state.runAllPaused = false;
        if (_runAllTimer) { clearTimeout(_runAllTimer); _runAllTimer = null; }
        _updatePanel();
        if (log) log.info("demo_run_all_stopped", {});
    }

    function nextScenario() {
        const idx = SCENARIOS.findIndex(s => s.id === _state.activeScenarioId);
        const next = (idx + 1) % SCENARIOS.length;
        applyDemoScenario(SCENARIOS[next].id);
        if (_state.runAllActive) { _state.runAllIndex = next; }
    }

    function prevScenario() {
        const idx = SCENARIOS.findIndex(s => s.id === _state.activeScenarioId);
        const prev = (idx - 1 + SCENARIOS.length) % SCENARIOS.length;
        applyDemoScenario(SCENARIOS[prev].id);
        if (_state.runAllActive) { _state.runAllIndex = prev; }
    }

    // ── Panel UI ───────────────────────────────────────────────────

    function _showPanel() {
        let panel = document.getElementById("demo-panel");
        if (!panel) _createPanel();
        panel = document.getElementById("demo-panel");
        if (panel) panel.classList.remove("hidden");
        _updatePanel();
    }

    function _hidePanel() {
        const panel = document.getElementById("demo-panel");
        if (panel) panel.classList.add("hidden");
    }

    function _createPanel() {
        const panel = document.createElement("div");
        panel.id = "demo-panel";
        panel.className = "demo-panel";

        let scenarioBtns = SCENARIOS.map(s =>
            `<button class="demo-btn demo-scenario-btn" data-scenario="${s.id}" title="${s.description}">${s.label}</button>`
        ).join("");

        panel.innerHTML = `
            <div class="demo-header">
                <span class="demo-title">DEMO MODE</span>
                <button class="demo-minimize" id="demo-minimize-btn" title="Minimize">&minus;</button>
                <button class="demo-close" id="demo-close-btn">&times;</button>
            </div>
            <div id="demo-body" class="demo-body">
                <div class="demo-controls">
                    <button class="demo-btn demo-run-all" id="demo-run-all">Run All</button>
                    <button class="demo-btn" id="demo-prev">&laquo; Prev</button>
                    <button class="demo-btn" id="demo-next">Next &raquo;</button>
                    <button class="demo-btn demo-stop" id="demo-stop">Stop / Clear</button>
                </div>
                <div class="demo-scenarios">${scenarioBtns}</div>
                <div class="demo-status" id="demo-status"></div>
                <div class="demo-checklist" id="demo-checklist"></div>
            </div>
        `;

        document.getElementById("app").appendChild(panel);

        // Build audio demo section
        if (typeof AudioDemoController !== "undefined") {
            const checklistEl = document.getElementById("demo-checklist");
            AudioDemoController.buildDemoPanelSection(checklistEl ? checklistEl.parentNode : panel);
        }

        // Build freshness demo section
        if (typeof FreshnessDemo !== "undefined") {
            const parent = document.getElementById("demo-checklist")?.parentNode || panel;
            const section = document.createElement("div");
            section.className = "demo-freshness-section";
            section.innerHTML = `<div style="font-weight:700;color:#f59e0b;margin:8px 0 4px;font-size:10px;">FRESHNESS DEMOS</div>`;
            const scenarios = FreshnessDemo.getScenarios();
            for (const s of scenarios) {
                const btn = document.createElement("button");
                btn.className = "demo-btn";
                btn.textContent = s.name;
                btn.title = s.description;
                btn.addEventListener("click", () => FreshnessDemo.run(s.id));
                section.appendChild(btn);
            }
            parent.appendChild(section);
        }

        // Wire events
        document.getElementById("demo-minimize-btn").addEventListener("click", () => {
            const body = document.getElementById("demo-body");
            const btn = document.getElementById("demo-minimize-btn");
            if (body) {
                const collapsed = body.classList.toggle("hidden");
                if (btn) btn.innerHTML = collapsed ? "+" : "&minus;";
            }
        });
        document.getElementById("demo-close-btn").addEventListener("click", disableDemoMode);
        document.getElementById("demo-run-all").addEventListener("click", () => {
            if (_state.runAllActive && !_state.runAllPaused) pauseRunAll();
            else if (_state.runAllActive && _state.runAllPaused) resumeRunAll();
            else runAll();
            _updatePanel();
        });
        document.getElementById("demo-prev").addEventListener("click", prevScenario);
        document.getElementById("demo-next").addEventListener("click", nextScenario);
        document.getElementById("demo-stop").addEventListener("click", () => { stopRunAll(); clearDemoScenario(); });

        panel.querySelectorAll(".demo-scenario-btn").forEach(btn => {
            btn.addEventListener("click", () => applyDemoScenario(btn.dataset.scenario));
        });
    }

    function _updatePanel() {
        // Update scenario button active states
        const panel = document.getElementById("demo-panel");
        if (!panel) return;

        panel.querySelectorAll(".demo-scenario-btn").forEach(btn => {
            btn.classList.toggle("demo-btn-active", btn.dataset.scenario === _state.activeScenarioId);
        });

        // Status
        const status = document.getElementById("demo-status");
        if (status) {
            const scenario = SCENARIOS.find(s => s.id === _state.activeScenarioId);
            if (scenario) {
                const runAllText = _state.runAllActive ? (_state.runAllPaused ? " [PAUSED]" : ` [${_state.runAllIndex + 1}/${SCENARIOS.length}]`) : "";
                status.textContent = `Active: ${scenario.label}${runAllText}`;
            } else {
                status.textContent = "No scenario active";
            }
        }

        // Checklist
        const checklist = document.getElementById("demo-checklist");
        if (checklist) {
            const scenario = SCENARIOS.find(s => s.id === _state.activeScenarioId);
            if (scenario && scenario.checklist) {
                checklist.innerHTML = scenario.checklist.map(c => `<div class="demo-check-item">&#9744; ${c}</div>`).join("");
            } else {
                checklist.innerHTML = "";
            }
        }

        // Run All button text
        const runAllBtn = document.getElementById("demo-run-all");
        if (runAllBtn) {
            if (_state.runAllActive && !_state.runAllPaused) runAllBtn.textContent = "Pause";
            else if (_state.runAllActive && _state.runAllPaused) runAllBtn.textContent = "Resume";
            else runAllBtn.textContent = "Run All";
        }
    }

    // ── Demo Label ─────────────────────────────────────────────────

    function _showDemoLabel() {
        let label = document.getElementById("demo-mode-label");
        if (!label) {
            label = document.createElement("div");
            label.id = "demo-mode-label";
            label.className = "demo-mode-label";
            label.innerHTML = "DEMO MODE — Synthetic Data";
            document.getElementById("app").appendChild(label);
        }
        label.classList.remove("hidden");
    }

    function _hideDemoLabel() {
        const label = document.getElementById("demo-mode-label");
        if (label) label.classList.add("hidden");
    }

    // ── Init UI ────────────────────────────────────────────────────

    function initUI() {
        // Add DEMO button to radar controls
        const controls = document.getElementById("radar-controls");
        if (controls) {
            const btn = document.createElement("button");
            btn.id = "btn-demo-toggle";
            btn.className = "radar-btn";
            btn.title = "Demo / Verification Mode (Shift+Alt+V)";
            btn.textContent = "DEMO";
            btn.addEventListener("click", () => {
                if (_state.enabled) disableDemoMode();
                else enableDemoMode();
            });
            controls.appendChild(btn);
        }

        // Keyboard shortcut: Shift+Alt+V
        document.addEventListener("keydown", (e) => {
            if (e.shiftKey && e.altKey && e.key === "V") {
                e.preventDefault();
                if (_state.enabled) disableDemoMode();
                else enableDemoMode();
            }
        });

        if (typeof STLogger !== "undefined") log = STLogger.for("demo");
    }

    return {
        initUI,
        enableDemoMode,
        disableDemoMode,
        applyDemoScenario,
        clearDemoScenario,
        runAll,
        stopRunAll,
        nextScenario,
        prevScenario,
        SCENARIOS,
    };
})();
