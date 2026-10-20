"""Read-only share links: token issue, revocation and resolution."""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
from typing import Any

from app.obs.errors import AppError
from app.plans import repository

TOKEN_BYTES = 32
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,100}$")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_share(database, user_id: int, plan_id: int, now_iso: str) -> dict[str, Any]:
    token = secrets.token_urlsafe(TOKEN_BYTES)
    with database.transaction() as connection:
        plan = repository.get_plan(connection, user_id, plan_id)
        if plan is None:
            raise AppError("NOT_FOUND", "方案不存在")
        # Only one active share per plan: issuing a new token revokes the old.
        connection.execute(
            "UPDATE shares SET revoked_at = ? WHERE plan_id = ? AND revoked_at IS NULL",
            (now_iso, plan_id),
        )
        connection.execute(
            "INSERT INTO shares(plan_id, token_hash, created_at) VALUES(?, ?, ?)",
            (plan_id, hash_token(token), now_iso),
        )
    return {
        "token": token,
        "url": f"/share/{token}",
        "createdAt": now_iso,
    }


def revoke_share(database, user_id: int, plan_id: int, now_iso: str) -> bool:
    with database.transaction() as connection:
        plan = repository.get_plan(connection, user_id, plan_id)
        if plan is None:
            raise AppError("NOT_FOUND", "方案不存在")
        cursor = connection.execute(
            "UPDATE shares SET revoked_at = ? WHERE plan_id = ? AND revoked_at IS NULL",
            (now_iso, plan_id),
        )
        return cursor.rowcount > 0


def resolve_share(database, token: str) -> sqlite3.Row:
    """Return the plan row behind an active token; invalid tokens are 404."""
    if not isinstance(token, str) or not TOKEN_PATTERN.match(token):
        raise AppError("NOT_FOUND", "分享链接不存在或已失效")
    with database.connection() as connection:
        row = connection.execute(
            "SELECT p.id, p.user_id, p.name, p.doc, p.revision, p.created_at, p.updated_at, "
            "       s.id AS share_id, s.created_at AS share_created_at "
            "FROM shares s JOIN plans p ON p.id = s.plan_id "
            "WHERE s.token_hash = ? AND s.revoked_at IS NULL",
            (hash_token(token),),
        ).fetchone()
    if row is None:
        raise AppError("NOT_FOUND", "分享链接不存在或已失效")
    return row
