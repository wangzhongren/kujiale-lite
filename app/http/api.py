"""API v1 route table and handlers.

Transport-only: parsing/response shaping happens here; all domain rules live
in ``app.plans`` / ``app.share`` / ``app.auth``.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from typing import Any

from app.auth import ratelimit, sessions
from app.auth.passwords import dummy_verify, hash_password, validate_password, verify_password
from app.http.response import Response
from app.http.router import Router
from app.obs.errors import AppError, validation_error
from app.share import service as share_service

USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.\-一-鿿]{3,32}$")
MAX_LOGIN_PASSWORD_INPUT = 512


def build_router(app) -> Router:
    router = Router()
    router.add("POST", "/api/v1/auth/register", register, auth="none", csrf=False)
    router.add("POST", "/api/v1/auth/login", login, auth="none", csrf=False)
    router.add("POST", "/api/v1/auth/logout", logout, auth="required", csrf=True)
    router.add("GET", "/api/v1/auth/me", me, auth="required", csrf=False)

    router.add("GET", "/api/v1/plans", list_plans, auth="required", csrf=False)
    router.add("POST", "/api/v1/plans", create_plan, auth="required", csrf=True)
    router.add("GET", "/api/v1/plans/{plan_id}", get_plan, auth="required", csrf=False)
    router.add("PUT", "/api/v1/plans/{plan_id}", update_plan, auth="required", csrf=True)
    router.add("DELETE", "/api/v1/plans/{plan_id}", delete_plan, auth="required", csrf=True)
    router.add(
        "POST", "/api/v1/plans/{plan_id}/share", create_share, auth="required", csrf=True
    )
    router.add(
        "DELETE", "/api/v1/plans/{plan_id}/share", revoke_share, auth="required", csrf=True
    )
    router.add(
        "GET", "/api/v1/plans/{plan_id}/export.csv", export_plan_csv, auth="required", csrf=False
    )

    router.add("GET", "/api/v1/share/{token}", get_shared_plan, auth="none", csrf=False)
    router.add(
        "GET", "/api/v1/share/{token}/export.csv", export_shared_csv, auth="none", csrf=False
    )
    router.add("GET", "/api/v1/catalog", get_catalog, auth="none", csrf=False)
    router.add("GET", "/api/v1/sample", get_sample, auth="required", csrf=False)
    return router


# --------------------------------------------------------------------------- auth
def register(app, request, params, connection):
    payload = request.json_object()
    username = _validate_username(payload.get("username"))
    password = validate_password(payload.get("password"))
    password_hash = hash_password(password)
    now_iso = sessions.iso_utc(app.now())
    try:
        with app.db.transaction() as transaction:
            cursor = transaction.execute(
                "INSERT INTO users(username, password_hash, created_at) VALUES(?, ?, ?)",
                (username, password_hash, now_iso),
            )
            user_id = int(cursor.lastrowid)
    except sqlite3.IntegrityError as exc:
        raise AppError(
            "CONFLICT_USERNAME", "用户名已被占用", {"field": "username"}
        ) from exc
    return Response.json(
        {"user": {"id": user_id, "username": username, "createdAt": now_iso}},
        status=201,
    )


def login(app, request, params, connection):
    payload = request.json_object()
    raw_username = payload.get("username")
    raw_password = payload.get("password")
    if not isinstance(raw_username, str) or not raw_username.strip() or len(raw_username) > 64:
        raise validation_error("请输入用户名", "username")
    if (
        not isinstance(raw_password, str)
        or not raw_password
        or len(raw_password) > MAX_LOGIN_PASSWORD_INPUT
    ):
        raise validation_error("请输入密码", "password")
    username = raw_username.strip()
    try:
        username.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise validation_error("用户名包含非法字符", "username") from exc
    rate_key = username.lower()
    now = app.now()

    if ratelimit.is_rate_limited(connection, rate_key, request.client_ip, now):
        retry = ratelimit.retry_after_seconds(connection, rate_key, request.client_ip, now)
        raise AppError(
            "AUTH_RATE_LIMITED",
            "登录尝试过于频繁，请稍后再试",
            {"retryAfterSeconds": retry},
            headers={"Retry-After": str(retry)},
        )

    user = connection.execute(
        "SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    if user is None:
        dummy_verify(raw_password)
        authenticated = False
    else:
        authenticated = verify_password(raw_password, user["password_hash"])

    if not authenticated:
        with app.db.transaction() as transaction:
            ratelimit.record_attempt(
                transaction, rate_key, request.client_ip, False, now
            )
        raise AppError("AUTH_INVALID_CREDENTIALS", "用户名或密码不正确")

    with app.db.transaction() as transaction:
        ratelimit.record_attempt(transaction, rate_key, request.client_ip, True, now)
        created = sessions.create_session(
            transaction, int(user["id"]), app.config.session_ttl_hours, now
        )

    max_age = app.config.session_ttl_hours * 3600
    secure = app.config.secure_cookie
    cookies = [
        sessions.session_cookie(created["token"], max_age, secure),
        sessions.csrf_cookie(created["csrfToken"], max_age, secure),
    ]
    return Response.json(
        {
            "user": {
                "id": int(user["id"]),
                "username": user["username"],
                "createdAt": user["created_at"],
            },
            "csrfToken": created["csrfToken"],
            "expiresAt": _epoch_iso(created["expiresAt"]),
        },
        cookies=cookies,
    )


def logout(app, request, params, connection):
    with app.db.transaction() as transaction:
        sessions.delete_session(transaction, request.session_token)
    return Response.empty(204, cookies=sessions.clear_cookie_headers())


def me(app, request, params, connection):
    session = request.session
    expires_at = int(session["expires_at"])
    remaining = max(1, expires_at - int(app.now().timestamp()))
    return Response.json(
        {
            "user": {
                "id": int(session["user_id"]),
                "username": session["username"],
                "createdAt": session["user_created_at"],
            },
            "csrfToken": session["csrf_token"],
            "expiresAt": _epoch_iso(expires_at),
        },
        cookies=[
            sessions.csrf_cookie(session["csrf_token"], remaining, app.config.secure_cookie)
        ],
    )


# -------------------------------------------------------------------------- plans
def list_plans(app, request, params, connection):
    page = _int_query(request, "page", 1)
    page_size = _int_query(request, "pageSize", 20)
    query = request.query_one("q")
    return Response.json(app.plans.list(request.user_id, page, page_size, query))


def create_plan(app, request, params, connection):
    if request.body:
        payload = request.json_object()
    else:
        payload = {}
    return Response.json(app.plans.create(request.user_id, payload), status=201)


def get_plan(app, request, params, connection):
    plan_id = _plan_id(params)
    return Response.json(app.plans.get(request.user_id, plan_id))


def update_plan(app, request, params, connection):
    plan_id = _plan_id(params)
    payload = request.json_object()
    return Response.json(app.plans.update(request.user_id, plan_id, payload))


def delete_plan(app, request, params, connection):
    plan_id = _plan_id(params)
    app.plans.delete(request.user_id, plan_id)
    return Response.empty(204)


def create_share(app, request, params, connection):
    plan_id = _plan_id(params)
    data = share_service.create_share(
        app.db, request.user_id, plan_id, sessions.iso_utc(app.now())
    )
    return Response.json(data, status=201)


def revoke_share(app, request, params, connection):
    plan_id = _plan_id(params)
    share_service.revoke_share(
        app.db, request.user_id, plan_id, sessions.iso_utc(app.now())
    )
    return Response.empty(204)


def export_plan_csv(app, request, params, connection):
    plan_id = _plan_id(params)
    data, disposition = app.plans.csv_for_owner(request.user_id, plan_id)
    return _csv_response(data, disposition)


# -------------------------------------------------------------------------- share
def get_shared_plan(app, request, params, connection):
    row = share_service.resolve_share(app.db, params["token"])
    return Response.json(app.plans.share_view(row))


def export_shared_csv(app, request, params, connection):
    row = share_service.resolve_share(app.db, params["token"])
    data, disposition = app.plans.csv_payload(row)
    return _csv_response(data, disposition)


# ------------------------------------------------------------------------ catalog
def get_catalog(app, request, params, connection):
    return Response.json(app.catalog, cache_control="public, max-age=300")


def get_sample(app, request, params, connection):
    return Response.json(app.sample)


# ------------------------------------------------------------------------ helpers
def _validate_username(value: object) -> str:
    if not isinstance(value, str):
        raise validation_error("用户名必须是字符串", "username")
    username = value.strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise validation_error(
            "用户名需为 3-32 位字母、数字、下划线、点、连字符或汉字", "username"
        )
    try:
        username.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise validation_error("用户名包含非法字符", "username") from exc
    return username


def _int_query(request, name: str, default: int) -> int:
    raw = request.query_one(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{name} 必须是整数", name) from exc
    if value < 1:
        raise validation_error(f"{name} 必须大于等于 1", name)
    return value


def _plan_id(params: dict[str, Any]) -> int:
    raw = params.get("plan_id", "")
    if not isinstance(raw, str) or not raw.isdigit():
        raise AppError("NOT_FOUND", "方案不存在")
    plan_id = int(raw)
    if plan_id < 1:
        raise AppError("NOT_FOUND", "方案不存在")
    return plan_id


def _epoch_iso(epoch: int) -> str:
    return datetime.fromtimestamp(int(epoch), timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")


def _csv_response(data: bytes, disposition: str) -> Response:
    return Response.bytes(
        data,
        "text/csv; charset=utf-8",
        headers={"Content-Disposition": disposition},
    )
