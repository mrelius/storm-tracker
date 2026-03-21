"""Alert engine — transforms detection events into stateful user-facing alerts.

Lifecycle: NEW → ACTIVE → ESCALATED → EXPIRED
Identity: keyed by storm_id + detection_type
Deduplication: same key updates existing alert instead of creating new one
Escalation: severity increase triggers immediate status transition
Expiration: TTL-based, alerts expire when detections stop refreshing them
"""
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from services.detection.models import DetectionEvent, DetectionType, DetectionResult
from services.detection.adapter import run_detection_cycle

logger = logging.getLogger(__name__)


class AlertStatus(str, Enum):
    new = "new"
    active = "active"
    escalated = "escalated"
    expired = "expired"


# TTL by severity (seconds) — alert expires if not refreshed within this window
ALERT_TTL = {
    1: 300,   # 5 minutes
    2: 300,   # 5 minutes
    3: 480,   # 8 minutes
    4: 600,   # 10 minutes
}
DEFAULT_TTL = 300


# Human-readable alert content by detection type
ALERT_TEMPLATES = {
    DetectionType.storm_proximity: {
        "title": "Approaching Storm",
        "base_message": "Storm approaching",
    },
    DetectionType.strong_storm: {
        "title": "Strong Storm Nearby",
        "base_message": "Strong storm detected nearby",
    },
    DetectionType.rotation: {
        "title": "Rotation Detected",
        "base_message": "Rotation detected in a nearby storm",
    },
    DetectionType.debris_signature: {
        "title": "Potential Debris Signature",
        "base_message": "Potential debris signature detected",
    },
}


@dataclass
class StormAlert:
    """Canonical alert object — single authoritative structure for all consumers.

    All fields are explicit. No downstream inference needed.
    """
    # Identity
    alert_id: str
    storm_id: str
    type: str               # storm_proximity, strong_storm, rotation, debris_signature
    severity: int            # 1-4

    # Content
    title: str
    message: str
    status: AlertStatus      # new, active, escalated, expired

    # Timestamps
    created_at: float
    updated_at: float
    expires_at: float

    # Location (client-relative)
    lat: float = 0.0
    lon: float = 0.0
    distance_mi: float = 0.0
    bearing_deg: float = 0.0
    direction: str = "unknown"

    # Motion (from tracker)
    trend: str = "unknown"        # closing, departing, unknown
    speed_mph: float = 0.0
    heading_deg: float = 0.0      # storm travel direction

    # Timing
    eta_min: Optional[float] = None

    # Confidence
    confidence: float = 0.0
    track_confidence: float = 0.0
    motion_confidence: float = 0.0
    trend_confidence: float = 0.0

    # Intensity
    intensity_trend: str = "unknown"


def _update_alert_fields(alert: StormAlert, event: DetectionEvent):
    """Update an existing alert's location/motion/confidence fields from a detection event."""
    alert.lat = event.lat
    alert.lon = event.lon
    alert.distance_mi = event.distance_mi
    alert.bearing_deg = event.bearing_deg
    alert.direction = event.direction
    alert.trend = event.trend
    alert.speed_mph = event.speed_mph
    alert.heading_deg = event.heading_deg
    alert.eta_min = event.eta_min
    alert.track_confidence = event.track_confidence
    alert.motion_confidence = event.motion_confidence
    alert.trend_confidence = event.trend_confidence
    alert.intensity_trend = getattr(event, "intensity_trend", "unknown")


def _alert_key(storm_id: str, detection_type: str) -> str:
    return f"{storm_id}:{detection_type}"


def format_message(event: DetectionEvent) -> str:
    """Build human-readable alert message from a detection event.

    Honestly omits ETA/direction when unavailable.
    """
    template = ALERT_TEMPLATES.get(event.type)
    if not template:
        return event.detail or "Weather alert."

    parts = [template["base_message"]]

    # Direction
    if event.direction and event.direction != "unknown":
        parts[0] += f" from the {event.direction}"

    # ETA
    if event.eta_min is not None and event.eta_min > 0:
        if event.eta_min < 60:
            parts.append(f"about {int(event.eta_min)} min away")
        else:
            hours = event.eta_min / 60
            parts.append(f"about {hours:.1f} hours away")

    # Distance
    if event.distance_mi > 0:
        parts.append(f"{event.distance_mi:.0f} mi")

    # Severity-specific suffix
    if event.type == DetectionType.debris_signature:
        parts.append("Seek shelter now")

    msg = ", ".join(parts) + "."
    return msg


