/**
 * Storm Tracker — AT Impacted Area Places + Expiry Bar
 *
 * Feature 1: Shows named places in the alert polygon area
 * Feature 2: Shows countdown bar for alert expiry
 *
 * Only active when AT is tracking a TOR/SVR/high-guidance alert.
 * Places fetched from Overpass API (OpenStreetMap), fallback to county names.
 */
const ATPlaces = (function () {

    const ELIGIBLE_EVENTS = new Set([
        "Tornado Warning",
        "Severe Thunderstorm Warning",
        "Tornado Watch",
    ]);
    const MAX_PLACES = 10;
    const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
    const CACHE_TTL_MS = 300000;  // 5 min cache per polygon

    let lastAlertId = null;
    let lastPlaces = null;
    let lastFetchTime = 0;
    let expiryTimer = null;

    function init() {
        StormState.on("autotrackTargetChanged", onTargetChanged);
        StormState.on("autotrackChanged", onModeChanged);
    }

    function onTargetChanged(targetId) {
        if (!targetId || targetId !== lastAlertId) {
            lastAlertId = targetId;
            lastPlaces = null;
            lastFetchTime = 0;
        }
        update();
    }

    function onModeChanged(data) {
        if (data.mode === "off") {
            hide();
            stopExpiryTimer();
        } else {
            update();
        }
    }

    function update() {
        const at = StormState.state.autotrack;
        if (at.mode === "off" || !at.targetAlertId) {
            hide();
            stopExpiryTimer();
            return;
        }

        const alert = StormState.state.alerts.data.find(a => a.id === at.targetAlertId);
        if (!alert) {
            hide();
            stopExpiryTimer();
            return;
        }

        // Only show for eligible severe events
        if (!ELIGIBLE_EVENTS.has(alert.event)) {
            hide();
            stopExpiryTimer();
            return;
        }

        // Start/update expiry bar
        updateExpiryBar(alert);

        // Fetch places if not cached
        if (lastAlertId === alert.id && lastPlaces && (Date.now() - lastFetchTime < CACHE_TTL_MS)) {
            renderPlaces(lastPlaces);
        } else {
            fetchPlaces(alert);
        }
    }

    // ── Places ──────────────────────────────────────────────────

    async function fetchPlaces(alert) {
        lastAlertId = alert.id;

        // Try polygon-based query first
        if (alert.polygon) {
            try {
                const polyRing = getPolyRing(alert.polygon);
                const bbox = getBBoxFromRing(polyRing);
                if (bbox) {
                    const rawPlaces = await queryOverpass(bbox);
                    // Filter to places actually inside the polygon (not just bbox)
                    const filtered = polyRing
                        ? rawPlaces.filter(p => p.lat != null && pointInPolygon(p.lat, p.lon, polyRing))
                        : rawPlaces;
                    const places = filtered.slice(0, MAX_PLACES);
                    if (places.length > 0) {
                        lastPlaces = places;
                        lastFetchTime = Date.now();
                        renderPlaces(places);
                        return;
                    }
                }
            } catch (e) { /* fallback */ }
        }

        // Fallback: extract place names from county_fips or headline
        const fallback = extractFallbackPlaces(alert);
        lastPlaces = fallback;
        lastFetchTime = Date.now();
        renderPlaces(fallback);
    }

    function getPolyRing(polygonStr) {
        /** Extract the outer ring as [[lon,lat],...] from GeoJSON string. */
        try {
            const geo = JSON.parse(polygonStr);
            const coords = geo.type === "Polygon" ? geo.coordinates[0]
                : geo.type === "MultiPolygon" ? geo.coordinates[0][0]
                : null;
            return (coords && coords.length >= 3) ? coords : null;
        } catch (e) {
            return null;
        }
    }

    function getBBoxFromRing(ring) {
        if (!ring) return null;
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (const [lon, lat] of ring) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        }
        return { s: minLat, n: maxLat, w: minLon, e: maxLon };
    }

    function pointInPolygon(lat, lon, ring) {
        /** Ray-casting point-in-polygon. Ring is [[lon,lat],...]. */
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if ((yi > lat) !== (yj > lat) &&
                (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    async function queryOverpass(bbox) {
        // Query for named places (cities, towns, villages) in the bounding box
        const query = `[out:json][timeout:5];
            (node["place"~"city|town|village"](${bbox.s},${bbox.w},${bbox.n},${bbox.e}););
            out body ${MAX_PLACES * 3};`;

        try {
            const resp = await fetch(OVERPASS_URL, {
                method: "POST",
                body: "data=" + encodeURIComponent(query),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
            if (!resp.ok) return [];
            const data = await resp.json();
            const elements = data.elements || [];

            return elements.slice(0, MAX_PLACES * 3).map(el => ({
                name: el.tags?.name || "Unknown",
                type: el.tags?.place || "place",
                lat: el.lat,
                lon: el.lon,
            }));
        } catch (e) {
            return [];
        }
    }

    function extractFallbackPlaces(alert) {
        const places = [];

        // From headline: extract area after "for "
        if (alert.headline) {
            const forIdx = alert.headline.lastIndexOf(" for ");
            if (forIdx > -1) {
                const area = alert.headline.substring(forIdx + 5).replace(/\.\.\.$/, "").trim();
                const parts = area.split(/[,;]/).map(s => s.trim()).filter(Boolean);
                for (const p of parts.slice(0, MAX_PLACES)) {
                    places.push({ name: p, type: "area" });
                }
            }
        }

        // From county_fips count
        if (places.length === 0 && alert.county_fips && alert.county_fips.length > 0) {
            places.push({ name: `${alert.county_fips.length} counties affected`, type: "region" });
        }

        return places;
    }

    function renderPlaces(places) {
        const container = document.getElementById("at-places-list");
        if (!container) return;

        if (!places || places.length === 0) {
            container.classList.add("hidden");
            return;
        }

        container.classList.remove("hidden");
        const inline = places.map(p => _esc(p.name)).join(" \u2013 ");
        container.innerHTML = `
            <div class="atp-header">Places in alert area</div>
            <div class="atp-items-inline">${inline}</div>
        `;
    }

    // ── Expiry Bar ──────────────────────────────────────────────

    function updateExpiryBar(alert) {
        stopExpiryTimer();

        if (!alert.expires) {
            hideExpiryBar();
            return;
        }

        // Start ticking
        _renderExpiry(alert.expires);
        expiryTimer = setInterval(() => _renderExpiry(alert.expires), 5000);
    }

    function _renderExpiry(expiresStr) {
        const bar = document.getElementById("at-expiry-bar");
        if (!bar) return;

        try {
            const exp = new Date(expiresStr).getTime();
            const now = Date.now();
            const remainMs = exp - now;

            if (remainMs <= 0) {
                bar.innerHTML = `<div class="ate-text ate-expired">EXPIRED</div>`;
                bar.classList.remove("hidden");
                stopExpiryTimer();
                return;
            }

            const remainMin = Math.ceil(remainMs / 60000);
            const totalMs = 60 * 60000;  // assume ~60 min max warning duration
            const pct = Math.min(100, Math.max(2, (remainMs / totalMs) * 100));

            const urgentClass = remainMin <= 5 ? "ate-urgent" : remainMin <= 15 ? "ate-warning" : "";

            bar.classList.remove("hidden");
            bar.innerHTML = `
                <div class="ate-track">
                    <div class="ate-fill ${urgentClass}" style="width:${pct}%"></div>
                </div>
                <span class="ate-text ${urgentClass}">${remainMin}m left</span>
            `;
        } catch (e) {
            bar.classList.add("hidden");
        }
    }

    function stopExpiryTimer() {
        if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
    }

    function hideExpiryBar() {
        const bar = document.getElementById("at-expiry-bar");
        if (bar) bar.classList.add("hidden");
    }

    function hide() {
        const container = document.getElementById("at-places-list");
        if (container) container.classList.add("hidden");
        hideExpiryBar();
    }

    function _esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init };
})();
