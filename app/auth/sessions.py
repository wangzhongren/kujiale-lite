"""Session tokens: random bearer tokens stored only as SHA-256 hashes."""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any

from app.obs.errors import validation_error

SESSION_COOKIE = "kj_session"
CSRF_COOKIE = "kj_csrf"
TOKEN_BYTES = 32
MAX_TOKEN_LENGTH = 200


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def new_csrf_token() -> str:
    return secrets.token_urlsafe(24)


def create_session(
    connection: sqlite3.Connection,
    user_id: int,
    ttl_hours: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    moment = now or now_utc()
    token = new_token()
    csrf = new_csrf_token()
    expires_epoch = int(moment.timestamp()) + ttl_hours * 3600
    connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(moment.timestamp()),))
    connection.execute(
        "INSERT INTO sessions(user_id, token_hash, csrf_token, created_at, expires_at) "
        "VALUES(?, ?, ?, ?, ?)",
        (user_id, hash_token(token), csrf, iso_utc(moment), expires_epoch),
    )
    return {
        "token": token,
        "csrfToken": csrf,
        "expiresAt": expires_epoch,
    }


def lookup_session(
    connection: sqlite3.Connection,
    token: str | None,
    now: datetime | None = None,
) -> sqlite3.Row | None:
    """Return the joined session/user row, or ``None`` when unusable."""
    if not token or not isinstance(token, str) or len(token) > MAX_TOKEN_LENGTH:
        return None
    moment = now or now_utc()
    row = connection.execute(
        "SELECT s.id AS session_id, s.user_id, s.csrf_token, s.expires_at, "
        "       u.username, u.created_at AS user_created_at "
        "FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ?",
        (hash_token(token),),
    ).fetchone()
    if row is None:
        return None
    if int(row["expires_at"]) <= int(moment.timestamp()):
        connection.execute("DELETE FROM sessions WHERE id = ?", (row["session_id"],))
        return None
    return row


def delete_session(connection: sqlite3.Connection, token: str | None) -> bool:
    if not token or not isinstance(token, str) or len(token) > MAX_TOKEN_LENGTH:
        return False
    cursor = connection.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
    return cursor.rowcount > 0


def ttl_seconds(connection: sqlite3.Connection, session_id: int, now: datetime | None = None) -> int:
    moment = now or now_utc()
    row = connection.execute("SELECT expires_at FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise validation_error("会话不存在或已过期")
    return max(0, int(row["expires_at"]) - int(moment.timestamp()))


def _cookie(name: str, value: str, max_age: int, *, http_only: bool, secure: bool) -> str:
    parts = [f"{name}={value}", f"Max-Age={max(0, int(max_age))}", "Path=/", "SameSite=Lax"]
    if http_only:
        parts.append("HttpOnly")
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def session_cookie(token: str, max_age: int, secure: bool = False) -> str:
    return _cookie(SESSION_COOKIE, token, max_age, http_only=True, secure=secure)


def csrf_cookie(token: str, max_age: int, secure: bool = False) -> str:
    # Readable by the same-origin frontend for the double-submit header.
    return _cookie(CSRF_COOKIE, token, max_age, http_only=False, secure=secure)


def clear_cookie_headers() -> list[str]:
    return [
        f"{SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
        f"{CSRF_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax",
    ]