def create_alert_from_event(event: DetectionEvent) -> StormAlert:
    """Create a new StormAlert from a DetectionEvent."""
    now = time.time()
    ttl = ALERT_TTL.get(event.severity, DEFAULT_TTL)
    template = ALERT_TEMPLATES.get(event.type, {"title": "Weather Alert"})

    return StormAlert(
        alert_id=_alert_key(event.storm_id, event.type.value),
        storm_id=event.storm_id,
        type=event.type.value,
        severity=event.severity,
        title=template["title"],
        message=format_message(event),
        status=AlertStatus.new,
        created_at=now,
        updated_at=now,
        expires_at=now + ttl,
        lat=event.lat,
        lon=event.lon,
        distance_mi=event.distance_mi,
        bearing_deg=event.bearing_deg,
        direction=event.direction,
        trend=event.trend,
        speed_mph=event.speed_mph,
        heading_deg=event.heading_deg,
        eta_min=event.eta_min,
        confidence=event.confidence,
        track_confidence=event.track_confidence,
        motion_confidence=event.motion_confidence,
        trend_confidence=event.trend_confidence,
        intensity_trend=getattr(event, "intensity_trend", "unknown"),
    )


class AlertStore:
    """In-memory store for active storm alerts with lifecycle management."""

    def __init__(self):
        self._alerts: dict[str, StormAlert] = {}

    def update_from_detections(self, events: list[DetectionEvent]) -> list[StormAlert]:
        """Process detection events into the alert store.

        - New events create NEW alerts
        - Matching events refresh ACTIVE alerts
        - Higher severity triggers ESCALATED status
        - Returns list of alerts that were created or changed
        """
        changed = []
        refreshed_keys = set()

        for event in events:
            key = _alert_key(event.storm_id, event.type.value)
            refreshed_keys.add(key)
            existing = self._alerts.get(key)

            if existing is None:
                # New alert
                alert = create_alert_from_event(event)
                self._alerts[key] = alert
                changed.append(alert)

            elif event.severity > existing.severity:
                # Escalation
                now = time.time()
                ttl = ALERT_TTL.get(event.severity, DEFAULT_TTL)
                existing.severity = event.severity
                existing.status = AlertStatus.escalated
                existing.updated_at = now
                existing.expires_at = now + ttl
                existing.message = format_message(event)
                _update_alert_fields(existing, event)
                changed.append(existing)

            else:
                # Refresh — update position/timing, keep active
                now = time.time()
                ttl = ALERT_TTL.get(existing.severity, DEFAULT_TTL)
                if existing.status == AlertStatus.new:
                    existing.status = AlertStatus.active
                existing.updated_at = now
                existing.expires_at = now + ttl
                existing.confidence = max(existing.confidence, event.confidence)
                existing.message = format_message(event)
                _update_alert_fields(existing, event)

        return changed

    def expire_stale(self) -> int:
        """Expire alerts past their TTL. Returns count of expired."""
        now = time.time()
        expired_count = 0
        to_remove = []

        for key, alert in self._alerts.items():
            if alert.status == AlertStatus.expired:
                # Already expired — remove if very old (2x TTL)
                ttl = ALERT_TTL.get(alert.severity, DEFAULT_TTL)
                if now - alert.updated_at > ttl * 2:
                    to_remove.append(key)
            elif now > alert.expires_at:
                alert.status = AlertStatus.expired
                alert.updated_at = now
                expired_count += 1

        for key in to_remove:
            del self._alerts[key]

        return expired_count

    def get_active_alerts(self) -> list[StormAlert]:
        """Return active (non-expired) alerts, ordered by severity desc, distance asc."""
        active = [
            a for a in self._alerts.values()
            if a.status != AlertStatus.expired
        ]
        active.sort(key=lambda a: (-a.severity, a.distance_mi, -a.updated_at))
        return active

    def get_all_alerts(self) -> list[StormAlert]:
        """Return all alerts including expired (for debugging)."""
        return list(self._alerts.values())

    @property
    def active_count(self) -> int:
        return sum(1 for a in self._alerts.values() if a.status != AlertStatus.expired)

    def clear(self):
        self._alerts.clear()


# Singleton alert store
_store: AlertStore | None = None


def get_store() -> AlertStore:
    global _store
    if _store is None:
        _store = AlertStore()
    return _store


async def run_alert_cycle(
    ref_lat: float | None = None,
    ref_lon: float | None = None,
) -> dict:
    """Full alert cycle: run detection → update alerts → expire stale → return active.

    This is the main orchestration entry point.
    """
    # 1. Run detection pipeline
    detection_result = await run_detection_cycle(ref_lat=ref_lat, ref_lon=ref_lon)

    # 2. Update alert store
    store = get_store()
    changed = store.update_from_detections(detection_result.events)

    # 3. Expire stale alerts
    expired = store.expire_stale()

    # 4. Get active alerts
    active = store.get_active_alerts()

    if changed or expired:
        logger.info(
            f"Alert cycle: {len(changed)} changed, {expired} expired, "
            f"{len(active)} active"
        )

    return {
        "alerts": active,
        "count": len(active),
        "updated_at": time.time(),
        "detections_processed": len(detection_result.events),
        "alerts_changed": len(changed),
        "alerts_expired": expired,
    }
