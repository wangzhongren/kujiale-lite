"""Response construction and hardened headers."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.obs.errors import AppError

SECURITY_HEADERS: dict[str, str] = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
        "frame-ancestors 'none'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
}

JSON_CONTENT_TYPE = "application/json; charset=utf-8"


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    content_type: str = JSON_CONTENT_TYPE
    headers: dict[str, str] = field(default_factory=dict)
    cookies: list[str] = field(default_factory=list)
    cache_control: str = "no-store"

    @classmethod
    def json(
        cls,
        payload: Any,
        status: int = 200,
        *,
        headers: Mapping[str, str] | None = None,
        cookies: list[str] | None = None,
        cache_control: str = "no-store",
    ) -> "Response":
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        return cls(
            status=status,
            body=body,
            content_type=JSON_CONTENT_TYPE,
            headers=dict(headers or {}),
            cookies=list(cookies or []),
            cache_control=cache_control,
        )

    @classmethod
    def bytes(
        cls,
        data: bytes,
        content_type: str,
        status: int = 200,
        *,
        headers: Mapping[str, str] | None = None,
        cookies: list[str] | None = None,
        cache_control: str = "no-store",
    ) -> "Response":
        return cls(
            status=status,
            body=data,
            content_type=content_type,
            headers=dict(headers or {}),
            cookies=list(cookies or []),
            cache_control=cache_control,
        )

    @classmethod
    def empty(
        cls,
        status: int = 204,
        *,
        headers: Mapping[str, str] | None = None,
        cookies: list[str] | None = None,
    ) -> "Response":
        return cls(
            status=status,
            body=b"",
            content_type=JSON_CONTENT_TYPE,
            headers=dict(headers or {}),
            cookies=list(cookies or []),
            cache_control="no-store",
        )

    def send(self, handler, request_id: str) -> None:
        handler.send_response(self.status)
        handler.send_header("Content-Type", self.content_type)
        handler.send_header("X-Request-Id", request_id)
        handler.send_header("Cache-Control", self.cache_control)
        for name, value in SECURITY_HEADERS.items():
            handler.send_header(name, value)
        for name, value in self.headers.items():
            handler.send_header(name, value)
        if self.status not in {204, 304}:
            handler.send_header("Content-Length", str(len(self.body)))
        for cookie in self.cookies:
            handler.send_header("Set-Cookie", cookie)
        if handler.close_connection:
            handler.send_header("Connection", "close")
        handler.end_headers()
        if handler.command != "HEAD" and self.status not in {204, 304} and self.body:
            handler.wfile.write(self.body)


def error_response(error: AppError, request_id: str) -> Response:
    return Response.json(
        error.to_body(request_id),
        status=error.status,
        headers=error.headers,
    )
