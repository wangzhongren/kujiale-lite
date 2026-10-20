"""CSRF double-submit helpers and browser origin checks."""

from __future__ import annotations

import hmac
from urllib.parse import urlsplit

from app.obs.errors import AppError

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def verify_double_submit(cookie_value: str | None, header_value: str | None, stored_value: str | None) -> bool:
    if not cookie_value or not header_value or not stored_value:
        return False
    return bool(
        hmac.compare_digest(cookie_value, header_value)
        and hmac.compare_digest(cookie_value, stored_value)
    )


def check_origin(origin: str | None, allowed_origins: frozenset[str]) -> None:
    """Reject cross-site state-changing requests when a browser sends Origin."""
    if origin is None:
        return
    normalized = origin.strip()
    if normalized in {"null", ""}:
        raise AppError("FORBIDDEN", "请求来源不被允许", {"reason": "origin"})
    parts = urlsplit(normalized)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise AppError("FORBIDDEN", "请求来源不被允许", {"reason": "origin"})
    candidate = f"{parts.scheme}://{parts.netloc}"
    if candidate not in allowed_origins:
        raise AppError("FORBIDDEN", "请求来源不被允许", {"reason": "origin"})


def check_fetch_site(value: str | None) -> None:
    """``Sec-Fetch-Site`` is a modern browser hint; reject obvious cross-site."""
    if value is None:
        return
    if value not in {"same-origin", "none"}:
        raise AppError("FORBIDDEN", "跨站请求被拒绝", {"reason": "fetch-site"})
