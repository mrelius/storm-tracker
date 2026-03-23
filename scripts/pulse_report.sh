#!/bin/bash
# Storm Tracker — Context Pulse Validation Report
# Run after a severe weather session to extract pulse telemetry.
# Usage: ./scripts/pulse_report.sh [hours_back]

HOURS=${1:-6}
LOG_FILE="/opt/storm-tracker/data/logs/storm_tracker.jsonl"
HOST="10.206.8.119"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║     CONTEXT PULSE — BEHAVIORAL VALIDATION REPORT        ║"
echo "║     Window: last ${HOURS}h                                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

ssh -i ~/.ssh/id_proxmox -o StrictHostKeyChecking=no root@$HOST "
python3 << 'PY'
import json, time, sys
from collections import Counter
from datetime import datetime, timezone

HOURS = $HOURS
LOG = '$LOG_FILE'
cutoff = time.time() - HOURS * 3600

events = []
try:
    with open(LOG) as f:
        for line in f:
            try:
                e = json.loads(line.strip())
                ts_str = e.get('ts', '')
                if not ts_str: continue
                ts = datetime.fromisoformat(ts_str).timestamp()
                if ts < cutoff: continue
                evt = e.get('event', '')
                mod = e.get('module', '')
                if 'pulse' in evt.lower() or 'context_pulse' in mod.lower():
                    events.append(e)
                if 'autotrack_target' in evt.lower():
                    events.append(e)
                if 'prediction_generated' in evt or 'prediction_suppressed' in evt:
                    events.append(e)
            except: pass
except FileNotFoundError:
    print('Log file not found')
    sys.exit(1)

if not events:
    print('No pulse or storm events in the last {} hours.'.format(HOURS))
    print('Waiting for real severe weather to generate data.')
    print('')
    print('==============================')
    print('CONTEXT PULSE DECISION')
    print('==============================')
    print('')
    print('Completion Rate: N/A')
    print('User Cancel Rate: N/A')
    print('High Priority Suppression: 0 occurrences')
    print('')
    print('Decision: INSUFFICIENT_DATA')
    print('')
    print('Reason:')
    print('- No pulse events recorded in the time window.')
    print('- Cannot evaluate without real storm session data.')
    print('')
    print('Recommended Action:')
    print('- No changes. Wait for severe weather session.')
    sys.exit(0)

# ── 1. METRICS SUMMARY ──────────────────────────────────────

pulse_events = [e for e in events if 'pulse' in e.get('event', '').lower()]
counts = Counter(e.get('event', '') for e in pulse_events)

s = counts.get('pulse_started', 0)
c = counts.get('pulse_completed', 0)
cu = counts.get('pulse_cancelled_user', 0)
ct = counts.get('pulse_cancelled_target', 0)
sp = counts.get('pulse_suppressed_reason', 0)
tg = counts.get('pulse_toggle', 0)
comp = round(c / s * 100, 1) if s else 0
canc = round(cu / s * 100, 1) if s else 0

print('=== 1. METRICS SUMMARY ===')
print(f'  total_pulses (started): {s}')
print(f'  completed:              {c}')
print(f'  cancelled_user:         {cu}')
print(f'  cancelled_target:       {ct}')
print(f'  suppressed:             {sp}')
print(f'  toggle_events:          {tg}')
print(f'  completion_rate:        {comp}%')
print(f'  user_cancel_rate:       {canc}%')

# Suppression breakdown
suppressed = [e for e in pulse_events if e.get('event') == 'pulse_suppressed_reason']
reasons = Counter()
for x in suppressed:
    reasons[x.get('extra', {}).get('reason', 'unknown')] += 1

hp_count = reasons.get('high_priority_event', 0) + reasons.get('tornado_audio_follow', 0)

if reasons:
    print(f'')
    print(f'  Suppression breakdown:')
    for r, n in reasons.most_common():
        print(f'    {r}: {n}')

# ── 2. BEHAVIORAL ANALYSIS ──────────────────────────────────

print(f'')
print(f'=== 2. BEHAVIORAL ANALYSIS ===')

bullets = []

if s == 0:
    bullets.append('No pulses fired during this window')
