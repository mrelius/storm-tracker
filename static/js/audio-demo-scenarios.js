/**
 * Storm Tracker — Audio Demo Scenario Registry
 *
 * Centralized registry of all audio demo scenarios.
 * Every audio feature MUST have at least one demo scenario.
 * validateAudioDemoCoverage() enforces this at load time.
 */
const AudioDemoScenarios = (function () {

    // ── Scenario Definitions ──────────────────────────────────────────

    const SCENARIOS = [
        {
            id: "audio-off",
            label: "Audio Off",
            category: "normal",
            state: {
                playbackState: "idle",
                muted: false,
                volume: 1.0,
                selectedSourceId: null,
                selectedSourceType: null,
                streamTitle: null,
                streamSubtitle: null,
                eventId: null,
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-idle",
            label: "Audio Idle",
            category: "normal",
            state: {
                playbackState: "idle",
                muted: false,
                volume: 0.8,
                selectedSourceId: null,
                selectedSourceType: null,
                streamTitle: null,
                streamSubtitle: null,
                eventId: null,
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-loading-event-stream",
            label: "Loading Event Stream",
            category: "normal",
            state: {
                playbackState: "loading",
                muted: false,
                volume: 1.0,
                selectedSourceId: "noaa_stream_1",
                selectedSourceType: "event",
                streamTitle: "Loading Event Audio...",
                streamSubtitle: "Connecting to NOAA",
                eventId: "demo_event_1",
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-playing-event-stream",
            label: "Playing Event Stream",
            category: "normal",
            state: {
                playbackState: "playing",
                muted: false,
                volume: 1.0,
                selectedSourceId: "noaa_stream_1",
                selectedSourceType: "event",
                streamTitle: "Tornado Warning Net",
                streamSubtitle: "Live Event Audio",
                eventId: "demo_event_1",
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-playing-weather-radio",
            label: "Playing Weather Radio",
            category: "normal",
            state: {
                playbackState: "playing",
                muted: false,
                volume: 0.9,
                selectedSourceId: "noaa_wx_radio",
                selectedSourceType: "weather_radio",
                streamTitle: "NOAA Weather Radio",
                streamSubtitle: "WXJ76 — Cincinnati",
                eventId: null,
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-playing-scanner",
            label: "Playing Scanner",
            category: "normal",
            state: {
                playbackState: "playing",
                muted: false,
                volume: 0.75,
                selectedSourceId: "scanner_dispatch",
                selectedSourceType: "scanner",
                streamTitle: "County Scanner Dispatch",
                streamSubtitle: "Hamilton County Fire/EMS",
                eventId: null,
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-muted-playing",
            label: "Muted While Playing",
            category: "normal",
            state: {
                playbackState: "playing",
                muted: true,
                volume: 0.75,
                selectedSourceId: "scanner_dispatch",
                selectedSourceType: "scanner",
                streamTitle: "Scanner (Muted)",
                streamSubtitle: "Hamilton County Fire/EMS",
                eventId: null,
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-paused",
            label: "Paused",
            category: "normal",
            state: {
                playbackState: "paused",
                muted: false,
                volume: 1.0,
                selectedSourceId: "noaa_stream_1",
                selectedSourceType: "event",
                streamTitle: "Paused Event Audio",
                streamSubtitle: "Tornado Warning Net — paused",
                eventId: "demo_event_1",
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-event-fallback-active",
            label: "Fallback Active",
            category: "transition",
            state: {
                playbackState: "playing",
                muted: false,
                volume: 1.0,
                selectedSourceId: "scanner_fallback",
                selectedSourceType: "fallback",
                streamTitle: "Fallback Audio Active",
                streamSubtitle: "Primary unavailable — using scanner",
                eventId: "demo_event_1",
                errorCode: null,
                errorMessage: null,
                autoTrackBound: false,
                fallbackActive: true,
            },
        },
        {
            id: "audio-no-stream-found",
            label: "No Stream Found",
            category: "error",
            state: {
                playbackState: "unavailable",
                muted: false,
                volume: 1.0,
                selectedSourceId: null,
                selectedSourceType: null,
                streamTitle: null,
                streamSubtitle: null,
                eventId: null,
                errorCode: "NO_STREAM",
                errorMessage: "No stream found for this area",
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-buffer-timeout",
            label: "Buffer Timeout",
            category: "error",
            state: {
                playbackState: "error",
                muted: false,
                volume: 1.0,
                selectedSourceId: "noaa_stream_1",
                selectedSourceType: "event",
                streamTitle: "NOAA Stream",
                streamSubtitle: "Buffer stalled",
                eventId: null,
                errorCode: "BUFFER_TIMEOUT",
                errorMessage: "Buffering timeout — stream stalled",
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-source-unavailable",
            label: "Source Unavailable",
            category: "error",
            state: {
                playbackState: "error",
                muted: false,
                volume: 1.0,
                selectedSourceId: "noaa_stream_1",
                selectedSourceType: "event",
                streamTitle: null,
                streamSubtitle: null,
                eventId: null,
                errorCode: "SOURCE_DOWN",
                errorMessage: "Source unavailable — server not responding",
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-unsupported-stream",
            label: "Unsupported Stream",
            category: "error",
            state: {
                playbackState: "error",
                muted: false,
                volume: 1.0,
                selectedSourceId: "unknown_format",
                selectedSourceType: "custom",
                streamTitle: "Unknown Format",
                streamSubtitle: null,
                eventId: null,
                errorCode: "UNSUPPORTED",
                errorMessage: "Unsupported stream format",
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
        {
            id: "audio-auto-track-bound-playing",
            label: "Auto Track Bound (Playing)",
            category: "auto",
            state: {
                playbackState: "playing",
                muted: false,
                volume: 1.0,
                selectedSourceId: "noaa_stream_auto",
                selectedSourceType: "event",
                streamTitle: "Auto-Tracked Storm Audio",
                streamSubtitle: "Bound to tracked tornado warning",
                eventId: "demo_event_auto",
                errorCode: null,
                errorMessage: null,
                autoTrackBound: true,
                fallbackActive: false,
            },
        },
        {
            id: "audio-auto-track-bound-loading",
            label: "Auto Track Bound (Loading)",
            category: "auto",
            state: {
                playbackState: "loading",
                muted: false,
                volume: 1.0,
                selectedSourceId: null,
                selectedSourceType: "event",
                streamTitle: "Binding Audio...",
                streamSubtitle: "Auto Track acquiring stream",
                eventId: "demo_event_auto",
                errorCode: null,
                errorMessage: null,
                autoTrackBound: true,
                fallbackActive: false,
            },
        },
        {
            id: "audio-error-generic",
            label: "Generic Error",
            category: "error",
            state: {
                playbackState: "error",
                muted: false,
                volume: 1.0,
                selectedSourceId: null,
                selectedSourceType: null,
                streamTitle: null,
                streamSubtitle: null,
                eventId: null,
                errorCode: "GENERIC",
                errorMessage: "Audio playback error",
                autoTrackBound: false,
                fallbackActive: false,
            },
        },
    ];

    // ── Feature Registry ──────────────────────────────────────────────
    // Every audio feature must declare demo scenario coverage.
    // Adding a feature without demo scenarios causes a validation error.

    const AUDIO_FEATURES = [
        { featureId: "audio_playback",    label: "Audio Playback",     hasControls: true,  demoScenarioIds: ["audio-playing-event-stream", "audio-playing-scanner", "audio-playing-weather-radio", "audio-paused"] },
        { featureId: "audio_loading",     label: "Audio Loading",      hasControls: false, demoScenarioIds: ["audio-loading-event-stream"] },
        { featureId: "audio_mute",        label: "Mute/Unmute",        hasControls: true,  demoScenarioIds: ["audio-muted-playing"] },
        { featureId: "audio_errors",      label: "Error States",       hasControls: false, demoScenarioIds: ["audio-error-generic", "audio-buffer-timeout", "audio-source-unavailable", "audio-unsupported-stream", "audio-no-stream-found"] },
        { featureId: "audio_fallback",    label: "Fallback Routing",   hasControls: false, demoScenarioIds: ["audio-event-fallback-active"] },
        { featureId: "audio_auto_track",  label: "Auto Track Binding", hasControls: false, demoScenarioIds: ["audio-auto-track-bound-playing", "audio-auto-track-bound-loading"] },
        { featureId: "audio_idle",        label: "Idle/Off States",    hasControls: true,  demoScenarioIds: ["audio-off", "audio-idle"] },
    ];

    // ── Validation Guard ──────────────────────────────────────────────

    function validateDemoCoverage() {
        const scenarioIds = new Set(SCENARIOS.map(s => s.id));
        const errors = [];

        for (const feature of AUDIO_FEATURES) {
            if (!feature.demoScenarioIds || feature.demoScenarioIds.length === 0) {
                errors.push(`Audio feature "${feature.featureId}" has no demo scenarios`);
                continue;
            }
            for (const id of feature.demoScenarioIds) {
                if (!scenarioIds.has(id)) {
                    errors.push(`Audio feature "${feature.featureId}" references missing scenario "${id}"`);
                }
            }
        }

        if (errors.length > 0) {
            // Hard fail: throw in development, log in production
            const msg = "[AUDIO DEMO COVERAGE FAILURE] " + errors.join("; ");
            console.error(msg);
            // Detect production by checking for minified scripts or explicit flag
            const isProduction = (typeof window !== "undefined" && window.__STORM_PRODUCTION === true);
            if (!isProduction) {
                throw new Error(msg);
            }
            return false;
        }
        return true;
    }

    // Run validation on load — will throw in dev if coverage is missing
    validateDemoCoverage();

    // ── Helpers ────────────────────────────────────────────────────────

    function getById(id) {
        return SCENARIOS.find(s => s.id === id) || null;
    }

    function getByCategory(category) {
        return SCENARIOS.filter(s => s.category === category);
    }

    return {
        SCENARIOS,
        AUDIO_FEATURES,
        validateDemoCoverage,
        getById,
        getByCategory,
    };
})();
