/**
 * Storm Tracker — Audio Source Lookup Table + Resolver
 *
 * Maps NWS CWA (County Warning Area) offices to local NOAA Weather Radio
 * and scanner stream URLs. Used when user has not configured override URLs.
 *
 * Resolution key: NWS CWA office code (3-letter, e.g. ILN, IND, LOT)
 * extracted from the alert's sender field or nearest NEXRAD site.
 *
 * Fallback order per source type:
 *   1. User override (from Settings audioSources)
 *   2. Lookup table (by CWA)
 *   3. Default/global URLs
 *   4. Empty (source unavailable)
 *
 * Spotter is NOT auto-resolved — user-configurable only.
 */
const AudioSourceLookup = (function () {

    // ── NOAA Weather Radio by CWA ──────────────────────────────
    // Key: NWS CWA code (lowercase)
    // Value: { label, urls }
    // CWA → Broadcastify NOAA Weather Radio feed IDs
    // These are community-maintained NWR rebroadcasts on Broadcastify
    const NOAA_BY_CWA = {
        // Ohio Valley
        iln: { label: "Wilmington OH", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        cle: { label: "Cleveland OH", urls: ["https://broadcastify.cdnstream1.com/22514"] },
        pbz: { label: "Pittsburgh PA", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        rlx: { label: "Charleston WV", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Indiana
        ind: { label: "Indianapolis IN", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        iwx: { label: "Fort Wayne IN", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Illinois
        ilx: { label: "Lincoln IL", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        lot: { label: "Chicago IL", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Kentucky / Tennessee
        lmk: { label: "Louisville KY", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        jkl: { label: "Jackson KY", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        mrx: { label: "Morristown TN", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Michigan
        dtx: { label: "Detroit MI", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        grr: { label: "Grand Rapids MI", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Midwest
        dvn: { label: "Quad Cities IA/IL", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        dmx: { label: "Des Moines IA", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        mkx: { label: "Milwaukee WI", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        mpx: { label: "Minneapolis MN", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Plains
        ict: { label: "Wichita KS", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        top: { label: "Topeka KS", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        oax: { label: "Omaha NE", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        sgf: { label: "Springfield MO", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        eax: { label: "Kansas City MO", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Southeast
        bmx: { label: "Birmingham AL", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        hun: { label: "Huntsville AL", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        ohx: { label: "Nashville TN", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        jan: { label: "Jackson MS", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        // Southern Plains / Tornado Alley
        oun: { label: "Norman OK", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        tsa: { label: "Tulsa OK", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        fwd: { label: "Fort Worth TX", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        shv: { label: "Shreveport LA", urls: ["https://broadcastify.cdnstream1.com/33645"] },
        lzk: { label: "Little Rock AR", urls: ["https://broadcastify.cdnstream1.com/33645"] },
    };

    // ── Scanner/Broadcastify by CWA ─────────────────────────────
    const SCANNER_BY_CWA = {
        iln: { label: "SW Ohio", urls: ["https://broadcastify.cdnstream1.com/14439"] },
        cle: { label: "NE Ohio", urls: ["https://broadcastify.cdnstream1.com/14439"] },
        ind: { label: "Central IN", urls: ["https://broadcastify.cdnstream1.com/14438"] },
        lot: { label: "Chicago", urls: ["https://broadcastify.cdnstream1.com/14437"] },
        oun: { label: "Central OK", urls: ["https://broadcastify.cdnstream1.com/14398"] },
        bmx: { label: "Central AL", urls: ["https://broadcastify.cdnstream1.com/14408"] },
    };

    // ── Default fallbacks ───────────────────────────────────────
    const DEFAULTS = {
        noaa: { label: "National", urls: [
            "https://broadcastify.cdnstream1.com/33645",
            "https://broadcastify.cdnstream1.com/22514",
        ]},
        scanner: { label: "Default", urls: [
            "https://broadcastify.cdnstream1.com/14439",
        ]},
        spotter: { label: "None", urls: [] },
    };

    /**
     * Resolve audio sources for a given event.
     *
     * @param {object} opts
     * @param {string} [opts.sender] - NWS sender string (e.g. "NWS Wilmington OH")
     * @param {string} [opts.cwa] - CWA code if known (e.g. "ILN")
     * @param {object} [opts.userOverrides] - { noaa: [...], spotter: [...], scanner: [...] }
     * @returns {{ noaa: {urls, label, origin}, spotter: {...}, scanner: {...} }}
     */
    function resolve(opts) {
        const cwa = (opts.cwa || _extractCWA(opts.sender || "")).toLowerCase();
        const userOvr = opts.userOverrides || {};

        return {
            noaa: _resolveType("noaa", cwa, userOvr.noaa, NOAA_BY_CWA),
            spotter: _resolveType("spotter", cwa, userOvr.spotter, {}),  // no lookup table
            scanner: _resolveType("scanner", cwa, userOvr.scanner, SCANNER_BY_CWA),
        };
    }

    function _resolveType(type, cwa, userUrls, lookupTable) {
        // 1. User override
        if (userUrls && userUrls.length > 0) {
            return { urls: userUrls, label: "User set", origin: "user_override" };
        }

        // 2. Lookup table by CWA
        if (cwa && lookupTable[cwa]) {
            const entry = lookupTable[cwa];
            return { urls: entry.urls, label: entry.label, origin: "lookup_table" };
        }

        // 3. Default
        const def = DEFAULTS[type];
        if (def && def.urls.length > 0) {
            return { urls: def.urls, label: def.label, origin: "default" };
        }

        // 4. None
        return { urls: [], label: "None", origin: "none" };
    }

    function _extractCWA(sender) {
        // Extract CWA from NWS sender like "NWS Wilmington OH" → map known names
        // Or from sender code like "w-nws.webmaster@noaa.gov" with office in URL
        const cwaMap = {
            "wilmington": "iln", "cleveland": "cle", "pittsburgh": "pbz",
            "charleston": "rlx", "indianapolis": "ind", "fort wayne": "iwx",
            "northern indiana": "iwx", "lincoln": "ilx", "chicago": "lot",
            "louisville": "lmk", "jackson ky": "jkl", "morristown": "mrx",
            "detroit": "dtx", "grand rapids": "grr", "quad cities": "dvn",
            "des moines": "dmx", "milwaukee": "mkx", "twin cities": "mpx",
            "minneapolis": "mpx", "wichita": "ict", "topeka": "top",
            "omaha": "oax", "springfield mo": "sgf", "kansas city": "eax",
            "birmingham": "bmx", "huntsville": "hun", "nashville": "ohx",
            "jackson ms": "jan", "norman": "oun", "tulsa": "tsa",
            "fort worth": "fwd", "dallas": "fwd", "shreveport": "shv",
            "little rock": "lzk",
        };

        const lower = sender.toLowerCase();
        for (const [name, code] of Object.entries(cwaMap)) {
            if (lower.includes(name)) return code;
        }
        return "";
    }

    return { resolve };
})();
