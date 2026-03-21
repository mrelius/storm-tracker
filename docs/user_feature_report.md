# Storm Tracker — User Feature Report

Complete inventory of all production features, grouped by functional area.

---

## Map / Radar

### Radar Reflectivity (REF)
- **What it does:** Shows precipitation intensity across the region as a color overlay on the map. Animated with up to 13 frames showing recent radar sweeps.
- **Where to find it:** REF button in the bottom-left radar controls bar.
- **When it appears:** Always available. Active by default on first load.
- **What you can do:** Toggle on/off. When active, use the play/pause button and scrubber to animate through recent frames. Adjust animation speed with the speed slider.
- **Automatic or manual:** Manual toggle. Animation plays automatically when started.

### Storm Relative Velocity (SRV)
- **What it does:** Shows wind speed and direction relative to the radar. Green = toward radar, Red = away from radar. Strong adjacent green/red indicates rotation (possible tornado).
- **Where to find it:** SRV button in the bottom-left radar controls bar.
- **When it appears:** Available when a NEXRAD radar site is selected.
- **What you can do:** Toggle on/off. Overlays on top of reflectivity. Single frame (no animation). A velocity legend appears showing the -64 to +64 knot scale.
- **Automatic or manual:** Manual toggle.

### Correlation Coefficient (CC)
- **What it does:** Shows how uniform precipitation is. Low CC (<0.80) indicates non-meteorological targets like debris — a strong tornado indicator.
- **Where to find it:** CC button in the bottom-left radar controls bar.
- **When it appears:** Requires SRV to be active (they share the same radar site). Depends on CC pipeline availability (LXC 121).
- **What you can do:** Toggle on/off. A CC legend appears showing the 0.2–1.0 scale with debris/hail/normal bands.
- **Automatic or manual:** Manual toggle.

### Radar Site Selector
- **What it does:** Selects which NEXRAD radar station provides SRV and CC data.
- **Where to find it:** Dropdown in the bottom-left radar controls bar.
- **When it appears:** Always visible.
- **What you can do:** Select "Auto (nearest)" for automatic selection, or manually choose a specific radar site.
- **Automatic or manual:** Default is automatic. Manual override available.

### Map Interaction
- **What it does:** Leaflet.js interactive map with zoom, pan, and click-to-inspect.
- **Where to find it:** Full screen behind all overlays.
- **What you can do:** Zoom with scroll/pinch. Pan by dragging. Click storm alert cards to center the map on that storm's location.
- **Automatic or manual:** Manual interaction.

---

## Alerts

### NWS Alert List
- **What it does:** Shows all active National Weather Service alerts for the region, fetched every 60 seconds.
- **Where to find it:** Lower section of the right-side alert panel, under "NWS Alerts."
- **When it appears:** Always visible when the alert panel is open.
- **What you can do:** Sort by severity, distance, issued time, or expiration. Filter by category (Primary/Secondary), warnings only, or marine alerts. Click any alert to see full details including headline, description, and instructions.
- **Automatic or manual:** Automatic fetch. Manual sorting/filtering.

### Alert Polygons on Map
- **What it does:** Draws NWS alert boundaries on the map as colored polygons. Counties are filled by severity level.
- **Where to find it:** Overlaid on the map automatically.
- **When it appears:** Whenever NWS alerts exist for visible areas.
- **What you can do:** Visual reference only. Colors indicate severity (red = tornado warning, orange = severe thunderstorm warning, yellow = watch).
- **Automatic or manual:** Automatic.

### Staleness Warning
- **What it does:** Shows a banner when alert data hasn't been refreshed recently.
- **Where to find it:** Top of the screen, below the header.
- **When it appears:** Amber warning after 2 minutes without update. Red warning after 5 minutes. Red "OFFLINE" banner if the server is unreachable.
- **What you can do:** Check your connection. The system will recover automatically when connectivity is restored.
- **Automatic or manual:** Automatic.

---

## Storm Intelligence

### Storm Alert Cards
- **What it does:** Shows detected storm threats as prioritized cards. Each card contains the alert title, impact description, action guidance, distance, ETA, confidence, motion, and lifecycle state.
- **Where to find it:** Top section of the right-side alert panel, under "Storm Alerts."
- **When it appears:** When the detection engine identifies storms meeting threat criteria relative to your location.
- **What you can do:** Read the situation at a glance. Click a card to center the map on that storm.
- **Automatic or manual:** Automatic detection and display.

