"""
Storm Tracker — Centralized Structured Logging

JSON-structured logs to stdout (journalctl) + rotating file.
Per-request correlation IDs via middleware.
Module-specific logger acquisition via get_logger().

Usage:
    from logging_config import get_logger
    logger = get_logger("ingest")
    logger.info("ingest_cycle_end", stored=317, purged=170, elapsed_ms=4237)
"""

import logging
import logging.handlers
import json
import time
import os
import uuid
import contextvars
from datetime import datetime, timezone
from pathlib import Path

# ── Request correlation ID (set per-request by middleware) ────────
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# ── Log directory ─────────────────────────────────────────────────
LOG_DIR = Path(os.environ.get("LOG_DIR", "./data/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── Rotation: 5MB per file, keep 5 rotated files (25MB total max) ─
LOG_FILE = LOG_DIR / "storm_tracker.jsonl"
MAX_BYTES = 5 * 1024 * 1024
BACKUP_COUNT = 5

# ── Sensitive field redaction ─────────────────────────────────────
REDACT_FIELDS = {"token", "password", "secret", "api_key", "authorization", "cookie"}


def _redact(obj):
    """Recursively redact sensitive fields from a dict."""
    if not isinstance(obj, dict):
        return obj
    return {
        k: "***REDACTED***" if k.lower() in REDACT_FIELDS else _redact(v)
        for k, v in obj.items()
    }


class StructuredJSONFormatter(logging.Formatter):
    """Formats log records as single-line JSON objects."""

    def format(self, record):
        ts = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat()

        entry = {
            "ts": ts,
            "level": record.levelname,
            "service": "storm-tracker",
            "module": record.name,
            "event": getattr(record, "event", None) or record.getMessage(),
            "message": record.getMessage(),
            "request_id": request_id_var.get("-"),
        }

        # Add structured extra fields
        extra = getattr(record, "extra_data", None)
        if extra and isinstance(extra, dict):
            entry["extra"] = _redact(extra)

        # Add specific context fields if present
        for field in ("alert_id", "user_action", "client_module", "client_level"):
            val = getattr(record, field, None)
            if val is not None:
                entry[field] = val

        # Add exception info
        if record.exc_info and record.exc_info[0]:
            entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(entry, default=str, ensure_ascii=False)


class StructuredLogAdapter(logging.LoggerAdapter):
    """Logger adapter that supports structured keyword arguments.

    Usage:
        logger.info("ingest_cycle_end", stored=317, purged=170)
        logger.error("fetch_failed", alert_id="abc123", exc_info=True)
    """

    def process(self, msg, kwargs):
        # Extract our custom fields from kwargs
        extra = kwargs.get("extra", {})

        # Pull structured fields from kwargs
        structured = {}
        passthrough_keys = {"exc_info", "stack_info", "stacklevel", "extra"}
        for k, v in list(kwargs.items()):
            if k not in passthrough_keys:
                structured[k] = v

        # Remove non-standard kwargs that logging.Logger doesn't accept
        for k in list(kwargs.keys()):
            if k not in passthrough_keys:
                del kwargs[k]

        # Attach structured data to extra
        extra["extra_data"] = structured
        # Preserve event name (the msg itself)
        extra["event"] = msg
        kwargs["extra"] = extra

        return msg, kwargs


def get_logger(module_name: str) -> StructuredLogAdapter:
    """Get a structured logger for a module.

    Args:
        module_name: Short name like "ingest", "alerts", "radar", "detection"

    Returns:
        StructuredLogAdapter with JSON formatting support
    """
    logger = logging.getLogger(f"st.{module_name}")
    return StructuredLogAdapter(logger, {})


def setup_logging(level: str = "INFO"):
    """Initialize the centralized logging system.

    Call once at application startup (in main.py lifespan).
    Sets up:
    - JSON formatter on root logger
    - Rotating file handler (5MB × 5 files)
    - Stream handler (stdout → journalctl)
    """
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Remove existing handlers (avoid duplicate from basicConfig)
    root.handlers.clear()

    formatter = StructuredJSONFormatter()

    # Stream handler → stdout → journalctl
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    root.addHandler(stream_handler)

    # Rotating file handler
    try:
        file_handler = logging.handlers.RotatingFileHandler(
            str(LOG_FILE),
            maxBytes=MAX_BYTES,
            backupCount=BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except (OSError, PermissionError) as e:
        # Don't crash if file logging fails
        root.warning(f"File logging unavailable: {e}")

    # Suppress noisy third-party loggers
    for name in ("uvicorn.access", "uvicorn.error", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)

    root.info("Structured logging initialized", extra={
        "extra_data": {"log_file": str(LOG_FILE), "level": level},
        "event": "logging_initialized",
    })
