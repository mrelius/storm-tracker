# Auto-Track — Live Severe Weather Verification Checklist

**Purpose**: Verify autotrack bridge matching, motion scoring, and projected path framing during the first real severe weather event with active detection engine storm alerts.

**When to use**: The first time Tornado Warnings or Severe Thunderstorm Warnings appear in the user's area and the detection engine produces storm alerts with motion vectors.

**Prerequisites**:
- Storm Tracker running on LXC 119
- Active NWS severe warnings (Tornado or SVR Thunderstorm)
- Detection engine producing storm alerts via `/api/storm-alerts`
- Debug panel open (Shift+Alt+D)
- Auto-track enabled (track or interrogate mode)

---

## Pre-Flight Checks

| Check | How to Verify | Status |
|---|---|---|
| Storm alerts present | Debug panel → BRIDGE section → `stormAlerts > 0` | |
| Storm alerts have nws_alert_id | `/api/storm-alerts?lat=X&lon=Y` → check first alert for `nws_alert_id` field | |
| Motion confidence gated | Storm alerts should have `motion_confidence ≥ 0.3` after ~4 minutes of tracking | |

---

## 1. Source-ID Matching (Tier 1)

**Goal**: Confirm that `nws_alert_id` exact matching is the primary match method.

| Check | Expected | Observed | Pass/Fail |
|---|---|---|---|
| BRIDGE section → `by method` shows `id:N` where N > 0 | Source-ID matches should dominate | | |
| SESSION section → `id matches` accumulates over time | Count should grow each eval cycle | | |
| Per-candidate → bridge line shows `source_id` in green | Method label is green, not amber | | |
| Per-candidate → `nws:…{id}` matches the NWS alert ID | IDs correspond to the tracked NWS alert | | |
| Per-candidate → `storm: {stormAlertId}` present | Shows the detection engine's internal alert ID | | |

**If source-ID matches are zero**: Check that the backend deployed correctly — `/api/storm-alerts` should return alerts with a non-empty `nws_alert_id` field. If the field is empty, the pipeline propagation may have regressed.

---

## 2. Centroid Fallback (Tier 2)

**Goal**: Confirm centroid fallback is rare and only used when source-ID is unavailable.

| Check | Expected | Observed | Pass/Fail |
|---|---|---|---|
| BRIDGE section → `ctr` count is low relative to `id` count | Centroid matches << source-ID matches | | |
| If centroid match occurs → `matchDistance` shown (e.g., `@ 12.3mi`) | Distance displayed in debug | | |
| Centroid matches only for alerts without `nws_alert_id` | E.g., legacy or simulator-generated alerts | | |

**If centroid matches dominate**: Possible regression — `nws_alert_id` may not be propagating. Check backend logs.

---

## 3. Ambiguity Rejection

**Goal**: Confirm no ambiguous centroid matches are accepted.

| Check | Expected | Observed | Pass/Fail |
|---|---|---|---|
| SESSION section → `ambig reject` shows count (may be 0) | Counter present and accurate | | |
| BRIDGE section → mismatches list shows `ambiguous:` entries | Only when 2 storm alerts are within 5mi of each other | | |
| No accepted centroid match where 2nd-best was < 5mi from best | Debug panel never shows an amber `centroid` match where multiple candidates were equidistant | | |

**Note**: Ambiguous rejections are expected when multiple NWS warnings share overlapping polygons (e.g., a Tornado Warning inside a broader SVR Thunderstorm Warning area). This is correct behavior.

---

## 4. Motion Scoring Activation

**Goal**: Confirm motion scoring uses real data from matched storm alerts.

| Check | Expected | Observed | Pass/Fail |
|---|---|---|---|
| Top candidate → `mot` factor shows score > 0 | Non-zero motion score when storm is closing | | |
| Top candidate → `mot` source shows `storm_alert` (not `unavailable`) | Source field indicates real data | | |
| Top candidate → motion detail shows trend + speed + confidence | e.g., `closing 45mph mc=0.72` | | |
| Closing storm scores higher than departing storm | Motion factor: closing=max, departing=0 | | |
| Motion score capped at 20 points | Even at max speed, motion ≤ 20 | | |
| Candidate with `hasMotion: false` → `mot: 0/20 (unavailable)` | NWS-only alerts score 0 for motion | | |

---

## 5. Projected Path Framing

**Goal**: Confirm map framing includes the projected storm position.

| Check | Expected | Observed | Pass/Fail |
|---|---|---|---|
| Top candidate shows `PATH` tag (amber) in debug panel | Projection data available | | |
| Map zooms out slightly to include projected position | Frame is wider than just the warning polygon | | |
| Amber dashed line visible from storm centroid to predicted position | Path arrow drawn on map | | |
| Arrowhead points in storm's direction of motion | Arrow tip at predicted position | | |
| `~10min` label visible at projected position | Time label at arrow endpoint | | |
| Path arrow disappears when mode switched to off | Clean removal of overlay | | |
| Path arrow updates when target switches | Old arrow removed, new arrow drawn | | |

**If no path appears**: Check that `predicted_lat`/`predicted_lon` are non-zero in the storm alert data. The detection engine needs ≥2 position updates (≥2 minutes) to compute a prediction.

---

## 6. Fallback Behavior (NWS-Only)

**Goal**: Confirm Phase 1 behavior is preserved for alerts without motion data.

| Check | Expected | Observed | Pass/Fail |
|---|---|---|---|
| NWS alerts without storm alert match score `mot: 0/20 (unavailable)` | Zero motion contribution | | |
| No path arrow for unmatched alerts | Only polygon framing | | |
| Scoring identical to Phase 1 for unmatched alerts | sev + cert + evt + dist + rec only | | |
| Mode switching, pausing, hysteresis all work normally | No regression | | |

---

## Session Summary

| Metric | Value |
|---|---|
| Session duration | |
| Total evals | |
| Source-ID matches (cumulative) | |
| Centroid matches (cumulative) | |
| Ambiguous rejections (cumulative) | |
| Unmatched (cumulative) | |
| Motion scores observed (>0) | Yes / No |
| Path arrows drawn | Yes / No |
| Any console errors | |

**Overall Assessment**: ___________

**Issues Found**: ___________

**Match Quality**: Source-ID dominant / Centroid dominant / Mixed / No storm alerts

**Ready for cinematic mode phase**: Yes / No
