/**
 * Storm Tracker — Feedback Module
 * Simple feedback submission + admin review.
 */
const Feedback = (function () {
    let modal = null;
    let submitBtn = null;
    let lastSubmitTime = 0;
    const SUBMIT_COOLDOWN_MS = 10000;

    function init() {
        const openBtn = document.getElementById("btn-feedback");
        if (openBtn) openBtn.addEventListener("click", openModal);
    }

    function openModal() {
        if (modal) { modal.remove(); modal = null; return; }

        modal = document.createElement("div");
        modal.id = "feedback-modal";
        modal.innerHTML = `
            <div class="fb-backdrop" onclick="Feedback.close()"></div>
            <div class="fb-panel">
                <div class="fb-header">
                    <span>Send Feedback</span>
                    <button class="fb-close" onclick="Feedback.close()">&times;</button>
                </div>
                <div class="fb-body">
                    <select id="fb-category" class="fb-select">
                        <option value="idea">Idea</option>
                        <option value="bug">Bug</option>
                        <option value="improvement">Improvement</option>
                        <option value="confusion">Confusing</option>
                        <option value="other">Other</option>
                    </select>
                    <textarea id="fb-message" class="fb-textarea" placeholder="What's on your mind?" rows="4" maxlength="2000"></textarea>
                    <div class="fb-footer">
                        <span id="fb-status" class="fb-status"></span>
                        <button id="fb-submit" class="fb-submit" onclick="Feedback.submit()">Send</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        setTimeout(() => document.getElementById("fb-message").focus(), 50);
    }

    function close() {
        if (modal) { modal.remove(); modal = null; }
    }

    async function submit() {
        const msgEl = document.getElementById("fb-message");
        const catEl = document.getElementById("fb-category");
        const statusEl = document.getElementById("fb-status");
        const btn = document.getElementById("fb-submit");
        if (!msgEl || !btn) return;

        const message = msgEl.value.trim();
        if (!message) {
            statusEl.textContent = "Please enter a message";
            statusEl.className = "fb-status fb-error";
            return;
        }

        // Client-side cooldown
        const now = Date.now();
        if (now - lastSubmitTime < SUBMIT_COOLDOWN_MS) {
            statusEl.textContent = "Please wait before submitting again";
            statusEl.className = "fb-status fb-error";
            return;
        }

        btn.disabled = true;
        statusEl.textContent = "Sending...";
        statusEl.className = "fb-status";

        try {
            const resp = await fetch("/api/feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: message,
                    category: catEl.value,
                    page_context: window.location.pathname,
                }),
            });

            if (resp.ok) {
                lastSubmitTime = Date.now();
                statusEl.textContent = "Sent! Thank you.";
                statusEl.className = "fb-status fb-success";
                msgEl.value = "";
                setTimeout(close, 1500);
            } else if (resp.status === 429) {
                statusEl.textContent = "Too fast — please wait";
                statusEl.className = "fb-status fb-error";
            } else {
                statusEl.textContent = "Failed to send — try again";
                statusEl.className = "fb-status fb-error";
            }
        } catch (e) {
            statusEl.textContent = "Network error — try again";
            statusEl.className = "fb-status fb-error";
        } finally {
            btn.disabled = false;
        }
    }

    return { init, close, submit };
})();
