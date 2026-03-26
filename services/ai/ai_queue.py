"""
Storm Tracker — AI Job Queue

Async queue for AI inference jobs. Prevents UI blocking.
Jobs are processed by a single worker to serialize GPU access.
"""

import asyncio
import time
import logging
from dataclasses import dataclass, field
from typing import Optional, Any
from enum import Enum

logger = logging.getLogger(__name__)


class JobType(str, Enum):
    SUMMARY = "summary"
    NARRATION = "narration"
    PRIORITY = "priority"
    INTERPRETATION = "interpretation"


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    DROPPED = "dropped"


@dataclass
class AIJob:
    job_type: JobType
    payload: dict = field(default_factory=dict)
    status: JobStatus = JobStatus.QUEUED
    result: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    job_id: str = ""

    def elapsed_ms(self) -> Optional[float]:
        if self.started_at and self.completed_at:
            return (self.completed_at - self.started_at) * 1000
        return None


# ── Queue State ─────────────────────────────────────────────────

_queue: asyncio.Queue | None = None
_max_depth = 10
_job_counter = 0
_stats = {
    "total_enqueued": 0,
    "total_completed": 0,
    "total_failed": 0,
    "total_dropped": 0,
    "last_job": None,
}


def init(max_depth: int = 10):
    global _queue, _max_depth
    _max_depth = max_depth
    _queue = asyncio.Queue(maxsize=max_depth)
    logger.info(f"AI queue initialized (max_depth={max_depth})")


def get_queue() -> asyncio.Queue:
    if _queue is None:
        init()
    return _queue


async def enqueue(job: AIJob) -> bool:
    """Add a job to the queue. Returns False if dropped."""
    global _job_counter
    _job_counter += 1
    job.job_id = f"ai-{_job_counter:06d}"

    q = get_queue()

    if q.full():
        # Drop oldest by getting and discarding
        try:
            dropped = q.get_nowait()
            dropped.status = JobStatus.DROPPED
            _stats["total_dropped"] += 1
            logger.warning(f"AI queue full — dropped job {dropped.job_id} ({dropped.job_type.value})")
        except asyncio.QueueEmpty:
            pass

    try:
        q.put_nowait(job)
        _stats["total_enqueued"] += 1
        logger.debug(f"AI job enqueued: {job.job_id} ({job.job_type.value}) depth={q.qsize()}")
        return True
    except asyncio.QueueFull:
        job.status = JobStatus.DROPPED
        _stats["total_dropped"] += 1
        return False


def get_stats() -> dict:
    q = get_queue()
    return {
        **_stats,
        "queue_depth": q.qsize(),
        "max_depth": _max_depth,
    }


def record_complete(job: AIJob):
    _stats["total_completed"] += 1
    _stats["last_job"] = {
        "job_id": job.job_id,
        "type": job.job_type.value,
        "status": job.status.value,
        "elapsed_ms": job.elapsed_ms(),
    }


def record_failure(job: AIJob):
    _stats["total_failed"] += 1
    _stats["last_job"] = {
        "job_id": job.job_id,
        "type": job.job_type.value,
        "status": job.status.value,
        "error": job.error,
    }
