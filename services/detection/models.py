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
    speed_mph: float = 0.0
    reflectivity_dbz: Optional[float] = None
    velocity_delta: Optional[float] = None
    cc_min: Optional[float] = None
    trend: Trend = Trend.unknown
    track_confidence: float = 0.0      # overall track quality (0-1)
    motion_confidence: float = 0.0     # speed/heading stability (0-1)
    trend_confidence: float = 0.0      # trend reliability (0-1)
    last_updated: float = 0.0          # epoch seconds


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
    eta_min: Optional[float] = None  # estimated time of arrival in minutes
    timestamp: float = 0.0           # epoch seconds when detection was created
    lat: float = 0.0
    lon: float = 0.0
    speed_mph: float = 0.0
    detail: str = ""                 # human-readable detail string


@dataclass
class DetectionResult:
    """Output of a full pipeline run across one or more storm objects."""
    events: list[DetectionEvent] = field(default_factory=list)
    storms_processed: int = 0
    detections_suppressed: int = 0   # events blocked by cooldown
