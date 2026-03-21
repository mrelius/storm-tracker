/**
 * Storm Tracker — Service Worker
 * Caches app shell + static assets. Serves stale alerts when offline.
 */
const CACHE_NAME = "storm-tracker-v34";
const SHELL_ASSETS = [
    "/",
    "/static/css/app.css",
    "/static/js/state.js",
    "/static/js/location.js",
    "/static/js/map.js",
    "/static/js/radar-manager.js",
    "/static/js/alert-renderer.js",
    "/static/js/alert-panel.js",
    "/static/js/storm-alert-panel.js",
    "/static/js/storm-audio.js",
    "/static/js/storm-notify.js",
    "/static/js/feedback.js",
    "/static/js/validation.js",
    "/static/js/app.js",
];

// API endpoints to cache with network-first strategy
const API_CACHE_PATTERNS = [
    "/api/alerts",
    "/api/alerts/counties",
    "/api/radar/products",
    "/api/location/default",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // API requests: network-first, fallback to cache
    if (API_CACHE_PATTERNS.some(p => url.pathname.startsWith(p))) {
        event.respondWith(networkFirstThenCache(event.request));
        return;
    }

    // Static assets: cache-first
    if (url.pathname.startsWith("/static/") || url.pathname === "/") {
        event.respondWith(cacheFirstThenNetwork(event.request));
        return;
    }

    // Everything else (including cross-origin tile requests): pass through directly
    // Do NOT wrap in event.respondWith — let the browser handle natively
    return;
});

async function networkFirstThenCache(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response(JSON.stringify({ error: "offline", cached: false }),
            { status: 503, headers: { "Content-Type": "application/json" } });
    }
}

async function cacheFirstThenNetwork(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (e) {
        return new Response("Offline", { status: 503 });
    }
}
