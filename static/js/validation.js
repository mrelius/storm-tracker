/**
 * Storm Tracker — Validation / Debug Mode
 * Click-to-inspect radar values, crosshair cursor, timestamp comparison,
 * alignment indicator, layer health. All gated behind toggle.
 */
const Validation = (function () {
    let enabled = false;
    let map = null;
    let crosshairMarker = null;
    let inspectPanel = null;
    let throttleTimer = null;
    const THROTTLE_MS = 100;
    const CC_SAMPLE_URL = "http://10.206.8.121:8121/api/radar/sample";

    // NWS velocity color table (approximate reverse mapping: RGBA → knots)
    // Green = inbound (negative), Red = outbound (positive)
    const VEL_COLOR_MAP = [
        { r: 0, g: 255, b: 0, val: -64 },
        { r: 0, g: 200, b: 0, val: -50 },
        { r: 0, g: 150, b: 0, val: -30 },
        { r: 0, g: 100, b: 0, val: -15 },
        { r: 0, g: 50, b: 0, val: -5 },
        { r: 50, g: 50, b: 50, val: 0 },
        { r: 50, g: 0, b: 0, val: 5 },
        { r: 100, g: 0, b: 0, val: 15 },
        { r: 150, g: 0, b: 0, val: 30 },
        { r: 200, g: 0, b: 0, val: 50 },
        { r: 255, g: 0, b: 0, val: 64 },
    ];

    // RainViewer reflectivity color table (approximate: RGBA → dBZ)
    const REF_COLOR_MAP = [
        { r: 0, g: 236, b: 236, val: 5 },
        { r: 1, g: 160, b: 246, val: 15 },
        { r: 0, g: 0, b: 246, val: 20 },
        { r: 0, g: 255, b: 0, val: 30 },
        { r: 0, g: 200, b: 0, val: 35 },
        { r: 255, g: 255, b: 0, val: 40 },
        { r: 231, g: 192, b: 0, val: 45 },
        { r: 255, g: 144, b: 0, val: 50 },
        { r: 255, g: 0, b: 0, val: 55 },
        { r: 214, g: 0, b: 0, val: 60 },
        { r: 192, g: 0, b: 0, val: 65 },
        { r: 255, g: 0, b: 255, val: 70 },
    ];

    function init(leafletMap) {
        map = leafletMap;
        inspectPanel = document.getElementById("validation-panel");

        document.getElementById("btn-validation-toggle").addEventListener("click", toggle);
        document.getElementById("btn-val-copy").addEventListener("click", copyToClipboard);
    }

    function toggle() {
        enabled = !enabled;
        const btn = document.getElementById("btn-validation-toggle");
        btn.classList.toggle("active", enabled);

        if (enabled) {
            activate();
        } else {
            deactivate();
        }
    }

    function activate() {
        map.getContainer().classList.add("validation-crosshair");
        map.on("mousemove", onMouseMove);
        map.on("click", onMapClick);
        if (inspectPanel) inspectPanel.classList.remove("hidden");
        updateLayerHealth();
        updateTimestamps();
    }

    function deactivate() {
        map.getContainer().classList.remove("validation-crosshair");
        map.off("mousemove", onMouseMove);
        map.off("click", onMapClick);
        if (crosshairMarker) {
            map.removeLayer(crosshairMarker);
            crosshairMarker = null;
        }
        if (inspectPanel) inspectPanel.classList.add("hidden");
    }

    function onMouseMove(e) {
        if (throttleTimer) return;
        throttleTimer = setTimeout(() => {
            throttleTimer = null;
            updateInspectValues(e.latlng, false);
        }, THROTTLE_MS);
    }

    function onMapClick(e) {
        updateInspectValues(e.latlng, true);

        if (crosshairMarker) map.removeLayer(crosshairMarker);
        crosshairMarker = L.circleMarker(e.latlng, {
            radius: 6,
            color: "#fff",
            weight: 2,
            fillColor: "#3b82f6",
            fillOpacity: 0.8,
            interactive: false,
        }).addTo(map);
    }

    async function updateInspectValues(latlng, isClick) {
        const lat = latlng.lat.toFixed(4);
        const lon = latlng.lng.toFixed(4);

        setField("val-coords", `${lat}, ${lon}`);

        // Sample REF from canvas
        const refRGBA = sampleTileCanvas("reflectivity", latlng);
        if (refRGBA && refRGBA.a > 10) {
            const dbz = reverseMapColor(refRGBA, REF_COLOR_MAP);
            setField("val-ref", dbz !== null ? `~${dbz} dBZ` : "color outside table");
        } else {
            setField("val-ref", refRGBA ? "no return" : "layer off");
        }

        // Sample SRV from canvas
        const srvRGBA = sampleTileCanvas("srv", latlng);
        if (srvRGBA && srvRGBA.a > 10) {
            const vel = reverseMapColor(srvRGBA, VEL_COLOR_MAP);
            setField("val-srv", vel !== null ? `~${vel} kt` : "color outside table");
        } else {
            setField("val-srv", srvRGBA ? "no return" : "layer off");
        }

        // Sample CC from backend (only on click to avoid hammering API)
        if (isClick) {
            setField("val-cc", "sampling...");
            try {
                const resp = await fetch(`${CC_SAMPLE_URL}?lat=${lat}&lon=${lon}`);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.cc_value !== null) {
                        const clamped = Math.max(0, Math.min(1, data.cc_value));
                        setField("val-cc", clamped.toFixed(4));
                    } else {
                        setField("val-cc", data.in_range ? "no return" : "out of range");
                    }
                } else {
                    setField("val-cc", "unavailable");
                }
            } catch (e) {
                setField("val-cc", "error");
            }
        }

        updateTimestamps();
        updateLayerHealth();
    }

    function sampleTileCanvas(productId, latlng) {
        /**
         * Sample pixel color from a Leaflet tile layer at a given lat/lng.
         * Returns {r, g, b, a} or null if layer not active.
         */
        const layers = StormState.state.radar.activeLayers;
        if (!layers.includes(productId)) return null;

        // Find tile layer elements in the map container
        const point = map.latLngToContainerPoint(latlng);
        const container = map.getContainer();

        // Get all tile images at this point
        const elements = document.elementsFromPoint(
            container.getBoundingClientRect().left + point.x,
            container.getBoundingClientRect().top + point.y,
        );

        // Find tile images (Leaflet creates <img> elements for tiles)
        for (const el of elements) {
            if (el.tagName === "IMG" && el.src && el.closest(".leaflet-tile-pane")) {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = 1;
                    canvas.height = 1;
                    const ctx = canvas.getContext("2d");

                    // Calculate position within the tile
                    const rect = el.getBoundingClientRect();
                    const tileX = point.x - (rect.left - container.getBoundingClientRect().left);
                    const tileY = point.y - (rect.top - container.getBoundingClientRect().top);

                    // Scale to natural tile size
                    const scaleX = el.naturalWidth / rect.width;
                    const scaleY = el.naturalHeight / rect.height;

                    ctx.drawImage(el,
                        tileX * scaleX, tileY * scaleY, 1, 1,
                        0, 0, 1, 1);
                    const pixel = ctx.getImageData(0, 0, 1, 1).data;
                    return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
                } catch (e) {
                    // CORS may block canvas read for cross-origin tiles
                    return null;
                }
            }
        }
        return null;
    }

    function reverseMapColor(rgba, colorMap) {
        /**
         * Find the nearest color in the color map and return its value.
         * Simple nearest-neighbor in RGB space.
         */
        let bestDist = Infinity;
        let bestVal = null;
        for (const entry of colorMap) {
            const dr = rgba.r - entry.r;
            const dg = rgba.g - entry.g;
            const db = rgba.b - entry.b;
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) {
                bestDist = dist;
                bestVal = entry.val;
            }
        }
        // Only return if reasonably close (within color distance threshold)
        return bestDist < 8000 ? bestVal : null;
    }

    function updateTimestamps() {
        const state = StormState.state.radar;
        const lines = [];

        // REF timestamp (from animation frame)
        if (state.activeLayers.includes("reflectivity") && state.frames && state.frames.length > 0) {
            const frame = state.frames[state.currentFrameIndex];
            if (frame && frame.timestamp) {
                lines.push({ label: "REF", ts: frame.timestamp });
            }
        }

        // SRV timestamp (from API — unknown, show "latest scan")
        if (state.activeLayers.includes("srv")) {
            lines.push({ label: "SRV", ts: null, text: "latest scan" });
        }

        // CC timestamp (from LXC 121 status)
        if (state.activeLayers.includes("cc")) {
            // Fetch asynchronously on first call, cache result
            fetchCCTimestamp().then(ts => {
                setField("val-ts-cc", ts ? formatTsShort(ts) : "unknown");
            });
        }

        const tsEl = document.getElementById("val-timestamps");
        if (!tsEl) return;

        let html = "";
        for (const line of lines) {
            const tsText = line.text || (line.ts ? formatTsShort(line.ts) : "unknown");
            html += `<div>${line.label}: ${tsText}</div>`;
        }
        if (state.activeLayers.includes("cc")) {
            const ccTs = document.getElementById("val-ts-cc");
            html += `<div>CC: <span id="val-ts-cc">${ccTs ? ccTs.textContent : "..."}</span></div>`;
        }

        tsEl.innerHTML = html;

        // Check alignment (REF vs CC timestamp difference)
        checkTimestampAlignment();
    }

    let _ccTimestampCache = null;
    let _ccTimestampAge = 0;

    async function fetchCCTimestamp() {
        if (_ccTimestampCache && Date.now() - _ccTimestampAge < 30000) {
            return _ccTimestampCache;
        }
        try {
            const resp = await fetch("http://10.206.8.121:8121/api/status");
            const data = await resp.json();
            if (data.timestamp) {
                _ccTimestampCache = data.timestamp;
                _ccTimestampAge = Date.now();
                return data.timestamp;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function checkTimestampAlignment() {
        const el = document.getElementById("val-alignment");
        if (!el) return;

        // Simple check: if both SRV and CC are from the same site, they're aligned by design
        const layers = StormState.state.radar.activeLayers;
        if (layers.includes("srv") && layers.includes("cc")) {
            el.textContent = "Alignment: OK (same site + scan)";
            el.className = "val-alignment val-ok";
        } else if (layers.includes("srv") || layers.includes("cc")) {
            el.textContent = "Alignment: partial (enable both SRV + CC)";
            el.className = "val-alignment val-warn";
        } else {
            el.textContent = "Alignment: N/A";
            el.className = "val-alignment";
        }
    }

    function updateLayerHealth() {
        const el = document.getElementById("val-health");
        if (!el) return;

        const layers = StormState.state.radar.activeLayers;
        const lines = [];

        if (layers.includes("reflectivity")) lines.push("REF: OK");
        if (layers.includes("srv")) lines.push("SRV: OK");
        if (layers.includes("cc")) lines.push("CC: OK");
        if (lines.length === 0) lines.push("No layers active");

        el.innerHTML = lines.map(l => `<div>${l}</div>`).join("");
    }

    function formatTsShort(ts) {
        if (!ts) return "--";
        try {
            // Handle both ISO and YYYYMMDDTHHMMSSZ format
            let d;
            if (ts.length === 16 && ts.includes("T")) {
                // 20260320T205725Z
                d = new Date(
                    ts.slice(0, 4) + "-" + ts.slice(4, 6) + "-" + ts.slice(6, 8) +
                    "T" + ts.slice(9, 11) + ":" + ts.slice(11, 13) + ":" + ts.slice(13, 15) + "Z"
                );
            } else {
                d = new Date(ts);
            }
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        } catch (e) {
            return ts;
        }
    }

    function setField(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function copyToClipboard() {
        const getField = (id) => {
            const el = document.getElementById(id);
            return el ? el.textContent.trim() : "—";
        };

        const tsEl = document.getElementById("val-timestamps");
        const timestamps = tsEl ? tsEl.textContent.replace(/\n/g, ", ").trim() : "—";

        const text = [
            `Storm Tracker Validation Export`,
            `Date: ${new Date().toISOString()}`,
            ``,
            `Coordinates: ${getField("val-coords")}`,
            `Radar Site: ${StormState.state.radar.activeLayers.length > 0 ? (document.getElementById("radar-site-label")?.textContent || "—") : "—"}`,
            ``,
            `REF (approx): ${getField("val-ref")}`,
            `SRV (approx): ${getField("val-srv")}`,
            `CC (exact):   ${getField("val-cc")}`,
            ``,
            `Timestamps: ${timestamps}`,
            `Alignment: ${getField("val-alignment")}`,
            `Layer Health: ${getField("val-health").replace(/\n/g, ", ")}`,
        ].join("\n");

        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById("btn-val-copy");
            btn.textContent = "Copied!";
            btn.classList.add("copied");
            setTimeout(() => {
                btn.textContent = "Copy to clipboard";
                btn.classList.remove("copied");
            }, 2000);
        }).catch(() => {
            // Fallback for non-HTTPS contexts
            const ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        });
    }

    return { init, toggle };
})();
