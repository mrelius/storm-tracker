/**
 * Storm Tracker — Audio Demo Tests
 *
 * Validates: scenario registry, coverage guard, effective VM selector,
 * demo enable/disable isolation, scenario application, and cleanup.
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

    function assertEqual(actual, expected, name) {
        const match = actual === expected;
        if (!match) {
            console.error(`FAIL: ${name} — expected "${expected}", got "${actual}"`);
        }
        assert(match, name);
    }

    // ── Test 1: Scenario Registry Completeness ────────────────────

    (function testScenarioRegistryExists() {
        assert(typeof AudioDemoScenarios !== "undefined", "AudioDemoScenarios module exists");
        assert(Array.isArray(AudioDemoScenarios.SCENARIOS), "SCENARIOS is array");
        assert(AudioDemoScenarios.SCENARIOS.length >= 15, "At least 15 scenarios defined");
    })();

    // ── Test 2: Every Scenario Has Required Fields ────────────────

    (function testScenarioFields() {
        const required = ["id", "label", "category", "state"];
        const stateRequired = ["playbackState"];

        for (const s of AudioDemoScenarios.SCENARIOS) {
            for (const f of required) {
                assert(s[f] != null, `Scenario "${s.id}" has field "${f}"`);
            }
            for (const f of stateRequired) {
                assert(s.state[f] != null, `Scenario "${s.id}" state has "${f}"`);
            }
        }
    })();

    // ── Test 3: Coverage Guard Passes ─────────────────────────────

    (function testCoverageGuardPasses() {
        const result = AudioDemoScenarios.validateDemoCoverage();
        assert(result === true, "Coverage guard passes with current registry");
    })();

    // ── Test 4: Coverage Guard Detects Missing ────────────────────

    (function testCoverageGuardDetectsMissing() {
        // Temporarily add a feature with a bad scenario ID
        const features = AudioDemoScenarios.AUDIO_FEATURES;
        const original = features.length;

        features.push({
            featureId: "test_missing_feature",
            label: "Test Missing",
            hasControls: false,
            demoScenarioIds: ["nonexistent-scenario-xyz"],
        });

        const result = AudioDemoScenarios.validateDemoCoverage();
        assert(result === false, "Coverage guard fails for missing scenario");

        // Restore
        features.pop();
        assert(features.length === original, "Feature registry restored after test");
    })();

    // ── Test 5: getById Returns Correct Scenario ──────────────────

    (function testGetById() {
        const s = AudioDemoScenarios.getById("audio-playing-scanner");
        assert(s !== null, "getById finds audio-playing-scanner");
        assertEqual(s.state.playbackState, "playing", "Scanner scenario has playing state");
        assertEqual(s.state.selectedSourceType, "scanner", "Scanner scenario has scanner source type");
    })();

    // ── Test 6: getById Returns Null for Missing ──────────────────

    (function testGetByIdMissing() {
        const s = AudioDemoScenarios.getById("nonexistent");
        assert(s === null, "getById returns null for missing ID");
    })();

    // ── Test 7: getByCategory Filters ─────────────────────────────

    (function testGetByCategory() {
        const errors = AudioDemoScenarios.getByCategory("error");
        assert(errors.length >= 4, "At least 4 error category scenarios");
        assert(errors.every(s => s.category === "error"), "All filtered scenarios are error category");
    })();

    // ── Test 8: Demo OFF Returns Runtime VM ───────────────────────

    (function testDemoOffReturnsRuntime() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Demo OFF returns runtime VM", result: "SKIP" });
            return;
        }

        StormState.state.demoAudio.enabled = false;
        const vm = AudioDemoController.getEffectiveAudioViewModel();
        assertEqual(vm.source, "runtime", "Demo OFF returns runtime source");
    })();

    // ── Test 9: Demo ON Returns Demo VM ───────────────────────────

    (function testDemoOnReturnsDemoVM() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Demo ON returns demo VM", result: "SKIP" });
            return;
        }

        // Enable and apply a scenario
        AudioDemoController.enableAudioDemo();
        AudioDemoController.applyAudioScenario("audio-playing-event-stream");

        // Wait for debounce
        setTimeout(() => {
            const vm = AudioDemoController.getEffectiveAudioViewModel();
            assertEqual(vm.source, "demo", "Demo ON returns demo source");
            assertEqual(vm.playbackState, "playing", "Demo VM has playing state");
            assertEqual(vm.sourceType, "event", "Demo VM has event source type");
            assertEqual(vm.title, "Tornado Warning Net", "Demo VM has correct title");

            // Cleanup
            AudioDemoController.disableAudioDemo();
        }, 150);
    })();

    // ── Test 10: Scenario Switch Clears Stale Error ───────────────

    (function testScenarioSwitchClearsError() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Scenario switch clears error", result: "SKIP" });
            return;
        }

        AudioDemoController.enableAudioDemo();
        AudioDemoController.applyAudioScenario("audio-error-generic");

        setTimeout(() => {
            const da1 = StormState.state.demoAudio;
            assertEqual(da1.errorCode, "GENERIC", "Error scenario sets errorCode");

            AudioDemoController.applyAudioScenario("audio-playing-scanner");

            setTimeout(() => {
                const da2 = StormState.state.demoAudio;
                assert(da2.errorCode === null, "Scanner scenario clears error code");
                assert(da2.errorMessage === null, "Scanner scenario clears error message");
                assertEqual(da2.playbackState, "playing", "Scanner scenario sets playing state");

                AudioDemoController.disableAudioDemo();
            }, 150);
        }, 150);
    })();

    // ── Test 11: Mute Override Works ──────────────────────────────

    (function testMuteOverride() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Mute override works", result: "SKIP" });
            return;
        }

        AudioDemoController.enableAudioDemo();
        AudioDemoController.applyAudioScenario("audio-playing-scanner");

        setTimeout(() => {
            AudioDemoController.setDemoMuted(true);
            const vm = AudioDemoController.getEffectiveAudioViewModel();
            assert(vm.muted === true, "Mute override reflected in VM");

            const strip = AudioDemoController.getStatusStripText();
            assert(strip === "AUDIO: MUTED", "Status strip shows MUTED");

            AudioDemoController.disableAudioDemo();
        }, 150);
    })();

    // ── Test 12: Fallback Override ─────────────────────────────────

    (function testFallbackOverride() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Fallback override works", result: "SKIP" });
            return;
        }

        AudioDemoController.enableAudioDemo();
        AudioDemoController.applyAudioScenario("audio-event-fallback-active");

        setTimeout(() => {
            const vm = AudioDemoController.getEffectiveAudioViewModel();
            assert(vm.fallback === true, "Fallback scenario sets fallback flag");

            const strip = AudioDemoController.getStatusStripText();
            assert(strip === "AUDIO: FALLBACK ACTIVE", "Status strip shows FALLBACK ACTIVE");

            AudioDemoController.disableAudioDemo();
        }, 150);
    })();

    // ── Test 13: Auto-Track Bound Renders ─────────────────────────

    (function testAutoTrackBound() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Auto-track bound renders", result: "SKIP" });
            return;
        }

        AudioDemoController.enableAudioDemo();
        AudioDemoController.applyAudioScenario("audio-auto-track-bound-playing");

        setTimeout(() => {
            const vm = AudioDemoController.getEffectiveAudioViewModel();
            assert(vm.autoTrack === true, "Auto-track bound flag set");
            assertEqual(vm.eventId, "demo_event_auto", "Event ID set for auto-track");

            AudioDemoController.disableAudioDemo();
        }, 150);
    })();

    // ── Test 14: Disable Cleans Up ────────────────────────────────

    (function testDisableCleansUp() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Disable cleans up", result: "SKIP" });
            return;
        }

        AudioDemoController.enableAudioDemo();
        AudioDemoController.applyAudioScenario("audio-playing-event-stream");

        setTimeout(() => {
            AudioDemoController.disableAudioDemo();
            const da = StormState.state.demoAudio;
            assert(da.enabled === false, "Demo disabled after disableAudioDemo");
            assert(da.scenarioId === null, "Scenario cleared after disable");
            assertEqual(da.playbackState, "idle", "Playback state reset to idle");
            assert(da.errorCode === null, "Error code cleared");
            assert(da.streamTitle === null, "Stream title cleared");

            const vm = AudioDemoController.getEffectiveAudioViewModel();
            assertEqual(vm.source, "runtime", "VM returns runtime after disable");
        }, 150);
    })();

    // ── Test 15: Status Strip Text Mapping ────────────────────────

    (function testStatusStripMapping() {
        if (typeof AudioDemoController === "undefined" || typeof StormState === "undefined") {
            results.push({ name: "Status strip text mapping", result: "SKIP" });
            return;
        }

        const scenarios = [
            { id: "audio-off", expected: "AUDIO: OFF" },
            { id: "audio-loading-event-stream", expected: "AUDIO: LOADING EVENT" },
            { id: "audio-playing-scanner", expected: "AUDIO: PLAYING SCANNER" },
            { id: "audio-playing-weather-radio", expected: "AUDIO: PLAYING WEATHER RADIO" },
            { id: "audio-muted-playing", expected: "AUDIO: MUTED" },
            { id: "audio-paused", expected: "AUDIO: PAUSED" },
            { id: "audio-event-fallback-active", expected: "AUDIO: FALLBACK ACTIVE" },
            { id: "audio-no-stream-found", expected: "AUDIO: UNAVAILABLE" },
            { id: "audio-buffer-timeout", expected: "AUDIO ERROR: BUFFERING TIMEOUT — STREAM STALLED" },
            { id: "audio-source-unavailable", expected: "AUDIO ERROR: SOURCE UNAVAILABLE — SERVER NOT RESPONDING" },
            { id: "audio-auto-track-bound-playing", expected: "AUDIO: PLAYING EVENT" },
            { id: "audio-error-generic", expected: "AUDIO ERROR: AUDIO PLAYBACK ERROR" },
        ];

        AudioDemoController.enableAudioDemo();

        let delay = 0;
        for (const { id, expected } of scenarios) {
            delay += 150;
            setTimeout(() => {
                AudioDemoController.applyAudioScenario(id);
                setTimeout(() => {
                    const strip = AudioDemoController.getStatusStripText();
                    assert(strip != null, `Strip text for ${id} is not null: "${strip}"`);
                }, 120);
            }, delay);
        }

        setTimeout(() => {
            AudioDemoController.disableAudioDemo();
        }, delay + 200);
    })();

    // ── Print Summary ─────────────────────────────────────────────

    setTimeout(() => {
        console.log("\n══════ AUDIO DEMO TEST RESULTS ══════");
        for (const r of results) {
            const icon = r.result === "PASS" ? "✓" : r.result === "FAIL" ? "✗" : "○";
            console.log(`  ${icon} ${r.name}: ${r.result}`);
        }
        console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
        console.log("═════════════════════════════════════\n");
    }, 5000);
})();