else:
    if comp >= 80:
        bullets.append(f'High completion rate ({comp}%) — users rarely interrupt')
    elif comp >= 60:
        bullets.append(f'Moderate completion rate ({comp}%) — some interruptions')
    else:
        bullets.append(f'Low completion rate ({comp}%) — frequent interruptions')

    if canc == 0:
        bullets.append('Zero user cancellations — pulse is non-intrusive')
    elif canc <= 15:
        bullets.append(f'Low user cancel rate ({canc}%) — acceptable')
    elif canc <= 30:
        bullets.append(f'Moderate user cancel rate ({canc}%) — borderline')
    else:
        bullets.append(f'High user cancel rate ({canc}%) — users fighting the pulse')

    if hp_count > 0:
        bullets.append(f'High-priority suppression fired {hp_count}x — TOR/debris guard working')
    else:
        bullets.append('No high-priority suppression events (no TOR activity in window)')

    if ct > 0:
        bullets.append(f'Target-change cancellations: {ct} — storms were switching')

    if tg > 0:
        bullets.append(f'User toggled CP {tg}x — indicates awareness of the feature')

    # Check if pulses cluster
    started_events = [e for e in pulse_events if e.get('event') == 'pulse_started']
    if len(started_events) >= 2:
        times = []
        for e in started_events:
            try:
                times.append(datetime.fromisoformat(e['ts']).timestamp())
            except: pass
        if len(times) >= 2:
            gaps = [times[i+1] - times[i] for i in range(len(times)-1)]
            avg_gap = sum(gaps) / len(gaps)
            bullets.append(f'Average time between pulses: {round(avg_gap)}s (target: 90s)')
            if avg_gap < 60:
                bullets.append('WARNING: pulses firing faster than expected')

for b in bullets:
    print(f'  - {b}')

# ── TIMELINE ─────────────────────────────────────────────────

print(f'')
print(f'=== SESSION TIMELINE (last 30 events) ===')
for e in events[-30:]:
    ts = e.get('ts', '?')
    if 'T' in str(ts): ts = ts.split('T')[1].split('.')[0]
    evt = e.get('event', '?')
    extra = e.get('extra', {})
    d = ''
    if 'storm_id' in extra: d += f' storm={extra[\"storm_id\"]}'
    if 'reason' in extra: d += f' reason={extra[\"reason\"]}'
    if 'from_zoom' in extra: d += f' z{extra[\"from_zoom\"]}>{extra.get(\"to_zoom\",\"?\")}'
    print(f'  {ts} {evt}{d}')

# ── 3. FINAL DECISION BLOCK ─────────────────────────────────

print(f'')
print(f'==============================')
print(f'CONTEXT PULSE DECISION')
print(f'==============================')
print(f'')
print(f'Completion Rate: {comp}%')
print(f'User Cancel Rate: {canc}%')
print(f'High Priority Suppression: {hp_count} occurrences')
print(f'')

if s == 0:
    decision = 'INSUFFICIENT_DATA'
    reason = 'No pulses fired. Cannot evaluate without storm session data.'
    action = 'No changes. Wait for severe weather session.'
elif comp >= 70 and canc <= 20:
    decision = 'ACCEPTED'
    reason = f'Completion {comp}% >= 70% and user cancel {canc}% <= 20%. Pulse behavior is non-intrusive and completing successfully.'
    action = 'Keep current settings (90s interval / 4s hold / zoom-2).'
elif canc > 30:
    decision = 'TOO_INTRUSIVE'
    reason = f'User cancel rate {canc}% > 30%. Users are actively fighting the pulse.'
    # Pick ONE recommendation based on which metric is worse
    if comp < 40:
        action = 'Increase interval from 90s to 150s. (Single change — do not stack.)'
    else:
        action = 'Reduce hold duration from 4s to 2s. (Single change — do not stack.)'
elif comp < 50:
    decision = 'NEEDS_TUNING'
    reason = f'Completion rate {comp}% is below 50%. Pulses are frequently interrupted before completing.'
    if canc > 20:
        action = 'Increase interval from 90s to 120s. (Single change — do not stack.)'
    else:
        action = 'Reduce zoom-out from 2 levels to 1 level. (Single change — do not stack.)'
else:
    decision = 'NEEDS_TUNING'
    reason = f'Completion {comp}%, cancel {canc}%. Marginal — close to thresholds but not clearly passing.'
    action = 'Reduce hold duration from 4s to 3s. (Single change — do not stack.)'

print(f'Decision: {decision}')
print(f'')
print(f'Reason:')
print(f'- {reason}')
print(f'')
print(f'Recommended Action:')
print(f'- {action}')
PY
" 2>/dev/null
