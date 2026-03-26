"""
Storm Tracker — AI Prompt Templates

Structured prompts for each AI task type.
All prompts include safety boundaries.
"""


def storm_summary_prompt(alerts: list[dict], location: dict, environment: dict | None = None) -> str:
    """Generate a concise storm summary from current alert state."""
    alert_lines = []
    for a in alerts[:8]:
        line = (f"- {a.get('event', 'Unknown')}: {a.get('headline', 'N/A')} "
                f"(severity={a.get('severity', '?')}, "
                f"distance={a.get('distance_mi', '?')}mi)")
        alert_lines.append(line)

    alert_block = "\n".join(alert_lines) if alert_lines else "No active alerts."

    env_block = ""
    if environment and environment.get("category") != "unknown":
        env_block = f"\nEnvironment: {environment.get('category', 'unknown')} — {environment.get('explanation', '')}"

    return f"""You are a severe weather briefing system. Generate a concise storm summary.

CURRENT SITUATION:
Location: {location.get('name', 'Unknown')} ({location.get('lat', '?')}, {location.get('lon', '?')})
Active alerts:
{alert_block}
{env_block}

RULES:
- Be factual and concise (2-4 sentences max)
- State the most significant threat first
- Include direction and distance if available
- Do NOT speculate beyond the data provided
- Do NOT give safety advice or instructions
- Use plain language, no jargon

SUMMARY:"""


def narration_prompt(alert: dict, location: dict) -> str:
    """Generate spoken narration text for browser TTS."""
    return f"""You are a weather alert narrator. Generate a brief spoken alert for text-to-speech.

ALERT:
Type: {alert.get('event', 'Unknown')}
Headline: {alert.get('headline', 'N/A')}
Severity: {alert.get('severity', 'Unknown')}
Distance: {alert.get('distance_mi', 'Unknown')} miles
Direction: {alert.get('direction', 'Unknown')}
Motion: {alert.get('motion', 'Unknown')}

RULES:
- One to two sentences only
- Written for speech (no abbreviations, no special characters)
- State the threat type, location relative to user, and movement
- Be calm and informative, not alarmist
- Do NOT give safety instructions

NARRATION:"""


def priority_prompt(alerts: list[dict], location: dict) -> str:
    """Suggest alert priority ranking with reasoning."""
    alert_lines = []
    for i, a in enumerate(alerts[:8]):
        line = (f"{i+1}. {a.get('event', '?')} — {a.get('severity', '?')} — "
                f"{a.get('distance_mi', '?')}mi — "
                f"motion: {a.get('motion', 'unknown')}")
        alert_lines.append(line)

    alert_block = "\n".join(alert_lines)

    return f"""You are a storm tracking assistant. Rank these alerts by threat to the user's location.

USER LOCATION: {location.get('name', 'Unknown')} ({location.get('lat', '?')}, {location.get('lon', '?')})

ALERTS:
{alert_block}

RULES:
- Return a numbered list (1 = highest threat)
- For each, give ONE reason (approaching, intensifying, proximity, etc.)
- Consider: severity, distance, motion toward user, event type
- This is ADVISORY — the deterministic tracker makes final decisions
- Max 3 sentences total reasoning

RANKING:"""


def interpretation_prompt(alert: dict, environment: dict | None = None) -> str:
    """Interpret a single alert's context and significance."""
    env_info = ""
    if environment:
        env_info = f"\nEnvironment: {environment.get('category', 'unknown')} — {environment.get('explanation', '')}"

    return f"""You are a severe weather analyst. Interpret this alert's significance.

ALERT:
Type: {alert.get('event', 'Unknown')}
Severity: {alert.get('severity', 'Unknown')}
Description: {alert.get('description', 'N/A')[:500]}
Motion: {alert.get('motion', 'Unknown')}
{env_info}

RULES:
- One to two sentences explaining significance
- Note if conditions are favorable for intensification
- Be factual, not speculative
- This is context only — do NOT recommend actions

INTERPRETATION:"""
