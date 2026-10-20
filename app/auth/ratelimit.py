"""Login rate limiting backed by the ``login_attempts`` table."""

from __future__ import annotations

import sqlite3
from datetime import datetime

WINDOW_SECONDS = 15 * 60
MAX_FAILURES = 5
RETENTION_SECONDS = 24 * 3600


def _epoch(now: datetime) -> int:
    return int(now.timestamp())


def _failure_count(connection: sqlite3.Connection, username: str, ip: str, now: datetime) -> int:
    # Limits are per account: a failure on ``alice`` must not lock ``bob`` just
    # because both are used from the same loopback address.  The IP is still
    # recorded for audit and for operators who want stricter edge rules.
    row = connection.execute(
        "SELECT COUNT(*) AS failures FROM login_attempts "
        "WHERE success = 0 AND attempted_at >= ? AND username = ?",
        (_epoch(now) - WINDOW_SECONDS, username),
    ).fetchone()
    return int(row["failures"]) if row else 0


def retry_after_seconds(connection: sqlite3.Connection, username: str, ip: str, now: datetime) -> int:
    row = connection.execute(
        "SELECT MIN(attempted_at) AS oldest FROM login_attempts "
        "WHERE success = 0 AND attempted_at >= ? AND username = ?",
        (_epoch(now) - WINDOW_SECONDS, username),
    ).fetchone()
    if row is None or row["oldest"] is None:
        return WINDOW_SECONDS
    remaining = int(row["oldest"]) + WINDOW_SECONDS - _epoch(now)
    return max(1, remaining)


def is_rate_limited(connection: sqlite3.Connection, username: str, ip: str, now: datetime) -> bool:
    return _failure_count(connection, username, ip, now) >= MAX_FAILURES


def record_attempt(
    connection: sqlite3.Connection,
    username: str,
    ip: str,
    success: bool,
    now: datetime,
) -> None:
    # Opportunistic retention pruning keeps the table bounded.
    connection.execute(
        "DELETE FROM login_attempts WHERE attempted_at < ?", (_epoch(now) - RETENTION_SECONDS,)
    )
    if success:
        connection.execute(
            "DELETE FROM login_attempts WHERE username = ?", (username,)
        )
        return
    connection.execute(
        "INSERT INTO login_attempts(username, ip, attempted_at, success) VALUES(?, ?, ?, 0)",
        (username, ip, _epoch(now)),
    )
