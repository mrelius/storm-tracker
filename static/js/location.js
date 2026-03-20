/**
 * Storm Tracker — Location Resolution
 * Fallback chain: GPS → saved → manual → Ohio Valley default
 */
const StormLocation = (function () {
    const STORAGE_KEY = "storm_tracker_location";

    async function resolve() {
        // 1. Try GPS
        const gps = await tryGPS();
        if (gps) {
            save(gps);
            StormState.setLocation(gps.lat, gps.lon, "gps", "GPS Location");
            return;
        }

        // 2. Try saved location
        const saved = load();
        if (saved) {
            StormState.setLocation(saved.lat, saved.lon, "saved", saved.name || "Saved Location");
            return;
        }

        // 3. Manual selection is handled by user interaction (skip in auto-resolve)

        // 4. Default fallback
        await useDefault();
    }

    function tryGPS() {
        return new Promise((resolve) => {
            if (!navigator.geolocation) {
                resolve(null);
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
                () => resolve(null),
                { timeout: 5000, maximumAge: 300000 }
            );
        });
    }

    function save(loc) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
        } catch (e) { /* ignore */ }
    }

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore */ }
        return null;
    }

    async function useDefault() {
        try {
            const resp = await fetch("/api/location/default");
            const data = await resp.json();
            StormState.setLocation(data.lat, data.lon, "default", data.name);
        } catch (e) {
            // Hardcoded ultimate fallback
            StormState.setLocation(39.5, -84.5, "default", "Ohio Valley");
        }
    }

    function setManual(lat, lon, name) {
        const loc = { lat, lon, name };
        save(loc);
        StormState.setLocation(lat, lon, "manual", name || "Manual Location");
    }

    return { resolve, setManual };
})();
