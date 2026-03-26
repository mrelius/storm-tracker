/**
 * Storm Tracker — Audio Unlock Module
 *
 * Manages browser audio unlock via user gesture.
 * Dual unlock: AudioContext.resume() + speechSynthesis silent utterance.
 * Provides shared AudioContext for pre-attention tone generation.
 *
 * Must init() before AlertEngine.init().
 *
 * State is session-only (not persisted). Each page load starts locked.
 * Gesture listeners auto-remove after successful unlock.
 */
const AudioUnlock = (function () {

    let _unlocked = false;
    let _audioCtx = null;
    let _handler = null;
    let log = null;

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("audio_unlock");

        // Create AudioContext eagerly (but it starts suspended)
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) _audioCtx = new AC();
        } catch (e) {
            if (log) log.info("audio_ctx_create_failed", { error: e.message });
        }

        _wireGesture();

        if (log) log.info("audio_unlock_init", {
            speechAvailable: typeof window.speechSynthesis !== "undefined",
            audioCtxAvailable: !!_audioCtx,
            audioCtxState: _audioCtx ? _audioCtx.state : "n/a",
        });
    }

    function _wireGesture() {
        if (_unlocked) return;

        _handler = () => {
            if (_unlocked) return;
            _attemptUnlock();
        };

        document.addEventListener("click", _handler, { passive: true });
        document.addEventListener("touchstart", _handler, { passive: true });
        document.addEventListener("keydown", _handler, { passive: true });
    }

    function _attemptUnlock() {
        if (_unlocked) return;

        let ctxOk = false;
        let speechOk = false;

        // 1. Resume AudioContext
        if (_audioCtx && _audioCtx.state === "suspended") {
            _audioCtx.resume().then(() => {
                ctxOk = true;
                if (log) log.info("audio_ctx_resumed", { state: _audioCtx.state });
                _checkBothUnlocked(ctxOk, speechOk);
            }).catch((e) => {
                if (log) log.info("audio_ctx_resume_failed", { error: e.message });
            });
        } else if (_audioCtx && _audioCtx.state === "running") {
            ctxOk = true;
        }

        // 2. SpeechSynthesis silent utterance
        if (typeof window.speechSynthesis !== "undefined") {
            try {
                const u = new SpeechSynthesisUtterance(" ");
                u.volume = 0;
                u.onstart = () => {
                    speechOk = true;
                    _checkBothUnlocked(ctxOk, speechOk);
                };
                u.onerror = () => {
                    // Speech unlock failed — still usable if AudioContext works
                    if (log) log.info("speech_silent_unlock_failed", {});
                    if (ctxOk) _markUnlocked();
                };
                window.speechSynthesis.speak(u);

                // Timeout: if onstart never fires (Chrome silent failure)
                setTimeout(() => {
                    if (!_unlocked && ctxOk) _markUnlocked();
                }, 500);
            } catch (e) {
                if (log) log.info("speech_unlock_error", { error: e.message });
                if (ctxOk) _markUnlocked();
            }
        } else {
            // No speech API — unlock if AudioContext works
            if (ctxOk) _markUnlocked();
        }
    }

    function _checkBothUnlocked(ctxOk, speechOk) {
        if (_unlocked) return;
        if (ctxOk || speechOk) _markUnlocked();
    }

    function _markUnlocked() {
        if (_unlocked) return;
        _unlocked = true;

        if (log) log.info("audio_unlocked", {
            audioCtxState: _audioCtx ? _audioCtx.state : "n/a",
        });

        // Remove gesture listeners
        if (_handler) {
            document.removeEventListener("click", _handler);
            document.removeEventListener("touchstart", _handler);
            document.removeEventListener("keydown", _handler);
            _handler = null;
        }
    }

    /** Force unlock from user gesture context (demo mode). */
    function forceUnlock() {
        _attemptUnlock();
    }

    /** @returns {boolean} */
    function isUnlocked() {
        return _unlocked;
    }

    /** @returns {boolean} */
    function canSpeak() {
        return _unlocked && typeof window.speechSynthesis !== "undefined";
    }

    /** @returns {AudioContext|null} Returns running AudioContext or null. */
    function getAudioContext() {
        if (!_audioCtx) return null;
        if (_audioCtx.state === "closed") return null;
        return _audioCtx;
    }

    return { init, forceUnlock, isUnlocked, canSpeak, getAudioContext };
})();