### Action State
- **What it does:** Tells you what to do right now. Three levels: Monitoring (no pill shown — default), Be ready (amber pill), Take action (red pill).
- **Where to find it:** First element in the card's primary meta line.
- **When it appears:** "Be ready" appears for credible approaching threats. "Take action" appears for confirmed dangerous situations (debris signature, severe direct hit at high confidence, very close and closing).
- **What you can do:** Use it to decide whether to continue normal activity, prepare shelter access, or take shelter immediately.
- **Automatic or manual:** Automatic. Derived from threat type, confidence, impact, distance, trend, and ETA.

### Lifecycle State
- **What it does:** Shows where the alert is in its life: DEVELOPING (just detected, building confidence), no badge (active and tracking normally), WEAKENING (storm fading or moving away), EXPIRED (briefly shown when alert is removed).
- **Where to find it:** Badge in the top-right corner of each alert card.
- **When it appears:** DEVELOPING for new low-confidence detections. WEAKENING when intensity drops or storm departs. EXPIRED briefly before removal.
- **What you can do:** Understand whether a threat is growing or fading.
- **Automatic or manual:** Automatic.

### Threat Ranking
- **What it does:** Orders storm alerts by composite threat score. The top storm gets a "PRIMARY" badge and a short reason explaining why it ranks first.
- **Where to find it:** Primary card has a blue border and reason line (e.g., "Direct path", "Closest threat"). Secondary cards show context (e.g., "Farther away", "Weaker").
- **When it appears:** When multiple storm alerts exist.
- **What you can do:** Focus attention on the primary threat. Use secondary context to understand relative risk.
- **Automatic or manual:** Automatic. Anti-thrash: primary only changes when a challenger clearly exceeds it by 5+ points.

### Confidence Display
- **What it does:** Shows how reliable the alert data is: High, Medium, or (for low confidence) indicated by DEVELOPING badge and reduced card opacity.
- **Where to find it:** Secondary meta line on each card, with a reason phrase.
- **When it appears:** "High · Multiple confirmations" when tracking is stable with ETA. "Medium · Motion uncertain" when tracking is established but motion data is limited. Low confidence hides the label and shows DEVELOPING badge instead.
- **What you can do:** Calibrate trust. High confidence + "Be ready" = act on it. Low confidence = monitor, don't overreact.
- **Automatic or manual:** Automatic.

---

## ETA / Motion / Impact

### ETA (Estimated Time of Arrival)
- **What it does:** Shows approximately how many minutes until the storm reaches your location.
- **Where to find it:** Primary meta line on alert cards (e.g., "ETA ~24m"). Also embedded in the impact description message when available.
- **When it appears:** Only when confidence is medium or higher AND the storm is closing AND speed is sufficient. Never shown at low confidence.
- **What you can do:** Use it to gauge urgency. ETA is approximate (uses "~" prefix). Changes are smoothed to avoid jitter — small variations (< 2 minutes) are held steady.
- **Automatic or manual:** Automatic.

### Direction and Speed
- **What it does:** Shows where the storm is relative to you (compass direction) and how fast it's moving.
- **Where to find it:** Secondary meta line on alert cards (e.g., "SW 63 mph").
- **When it appears:** When the storm has enough tracking history to compute motion.
- **What you can do:** Understand approach direction. "Approaching from SW at 63 mph" means the storm is southwest of you and heading your way.
- **Automatic or manual:** Automatic.

### Impact Classification
- **What it does:** Predicts whether the storm will hit your location directly, pass nearby, or miss. Uses closest-point-of-approach (CPA) vector math and storm footprint estimation.
- **Where to find it:** Shown in the card's main message (e.g., "Strong storm from the southwest, on track to impact your area in ~24 min").
- **When it appears:** When the system has enough tracking data and motion confidence to project trajectory.
- **What you can do:** Direct hit = prepare now. Near miss = be aware. Passing = low concern.
- **Automatic or manual:** Automatic.

---

## History / Timeline

### Alert History
- **What it does:** Records lifecycle events (created, escalated, expired) for the last 100 alerts. Available via API.
- **Where to find it:** API endpoint `/api/storm-alerts/history`.
- **When it appears:** Continuously recorded in the background.
- **What you can do:** Review what storms were detected and when. Useful for post-event analysis.
- **Automatic or manual:** Automatic recording. Manual review via API.

---

## Settings / Controls

### Header Minimize
- **What it does:** Hides the entire top header bar to maximize map space.
- **Where to find it:** Up-arrow button (▲) in the top-right of the header.
- **When it appears:** Always available.
- **What you can do:** Click to minimize. A small "▼ Header" button appears in the top-left corner to restore it. State persists across page refreshes.
- **Automatic or manual:** Manual toggle. Persists in browser storage.

