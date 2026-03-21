# Storm Tracker — User Manual

A non-technical guide to using Storm Tracker for severe weather awareness and decision-making.

---

## Getting Started

### What is Storm Tracker?
Storm Tracker is a real-time severe weather monitoring system focused on tornado awareness and fast situational decision-making. It shows radar imagery, NWS alerts, and storm threat analysis on an interactive map.

### First Load
When you open Storm Tracker, you'll see:
- A dark map centered on the Ohio Valley region (default location)
- Radar reflectivity overlay showing current precipitation
- An alert panel on the right side showing any active severe weather
- A header bar with status information at the top

The system immediately begins fetching NWS alerts and will update every 60 seconds automatically.

### Sharing Your Location
Storm Tracker works best when it knows your location. Your browser may prompt you to share your location — accepting this allows the system to calculate distances, ETAs, and threat assessments relative to where you actually are.

If you don't share your location, the system uses a default reference point (Ohio Valley, 39.5°N, 84.5°W). The indicator below the Storm Alerts header shows "Your location" or "Default location."

---

## How to Read the Radar / Map

### Reflectivity (REF)
The main radar overlay. Colors show precipitation intensity:
- **Green:** Light rain
- **Yellow/Orange:** Moderate to heavy rain
- **Red:** Very heavy rain or hail
- **Purple/White:** Extreme precipitation — possible severe storms

Use the animation controls (play button, scrubber, speed slider) in the bottom-left to see how storms have moved over the last hour.

### Storm Relative Velocity (SRV)
Toggle SRV with the SRV button. This shows wind motion relative to the radar:
- **Green:** Wind blowing toward the radar
- **Red:** Wind blowing away from the radar
- **Strong green next to strong red:** Rotation — possible tornado

A velocity legend appears showing the scale from -64 to +64 knots.

### Correlation Coefficient (CC)
Toggle CC with the CC button (requires SRV active). This shows how uniform the precipitation is:
- **Purple/Blue (< 0.80):** Non-uniform targets — could be debris from a tornado
- **Yellow/Orange (0.80–0.90):** Mixed precipitation, possibly hail
- **Green (> 0.95):** Normal precipitation

A CC legend appears showing these bands. Low CC combined with high reflectivity and rotation is the strongest indicator of a tornado.

### Radar Site
The radar site selector (dropdown in the bottom-left) controls which NEXRAD radar station provides SRV and CC data. "Auto (nearest)" selects the closest station to your location. You can manually switch if you want data from a different station.

---

## How to Read Alerts and Threat Cards

### NWS Alert List
The lower section of the alert panel shows raw NWS alerts. These are official government-issued warnings, watches, and statements. You can:
- **Sort** by severity, distance, issue time, or expiration
- **Filter** by Primary (tornado/severe), Secondary (flood/winter), Warnings only, or Marine
- **Click** any alert to read the full details including official instructions

### Storm Alert Cards
The upper section shows analyzed storm threats from the detection engine. These cards combine radar data, tracking, and prediction to give you actionable intelligence.

**Reading a card top to bottom:**

1. **Title + Badge:** What type of detection (Rotation Detected, Strong Storm Nearby, Potential Debris Signature) plus a lifecycle badge if applicable (DEVELOPING, WEAKENING, NEW, ESCALATED, PRIMARY).

2. **Impact Message:** A natural-language description of the situation. Examples:
   - "Rotation detected in a nearby storm from the SW, 12 mi."
   - "Strong storm from the southwest, on track to impact your area in ~24 min"

3. **Primary Reason** (top storm only): Why this storm ranks first — "Direct path", "Closest threat", "Debris detected", "Approaching."

4. **Secondary Context** (other storms): Why this storm ranks lower — "Farther away", "Weaker", "Not approaching."

5. **Primary Meta Line:** The most important numbers:
   - **Action pill:** "Be ready" (amber) or "Take action" (red). If neither appears, the system is monitoring — no action needed yet.
   - **Distance:** How far the storm is from you in miles.
   - **ETA:** Estimated time of arrival (e.g., "ETA ~24m"). Only shown when the system has enough confidence in the prediction.

6. **Secondary Meta Line:** Supporting context:
   - **Motion:** Direction and speed (e.g., "SW 63 mph") or motion trend ("Approaching", "Moving away").
   - **Confidence:** How reliable the data is (e.g., "High · Multiple confirmations", "Medium · Motion uncertain"). For debris signatures, shows "Debris confirmed" instead.

7. **Freshness:** Only shown if data is older than 60 seconds. "Updated 2m ago" or "Data may be stale."

