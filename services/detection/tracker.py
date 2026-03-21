"""Storm tracker — maintains identity and motion across detection cycles.

Matches new storm candidates to existing tracks using spatial proximity.
Computes motion vectors (speed, heading) from position history.
Client-relative trend (closing/departing) computed at evaluation time.
"""
import math
import time
from dataclasses import dataclass, field
from services.detection.geometry import haversine_mi, compute_bearing


MATCH_RADIUS_MI = 30.0   # max distance to match a candidate to existing track
MAX_HISTORY = 5           # position history entries per track
EXPIRE_CYCLES = 3         # remove track after N missed cycles
MIN_SPEED_MPH = 2.0       # below this, treat as stationary
MAX_SPEED_MPH = 150.0      # above this, reject as bad data
TREND_THRESHOLD_MI = 0.5   # distance change below this = no trend


@dataclass
class StormTrack:
    """A tracked storm with position history and motion vector."""
    storm_id: str
    positions: list[tuple[float, float, float]] = field(default_factory=list)
    # (lat, lon, epoch_seconds)
    speed_mph: float = 0.0
    heading_deg: float = 0.0    # direction of travel (0=N, 90=E, etc.)
    missed_cycles: int = 0
    reflectivity_dbz: float | None = None
    velocity_delta: float | None = None
    cc_min: float | None = None
    nws_event: str = ""
    nws_severity: str = ""

    @property
    def lat(self) -> float:
        return self.positions[-1][0] if self.positions else 0.0

    @property
    def lon(self) -> float:
        return self.positions[-1][1] if self.positions else 0.0

    @property
    def last_updated(self) -> float:
        return self.positions[-1][2] if self.positions else 0.0

    @property
    def prev_lat(self) -> float | None:
        return self.positions[-2][0] if len(self.positions) >= 2 else None

    @property
    def prev_lon(self) -> float | None:
        return self.positions[-2][1] if len(self.positions) >= 2 else None


class StormTracker:
    """Maintains tracked storms across detection cycles.

    Usage:
        tracker = StormTracker()
        # Each cycle:
        tracked = tracker.update(new_candidates)
        # tracked = list of StormTrack with motion computed
    """

    def __init__(self):
        self._tracks: dict[str, StormTrack] = {}
        self._next_id = 1

    def update(self, candidates) -> list[StormTrack]:
        """Match new candidates to existing tracks, compute motion, return tracked storms.

        candidates: list of BaseStormCandidate (from adapter).
        """
        now = time.time()
        matched_track_ids = set()
        matched_candidates = set()

        # 1. Match candidates to existing tracks (nearest neighbor, greedy)
        pairs = []
        for i, c in enumerate(candidates):
            for track_id, track in self._tracks.items():
                dist = haversine_mi(track.lat, track.lon, c.lat, c.lon)
                if dist <= MATCH_RADIUS_MI:
                    pairs.append((dist, i, track_id))

        pairs.sort(key=lambda p: p[0])  # closest first

        for dist, cand_idx, track_id in pairs:
            if cand_idx in matched_candidates or track_id in matched_track_ids:
                continue
            # Match found — update track
            track = self._tracks[track_id]
            c = candidates[cand_idx]
            track.positions.append((c.lat, c.lon, now))
            if len(track.positions) > MAX_HISTORY:
                track.positions = track.positions[-MAX_HISTORY:]
            track.missed_cycles = 0
            track.reflectivity_dbz = c.reflectivity_dbz
            track.velocity_delta = c.velocity_delta
            track.cc_min = c.cc_min
            track.nws_event = c.nws_event
            track.nws_severity = c.nws_severity
            _compute_motion(track)
            matched_track_ids.add(track_id)
            matched_candidates.add(cand_idx)

        # 2. Create new tracks for unmatched candidates
        new_track_ids = set()
        for i, c in enumerate(candidates):
            if i in matched_candidates:
                continue
            track_id = f"st_{self._next_id}"
            self._next_id += 1
            track = StormTrack(
                storm_id=track_id,
                positions=[(c.lat, c.lon, now)],
                reflectivity_dbz=c.reflectivity_dbz,
                velocity_delta=c.velocity_delta,
                cc_min=c.cc_min,
                nws_event=c.nws_event,
                nws_severity=c.nws_severity,
            )
            self._tracks[track_id] = track
            new_track_ids.add(track_id)

        # 3. Increment missed cycles for unmatched OLD tracks (not newly created)
        for track_id in list(self._tracks.keys()):
            if track_id not in matched_track_ids and track_id not in new_track_ids:
                self._tracks[track_id].missed_cycles += 1

        # 4. Expire old tracks
        expired = [tid for tid, t in self._tracks.items() if t.missed_cycles >= EXPIRE_CYCLES]
        for tid in expired:
            del self._tracks[tid]

        return list(self._tracks.values())

    @property
    def track_count(self) -> int:
        return len(self._tracks)

    def clear(self):
        self._tracks.clear()
        self._next_id = 1


def _compute_motion(track: StormTrack):
    """Compute speed and heading from the last two positions."""
    if len(track.positions) < 2:
        track.speed_mph = 0.0
        track.heading_deg = 0.0
        return

    lat1, lon1, t1 = track.positions[-2]
    lat2, lon2, t2 = track.positions[-1]
    dt_hours = (t2 - t1) / 3600.0

    if dt_hours <= 0:
        track.speed_mph = 0.0
        track.heading_deg = 0.0
        return

    dist = haversine_mi(lat1, lon1, lat2, lon2)
    speed = dist / dt_hours

    # Guard against unrealistic speed
    if speed > MAX_SPEED_MPH:
        track.speed_mph = 0.0
        track.heading_deg = 0.0
        return

    if speed < MIN_SPEED_MPH:
        track.speed_mph = 0.0
        # Keep previous heading if any
        return

    track.speed_mph = round(speed, 1)
    track.heading_deg = compute_bearing(lat1, lon1, lat2, lon2)


def compute_trend(
    track: StormTrack,
    ref_lat: float, ref_lon: float,
) -> str:
    """Compute client-relative trend: closing, departing, or unknown.

    Compares distance from client to storm's previous vs current position.
    """
    if track.prev_lat is None or track.prev_lon is None:
        return "unknown"

    prev_dist = haversine_mi(ref_lat, ref_lon, track.prev_lat, track.prev_lon)
    curr_dist = haversine_mi(ref_lat, ref_lon, track.lat, track.lon)
    delta = curr_dist - prev_dist

    if delta < -TREND_THRESHOLD_MI:
        return "closing"
    elif delta > TREND_THRESHOLD_MI:
        return "departing"
    return "unknown"


# Singleton tracker
_tracker: StormTracker | None = None


def get_tracker() -> StormTracker:
    global _tracker
    if _tracker is None:
        _tracker = StormTracker()
    return _tracker
