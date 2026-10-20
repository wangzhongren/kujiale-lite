"""Parameterised SQL for plan rows.  Every query is scoped by ``user_id``."""

from __future__ import annotations

import sqlite3
from typing import Any

from app.obs.errors import AppError


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def get_plan(connection: sqlite3.Connection, user_id: int, plan_id: int) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT id, user_id, name, doc, revision, created_at, updated_at "
        "FROM plans WHERE id = ? AND user_id = ?",
        (plan_id, user_id),
    ).fetchone()


def list_plans(
    connection: sqlite3.Connection,
    user_id: int,
    *,
    limit: int,
    offset: int,
    query: str | None = None,
) -> tuple[list[sqlite3.Row], int]:
    where = "user_id = ?"
    params: list[Any] = [user_id]
    if query:
        where += " AND name LIKE ? ESCAPE '\\'"
        params.append(f"%{_escape_like(query)}%")
    total_row = connection.execute(f"SELECT COUNT(*) AS total FROM plans WHERE {where}", params).fetchone()
    total = int(total_row["total"]) if total_row else 0
    rows = connection.execute(
        "SELECT id, user_id, name, doc, revision, created_at, updated_at "
        f"FROM plans WHERE {where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return list(rows), total


def create_plan(
    connection: sqlite3.Connection,
    user_id: int,
    name: str,
    document_json: str,
    now_iso: str,
) -> sqlite3.Row:
    cursor = connection.execute(
        "INSERT INTO plans(user_id, name, doc, revision, created_at, updated_at) "
        "VALUES(?, ?, ?, 1, ?, ?)",
        (user_id, name, document_json, now_iso, now_iso),
    )
    row = get_plan(connection, user_id, int(cursor.lastrowid))
    if row is None:  # pragma: no cover - insert and select share a transaction
        raise AppError("INTERNAL", "方案创建失败")
    return row


def update_plan(
    connection: sqlite3.Connection,
    user_id: int,
    plan_id: int,
    *,
    name: str,
    document_json: str,
    expected_revision: int,
    now_iso: str,
) -> sqlite3.Row:
    current = get_plan(connection, user_id, plan_id)
    if current is None:
        # Other users' plans are indistinguishable from missing ones (404).
        raise AppError("NOT_FOUND", "方案不存在")
    if int(current["revision"]) != int(expected_revision):
        raise AppError(
            "CONFLICT_REVISION",
            "方案已在别处更新，请重新载入",
            {
                "expectedRevision": int(expected_revision),
                "currentRevision": int(current["revision"]),
            },
        )
    cursor = connection.execute(
        "UPDATE plans SET name = ?, doc = ?, revision = revision + 1, updated_at = ? "
        "WHERE id = ? AND user_id = ? AND revision = ?",
        (name, document_json, now_iso, plan_id, user_id, int(expected_revision)),
    )
    if cursor.rowcount != 1:
        raise AppError(
            "CONFLICT_REVISION",
            "方案已在别处更新，请重新载入",
            {"expectedRevision": int(expected_revision)},
        )
    row = get_plan(connection, user_id, plan_id)
    if row is None:  # pragma: no cover - defensive
        raise AppError("INTERNAL", "方案更新后读取失败")
    return row


def delete_plan(connection: sqlite3.Connection, user_id: int, plan_id: int) -> bool:
    cursor = connection.execute(
        "DELETE FROM plans WHERE id = ? AND user_id = ?", (plan_id, user_id)
    )
    return cursor.rowcount == 1