---

## Meaning of Colors, Legends, and Labels

### Card Border Colors (Left Edge)
- **Blue:** Severity 1 — informational / low concern
- **Yellow/Orange:** Severity 2 — moderate concern
- **Red:** Severity 3 — significant threat
- **Bold Red:** Severity 4 — extreme threat

### Card Visual Weight
- **Dashed border, slightly faded:** Low confidence — treat as developing, don't rely on predictions yet
- **Normal border:** Medium confidence
- **Thicker border:** High confidence
- **Blue highlight border + glow:** Primary (top-ranked) threat

### Lifecycle Badges
- **NEW:** Just detected this cycle
- **DEVELOPING:** Early detection, still building tracking history
- **ESCALATED:** Severity increased since last update
- **PRIMARY:** Highest-ranked threat when multiple storms exist
- **WEAKENING:** Storm intensity fading or moving away
- **EXPIRED:** Briefly shown when an alert is removed (then disappears)

### Action States
- **No pill shown:** Monitoring — the system is watching, no action needed from you
- **Be ready (amber):** Credible approaching threat — know where your shelter is, prepare to move
- **Take action (red):** Confirmed dangerous situation — move to shelter now

---

## How to Interpret ETA, Direction, Severity, and Confidence

### ETA
- Always shown with "~" (approximately) — never exact
- Rounded to whole minutes
- Only appears when confidence is medium or higher
- Small changes (< 2 minutes) are held steady to prevent jitter
- If ETA disappears, the storm may have changed course or confidence dropped
- ETA never appears for storms that aren't closing

### Direction
- Compass directions (N, NE, E, SE, S, SW, W, NW) indicate where the storm is relative to you
- "Approaching from SW" means the storm is to your southwest and heading toward you
- "Moving away" means the storm is departing — threat is decreasing

### Severity
- **1:** General awareness — storms in the region
- **2:** Notable storm — worth watching
- **3:** Severe threat — tornado warning or confirmed severe conditions
- **4:** Extreme — confirmed tornado indicators (debris signature)

### Confidence
- **Low (DEVELOPING badge):** Limited tracking data. Predictions may not be accurate. Don't act on ETA or trajectory yet.
- **Medium:** Reasonable tracking established. Predictions are credible but could shift.
- **High + "Multiple confirmations":** Stable tracking, consistent motion, ETA computed. High trust in the assessment.

**Key principle:** If confidence is low and action says "Monitoring," the system is being honest that it doesn't have enough data yet. Wait for confidence to build before making decisions based on ETA or impact predictions.

---

## Controls Reference

### Header Bar
| Control | Location | What it does |
|---------|----------|--------------|
| Minimize (▲) | Top-right | Hides the entire header to maximize map space |
| Restore (▼ Header) | Top-left (when minimized) | Brings the header back |
| FB | Top-right | Opens the feedback submission form |
| ☰ | Top-right | Toggles the alert panel open/closed |

### Radar Controls (Bottom-Left)
| Control | What it does |
|---------|--------------|
| REF | Toggle reflectivity radar overlay |
| SRV | Toggle storm relative velocity overlay |
| CC | Toggle correlation coefficient overlay (requires SRV) |
| Site dropdown | Select NEXRAD radar station |
| ▶ Play/Pause | Start/stop radar animation (REF only) |
| Scrubber slider | Jump to a specific animation frame |
| Speed slider | Adjust animation playback speed |

### Alert Panel
| Control | What it does |
|---------|--------------|
| Sort dropdown | Sort NWS alerts by severity/distance/time |
| ▼ Sort order | Toggle ascending/descending |
| All / Primary / Secondary | Filter alerts by category |
| Warnings | Show only tornado + severe thunderstorm warnings |
| Marine | Toggle marine alerts visibility |
| 🔔 Sound | Toggle audio alert tone |
| 🔇 Notify | Toggle browser push notifications |

### Keyboard
| Key | What it does |
|-----|--------------|
| D | Toggle debug overlay on alert cards (shows internal scores and states) |

---

## How Notifications Work

### Audio Alerts
When enabled (bell icon), a short tone plays for severity 3+ storm alerts. The tone only plays when a new alert is created or when an existing alert escalates. There is a 15-second cooldown between tones to prevent rapid-fire sounds.

### Browser Notifications
When enabled (speaker icon) and browser permission is granted, the system shows desktop/mobile notifications for significant events. The notification includes the alert title and action guidance.

