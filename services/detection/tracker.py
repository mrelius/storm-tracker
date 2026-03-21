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
TREND_THRESHOLD_MI = 0.1   # distance change below this = no trend (supports 8s-60s cadence)


@dataclass
class StormTrack:
    """A tracked storm with position history, motion vector, and confidence."""
    storm_id: str
    positions: list[tuple[float, float, float]] = field(default_factory=list)
    speed_mph: float = 0.0
    heading_deg: float = 0.0
    missed_cycles: int = 0
    total_cycles: int = 0          # how many cycles this track has been alive
    recent_speeds: list[float] = field(default_factory=list)   # last N speeds
    recent_headings: list[float] = field(default_factory=list) # last N headings
    track_confidence: float = 0.0  # overall track quality (0-1)
    motion_confidence: float = 0.0 # speed/heading stability (0-1)
    smoothed_speed: float = 0.0    # moving average of recent speeds
    reflectivity_dbz: float | None = None
    velocity_delta: float | None = None
    cc_min: float | None = None
    prev_reflectivity_dbz: float | None = None
    prev_velocity_delta: float | None = None
    recent_dbz: list[float] = field(default_factory=list)
    recent_velocity: list[float] = field(default_factory=list)
    intensity_trend: str = "unknown"
    smoothed_heading: float = 0.0
    predicted_lat: float = 0.0
    predicted_lon: float = 0.0
    prediction_minutes: float = 0.0
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
            # Store previous values for intensity trend
            track.prev_reflectivity_dbz = track.reflectivity_dbz
            track.prev_velocity_delta = track.velocity_delta
            track.reflectivity_dbz = c.reflectivity_dbz
            track.velocity_delta = c.velocity_delta
            track.cc_min = c.cc_min
            track.nws_event = c.nws_event
            track.nws_severity = c.nws_severity
            _compute_motion(track)
            _compute_intensity_trend(track)
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
                recent_dbz=[c.reflectivity_dbz] if c.reflectivity_dbz is not None else [],
                recent_velocity=[c.velocity_delta] if c.velocity_delta is not None else [],
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


MAX_RECENT = 5  # how many recent values to keep for smoothing
PREDICTION_MINUTES = 10  # forward projection horizon


def _compute_motion(track: StormTrack):
    """Compute speed, heading, smoothed speed, and confidence from position history."""
    track.total_cycles += 1

    if len(track.positions) < 2:
        track.speed_mph = 0.0
        track.heading_deg = 0.0
        _compute_confidence(track)
        return

    lat1, lon1, t1 = track.positions[-2]
    lat2, lon2, t2 = track.positions[-1]
    dt_hours = (t2 - t1) / 3600.0

    if dt_hours <= 0:
        track.speed_mph = 0.0
        track.heading_deg = 0.0
        _compute_confidence(track)
        return

    dist = haversine_mi(lat1, lon1, lat2, lon2)
    speed = dist / dt_hours

    if speed > MAX_SPEED_MPH:
        track.speed_mph = 0.0
        track.heading_deg = 0.0
        _compute_confidence(track)
        return

    if speed < MIN_SPEED_MPH:
        track.speed_mph = 0.0
        _compute_confidence(track)
        return

    heading = compute_bearing(lat1, lon1, lat2, lon2)

    track.speed_mph = round(speed, 1)
    track.heading_deg = heading

    # Record recent values for smoothing/stability
    track.recent_speeds.append(speed)
    if len(track.recent_speeds) > MAX_RECENT:
        track.recent_speeds = track.recent_speeds[-MAX_RECENT:]

    track.recent_headings.append(heading)
    if len(track.recent_headings) > MAX_RECENT:
        track.recent_headings = track.recent_headings[-MAX_RECENT:]

    # Smoothed speed: simple average of recent
    track.smoothed_speed = round(sum(track.recent_speeds) / len(track.recent_speeds), 1)

    # Smoothed heading: circular mean of recent headings
    track.smoothed_heading = _circular_mean(track.recent_headings)

    # Prediction: project position forward using smoothed speed + heading
    _compute_prediction(track)

    _compute_confidence(track)


def _compute_confidence(track: StormTrack):
    """Compute track_confidence and motion_confidence from track state.

    Rules (deterministic, explainable):
    - track_confidence: based on age, continuity, position count
    - motion_confidence: based on speed/heading stability across recent history
    """
    # --- Track confidence ---
    n_pos = len(track.positions)
    age_factor = min(1.0, n_pos / 4.0)  # 1 pos=0.25, 2=0.5, 3=0.75, 4+=1.0

    # Continuity penalty: missed cycles reduce confidence
    continuity = max(0.0, 1.0 - track.missed_cycles * 0.3)

    track.track_confidence = round(age_factor * continuity, 2)

    # --- Motion confidence ---
    if len(track.recent_speeds) < 2:
        track.motion_confidence = round(track.track_confidence * 0.5, 2)
        return

    # Speed stability: coefficient of variation (std/mean)
    speeds = track.recent_speeds
    mean_speed = sum(speeds) / len(speeds)
    if mean_speed > 0:
        variance = sum((s - mean_speed) ** 2 for s in speeds) / len(speeds)
        cv = (variance ** 0.5) / mean_speed
        speed_stability = max(0.0, 1.0 - cv)  # cv=0 → perfect, cv>1 → terrible
    else:
        speed_stability = 0.5

    # Heading stability: max angular difference between consecutive headings
    headings = track.recent_headings
    heading_diffs = []
    for i in range(1, len(headings)):
        diff = abs(headings[i] - headings[i - 1])
        if diff > 180:
            diff = 360 - diff
        heading_diffs.append(diff)

    if heading_diffs:
        max_diff = max(heading_diffs)
        # <20° = high stability, >45° = low
        heading_stability = max(0.0, 1.0 - max_diff / 60.0)
    else:
        heading_stability = 0.5

    track.motion_confidence = round(
        track.track_confidence * (speed_stability * 0.5 + heading_stability * 0.5), 2
    )


