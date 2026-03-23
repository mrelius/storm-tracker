/**
 * Storm Tracker — In-App Log Viewer
 *
 * Hidden debug panel that reads from GET /api/logs.
 * Toggle with Shift+Alt+L.
 * Supports level/module/text filtering, time range, and copy.
 */
const LogViewer = (function () {

    let panel = null;
    let visible = false;
    let refreshTimer = null;
    const POLL_INTERVAL = 10000;  // 10s auto-refresh

    function init() {
        document.addEventListener("keydown", (e) => {
            if (e.shiftKey && e.altKey && e.key === "L") {
                e.preventDefault();
                toggle();
            }
        });
    }

    function toggle() {
        visible = !visible;
        ensurePanel();
        panel.classList.toggle("hidden", !visible);
        if (visible) {
            fetchAndRender();
            refreshTimer = setInterval(fetchAndRender, POLL_INTERVAL);
        } else {
            if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        }
    }

    function ensurePanel() {
        if (panel) return;
        panel = document.createElement("div");
        panel.id = "log-viewer-panel";
        panel.className = "log-viewer-panel hidden";
        panel.innerHTML = `
            <div class="lv-header">
                <span class="lv-title">SYSTEM LOGS</span>
                <div class="lv-controls">
                    <select id="lv-level" class="lv-select">
                        <option value="">All Levels</option>
                        <option value="ERROR">ERROR</option>
                        <option value="WARNING">WARN</option>
                        <option value="INFO">INFO</option>
                        <option value="DEBUG">DEBUG</option>
                    </select>
                    <select id="lv-time" class="lv-select">
                        <option value="5">5m</option>
                        <option value="15" selected>15m</option>
                        <option value="60">1h</option>
                        <option value="360">6h</option>
                    </select>
                    <input id="lv-search" class="lv-search" placeholder="search..." type="text">
                    <button id="lv-copy" class="lv-btn" title="Copy logs">Copy</button>
                    <button id="lv-close" class="lv-btn" title="Close">&times;</button>
                </div>
            </div>
            <div id="lv-body" class="lv-body"></div>
        `;
        document.getElementById("app").appendChild(panel);

        // Wire events
        panel.querySelector("#lv-close").addEventListener("click", toggle);
        panel.querySelector("#lv-level").addEventListener("change", fetchAndRender);
        panel.querySelector("#lv-time").addEventListener("change", fetchAndRender);
        panel.querySelector("#lv-search").addEventListener("input", debounce(fetchAndRender, 300));
        panel.querySelector("#lv-copy").addEventListener("click", copyLogs);
    }

    let _lastLogs = [];

    async function fetchAndRender() {
        if (!visible) return;

        const level = document.getElementById("lv-level")?.value || "";
        const minutes = document.getElementById("lv-time")?.value || "15";
        const search = document.getElementById("lv-search")?.value || "";

        const params = new URLSearchParams({ minutes, limit: "300" });
        if (level) params.set("level", level);
        if (search) params.set("search", search);

        try {
            const resp = await fetch(`/api/logs?${params}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            _lastLogs = data.logs || [];
            renderLogs(_lastLogs);
        } catch (e) {
            const body = document.getElementById("lv-body");
            if (body) body.innerHTML = `<div class="lv-error">Failed to fetch logs: ${e.message}</div>`;
        }
    }

    function renderLogs(logs) {
        const body = document.getElementById("lv-body");
        if (!body) return;

        if (logs.length === 0) {
            body.innerHTML = '<div class="lv-empty">No logs matching filters</div>';
            return;
        }

        const html = logs.map(entry => {
            const ts = entry.ts ? entry.ts.split("T")[1]?.split(".")[0] || entry.ts : "—";
            const lvl = entry.level || "—";
            const mod = (entry.module || "—").replace("st.", "");
            const evt = entry.event || "—";
            const msg = entry.message || "";
            const rid = entry.request_id && entry.request_id !== "-" ? entry.request_id : "";
            const lvlClass = lvl === "ERROR" ? "lv-err" : lvl === "WARNING" ? "lv-warn" : lvl === "DEBUG" ? "lv-dbg" : "lv-info";

            let extraStr = "";
            if (entry.extra && Object.keys(entry.extra).length > 0) {
                extraStr = Object.entries(entry.extra).map(([k, v]) => `${k}=${v}`).join(" ");
            }

            return `<div class="lv-row ${lvlClass}">
                <span class="lv-ts">${esc(ts)}</span>
                <span class="lv-lvl">${esc(lvl.slice(0, 4))}</span>
                <span class="lv-mod">${esc(mod)}</span>
                ${rid ? `<span class="lv-rid">${esc(rid)}</span>` : ""}
                <span class="lv-evt">${esc(evt)}</span>
                ${extraStr ? `<span class="lv-extra">${esc(extraStr)}</span>` : ""}
            </div>`;
        }).join("");

        body.innerHTML = html;
    }

    function copyLogs() {
        if (!_lastLogs.length) return;
        const text = _lastLogs.map(e => JSON.stringify(e)).join("\n");
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById("lv-copy");
            if (btn) { btn.textContent = "Copied!"; setTimeout(() => btn.textContent = "Copy", 1500); }
        }).catch(() => {});
    }

    function debounce(fn, ms) {
        let t;
        return function () { clearTimeout(t); t = setTimeout(fn, ms); };
    }

    function esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init, toggle };
})();
