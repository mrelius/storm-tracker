"""Central detection pipeline.

Accepts storm objects, runs all detectors, applies cooldown filtering,
returns structured DetectionResult. Stateful (owns cooldown state).
"""
import logging
from services.detection.models import StormObject, DetectionResult
from services.detection.detectors import ALL_DETECTORS
from services.detection.state import DetectionState

logger = logging.getLogger(__name__)


class DetectionPipeline:
    """Runs all detectors against storm objects with cooldown filtering.

    Usage:
        pipeline = DetectionPipeline()
        result = pipeline.process([storm1, storm2, ...])
        # result.events = list of emitted DetectionEvents
    """

    def __init__(self, detectors=None):
        self.detectors = detectors or ALL_DETECTORS
        self.state = DetectionState()

    def process(self, storms: list[StormObject]) -> DetectionResult:
        """Process a collection of storm objects through all detectors.

        Returns DetectionResult with emitted events and suppression count.
        """
        self.state.reset_suppressed_count()
        result = DetectionResult(storms_processed=len(storms))

        for storm in storms:
            for detector in self.detectors:
                try:
                    events = detector(storm)
                except Exception as e:
                    logger.error(f"Detector {detector.__name__} failed on {storm.id}: {e}")
                    continue

                for event in events:
                    if self.state.should_emit(event):
                        self.state.record_emission(event)
                        result.events.append(event)
                    else:
                        self.state.record_suppression()

        result.detections_suppressed = self.state.suppressed_count

        # Periodic cleanup
        self.state.cleanup_expired()

        if result.events:
            logger.info(
                f"Detection pipeline: {result.storms_processed} storms, "
                f"{len(result.events)} events emitted, "
                f"{result.detections_suppressed} suppressed"
            )

        return result

    def process_single(self, storm: StormObject) -> DetectionResult:
        """Convenience: process a single storm object."""
        return self.process([storm])

    def reset(self):
        """Clear all state. Use for testing or full reset."""
        self.state.clear()
