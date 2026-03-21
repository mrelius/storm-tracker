# Storm Tracker — Phase Legend

All completed development phases in chronological order.

---

## Phase 1–4: Foundation
**Title:** Detection engine + frontend
**What changed:** Built the core app — FastAPI backend, SQLite database, Redis cache, Leaflet.js map, NWS alert ingestion (60s polling), county boundaries, radar tile layers (Reflectivity via RainViewer, SRV via IEM), alert polygon rendering, zone geometry fetch, service worker for offline support.
**Why it matters:** This is the entire base system. Without it, nothing else works.
**What the user notices:** Map with radar overlays, NWS alert list in side panel, county coloring by severity, alert detail view.
**Controls:** REF/SRV/CC radar toggle buttons, radar site selector, NWS alert sort/filter controls, alert panel toggle.
**Tag:** `backend` `frontend` `radar-map` `alerts-notifications`

## Phase 5: Background Polling + History
**Title:** Background polling + alert history
**What changed:** Added a background loop that runs the detection engine every 60 seconds automatically. Added a bounded alert history (last 100 lifecycle events).
**Why it matters:** Alerts update without manual refresh. History allows reviewing what happened.
**What the user notices:** Alerts appear and update automatically.
**Tag:** `backend` `alerts-notifications`

## Phase 6: WebSocket Push
**Title:** Real-time WebSocket push
**What changed:** Added WebSocket connection so the browser receives alert updates instantly instead of waiting for the next poll cycle.
**Why it matters:** Critical alerts reach the user in seconds, not minutes.
**What the user notices:** Live updates indicator (dot next to "Storm Alerts" header). Alerts appear immediately when detected.
**Tag:** `backend` `frontend`

## Phase 7: Audio Notifications
**Title:** Alert sound
**What changed:** Added an audio tone (880 Hz, 0.4s) that plays when a severity 3+ storm alert is created or escalated.
**Why it matters:** Gets attention even when the user isn't looking at the screen.
**What the user notices:** Bell icon toggle in the Storm Alerts header. Sound plays for tornado warnings and severe storms.
**Controls:** Sound toggle button (bell icon).
**Tag:** `frontend` `alerts-notifications`

## Phase 8: Browser Notifications
**Title:** Browser push notifications
**What changed:** Added browser notification support for critical alerts. Requires user opt-in.
**Why it matters:** Alerts reach the user even when the tab is in the background.
**What the user notices:** Notification toggle button next to sound toggle. Browser permission prompt on first enable.
**Controls:** Notification toggle button.
**Tag:** `frontend` `alerts-notifications`

## Phase 9–10: Per-Client Location + Detection
**Title:** Client-relative detection
**What changed:** Each browser client can share its GPS location. The detection engine evaluates storm threats relative to the user's actual position, not just the default server location.
**Why it matters:** Distance, direction, ETA, and threat assessment are accurate to where you actually are.
**What the user notices:** "Your location" vs "Default location" indicator. Distance/direction values match their real position.
**Tag:** `backend` `frontend` `data`

## Phase 11: Storm Tracking
**Title:** Storm persistence + motion tracking
**What changed:** Added a storm tracker that maintains storm identity across detection cycles. Computes speed, heading, and motion vectors from position history.
**Why it matters:** Storms are tracked over time instead of appearing as disconnected snapshots. Enables ETA computation.
**What the user notices:** Speed and heading shown on alert cards. Storms maintain consistent identity.
**Tag:** `backend` `data`

## Phase 12: Confidence Model
**Title:** Confidence + signal quality
**What changed:** Added track confidence (based on tracking maturity) and motion confidence (based on speed/heading stability). These gate ETA and other derived signals.
**Why it matters:** The system doesn't show uncertain predictions as if they were certain.
**What the user notices:** Confidence level shown on cards (High, Medium). Low-confidence alerts appear with reduced visual weight and "DEVELOPING" badge.
**Tag:** `backend` `UX`

