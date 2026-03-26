/**
 * Storm Tracker — Unified State Client
 *
 * Single entry point for consuming authoritative storm state from backend.
 * Uses WebSocket as primary transport, HTTP polling as fallback.
 *
 * Flow:
 *   /ws/storm-state → state_sync message → _applyState → StormState events
 *   (fallback) /api/storm/state poll → _applyState → StormState events
 *
 * Ordering: sequence_id ensures no out-of-order application.
 * Demo and live NWS use the SAME delivery path — indistinguishable at this layer.
 */
const StormStateClient = (function () {

    // ── Config ─────────────────────────────────────────────────────
    var POLL_INTERVAL_MS = 15000;         // Polling fallback interval
    var MIN_FETCH_INTERVAL_MS = 1000;     // Rate limit for poll
    var STALE_THRESHOLD_SEC = 60;         // Warn if state >60s old
    var WS_RECONNECT_BASE_MS = 1000;      // Initial reconnect delay
    var WS_RECONNECT_MAX_MS = 30000;      // Max reconnect delay
    var WS_PING_INTERVAL_MS = 25000;      // Keepalive ping

    // ── State ──────────────────────────────────────────────────────
    var _ws = null;
    var _wsConnected = false;
    var _wsReconnectDelay = WS_RECONNECT_BASE_MS;
    var _wsReconnectTimer = null;
    var _wsPingTimer = null;
    var _lastSequenceId = 0;
    var _lastFetchTs = 0;
    var _lastStateTs = 0;
    var _lastPrimaryId = null;
    var _fetchCount = 0;
    var _wsApplyCount = 0;
    var _errorCount = 0;
    var _desyncCount = 0;
    var _pollTimer = null;
    var _enabled = true;
    var log = null;

    // ── Init ───────────────────────────────────────────────────────

    function init() {
        if (typeof STLogger !== "undefined") log = STLogger.for("state_client");

        // Primary: WebSocket
        _connectWS();

        // Fallback: polling (runs always, but skips if WS is fresh)
        _pollTimer = setInterval(function () {
            if (_enabled && !_wsConnected) {
                _pollFetch();
            }
        }, POLL_INTERVAL_MS);

        if (log) log.info("storm_state_client_init", { transport: "ws+poll_fallback" });
    }

    // ── WebSocket ──────────────────────────────────────────────────

    function _connectWS() {
        if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        var url = proto + "//" + window.location.host + "/ws/storm-state";

        try {
            _ws = new WebSocket(url);
        } catch (e) {
            if (log) log.warn("ws_connect_failed", { error: e.message });
            _scheduleReconnect();
            return;
        }

        _ws.onopen = function () {
            _wsConnected = true;
            _wsReconnectDelay = WS_RECONNECT_BASE_MS;
            if (log) log.info("ws_connected", { url: url });

            // Start keepalive
            if (_wsPingTimer) clearInterval(_wsPingTimer);
            _wsPingTimer = setInterval(function () {
                if (_ws && _ws.readyState === WebSocket.OPEN) {
                    _ws.send("ping");
                }
            }, WS_PING_INTERVAL_MS);
        };

        _ws.onmessage = function (event) {
            try {
                var msg = JSON.parse(event.data);
                if (msg.type === "state_sync") {
                    _onWsStateSync(msg);
                }
                // pong is silently consumed
            } catch (e) {
                if (log) log.warn("ws_parse_error", { error: e.message });
            }
        };

        _ws.onclose = function () {
            _wsConnected = false;
            if (_wsPingTimer) { clearInterval(_wsPingTimer); _wsPingTimer = null; }
            if (log) log.info("ws_disconnected", { reconnect_ms: _wsReconnectDelay });
            _scheduleReconnect();
        };

        _ws.onerror = function () {
            // onclose will fire after this
            _errorCount++;
        };
    }

    function _scheduleReconnect() {
        if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = setTimeout(function () {
            _connectWS();
        }, _wsReconnectDelay);
        // Exponential backoff
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    }

    function _onWsStateSync(msg) {
        var seqId = msg.sequence_id || 0;

        // Ordering guard: reject out-of-order messages
        if (seqId > 0 && seqId <= _lastSequenceId) {
            if (log) log.info("ws_out_of_order_rejected", {
                received: seqId, last: _lastSequenceId
            });
            return;
        }
        _lastSequenceId = seqId;
        _wsApplyCount++;

        _applyState(msg);

        if (log) log.info("ws_client_apply_state", {
            sequence_id: seqId,
            alert_count: (msg.active_ids || []).length,
            primary_id: msg.primary_id || null,
        });
    }

    // ── HTTP Polling (fallback) ────────────────────────────────────

    function _pollFetch() {
        var now = Date.now();
        if (now - _lastFetchTs < MIN_FETCH_INTERVAL_MS) return;
        _lastFetchTs = now;

        window.fetch("/api/storm/state").then(function (resp) {
            if (!resp.ok) {
                _errorCount++;
                return;
            }
            return resp.json();
        }).then(function (stateData) {
            if (!stateData) return;

            var seqId = stateData.sequence_id || 0;
            // Only apply if newer than WS data
            if (seqId > 0 && seqId <= _lastSequenceId) return;
            _lastSequenceId = seqId;
            _fetchCount++;

            _applyState(stateData);

            if (log && _fetchCount % 10 === 0) {
                log.info("poll_fallback_active", {
                    fetches: _fetchCount,
                    ws_connected: _wsConnected,
                    sequence_id: seqId,
                });
            }
        }).catch(function (e) {
            _errorCount++;
        });
    }

    // ── Shared State Application ───────────────────────────────────

    function _applyState(stateData) {
        var alerts = stateData.alerts || {};
        var primaryId = stateData.primary_id || null;
        var activeIds = stateData.active_ids || [];
        var timestamp = stateData.timestamp || 0;

        // Convert alerts map to array (frontend expects array)
        var alertArray = [];
        for (var i = 0; i < activeIds.length; i++) {
            var aid = activeIds[i];
            if (alerts[aid]) {
                alertArray.push(alerts[aid]);
            }
        }

        _lastStateTs = timestamp;

        // Stale check
        var stateAge = (Date.now() / 1000) - timestamp;
        if (timestamp > 0 && stateAge > STALE_THRESHOLD_SEC) {
            if (log) log.warn("state_stale_detected", { age_sec: Math.round(stateAge) });
        }

        // Apply to StormState (triggers alertsUpdated event)
        StormState.setAlerts(alertArray);

        // Handle primary target from backend
        if (primaryId !== _lastPrimaryId) {
            var oldPrimary = _lastPrimaryId;
            _lastPrimaryId = primaryId;

            // Update autotrack target if AT is enabled
            if (primaryId && StormState.state.autotrack.enabled) {
                StormState.state.autotrack.targetAlertId = primaryId;
                var primaryAlert = alerts[primaryId];
                if (primaryAlert) {
                    StormState.state.autotrack.targetEvent = primaryAlert.event || null;
                }
                StormState.emit("autotrackTargetChanged", {
                    currentTarget: primaryId,
                    previousTarget: oldPrimary,
                });
            }

            // Emit dedicated primary change event
            StormState.emit("primary_target_changed", {
                primary_id: primaryId,
                previous_id: oldPrimary,
                event: (alerts[primaryId] || {}).event || null,
                active_count: activeIds.length,
                sequence_id: stateData.sequence_id || 0,
            });

            if (log) log.info("primary_target_changed", {
                from: oldPrimary,
                to: primaryId,
                event: (alerts[primaryId] || {}).event || null,
                sequence_id: stateData.sequence_id || 0,
            });
        }

        // Emit state applied event
        StormState.emit("frontend_state_applied", {
            active_count: activeIds.length,
            primary_id: primaryId,
            sequence_id: stateData.sequence_id || 0,
            transport: _wsConnected ? "ws" : "poll",
        });
    }

    // ── Public API ─────────────────────────────────────────────────

    function getState() {
        return {
            enabled: _enabled,
            wsConnected: _wsConnected,
            lastSequenceId: _lastSequenceId,
            lastFetchTs: _lastFetchTs,
            lastStateTs: _lastStateTs,
            lastPrimaryId: _lastPrimaryId,
            fetchCount: _fetchCount,
            wsApplyCount: _wsApplyCount,
            errorCount: _errorCount,
            desyncCount: _desyncCount,
            transport: _wsConnected ? "ws" : "poll",
        };
    }

    function setEnabled(enabled) {
        _enabled = enabled;
        if (log) log.info("state_client_enabled", { enabled: enabled });
    }

    // Manual fetch (for external callers)
    function fetch() {
        _pollFetch();
    }

    return {
        init: init,
        fetch: fetch,
        getState: getState,
        setEnabled: setEnabled,
    };
})();