def _circular_mean(angles: list[float]) -> float:
    """Compute circular mean of angles in degrees. Handles wrap-around correctly."""
    if not angles:
        return 0.0
    sin_sum = sum(math.sin(math.radians(a)) for a in angles)
    cos_sum = sum(math.cos(math.radians(a)) for a in angles)
    mean = math.degrees(math.atan2(sin_sum, cos_sum))
    return round(mean % 360, 1)


def _compute_prediction(track: StormTrack):
    """Project storm position forward using smoothed speed and heading.

    Only predicts when motion_confidence is sufficient and speed is meaningful.
    """
    if track.smoothed_speed < MIN_SPEED_MPH or track.motion_confidence < 0.3:
        track.predicted_lat = track.lat
        track.predicted_lon = track.lon
        track.prediction_minutes = 0
        return

    # Distance to travel in PREDICTION_MINUTES
    dist_mi = track.smoothed_speed * (PREDICTION_MINUTES / 60.0)

    # Convert heading to lat/lon offset
    heading_rad = math.radians(track.smoothed_heading)
    # Approximate: 1 degree lat ≈ 69 miles, 1 degree lon ≈ 69 * cos(lat)
    lat_offset = (dist_mi * math.cos(heading_rad)) / 69.0
    cos_lat = math.cos(math.radians(track.lat)) if track.lat != 0 else 1
    lon_offset = (dist_mi * math.sin(heading_rad)) / (69.0 * max(cos_lat, 0.01))

    track.predicted_lat = round(track.lat + lat_offset, 6)
    track.predicted_lon = round(track.lon + lon_offset, 6)
    track.prediction_minutes = PREDICTION_MINUTES


def _compute_intensity_trend(track: StormTrack):
    """Compute whether the storm is strengthening, weakening, or stable.

    Uses history of dbz/velocity values (last 3-5 frames) for sustained trend.
    Single-frame jitter is filtered out.
    """
    # Record current values in history
    if track.reflectivity_dbz is not None:
        track.recent_dbz.append(track.reflectivity_dbz)
        if len(track.recent_dbz) > MAX_RECENT:
            track.recent_dbz = track.recent_dbz[-MAX_RECENT:]

    if track.velocity_delta is not None:
        track.recent_velocity.append(track.velocity_delta)
        if len(track.recent_velocity) > MAX_RECENT:
            track.recent_velocity = track.recent_velocity[-MAX_RECENT:]

    # Need at least 2 values to determine trend
    if len(track.recent_dbz) < 2:
        track.intensity_trend = "unknown"
        return

    # Check sustained direction: compare first vs last in window
    dbz_first = track.recent_dbz[0]
    dbz_last = track.recent_dbz[-1]
    dbz_delta = dbz_last - dbz_first

    vel_delta = 0
    if len(track.recent_velocity) >= 2:
        vel_delta = track.recent_velocity[-1] - track.recent_velocity[0]

    # Sustained threshold: 5 dBZ or 10 kt over the window
    if dbz_delta >= 5 or vel_delta >= 10:
        track.intensity_trend = "strengthening"
    elif dbz_delta <= -5 or vel_delta <= -10:
        track.intensity_trend = "weakening"
    else:
        track.intensity_trend = "stable"


def compute_trend(
    track: StormTrack,
    ref_lat: float, ref_lon: float,
) -> tuple[str, float]:
    """Compute client-relative trend and trend confidence.

    Returns (trend_str, confidence):
    - trend: "closing", "departing", or "unknown"
    - confidence: 0.0-1.0 based on magnitude of change + motion confidence

    Compares distance from client to storm's previous vs current position.
    """
    if track.prev_lat is None or track.prev_lon is None:
        return ("unknown", 0.0)

    prev_dist = haversine_mi(ref_lat, ref_lon, track.prev_lat, track.prev_lon)
    curr_dist = haversine_mi(ref_lat, ref_lon, track.lat, track.lon)
    delta = curr_dist - prev_dist

    if abs(delta) < TREND_THRESHOLD_MI:
        return ("unknown", 0.0)

    # Trend confidence = motion_confidence × magnitude factor
    magnitude = min(1.0, abs(delta) / 5.0)  # 5 mi change = full magnitude
    trend_conf = round(track.motion_confidence * magnitude, 2)

    if delta < -TREND_THRESHOLD_MI:
        return ("closing", trend_conf)
    else:
        return ("departing", trend_conf)


# Singleton tracker
_tracker: StormTracker | None = None


def get_tracker() -> StormTracker:
    global _tracker
    if _tracker is None:
        _tracker = StormTracker()
    return _tracker
