"""Detection state and cooldown management.

Prevents duplicate emissions for the same storm + event type within
a cooldown window. Cooldown duration scales with severity.

State is in-memory only — no persistence needed. Detections are
ephemeral by nature (they represent current conditions, not history).
"""
import time
from dataclasses import dataclass
from services.detection.models import DetectionEvent


# Cooldown durations by severity (seconds)
# Higher severity = longer cooldown (don't spam critical alerts)
COOLDOWN_BY_SEVERITY = {
    1: 120,    # 2 minutes
    2: 180,    # 3 minutes
    3: 240,    # 4 minutes
    4: 300,    # 5 minutes
}
DEFAULT_COOLDOWN = 120


@dataclass
class CooldownEntry:
    """Tracks when a specific storm+event was last emitted."""
    storm_id: str
    event_type: str
    severity: int
    last_emitted: float  # epoch seconds
    cooldown_sec: int


class DetectionState:
    """Manages cooldown state for detection events.

    Keyed by (storm_id, event_type). Thread-safe via simple dict
    (single-process, single-threaded pipeline).
    """

    def __init__(self):
        self._entries: dict[str, CooldownEntry] = {}
        self._suppressed_count = 0

    def _key(self, storm_id: str, event_type: str) -> str:
        return f"{storm_id}:{event_type}"

    def should_emit(self, event: DetectionEvent) -> bool:
        """Check if an event should be emitted or is in cooldown.

        Returns True if the event should be emitted.
        An event with HIGHER severity than the stored entry
        bypasses cooldown (escalation).
        """
        key = self._key(event.storm_id, event.type.value)
        entry = self._entries.get(key)

        if entry is None:
            return True

        now = time.time()
        elapsed = now - entry.last_emitted
        cooldown = COOLDOWN_BY_SEVERITY.get(entry.severity, DEFAULT_COOLDOWN)

        # Cooldown expired
        if elapsed >= cooldown:
            return True

        # Severity escalation bypasses cooldown
        if event.severity > entry.severity:
            return True

        return False

    def record_emission(self, event: DetectionEvent):
        """Record that an event was emitted. Updates cooldown timer."""
        key = self._key(event.storm_id, event.type.value)
        cooldown = COOLDOWN_BY_SEVERITY.get(event.severity, DEFAULT_COOLDOWN)

        self._entries[key] = CooldownEntry(
            storm_id=event.storm_id,
            event_type=event.type.value,
            severity=event.severity,
            last_emitted=time.time(),
            cooldown_sec=cooldown,
        )

    def record_suppression(self):
        """Increment suppressed count for reporting."""
        self._suppressed_count += 1

    @property
    def suppressed_count(self) -> int:
        return self._suppressed_count

    def reset_suppressed_count(self):
        self._suppressed_count = 0

    def cleanup_expired(self):
        """Remove entries whose cooldown has fully expired.

        Called periodically to prevent unbounded memory growth.
        """
        now = time.time()
        expired = []
        for key, entry in self._entries.items():
            cooldown = COOLDOWN_BY_SEVERITY.get(entry.severity, DEFAULT_COOLDOWN)
            if now - entry.last_emitted > cooldown * 2:  # 2x cooldown = safe to purge
                expired.append(key)
        for key in expired:
            del self._entries[key]

    def get_entry(self, storm_id: str, event_type: str) -> CooldownEntry | None:
        """Get cooldown entry for debugging/inspection."""
        return self._entries.get(self._key(storm_id, event_type))

    @property
    def active_entries(self) -> int:
        return len(self._entries)

    def clear(self):
        """Reset all state."""
        self._entries.clear()
        self._suppressed_count = 0
