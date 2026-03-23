#!/bin/bash
# Storm Tracker — Guidance Validation & Trust Calibration Report
# Run after a storm session to evaluate guidance accuracy.
# Usage: ./scripts/guidance_report.sh [hours_back]

HOURS=${1:-6}
LOG_FILE="/opt/storm-tracker/data/logs/storm_tracker.jsonl"
HOST="10.206.8.119"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║    GUIDANCE VALIDATION & TRUST CALIBRATION REPORT        ║"
echo "║    Window: last ${HOURS}h                                        ║"
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

guidance_events = []
prediction_events = []

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
                if evt in ('guidance_generated', 'guidance_suppressed'):
                    e['_ts'] = ts
                    guidance_events.append(e)
                elif evt in ('prediction_generated', 'prediction_suppressed'):
                    e['_ts'] = ts
                    prediction_events.append(e)
            except: pass
except FileNotFoundError:
    print('Log file not found')
    sys.exit(1)

gen = [e for e in guidance_events if e.get('event') == 'guidance_generated']
sup = [e for e in guidance_events if e.get('event') == 'guidance_suppressed']

print(f'=== 1. METRICS ===')
print(f'  Total guidance calls:     {len(guidance_events)}')
print(f'    Generated:              {len(gen)}')
print(f'    Suppressed:             {len(sup)}')
print(f'  Prediction events:        {len(prediction_events)}')

if not gen and not sup:
    print()
    print('  No guidance events in window. Waiting for storm session.')
    print()
    print('==============================')
    print('GUIDANCE VALIDATION DECISION')
    print('==============================')
    print()
    print('Decision: INSUFFICIENT_DATA')
    print('Recommendation: No changes. Wait for severe weather.')
    sys.exit(0)

# Priority distribution
priorities = Counter(e.get('extra', {}).get('priority', '?') for e in gen)
print(f'')
print(f'  Priority distribution:')
for p in ['critical', 'high', 'elevated', 'low']:
    print(f'    {p:12s} {priorities.get(p, 0)}')

# Suppression reasons
if sup:
    reasons = Counter(e.get('extra', {}).get('reason', '?') for e in sup)
    print(f'')
    print(f'  Suppression reasons:')
    for r, n in reasons.most_common():
        print(f'    {r}: {n}')

# Event types that drove guidance
events_seen = Counter(e.get('extra', {}).get('event_type', 'none') for e in gen)
print(f'')
print(f'  Event types driving guidance:')
for ev, n in events_seen.most_common():
    print(f'    {ev}: {n}')

# Priority changes (transitions)
print(f'')
print(f'=== 2. GUIDANCE TIMELINE ===')
last_priority = None
transitions = 0
for e in guidance_events:
    ts = e.get('ts', '?')
    if 'T' in str(ts): ts = ts.split('T')[1].split('.')[0]
    evt = e.get('event', '?')
    extra = e.get('extra', {})

    if evt == 'guidance_generated':
        pri = extra.get('priority', '?')
        headline = extra.get('headline', '?')[:40]
        event_type = extra.get('event_type', '-')
        eta = extra.get('eta_minutes')
        impact = extra.get('impact', '-')
        sev = extra.get('severity_trend', '-')
        spc = extra.get('spc_risk', '-')

        marker = ''
        if last_priority and pri != last_priority:
            transitions += 1
            if pri in ('critical', 'high') and last_priority in ('low', 'elevated', 'none'):
                marker = ' ** ESCALATION'
            elif pri in ('low', 'none') and last_priority in ('critical', 'high'):
                marker = ' ** DOWNGRADE'
            else:
                marker = ' * change'

        eta_str = f'eta={int(eta)}m' if eta else 'eta=-'
        print(f'  {ts} [{pri:9s}] {headline} | {event_type} {eta_str} {impact} sev={sev} spc={spc}{marker}')
        last_priority = pri
    else:
        reason = extra.get('reason', '?')
        print(f'  {ts} [suppressed] {reason}')
        last_priority = 'none'

print(f'')
print(f'  Total priority transitions: {transitions}')

# Metrics
print(f'')
print(f'=== 3. VALIDATION METRICS ===')
critical_count = priorities.get('critical', 0)
high_count = priorities.get('high', 0)
total_gen = len(gen)

print(f'  Guidance changes per window: {transitions}')
print(f'  Critical outputs: {critical_count}')
print(f'  High outputs: {high_count}')
if total_gen > 0:
    critical_rate = round(critical_count / total_gen * 100, 1)
    print(f'  Critical rate: {critical_rate}% of all guidance')
else:
    critical_rate = 0

# Check for rapid flapping (>3 transitions in 5 minutes)
flapping = False
if len(guidance_events) >= 4:
    recent_ts = [e['_ts'] for e in guidance_events[-10:]]
    for i in range(len(recent_ts) - 3):
        if recent_ts[i+3] - recent_ts[i] < 300:
            flapping = True
            break
if flapping:
    print(f'  WARNING: Rapid guidance flapping detected')
else:
    print(f'  No flapping detected')

print(f'')
print(f'==============================')
print(f'GUIDANCE VALIDATION DECISION')
print(f'==============================')
print(f'')

issues = []
if critical_rate > 50 and total_gen > 5:
    issues.append('High critical rate may indicate over-sensitivity')
if transitions > 20:
    issues.append('Excessive priority transitions — may confuse users')
if flapping:
    issues.append('Rapid flapping — needs debounce or hysteresis')

if not issues:
    print(f'Decision: ACCEPTED')
    print(f'')
    print(f'Reason:')
    print(f'- No anomalies detected in guidance output')
    print(f'- Priority transitions appear appropriate')
    print(f'')
    print(f'Recommendation:')
    print(f'- Keep current rules and thresholds')
else:
    print(f'Decision: NEEDS_REVIEW')
    print(f'')
    print(f'Issues:')
    for issue in issues:
        print(f'- {issue}')
    print(f'')
    print(f'Recommendation:')
    if flapping:
        print(f'- Add guidance output debounce (suppress same priority within 30s)')
    elif critical_rate > 50:
        print(f'- Review critical threshold — consider raising score requirement from 80 to 90')
    else:
        print(f'- Review transition frequency — consider adding hysteresis')
PY
" 2>/dev/null