Notifications are sent only when the backend approves them. The backend decides based on:
- Is this the top-ranked storm? (secondary storms usually don't notify)
- Is confidence sufficient? (low confidence suppresses notifications except for debris)
- Has enough time passed? (5-minute cooldown per alert)
- Is this an escalation? (escalations bypass cooldown)

You will NOT be notified for:
- Minor score changes
- ETA fluctuations
- Confidence adjustments
- Secondary storms (unless debris)
- Repeated identical alerts

---

## What to Do During Real Weather Events

### If you see "Monitoring" (no action pill):
- Remain aware of the situation
- Check back periodically
- Continue normal activity

### If you see "Be ready" (amber pill):
- Know where your safe room or shelter is
- Gather household members and pets
- Move shoes and a phone near your shelter location
- Monitor the situation — it may escalate or pass

### If you see "Take action" (red pill):
- Move to your designated shelter immediately
- Interior room, lowest floor, away from windows
- Cover your head and neck
- Stay sheltered until the threat passes

### If you see "WEAKENING" badge:
- The threat is decreasing — storm is fading or moving away
- Don't let your guard down completely until the alert expires
- Wait for the alert to disappear before resuming normal activity

### General Principles
- **Trust the action state** — it's derived from multiple real signals, not a single data point
- **Don't ignore low-confidence alerts** — they may develop rapidly
- **ETA is approximate** — use it for general urgency, not precise timing
- **Multiple storms** — focus on the primary (top) card but be aware of all active threats
- **Official sources** — Storm Tracker supplements, but does not replace, official NWS warnings. Always follow official instructions.

---

## Known Limitations

### Data Accuracy
- **Reflectivity values** are approximate when sampled from rendered map tiles (~3 dBZ accuracy)
- **SRV values** are approximate from rendered tiles (~5 knot accuracy)
- **CC values** are exact when sampled from the raw radar grid
- **ETA** is computed from tracked storm speed and distance — actual arrival depends on storm behavior changes
- **Storm position** is estimated from NWS alert polygon centroids, not precise storm-cell tracking

### System Behavior
- **Single radar site** for SRV and CC — only one NEXRAD station's coverage is visible at a time
- **SRV has no animation** — shows latest scan only (IEM limitation)
- **CC pipeline** depends on LXC 121 availability — may show "unavailable" if the pipeline is down
- **Alert delay** — NWS alerts are polled every 60 seconds, so there can be up to 60 seconds of delay from NWS publication to display
- **No SPC outlook overlays** — day 1–3 convective outlook maps are not included
- **No lightning data** — real-time lightning strikes are not displayed

### Confidence Boundaries
- Storm detection is based on NWS alerts + radar signals, not direct storm-cell tracking
- Motion vectors require multiple detection cycles to establish — brand new storms have no motion data
- Impact predictions (direct hit / near miss) assume the storm continues on its current path — storms can change direction
- Confidence can drop if tracking is lost (storm merges, splits, or radar coverage gaps)

---

## Glossary

| Term | Meaning |
|------|---------|
| **Reflectivity (REF)** | Radar measurement of precipitation intensity, shown in dBZ (decibels of reflectivity) |
| **SRV** | Storm Relative Velocity — wind speed and direction relative to the radar station |
| **CC** | Correlation Coefficient (RHOHV) — how uniform radar returns are; low values suggest debris or non-precipitation targets |
| **NWS** | National Weather Service — the official US government weather agency |
| **NEXRAD** | NEXt-generation RADar — the US national weather radar network |
| **ETA** | Estimated Time of Arrival — approximate minutes until a storm reaches your location |
| **CPA** | Closest Point of Approach — the nearest projected distance between the storm's path and your location |
| **dBZ** | Decibels of reflectivity — radar measurement unit; higher = more intense precipitation |
| **Knots (kt)** | Wind speed unit used in radar; 1 knot ≈ 1.15 mph |
| **Severity** | Internal threat level (1–4); 3+ = significant severe weather |
| **Confidence** | System's assessment of data reliability (Low / Medium / High) |
| **Action State** | System guidance on what to do (Monitor / Be ready / Take action) |
| **Lifecycle** | Where an alert is in its life (Forming → Active → Weakening → Expired) |
| **Primary Threat** | The top-ranked storm among all active threats |
| **Debris Signature** | Low CC + high reflectivity = likely tornado-lofted debris — strongest tornado indicator |
| **Hysteresis** | Anti-jitter mechanism — the primary storm doesn't change unless a challenger clearly exceeds it |
| **Cooldown** | Minimum time between repeated notifications for the same alert (5 minutes) |
| **Quiet Hours** | Configurable window during which only "Take action" and debris notifications are sent |