## Phase 13–15: UI Truthfulness + Prioritization + Schema
**Title:** Truthful UI, threat ranking, canonical schema
**What changed:** ETA stabilization (frontend smoothing to prevent jitter), threat prioritization with composite scoring, canonical alert data schema with all fields explicit.
**Why it matters:** Alerts are ranked by real threat level, not just arrival order. UI doesn't show misleading precision.
**What the user notices:** Most important storm shown first. ETA doesn't jump around. Consistent card layout.
**Tag:** `backend` `frontend` `UX`

## Phase 16–20: Motion, Prediction, Impact
**Title:** Motion display, intensity trends, smoothing, impact prediction, storm footprint
**What changed:** Added direction/speed display, intensity trend detection (strengthening/weakening), motion smoothing for stability, closest-point-of-approach (CPA) prediction, storm radius estimation, impact classification (direct hit / near miss / passing).
**Why it matters:** The user understands not just where the storm is, but where it's going and whether it will affect them.
**What the user notices:** Impact descriptions on cards ("on track to impact your area in ~24 min"), direction from compass, speed in mph, "Strengthening" / "Weakening" labels.
**Tag:** `backend` `frontend` `data`

## Phase 21–22: Geographic Context + Noise Reduction
**Title:** Geographic language + alert filtering
**What changed:** Added human-readable geographic descriptions in impact messages. Added alert filtering to suppress low-value alerts when high-value ones exist (max 5 alerts shown).
**Why it matters:** Reduces alert fatigue. Messages read naturally instead of showing raw numbers.
**What the user notices:** Cleaner alert list. Impact descriptions use natural language ("from the southwest").
**Tag:** `backend` `UX`

## Phase 23: Simulation System
**Title:** Simulation mode + debug overlay
**What changed:** Added synthetic storm injection for testing. Added debug overlay (D key) showing internal scores and state.
**Why it matters:** Allows testing the full detection pipeline without waiting for real severe weather.
**What the user notices:** Nothing in production — simulation controls removed from production UI. Debug overlay still available via D key.
**Controls:** D key toggles debug overlay (hidden by default).
**Tag:** `admin-dev-only`

## Phase 24: Trust + UX Stability
**Title:** Trust and UX stability layer
**What changed:** Stabilized ETA display, refined confidence tiers, improved card rendering consistency.
**Why it matters:** Reduces visual noise and prevents the UI from feeling jittery.
**What the user notices:** Smoother updates, less flickering, more consistent card appearance.
**Tag:** `frontend` `UX`

## Phase 25: ETA Activation
**Title:** Predictive trust — ETA computation
**What changed:** Fixed ETA computation to activate when storms are clearly closing. Fixed trend detection sensitivity, pipeline cooldown during simulation, tracker position accumulation.
**Why it matters:** ETA now appears when the system has enough data to compute it reliably.
**What the user notices:** "ETA ~24m" appears on cards for approaching storms with sufficient tracking confidence.
**Tag:** `backend` `data`

## Phase 26: Decision Layer
**Title:** Action state ("Should I act?")
**What changed:** Added action_state (Monitor / Be ready / Take action) derived from threat type, impact, severity, distance, ETA, confidence, and trend. Confidence guard prevents low-confidence alerts from escalating to "Take action" (except debris).
**Why it matters:** Answers the most important user question at a glance: "Do I need to do something right now?"
**What the user notices:** Action pill on alert cards: "Be ready" (amber) or "Take action" (red). No pill shown for "Monitoring" (default state).
**Tag:** `backend` `frontend` `UX`

## Phase 27: Lifecycle Clarity
**Title:** Alert lifecycle states
**What changed:** Added lifecycle tracking (forming → active → weakening → expired). Anti-oscillation prevents rapid state flipping. Expired alerts briefly display before disappearing.
**Why it matters:** Users understand why an alert appeared, changed, or disappeared.
**What the user notices:** "DEVELOPING" badge on new uncertain alerts. "WEAKENING" badge when storms fade. Brief "EXPIRED" card before removal.
**Tag:** `backend` `frontend` `UX`

