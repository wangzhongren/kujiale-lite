"""JSON-lines structured logging.

Every request emits one JSON object with ``ts/level/event/requestId/route/
status/durationMs/errCode``.  Sensitive keys are redacted defensively even if
a caller passes them by mistake; request bodies, cookies and authorization
headers are never logged by the HTTP layer.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any, TextIO

LOGGER_NAME = "kujiale"

SENSITIVE_FIELDS = frozenset(
    {
        "password",
        "passwordhash",
        "token",
        "tokenhash",
        "sessiontoken",
        "cookie",
        "setcookie",
        "authorization",
        "csrf",
        "csrftoken",
        "secret",
    }
)

REDACTED = "[redacted]"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sanitize_fields(fields: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in fields.items():
        if key.lower() in SENSITIVE_FIELDS:
            clean[key] = REDACTED
        elif isinstance(value, (str, int, float, bool)) or value is None:
            clean[key] = value
        else:
            clean[key] = str(value)
    return clean


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": _utc_now_iso(),
            "level": record.levelname,
            "event": getattr(record, "event", "log"),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(sanitize_fields(fields))
        message = record.getMessage()
        if message:
            payload.setdefault("message", message)
        if record.exc_info:
            exc_type = record.exc_info[0]
            payload["excType"] = exc_type.__name__ if exc_type else "Exception"
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def configure_logging(level: str = "INFO", stream: TextIO | None = None) -> logging.Logger:
    logger = logging.getLogger(LOGGER_NAME)
    logger.handlers.clear()
    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    logger.propagate = False
    return logger


def get_logger(name: str | None = None) -> logging.Logger:
    if name:
        return logging.getLogger(f"{LOGGER_NAME}.{name}")
    return logging.getLogger(LOGGER_NAME)


def log_event(logger: logging.Logger, level: int, event: str, **fields: Any) -> None:
    """Emit one structured event.  Never pass secrets as field values."""
    logger.log(level, "", extra={"event": event, "fields": fields})
