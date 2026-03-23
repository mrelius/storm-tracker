"""Storm detection data models.

Defines the normalized storm object shape consumed by detectors,
and the detection event shape emitted by the pipeline.
"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class Trend(str, Enum):
    closing = "closing"
    steady = "steady"
    departing = "departing"
    unknown = "unknown"


class DetectionType(str, Enum):
    storm_proximity = "storm_proximity"
    strong_storm = "strong_storm"
    rotation = "rotation"
    debris_signature = "debris_signature"


@dataclass
class StormObject:
    """Normalized storm object consumed by all detectors.

    Fields that may not be available from live data are Optional
    with None defaults. Detectors check for None before using them.
    """
    id: str
    lat: float
    lon: float
    distance_mi: float
    bearing_deg: float
    direction: str = "unknown"
    nws_alert_id: str = ""
    speed_mph: float = 0.0
    reflectivity_dbz: Optional[float] = None
    velocity_delta: Optional[float] = None
    cc_min: Optional[float] = None
    trend: Trend = Trend.unknown
    heading_deg: float = 0.0           # storm travel direction (0=N, 90=E)
    smoothed_heading: float = 0.0     # smoothed travel direction
    intensity_trend: str = "unknown"
    predicted_lat: float = 0.0
    predicted_lon: float = 0.0
    prediction_minutes: float = 0.0
    # Impact analysis (client-relative)
    storm_radius_mi: float = 5.0
    cpa_distance_mi: Optional[float] = None
    time_to_cpa_min: Optional[float] = None
    impact: str = "uncertain"
    impact_description: str = ""
    projected_severity_label: str = "unknown"
    projected_severity_score: int = 0
    impact_severity_label: str = "unknown"
    impact_severity_score: int = 0
    track_confidence: float = 0.0
    motion_confidence: float = 0.0
    trend_confidence: float = 0.0
    last_updated: float = 0.0


@dataclass
class DetectionEvent:
    """A single detection emitted by a detector.

    This is the stable output contract consumed by alert/UI layers.
    """
    type: DetectionType
    severity: int                    # 1 (low) to 4 (critical)
    confidence: float                # 0.0 to 1.0
    storm_id: str
    distance_mi: float
    direction: str
    bearing_deg: float
    nws_alert_id: str = ""
    eta_min: Optional[float] = None
    timestamp: float = 0.0
    lat: float = 0.0
    lon: float = 0.0
    speed_mph: float = 0.0
    heading_deg: float = 0.0
    trend: str = "unknown"
    intensity_trend: str = "unknown"
    storm_radius_mi: float = 5.0
    impact: str = "uncertain"
    impact_description: str = ""
    cpa_distance_mi: float | None = None
    time_to_cpa_min: float | None = None
    projected_severity_label: str = "unknown"
    impact_severity_label: str = "unknown"
    impact_severity_score: int = 0
    track_confidence: float = 0.0
    motion_confidence: float = 0.0
    trend_confidence: float = 0.0
    detail: str = ""


@dataclass
class DetectionResult:
    """Output of a full pipeline run across one or more storm objects."""
    events: list[DetectionEvent] = field(default_factory=list)
    storms_processed: int = 0
    detections_suppressed: int = 0   # events blocked by cooldown