## Phase 28: Multi-Storm Prioritization
**Title:** Primary storm explanation
**What changed:** Added primary_reason explaining why the top storm ranks first ("Debris detected", "Direct path", "Closest threat", "Approaching"). Added secondary_context for non-primary storms ("Farther away", "Weaker", "Not approaching").
**Why it matters:** When multiple storms exist, the user instantly understands which matters most and why.
**What the user notices:** Short reason line on the primary card. Italic context on secondary cards. Anti-thrash hysteresis prevents the primary storm from flip-flopping.
**Tag:** `backend` `frontend` `UX`

## Phase 29: Trust Calibration
**Title:** Confidence UX
**What changed:** Added confidence_reason phrases ("Limited data", "Motion uncertain", "Tracking stable", "Multiple confirmations"). Suppressed ETA when confidence is low. Debris cards show "Debris confirmed" instead of "Low confidence".
**Why it matters:** Users understand why the system is certain or uncertain, and can calibrate their trust accordingly.
**What the user notices:** Confidence labels with short explanations in the card meta line. No ETA shown when data is insufficient.
**Tag:** `frontend` `UX`

## Phase 30–32: UX Polish + Trust Gap Corrections
**Title:** Visual polish and message clarity
**What changed:** Split meta into primary (action/distance/ETA) and secondary (motion/confidence) lines. Removed "Monitoring" pill (noise reduction). Fixed "Trajectory uncertain" as default message — now shows actual detection text. Removed ETA duplication between message and meta. Debris confidence reframing.
**Why it matters:** Cards are faster to read, clearer under stress, and never lead with what's unknown.
**What the user notices:** Cleaner card layout. Messages say what was detected, not "trajectory uncertain". ETA appears in only one place.
**Tag:** `frontend` `UX`

## Phase 33: Notification Intelligence
**Title:** Smart notification triggers
**What changed:** Built a notification engine that decides WHEN to notify based on action_state, confidence, priority ranking, and event type. Per-alert cooldown (5 min), escalation bypass, debris bypass, ETA critical crossing (<10 min), quiet hours support. Backend is single source of truth — frontend only displays approved notifications.
**Why it matters:** Eliminates alert fatigue. Only meaningful events trigger notifications.
**What the user notices:** Fewer, more relevant notifications. Critical events always get through. Repeated minor updates don't spam.
**Controls:** Quiet hours configurable via environment variables (disabled by default).
**Tag:** `backend` `alerts-notifications`

## Feedback Feature
**Title:** User feedback box
**What changed:** Added in-app feedback submission (FB button in header). Categories: idea, bug, improvement, confusing, other. Server-side SQLite storage. Admin review page at /feedback with status management and filtering.
**Why it matters:** Users can report issues and suggest improvements directly from the app.
**What the user notices:** FB button in top-right header. Modal opens with category dropdown and text area.
**Controls:** FB button, category selector, submit button.
**Tag:** `frontend` `backend` `admin-dev-only`

## Final Phase: Production Cleanup
**Title:** Header minimize, simulator removal, release prep
**What changed:** Added collapsible header (minimize button hides entire top bar, floating restore button to bring it back). Removed all simulation controls from production UI. Disabled simulation endpoints by default (DEBUG_MODE=false). Bumped service worker cache. Cleaned git repo. Pushed to GitHub.
**Why it matters:** Clean production state. Maximum map visibility. No debug clutter.
**What the user notices:** Up-arrow button in header minimizes it entirely. Small "Header" button in top-left corner restores it. No simulation controls visible.
**Controls:** Header minimize/restore buttons. State persists across page refreshes.
**Tag:** `frontend` `UX` `admin-dev-only`
