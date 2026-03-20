/**
 * Storm Tracker — Map initialization and base layer management.
 */
const StormMap = (function () {
    let map = null;
    let countyLayer = null;
    let countyData = null;

    function init() {
        map = L.map("map", {
            center: [39.5, -84.5],
            zoom: 6,
            zoomControl: true,
            attributionControl: true,
        });

        // Dark basemap (CartoDB Dark Matter)
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org/">OSM</a>',
            subdomains: "abcd",
            maxZoom: 19,
        }).addTo(map);

        // Listen for location changes
        StormState.on("locationChanged", (loc) => {
            map.setView([loc.lat, loc.lon], map.getZoom());
            document.getElementById("location-display").textContent =
                loc.name || `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`;
        });

        // Listen for panel toggle to resize
        StormState.on("panelToggled", () => {
            setTimeout(() => map.invalidateSize(), 300);
        });

        // Load county boundaries
        loadCounties();

        return map;
    }

    async function loadCounties() {
        try {
            const resp = await fetch("/data/counties_midwest.geojson");
            if (!resp.ok) throw new Error(`County data fetch failed: ${resp.status}`);
            countyData = await resp.json();
            createCountyLayer();
        } catch (e) {
            console.error("Failed to load county data:", e);
        }
    }

    function createCountyLayer() {
        if (!countyData) return;

        countyLayer = L.geoJSON(countyData, {
            style: defaultCountyStyle,
            onEachFeature: (feature, layer) => {
                const props = feature.properties;
                layer.bindTooltip(`${props.NAME} County`, {
                    sticky: true,
                    className: "county-tooltip",
                });
                layer._fips = feature.id;
            },
        }).addTo(map);
    }

    function defaultCountyStyle() {
        return {
            fillColor: "transparent",
            fillOpacity: 0,
            color: "#1e293b",
            weight: 0.5,
            opacity: 0.4,
        };
    }

    function colorCounties(countyMap) {
        if (!countyLayer) return;

        countyLayer.eachLayer((layer) => {
            const fips = layer._fips;
            const event = countyMap[fips];
            if (event) {
                const color = StormState.getEventColor(event);
                layer.setStyle({
                    fillColor: color,
                    fillOpacity: 0.35,
                    color: color,
                    weight: 1.5,
                    opacity: 0.7,
                });
            } else {
                layer.setStyle(defaultCountyStyle());
            }
        });
    }

    let highlightLayer = null;

    function focusOnAlert(alert) {
        if (!map) return;
        let targetBounds = null;

        // Try polygon first
        if (alert.polygon) {
            try {
                const geojson = JSON.parse(alert.polygon);
                const layer = L.geoJSON(geojson);
                targetBounds = layer.getBounds();
            } catch (e) { /* fall through */ }
        }

        // Try county FIPS centroids
        if (!targetBounds && alert.county_fips && alert.county_fips.length > 0 && countyLayer) {
            const bounds = L.latLngBounds([]);
            countyLayer.eachLayer((layer) => {
                if (alert.county_fips.includes(layer._fips)) {
                    bounds.extend(layer.getBounds());
                }
            });
            if (bounds.isValid()) targetBounds = bounds;
        }

        if (!targetBounds) return;

        map.fitBounds(targetBounds, { padding: [50, 50], maxZoom: 10 });
        flashHighlight(targetBounds, StormState.getEventColor(alert.event));
    }

    function flashHighlight(bounds, color) {
        if (highlightLayer) {
            map.removeLayer(highlightLayer);
        }
        highlightLayer = L.rectangle(bounds, {
            color: color,
            weight: 3,
            fillColor: color,
            fillOpacity: 0.3,
            opacity: 1,
            className: "focus-flash",
            interactive: false,
        }).addTo(map);

        // Fade out after 1.5s
        setTimeout(() => {
            if (highlightLayer) {
                map.removeLayer(highlightLayer);
                highlightLayer = null;
            }
        }, 1500);
    }

    function getCenter() {
        if (!map) return null;
        const c = map.getCenter();
        return { lat: c.lat, lon: c.lng };
    }

    function onMoveEnd(callback) {
        if (map) map.on("moveend", callback);
    }

    function getMap() {
        return map;
    }

    function getCountyLayer() {
        return countyLayer;
    }

    return { init, colorCounties, getMap, getCountyLayer, focusOnAlert, getCenter, onMoveEnd };
})();