### Alert Panel Toggle
- **What it does:** Opens/closes the right-side alert panel.
- **Where to find it:** Hamburger button (☰) in the top-right of the header.
- **When it appears:** Always available.
- **What you can do:** Toggle to show or hide the entire alert panel.
- **Automatic or manual:** Manual toggle.

### Sound Toggle
- **What it does:** Enables/disables the audio alert tone for severity 3+ events.
- **Where to find it:** Bell icon in the Storm Alerts section header.
- **When it appears:** Always visible when alert panel is open.
- **What you can do:** Click to toggle. Enabled by default.
- **Automatic or manual:** Manual toggle. Persists in browser storage.

### Notification Toggle
- **What it does:** Enables/disables browser push notifications for critical alerts.
- **Where to find it:** Speaker icon next to the sound toggle.
- **When it appears:** Always visible when alert panel is open.
- **What you can do:** Click to enable (prompts for browser permission on first use). Disabled by default (requires explicit opt-in).
- **Automatic or manual:** Manual toggle. Persists in browser storage.

### Debug Overlay
- **What it does:** Shows internal scoring, ranking, lifecycle, action state, confidence, and tracking data on each alert card.
- **Where to find it:** Press the D key on your keyboard.
- **When it appears:** Only when manually activated. Hidden by default.
- **What you can do:** Inspect threat_score, rank_position, impact, confidence details, lifecycle signal, action trigger, ETA, distance, trend for each alert.
- **Automatic or manual:** Manual (D key toggle).

---

## Mobile Behavior

### Responsive Layout
- **What it does:** Adapts to narrow screens. The header center section hides automatically on small screens. The alert panel takes full width on mobile.
- **Where to find it:** Automatic based on screen width.
- **When it appears:** Screens narrower than approximately 600px.
- **What you can do:** All controls remain accessible. Use the panel toggle to switch between map and alerts.
- **Automatic or manual:** Automatic.

### Touch Interaction
- **What it does:** Map supports touch gestures (pinch to zoom, drag to pan). Alert cards are tap targets.
- **Where to find it:** Map and alert panel.
- **What you can do:** Tap alert cards to center map. Pinch/zoom the map. All buttons are touch-friendly.
- **Automatic or manual:** Manual interaction.

---

## Notification Behavior

### When Notifications Fire
- **New significant alert:** When a new storm alert enters the system with action state "Be ready" or higher.
- **Escalation:** When an alert's action state increases (e.g., Monitor → Be ready → Take action). Bypasses cooldown.
- **Debris detection:** Always notifies, bypassing confidence and primary-only filters.
- **ETA critical:** When ETA drops below 10 minutes for the first time.
- **Resolution:** Optional notification when a previously active alert expires.

### When Notifications Don't Fire
- **Low confidence:** Suppressed unless debris is detected.
- **Secondary storms:** Only the top-ranked storm triggers notifications (unless a secondary has debris).
- **Repeated updates:** 5-minute cooldown per alert prevents duplicate notifications.
- **ETA changes:** Normal ETA fluctuations never trigger notifications.
- **Quiet hours:** If configured, "Be ready" alerts are suppressed during quiet hours. "Take action" and debris always get through.

### Audio vs Browser Notifications
- **Audio:** 880 Hz tone, 0.4 seconds. Plays for severity 3+ events. 15-second global cooldown.
- **Browser:** Shows a system notification with alert title and impact description. Requires user opt-in and browser permission. Uses backend-approved payloads only — no separate frontend decision logic.

---

## Feedback / Wishlist

### Feedback Submission
- **What it does:** Lets you submit ideas, bug reports, improvement suggestions, or notes about confusing behavior directly from the app.
- **Where to find it:** FB button in the top-right of the header bar.
- **When it appears:** Always available.
- **What you can do:** Click FB to open the feedback modal. Select a category (Idea, Bug, Improvement, Confusing, Other). Type your message (up to 2000 characters). Click Send. A confirmation appears and the modal closes automatically.
- **Automatic or manual:** Manual submission.

### Feedback Review (Admin)
- **What it does:** Lists all submitted feedback with filtering by status and category, and the ability to update status and add planning notes.
- **Where to find it:** Navigate to `/feedback` in your browser.
- **When it appears:** Always accessible.
- **What you can do:** Filter by status (New, Reviewed, Planned, Done, Dismissed). Filter by category. Change status inline. Add notes for planning context.
- **Automatic or manual:** Manual review.
