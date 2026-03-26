/**
 * Storm Tracker — Settings Panel + Screen Wake Lock
 *
 * Provides user-configurable display options:
 * - Map tile style (dark/satellite/terrain/standard)
 * - Alert polygon opacity
 * - UI opacity
 * - Screen wake lock (keep display on)
 * - Animation toggle
 *
 * All settings persisted to localStorage.
 * Screen Wake Lock uses the Wake Lock API (navigator.wakeLock).
 */
const Settings = (function () {

    const STORAGE_KEY = "storm_tracker_settings";
    let wakeLock = null;
    let panelVisible = false;

    // Default settings
    const DEFAULTS = {
        mapStyle: "dark",
        polygonOpacity: 0.35,
        uiOpacity: 0.92,
        srvOpacity: 0.65,
        ccOpacity: 0.55,
        keepScreenOn: false,
        animationsEnabled: true,
        showPrimary: true,
        showSecondary: true,
        showWarnings: true,
        showMarine: false,
        showCountyPolygons: true,
        audioSourceMode: "noaa",
        audioSources: {
            noaa: [
                "https://broadcastify.cdnstream1.com/33645",
                "https://broadcastify.cdnstream1.com/22514",
            ],
            spotter: [],
            scanner: [
                "https://broadcastify.cdnstream1.com/14439",
            ],
        },
    };

    let current = { ...DEFAULTS };

    // Map tile URLs
    const MAP_TILES = {
        dark: {
            url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            label: "Dark",
            attribution: "&copy; CartoDB",
        },
        satellite: {
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            label: "Satellite",
            attribution: "&copy; Esri",
        },
        terrain: {
            url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
            label: "Terrain",
            attribution: "&copy; OpenTopoMap",
        },
        standard: {
            url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
            label: "Standard",
            attribution: "&copy; CartoDB",
        },
    };

    // ── Init ────────────────────────────────────────────────────────

    function init() {
        load();

        // Gear button
        const btn = document.getElementById("btn-settings");
        if (btn) btn.addEventListener("click", togglePanel);

        // Build panel
        buildPanel();

        // Apply saved settings
        applyAll();

        // Re-acquire wake lock on visibility change (browser releases on tab switch)
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && current.keepScreenOn) {
                acquireWakeLock();
            }
        });
    }

    // ── Persistence ─────────────────────────────────────────────────

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                current = { ...DEFAULTS, ...saved };

                // Migrate legacy: audioSourceMode "auto" → "noaa"
                if (current.audioSourceMode === "auto") {
                    current.audioSourceMode = "noaa";
                }

                // Sync normalized state fields from persisted settings
                const policyMap = { noaa: "noaa_preferred", spotter: "spotter_preferred", scanner: "scanner_only" };
                if (typeof StormState !== "undefined") {
                    StormState.state.audioFollow.policy = policyMap[current.audioSourceMode] || "noaa_preferred";
                }
            }
        } catch (e) {
            current = { ...DEFAULTS };
        }
    }

    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
        } catch (e) { /* ignore */ }
    }

    // ── Panel UI ────────────────────────────────────────────────────

    function togglePanel() {
        panelVisible = !panelVisible;
        const panel = document.getElementById("settings-panel");
        if (panel) {
            panel.classList.toggle("hidden", !panelVisible);
            if (panelVisible) { syncUI(); _syncLocUI(panel); }
        }
    }

    function buildPanel() {
        const panel = document.createElement("div");
        panel.id = "settings-panel";
        panel.className = "settings-panel hidden";
        panel.innerHTML = `
            <div class="settings-header">
                <span class="settings-title">SETTINGS</span>
                <button id="settings-close" class="settings-close">&times;</button>
            </div>
            <div class="settings-body">
                <div class="settings-group">
                    <label class="settings-label">Map Style</label>
                    <div class="settings-row" id="sett-map-style">
                        <button class="sett-btn" data-val="dark">Dark</button>
                        <button class="sett-btn" data-val="satellite">Satellite</button>
                        <button class="sett-btn" data-val="terrain">Terrain</button>
                        <button class="sett-btn" data-val="standard">Standard</button>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Alert Polygon Opacity</label>
                    <input type="range" id="sett-polygon-opacity" min="10" max="100" step="5" class="settings-range">
                    <span id="sett-polygon-opacity-val" class="settings-val"></span>
                </div>
                <div class="settings-group">
                    <label class="settings-label">SRV Opacity</label>
                    <input type="range" id="sett-srv-opacity" min="10" max="100" step="5" class="settings-range">
                    <span id="sett-srv-opacity-val" class="settings-val"></span>
                </div>
                <div class="settings-group">
                    <label class="settings-label">CC Opacity</label>
                    <input type="range" id="sett-cc-opacity" min="10" max="100" step="5" class="settings-range">
                    <span id="sett-cc-opacity-val" class="settings-val"></span>
                </div>
                <div class="settings-group">
                    <label class="settings-label">UI Panel Opacity</label>
                    <input type="range" id="sett-ui-opacity" min="50" max="100" step="5" class="settings-range">
                    <span id="sett-ui-opacity-val" class="settings-val"></span>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Alert Sort</label>
                    <select id="sett-alert-sort" class="settings-select">
                        <option value="severity">Severity</option>
                        <option value="distance">Distance</option>
                        <option value="issued">Issued</option>
                        <option value="expiration">Expiration</option>
                    </select>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Alert Layers</label>
                    <div class="settings-row">
                        <label class="sett-check"><input type="checkbox" id="sett-show-primary" checked> Primary</label>
                        <label class="sett-check"><input type="checkbox" id="sett-show-secondary" checked> Secondary</label>
                        <label class="sett-check"><input type="checkbox" id="sett-show-warnings" checked> Warnings</label>
                        <label class="sett-check"><input type="checkbox" id="sett-show-marine"> Marine</label>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Show County Polygons</label>
                    <button id="sett-county-polys" class="sett-toggle"></button>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Audio Source Mode</label>
                    <div class="settings-row" id="sett-audio-source-mode">
                        <button class="sett-btn" data-val="noaa">NOAA</button>
                        <button class="sett-btn" data-val="spotter">Spotter</button>
                        <button class="sett-btn" data-val="scanner">Scanner</button>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">NOAA Streams</label>
                    <textarea id="sett-urls-noaa" class="settings-textarea" rows="2" placeholder="One URL per line"></textarea>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Spotter Streams</label>
                    <textarea id="sett-urls-spotter" class="settings-textarea" rows="2" placeholder="One URL per line"></textarea>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Scanner Streams</label>
                    <textarea id="sett-urls-scanner" class="settings-textarea" rows="2" placeholder="One URL per line"></textarea>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Keep Screen On</label>
                    <button id="sett-wake-lock" class="sett-toggle"></button>
                    <span id="sett-wake-status" class="settings-val"></span>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Animations</label>
                    <button id="sett-animations" class="sett-toggle"></button>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Simple Mode</label>
                    <button id="btn-simple-mode" class="sett-toggle"></button>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Audio Tests</label>
                    <div class="settings-row">
                        <button id="sett-noaa-test" class="sett-btn">Test NOAA Stream</button>
                        <button id="sett-tone-test" class="sett-btn">Test Audio Tone</button>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Saved Locations</label>
                    <div class="sett-loc-block" data-slot="home">
                        <div class="sett-loc-name-row">
                            <span class="sett-loc-icon">\uD83C\uDFE0</span>
                            <input type="text" id="sett-label-home" class="sett-loc-name" placeholder="Home" maxlength="30">
                            <span id="sett-badge-home" class="sett-loc-badge"></span>
                        </div>
                        <div class="sett-loc-row">
                            <input type="text" id="sett-loc-home" class="sett-loc-input" placeholder="Enter address...">
                            <button class="sett-loc-save" data-slot="home">Save</button>
                            <button class="sett-loc-pin" data-slot="home" data-kind="home" title="Drop pin on map">\uD83D\uDCCD</button>
                            <button class="sett-loc-clear" data-slot="home" title="Clear">\u2715</button>
                        </div>
                        <div id="sett-meta-home" class="sett-loc-meta"></div>
                    </div>
                    <div class="sett-loc-block" data-slot="work1">
                        <div class="sett-loc-name-row">
                            <span class="sett-loc-icon">\uD83D\uDCBC</span>
                            <input type="text" id="sett-label-work1" class="sett-loc-name" placeholder="Work 1" maxlength="30">
                            <span id="sett-badge-work1" class="sett-loc-badge"></span>
                        </div>
                        <div class="sett-loc-row">
                            <input type="text" id="sett-loc-work1" class="sett-loc-input" placeholder="Enter address...">
                            <button class="sett-loc-save" data-slot="work1">Save</button>
                            <button class="sett-loc-pin" data-slot="work1" data-kind="work" title="Drop pin on map">\uD83D\uDCCD</button>
                            <button class="sett-loc-clear" data-slot="work1" title="Clear">\u2715</button>
                        </div>
                        <div id="sett-meta-work1" class="sett-loc-meta"></div>
                    </div>
                    <div class="sett-loc-block" data-slot="work2">
                        <div class="sett-loc-name-row">
                            <span class="sett-loc-icon">\uD83D\uDCBC</span>
                            <input type="text" id="sett-label-work2" class="sett-loc-name" placeholder="Work 2" maxlength="30">
                            <span id="sett-badge-work2" class="sett-loc-badge"></span>
                        </div>
                        <div class="sett-loc-row">
                            <input type="text" id="sett-loc-work2" class="sett-loc-input" placeholder="Enter address...">
                            <button class="sett-loc-save" data-slot="work2">Save</button>
                            <button class="sett-loc-pin" data-slot="work2" data-kind="work" title="Drop pin on map">\uD83D\uDCCD</button>
                            <button class="sett-loc-clear" data-slot="work2" title="Clear">\u2715</button>
                        </div>
                        <div id="sett-meta-work2" class="sett-loc-meta"></div>
                    </div>
                    <div id="sett-loc-status" class="sett-loc-status"></div>
                    <div id="sett-loc-hint" class="sett-loc-hint">Set your Home location to improve local awareness</div>
                </div>
                <div class="settings-divider"></div>
                <div id="sett-ai-section">
                    ${typeof AIPanel !== "undefined" ? AIPanel.getSettingsHTML() : '<div class="settings-group"><label class="settings-label">AI Advisory</label><span class="settings-val">Not loaded</span></div>'}
                </div>
                <div class="settings-divider"></div>
                <div class="settings-group">
                    <button id="btn-feedback" class="sett-btn" style="width:100%">Send Feedback</button>
                </div>
                <div class="settings-group settings-reset">
                    <button id="sett-reset" class="sett-btn sett-btn-danger">Reset Defaults</button>
                </div>
            </div>
        `;
        document.getElementById("app").appendChild(panel);

        // Wire events
        panel.querySelector("#settings-close").addEventListener("click", togglePanel);

        // Map style buttons
        panel.querySelectorAll("#sett-map-style .sett-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                current.mapStyle = btn.dataset.val;
                save();
                applyMapStyle();
                syncUI();
            });
        });

        // Polygon opacity
        const polySlider = panel.querySelector("#sett-polygon-opacity");
        polySlider.addEventListener("input", (e) => {
            current.polygonOpacity = parseInt(e.target.value) / 100;
            save();
            applyPolygonOpacity();
            syncUI();
        });

        // SRV opacity
        const srvSlider = panel.querySelector("#sett-srv-opacity");
        srvSlider.addEventListener("input", (e) => {
            current.srvOpacity = parseInt(e.target.value) / 100;
            save();
            applySRVOpacity();
            syncUI();
        });

        // CC opacity
        const ccSlider = panel.querySelector("#sett-cc-opacity");
        ccSlider.addEventListener("input", (e) => {
            current.ccOpacity = parseInt(e.target.value) / 100;
            save();
            applyCCOpacity();
            syncUI();
        });

        // UI opacity
        const uiSlider = panel.querySelector("#sett-ui-opacity");
        uiSlider.addEventListener("input", (e) => {
            current.uiOpacity = parseInt(e.target.value) / 100;
            save();
            applyUIOpacity();
            syncUI();
        });

        // Alert sort
        const sortSel = panel.querySelector("#sett-alert-sort");
        if (sortSel) {
            // Sync from current state
            const origSort = document.getElementById("sort-field");
            if (origSort) sortSel.value = origSort.value;

            sortSel.addEventListener("change", () => {
                const orig = document.getElementById("sort-field");
                if (orig) {
                    orig.value = sortSel.value;
                    orig.dispatchEvent(new Event("change"));
                }
            });
        }

        // Alert layer checkboxes
        for (const key of ["primary", "secondary", "warnings", "marine"]) {
            const cb = panel.querySelector(`#sett-show-${key}`);
            if (cb) cb.addEventListener("change", () => {
                const stateKey = "show" + key.charAt(0).toUpperCase() + key.slice(1);
                current[stateKey] = cb.checked;
                save();
                applyAlertLayers();
            });
        }

        // County polygons
        panel.querySelector("#sett-county-polys").addEventListener("click", () => {
            current.showCountyPolygons = !current.showCountyPolygons;
            save();
            applyCountyPolygons();
            syncUI();
        });

        // Audio source mode
        panel.querySelectorAll("#sett-audio-source-mode .sett-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                current.audioSourceMode = btn.dataset.val;
                // Sync to normalized state
                const policyMap = { noaa: "noaa_preferred", spotter: "spotter_preferred", scanner: "scanner_only" };
                StormState.state.audioFollow.policy = policyMap[btn.dataset.val] || "noaa_preferred";
                save();
                syncUI();
            });
        });

        // Audio stream URLs
        for (const type of ["noaa", "spotter", "scanner"]) {
            const ta = panel.querySelector(`#sett-urls-${type}`);
            if (ta) ta.addEventListener("change", () => {
                const urls = _parseUrls(ta.value);
                if (!current.audioSources) current.audioSources = {};
                current.audioSources[type] = urls;
                save();
                _pushUrlsToAudioFollow();
            });
        }

        // Wake lock
        panel.querySelector("#sett-wake-lock").addEventListener("click", () => {
            current.keepScreenOn = !current.keepScreenOn;
            save();
            if (current.keepScreenOn) {
                acquireWakeLock();
            } else {
                releaseWakeLock();
            }
            syncUI();
        });

        // Animations
        panel.querySelector("#sett-animations").addEventListener("click", () => {
            current.animationsEnabled = !current.animationsEnabled;
            save();
            applyAnimations();
            syncUI();
        });

        // Simple mode
        const simpleBtn = panel.querySelector("#btn-simple-mode");
        if (simpleBtn) simpleBtn.addEventListener("click", () => {
            if (typeof ClarityLayer !== "undefined") ClarityLayer.toggleSimpleMode();
            syncUI();
        });

        // Saved locations
        panel.querySelectorAll(".sett-loc-save").forEach(btn => {
            btn.addEventListener("click", async () => {
                const slot = btn.dataset.slot;
                const input = panel.querySelector("#sett-loc-" + slot);
                const status = panel.querySelector("#sett-loc-status");
                if (!input || !status) return;

                const address = input.value.trim();
                if (!address) {
                    status.textContent = "Enter an address";
                    return;
                }

                btn.disabled = true;
                status.textContent = "Geocoding...";

                if (typeof IdleAwareness !== "undefined" && IdleAwareness.setSavedLocation) {
                    const result = await IdleAwareness.setSavedLocation(slot, address);
                    if (result.ok) {
                        if (result.cleared) {
                            status.textContent = "Cleared " + slot;
                            status.style.color = "#94a3b8";
                        } else {
                            const badge = result.precision === "exact" ? "Geocoded" : "Approximate";
                            const color = result.precision === "exact" ? "#34d399" : "#fbbf24";
                            status.textContent = `Saved (${badge}): ` + (result.displayName || address).slice(0, 45);
                            status.style.color = color;
                        }
                        // Refresh the full UI row
                        _syncLocUI(panel);
                        const hint = panel.querySelector("#sett-loc-hint");
                        if (hint) hint.style.display = "none";
                    } else {
                        status.textContent = "Failed: " + (result.error || "unknown");
                        status.style.color = "#f87171";
                    }
                } else {
                    status.textContent = "IDLE system not available";
                    status.style.color = "#f87171";
                }
                btn.disabled = false;
                setTimeout(() => { status.textContent = ""; }, 4000);
            });
        });

        // userLabel save-on-blur
        for (const slot of ["home", "work1", "work2"]) {
            const labelInput = panel.querySelector("#sett-label-" + slot);
            if (labelInput) {
                labelInput.addEventListener("blur", () => {
                    if (typeof IdleAwareness === "undefined") return;
                    const st = IdleAwareness.getState();
                    const loc = st.savedLocations?.[slot];
                    if (!loc) return;
                    // Sanitize: trim, collapse spaces, max 60 chars
                    let newLabel = labelInput.value.trim().replace(/\s+/g, " ").slice(0, 60);
                    // If empty after trim, revert to slot default
                    if (!newLabel) {
                        const defaults = { home: "Home", work1: "Work 1", work2: "Work 2" };
                        newLabel = loc.userLabel || defaults[slot] || slot;
                        labelInput.value = newLabel;
                    }
                    const oldLabel = loc.userLabel;
                    if (newLabel !== oldLabel) {
                        loc.userLabel = newLabel;
                        loc.label = newLabel;
                        try { localStorage.setItem("idle_saved_locations", JSON.stringify(st.savedLocations)); } catch(e) {}
                        // Log label edit
                        if (typeof STLogger !== "undefined") {
                            STLogger.for("idle_aware").info("location_user_label_updated", { slot, old_value: oldLabel, new_value: newLabel });
                        }
                    }
                });
            }
        }

        // Load existing saved location values into inputs
        _syncLocUI(panel);
    }

    function _syncLocUI(panel) {
        if (!panel) panel = document.getElementById("settings-panel");
        if (!panel || typeof IdleAwareness === "undefined") return;

        const BADGE_TEXT = { manual_pin: "Manual Pin", exact: "Geocoded", approximate: "Approximate" };
        const BADGE_COLOR = { manual_pin: "#34d399", exact: "#34d399", approximate: "#fbbf24" };

        {
            const st = IdleAwareness.getState();
            const sl = st.savedLocations || {};
            let hasAny = false;
            for (const slot of ["home", "work1", "work2"]) {
                const addrInput = panel.querySelector("#sett-loc-" + slot);
                const labelInput = panel.querySelector("#sett-label-" + slot);
                const badge = panel.querySelector("#sett-badge-" + slot);
                const meta = panel.querySelector("#sett-meta-" + slot);
                const loc = sl[slot];

                if (!loc) {
                    if (badge) { badge.textContent = ""; }
                    if (meta) { meta.textContent = ""; }
                    continue;
                }
                hasAny = true;

                // Name field: userLabel or default
                if (labelInput) {
                    labelInput.value = loc.userLabel || loc.label || "";
                }

                // Address field: resolvedLabel or address or coords
                if (addrInput) {
                    addrInput.value = loc.resolvedLabel || loc.address || `(${loc.lat?.toFixed(4)}, ${loc.lng?.toFixed(4)})`;
                }

                // Badge
                if (badge) {
                    const p = loc.precision || "approximate";
                    badge.textContent = BADGE_TEXT[p] || p;
                    badge.style.color = BADGE_COLOR[p] || "#94a3b8";
                }

                // Meta line: secondary info
                if (meta) {
                    const parts = [];
                    if (loc.precision === "manual_pin" && loc.resolvedLabel) {
                        parts.push(loc.resolvedLabel.slice(0, 50));
                    }
                    if (loc.lat != null) parts.push(`${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`);
                    meta.textContent = parts.join(" · ");
                }
            }
            if (hasAny) {
                const hint = panel.querySelector("#sett-loc-hint");
                if (hint) hint.style.display = "none";
            }
        }

        // Pin drop buttons
        panel.querySelectorAll(".sett-loc-pin").forEach(btn => {
            btn.addEventListener("click", () => {
                const slot = btn.dataset.slot;
                const kind = btn.dataset.kind || "home";
                // Close settings panel first so map is clickable
                togglePanel();
                if (typeof IdleAwareness !== "undefined" && IdleAwareness.enterPinMode) {
                    IdleAwareness.enterPinMode(slot, kind);
                }
            });
        });

        // Clear buttons
        panel.querySelectorAll(".sett-loc-clear").forEach(btn => {
            btn.addEventListener("click", async () => {
                const slot = btn.dataset.slot;
                const status = panel.querySelector("#sett-loc-status");
                if (typeof IdleAwareness !== "undefined" && IdleAwareness.setSavedLocation) {
                    await IdleAwareness.setSavedLocation(slot, "");
                    const input = panel.querySelector("#sett-loc-" + slot);
                    if (input) input.value = "";
                    if (status) { status.textContent = "Cleared " + slot; status.style.color = "#94a3b8"; }
                }
            });
        });

        // Audio test buttons (proxied from toolbar originals)
        const settNoaaTest = panel.querySelector("#sett-noaa-test");
        const settToneTest = panel.querySelector("#sett-tone-test");
        if (settNoaaTest) {
            settNoaaTest.addEventListener("click", () => {
                const orig = document.getElementById("btn-noaa-test");
                if (orig) orig.click();
            });
        }
        if (settToneTest) {
            settToneTest.addEventListener("click", () => {
                const orig = document.getElementById("btn-tone-test");
                if (orig) orig.click();
            });
        }

        // Reset
        panel.querySelector("#sett-reset").addEventListener("click", () => {
            current = { ...DEFAULTS };
            save();
            applyAll();
            syncUI();
        });

        // Wire AI settings controls
        if (typeof AIPanel !== "undefined") AIPanel.bindSettingsControls();
    }

    function syncUI() {
        // Map style buttons
        document.querySelectorAll("#sett-map-style .sett-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.val === current.mapStyle);
        });

        // Polygon opacity
        const polySlider = document.getElementById("sett-polygon-opacity");
        if (polySlider) polySlider.value = Math.round(current.polygonOpacity * 100);
        const polyVal = document.getElementById("sett-polygon-opacity-val");
        if (polyVal) polyVal.textContent = Math.round(current.polygonOpacity * 100) + "%";

        // SRV opacity
        const srvSlider = document.getElementById("sett-srv-opacity");
        if (srvSlider) srvSlider.value = Math.round(current.srvOpacity * 100);
        const srvVal = document.getElementById("sett-srv-opacity-val");
        if (srvVal) srvVal.textContent = Math.round(current.srvOpacity * 100) + "%";

        // CC opacity
        const ccSlider2 = document.getElementById("sett-cc-opacity");
        if (ccSlider2) ccSlider2.value = Math.round(current.ccOpacity * 100);
        const ccVal = document.getElementById("sett-cc-opacity-val");
        if (ccVal) ccVal.textContent = Math.round(current.ccOpacity * 100) + "%";

        // UI opacity
        const uiSlider = document.getElementById("sett-ui-opacity");
        if (uiSlider) uiSlider.value = Math.round(current.uiOpacity * 100);
        const uiVal = document.getElementById("sett-ui-opacity-val");
        if (uiVal) uiVal.textContent = Math.round(current.uiOpacity * 100) + "%";

        // Alert sort sync
        const sortSel2 = document.getElementById("sett-alert-sort");
        const origSort = document.getElementById("sort-field");
        if (sortSel2 && origSort) sortSel2.value = origSort.value;

        // Alert layer checkboxes
        for (const key of ["primary", "secondary", "warnings", "marine"]) {
            const cb = document.getElementById(`sett-show-${key}`);
            const stateKey = "show" + key.charAt(0).toUpperCase() + key.slice(1);
            if (cb) cb.checked = current[stateKey];
        }

        // County polygons
        const countyBtn = document.getElementById("sett-county-polys");
        if (countyBtn) {
            countyBtn.textContent = current.showCountyPolygons ? "ON" : "OFF";
            countyBtn.classList.toggle("active", current.showCountyPolygons);
        }

        // Simple mode
        const simBtn = document.getElementById("btn-simple-mode");
        if (simBtn) {
            const isSimple = localStorage.getItem("simple_mode") === "true";
            simBtn.textContent = isSimple ? "ON" : "OFF";
            simBtn.classList.toggle("active", isSimple);
        }

        // Audio source mode
        document.querySelectorAll("#sett-audio-source-mode .sett-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.val === current.audioSourceMode);
        });

        // Audio stream URL textareas
        const srcs = current.audioSources || {};
        for (const type of ["noaa", "spotter", "scanner"]) {
            const ta = document.getElementById(`sett-urls-${type}`);
            if (ta) ta.value = (srcs[type] || []).join("\n");
        }

        // Wake lock
        const wakeBtn = document.getElementById("sett-wake-lock");
        if (wakeBtn) {
            wakeBtn.textContent = current.keepScreenOn ? "ON" : "OFF";
            wakeBtn.classList.toggle("active", current.keepScreenOn);
        }
        const wakeStatus = document.getElementById("sett-wake-status");
        if (wakeStatus) {
            if (!("wakeLock" in navigator)) {
                wakeStatus.textContent = "(not supported)";
            } else if (current.keepScreenOn && wakeLock) {
                wakeStatus.textContent = "active";
            } else if (current.keepScreenOn) {
                wakeStatus.textContent = "pending";
            } else {
                wakeStatus.textContent = "";
            }
        }

        // Animations
        const animBtn = document.getElementById("sett-animations");
        if (animBtn) {
            animBtn.textContent = current.animationsEnabled ? "ON" : "OFF";
            animBtn.classList.toggle("active", current.animationsEnabled);
        }
    }

    // ── Apply Settings ──────────────────────────────────────────────

    function applyAll() {
        // Only swap tile layer if user changed from default dark
        if (current.mapStyle !== "dark") applyMapStyle();
        applyPolygonOpacity();
        applySRVOpacity();
        applyCCOpacity();
        applyUIOpacity();
        applyAnimations();
        applyCountyPolygons();
        applyAlertLayers();
        _pushUrlsToAudioFollow();
        if (current.keepScreenOn) acquireWakeLock();
    }

    function applyMapStyle() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;

        const style = MAP_TILES[current.mapStyle] || MAP_TILES.dark;

        // Remove current base tile (could be from map.js init or previous settings change)
        const existingBase = StormMap.getBaseTile();
        if (existingBase) {
            map.removeLayer(existingBase);
        }

        const newLayer = L.tileLayer(style.url, {
            attribution: style.attribution,
            maxZoom: 19,
            subdomains: "abcd",
        }).addTo(map);

        newLayer.setZIndex(0);
        StormMap.setBaseTile(newLayer);
    }

    function applyPolygonOpacity() {
        // Apply to ALL Leaflet GeoJSON polygon layers on the map
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        if (!map) return;
        map.eachLayer(layer => {
            // Match any GeoJSON layer with fillOpacity (alert polygons, county fills)
            if (layer.setStyle && layer.feature) {
                layer.setStyle({ fillOpacity: current.polygonOpacity });
            }
            // Also check layer groups (L.geoJSON returns a layer group)
            if (layer.eachLayer) {
                layer.eachLayer(sub => {
                    if (sub.setStyle && sub.feature) {
                        sub.setStyle({ fillOpacity: current.polygonOpacity });
                    }
                });
            }
        });
    }

    function applySRVOpacity() {
        const layer = typeof RadarManager !== "undefined" ? RadarManager.getOverlayLayer("srv") : null;
        if (layer) layer.setOpacity(current.srvOpacity);
    }

    function applyCCOpacity() {
        const layer = typeof RadarManager !== "undefined" ? RadarManager.getOverlayLayer("cc") : null;
        if (layer) layer.setOpacity(current.ccOpacity);
    }

    function applyUIOpacity() {
        // Apply opacity directly to panel background via inline style
        const alpha = current.uiOpacity;
        const panels = ["#top-bar", "#alert-panel", ".autotrack-badge",
                        ".audio-follow-strip", ".at-collapsed-rail", "#mobile-dock",
                        ".spc-risk-card", ".prediction-card"];
        panels.forEach(sel => {
            const el = document.querySelector(sel);
            if (el) el.style.opacity = alpha;
        });
    }

    function applyAlertLayers() {
        // Emit event — alert-panel and alert-renderer consume this
        StormState.emit("alertLayerVisibilityChanged", {
            showPrimary: current.showPrimary,
            showSecondary: current.showSecondary,
            showWarnings: current.showWarnings,
            showMarine: current.showMarine,
        });
    }

    function applyCountyPolygons() {
        const map = typeof StormMap !== "undefined" ? StormMap.getMap() : null;
        const layer = typeof StormMap !== "undefined" ? StormMap.getCountyLayer() : null;
        if (!map || !layer) return;

        if (current.showCountyPolygons) {
            if (!map.hasLayer(layer)) layer.addTo(map);
        } else {
            if (map.hasLayer(layer)) map.removeLayer(layer);
        }
    }

    function _parseUrls(text) {
        return (text || "").split("\n")
            .map(s => s.trim())
            .filter(s => s && /^https?:\/\/.+/i.test(s));
    }

    function _pushUrlsToAudioFollow() {
        // Push configured URLs into AudioFollow's STREAMS registry
        if (typeof AudioFollow === "undefined" || !AudioFollow.setStreamUrls) return;
        const srcs = current.audioSources || {};
        for (const type of ["noaa", "spotter", "scanner"]) {
            AudioFollow.setStreamUrls(type, srcs[type] || []);
        }
    }

    function applyAnimations() {
        document.documentElement.classList.toggle("no-animations", !current.animationsEnabled);
    }

    // ── Wake Lock ───────────────────────────────────────────────────

    async function acquireWakeLock() {
        if (!("wakeLock" in navigator)) return;
        try {
            wakeLock = await navigator.wakeLock.request("screen");
            wakeLock.addEventListener("release", () => {
                wakeLock = null;
                syncUI();
            });
            console.log("[Settings] Wake lock acquired");
            syncUI();
        } catch (e) {
            console.warn("[Settings] Wake lock failed:", e.message);
            wakeLock = null;
        }
    }

    function releaseWakeLock() {
        if (wakeLock) {
            wakeLock.release();
            wakeLock = null;
            console.log("[Settings] Wake lock released");
        }
    }

    // ── Public ──────────────────────────────────────────────────────

    return { init, togglePanel };
})();
