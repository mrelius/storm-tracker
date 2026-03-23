/**
 * Storm Tracker — Guidance Card
 *
 * Displays prioritized situational guidance from the guidance engine.
 * Polls /api/guidance every 20 seconds. Shows headline + key messages
 * with color-coded priority. Suppressed when no relevant signals.
 */
const GuidanceCard = (function () {

    const POLL_MS = 20000;
    let pollTimer = null;

    function init() {
        pollTimer = setInterval(fetchGuidance, POLL_MS);
        fetchGuidance();
    }

    async function fetchGuidance() {
        const loc = StormState.state.location;
        const lat = loc.lat || 39.5;
        const lon = loc.lon || -84.5;

        try {
            const resp = await fetch(`/api/guidance?lat=${lat}&lon=${lon}`);
            if (!resp.ok) return;
            const data = await resp.json();
            render(data.guidance);
        } catch (e) { /* silent */ }
    }

    function render(g) {
        const card = document.getElementById("guidance-card");
        if (!card) return;

        if (!g || g.suppressed || g.priority === "none") {
            card.classList.add("hidden");
            return;
        }

        card.classList.remove("hidden");

        const priorityClass = {
            critical: "guid-critical",
            high: "guid-high",
            elevated: "guid-elevated",
            low: "guid-low",
        }[g.priority] || "guid-low";

        const borderColor = {
            critical: "#ef4444",
            high: "#f59e0b",
            elevated: "#3b82f6",
            low: "#64748b",
        }[g.priority] || "#64748b";

        const msgs = (g.messages || []).slice(0, 2).map(m =>
            `<div class="guid-msg">${esc(m)}</div>`
        ).join("");

        card.innerHTML = `
            <div class="guid-header" style="border-left-color:${borderColor}">
                <span class="guid-priority ${priorityClass}">${g.priority.toUpperCase()}</span>
                <span class="guid-headline">${esc(g.headline)}</span>
            </div>
            ${msgs ? `<div class="guid-body">${msgs}</div>` : ""}
        `;
    }

    function esc(s) {
        if (!s) return "";
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    return { init };
})();
