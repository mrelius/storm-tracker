/**
 * Storm Tracker — Audio Unavailable Text Announcement
 *
 * When Audio Follow cannot resolve a working stream, injects a
 * high-priority message into the top ticker bar. Repeats every 45s
 * while unavailable, stops immediately when audio recovers.
 *
 * Does NOT modify routing, timers, AT, or guidance.
 */
const AudioAnnounce = (function () {

    const DISPLAY_MS = 8000;     // show announcement for 8s
    const REPEAT_MS = 45000;     // repeat every 45s while unavailable
    let repeatTimer = null;
    let displayTimer = null;
    let active = false;          // announcement currently showing
    let savedTickerHTML = null;   // original ticker content to restore

    function init() {
        // Watch for audio state changes via debug events
        StormState.on("audioFollowDebug", onAudioStateChange);
        StormState.on("autotrackTargetChanged", checkState);
    }

    function onAudioStateChange(dbg) {
        if (!dbg) return;
        const af = StormState.state.audioFollow;

        if (_shouldAnnounce(af)) {
            if (!repeatTimer) startRepeat();
        } else {
            stopAll();
        }
    }

    function checkState() {
        const af = StormState.state.audioFollow;
        if (!_shouldAnnounce(af)) {
            stopAll();
        }
    }

    function _shouldAnnounce(af) {
        if (!af.enabled) return false;
        if (!af.targetEvent) return false;
        if (af.owner === "manual") return false;
        if (af.status !== "unavailable") return false;
        // Don't announce during transient states
        if (af.debounceUntil && Date.now() < af.debounceUntil) return false;
        if (af.stabilityUntil && Date.now() < af.stabilityUntil) return false;
        if (af.cooldownUntil && Date.now() < af.cooldownUntil) return false;
        return true;
    }

    function startRepeat() {
        stopAll();
        showAnnouncement();
        repeatTimer = setInterval(showAnnouncement, REPEAT_MS);
    }

    function showAnnouncement() {
        const af = StormState.state.audioFollow;
        if (!_shouldAnnounce(af)) { stopAll(); return; }

        const ticker = document.querySelector(".at-rail-ticker-text");
        if (!ticker) return;

        // Save current ticker content (only if we haven't already)
        if (!active) {
            savedTickerHTML = ticker.textContent;
        }

        // Build announcement message
        const msg = _buildMessage(af.targetEvent);

        // Override ticker
        ticker.textContent = msg;
        ticker.style.animation = "none";  // stop scrolling — show static
        ticker.style.color = "#ef4444";
        ticker.style.fontWeight = "700";
        active = true;

        // Restore after display duration
        if (displayTimer) clearTimeout(displayTimer);
        displayTimer = setTimeout(() => {
            _restoreTicker(ticker);
            displayTimer = null;
        }, DISPLAY_MS);
    }

    function _buildMessage(eventClass) {
        if (eventClass === "tornado_warning") {
            return "\u26A0\uFE0F TORNADO WARNING \u2014 Audio unavailable \u2014 Seek shelter immediately";
        }
        if (eventClass === "severe_thunderstorm_warning") {
            // Try to get hazard info from tracked alert
            const at = StormState.state.autotrack;
            const alert = StormState.state.alerts.data.find(a => a.id === at.targetAlertId);
            let hazard = "";
            if (alert && alert.description) {
                const hailMatch = alert.description.match(/(\d[\d.]*)\s*inch\s*hail/i);
                const windMatch = alert.description.match(/(\d+)\s*mph\s*wind/i);
                if (hailMatch) hazard = hailMatch[0];
                else if (windMatch) hazard = windMatch[0];
            }
            const hazardStr = hazard ? ` \u2014 ${hazard}` : "";
            return `\u26C8\uFE0F SEVERE THUNDERSTORM${hazardStr} \u2014 Audio unavailable`;
        }
        return "\u26A0\uFE0F WEATHER ALERT \u2014 Audio unavailable";
    }

    function _restoreTicker(ticker) {
        if (!ticker) return;
        if (savedTickerHTML !== null) {
            ticker.textContent = savedTickerHTML;
        }
        ticker.style.animation = "";
        ticker.style.color = "";
        ticker.style.fontWeight = "";
        active = false;
    }

    function stopAll() {
        if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
        if (displayTimer) { clearTimeout(displayTimer); displayTimer = null; }
        if (active) {
            const ticker = document.querySelector(".at-rail-ticker-text");
            _restoreTicker(ticker);
        }
        savedTickerHTML = null;
    }

    return { init };
})();
