"""Request parsing with strict size limits and hardened JSON handling."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from app.obs.errors import AppError

MAX_BODY_BYTES = 2 * 1024 * 1024 + 64 * 1024
MAX_HEADER_BYTES = 32 * 1024
MAX_QUERY_BYTES = 4096


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: Any
    body: bytes
    request_id: str
    client_ip: str
    cookies: dict[str, str] = field(default_factory=dict)
    route: str = "unmatched"
    session: Any = None
    user_id: int | None = None
    session_token: str | None = None

    def header(self, name: str, default: str | None = None) -> str | None:
        value = self.headers.get(name)
        return default if value is None else value

    def cookie(self, name: str) -> str | None:
        return self.cookies.get(name)

    def query_one(self, name: str) -> str | None:
        values = self.query.get(name)
        return values[0] if values else None

    def require_json_content_type(self) -> None:
        content_type = self.header("Content-Type") or ""
        media_type = content_type.split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            raise AppError(
                "UNSUPPORTED_MEDIA_TYPE",
                "请求必须使用 application/json",
                {"contentType": media_type or None},
            )

    def json_object(self) -> dict[str, Any]:
        self.require_json_content_type()
        if not self.body:
            raise AppError("VALIDATION_FAILED", "请求体不能为空", {"field": "body"})
        try:
            text = self.body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AppError("VALIDATION_FAILED", "请求体必须是 UTF-8 编码", {"field": "body"}) from exc
        try:
            payload = json.loads(
                text,
                parse_constant=_reject_constant,
                object_pairs_hook=_no_duplicate_keys,
            )
        except _DuplicateKeyError as exc:
            raise AppError("VALIDATION_FAILED", f"JSON 中存在重复键：{exc.key}", {"field": "body"}) from exc
        except RecursionError as exc:
            raise AppError("VALIDATION_FAILED", "JSON 嵌套过深", {"field": "body"}) from exc
        except ValueError as exc:
            raise AppError("VALIDATION_FAILED", "请求体不是合法 JSON", {"field": "body"}) from exc
        if not isinstance(payload, dict):
            raise AppError("VALIDATION_FAILED", "请求体必须是 JSON 对象", {"field": "body"})
        return payload


class _DuplicateKeyError(ValueError):
    def __init__(self, key: str) -> None:
        super().__init__(f"duplicate key {key}")
        self.key = key


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value}")


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKeyError(key)
        result[key] = value
    return result


def _parse_cookies(header_value: str | None) -> dict[str, str]:
    if not header_value:
        return {}
    jar: SimpleCookie = SimpleCookie()
    try:
        jar.load(header_value)
    except Exception:
        return {}
    return {name: morsel.value for name, morsel in jar.items()}


def read_request(handler, request_id: str) -> Request:
    raw_target = handler.path
    if not isinstance(raw_target, str) or "\x00" in raw_target or "\\" in raw_target:
        raise AppError("NOT_FOUND", "资源不存在")

    try:
        parts = urlsplit(raw_target)
    except ValueError as exc:
        # Malformed IPv6 authority or similar parser-level garbage.
        raise AppError("NOT_FOUND", "资源不存在") from exc
    if parts.netloc:
        # Origin-form targets must not carry an authority component.
        raise AppError("NOT_FOUND", "资源不存在")
    if len(parts.query) > MAX_QUERY_BYTES:
        raise AppError("PAYLOAD_TOO_LARGE", "查询字符串过长", {"maxBytes": MAX_QUERY_BYTES})
    try:
        path = unquote(parts.path, errors="strict")
    except UnicodeDecodeError as exc:
        raise AppError("NOT_FOUND", "资源不存在") from exc
    if "\x00" in path or "\\" in path:
        raise AppError("NOT_FOUND", "资源不存在")
    if not path.startswith("/"):
        raise AppError("NOT_FOUND", "资源不存在")
    if len(path) > 1:
        path = path.rstrip("/") or "/"

    headers = handler.headers
    header_bytes = sum(len(str(key)) + len(str(value)) for key, value in headers.items())
    if header_bytes > MAX_HEADER_BYTES:
        handler.close_connection = True
        raise AppError(
            "PAYLOAD_TOO_LARGE",
            "请求头过大",
            {"maxBytes": MAX_HEADER_BYTES},
            headers={"Connection": "close"},
        )

    transfer_encoding = headers.get("Transfer-Encoding")
    if transfer_encoding:
        handler.close_connection = True
        raise AppError(
            "UNSUPPORTED_MEDIA_TYPE",
            "不支持分块传输编码",
            {"transferEncoding": transfer_encoding},
            headers={"Connection": "close"},
        )

    lengths = headers.get_all("Content-Length") or []
    if len(lengths) > 1:
        handler.close_connection = True
        raise AppError(
            "VALIDATION_FAILED",
            "Content-Length 重复",
            headers={"Connection": "close"},
        )

    body = b""
    if lengths:
        raw_length = lengths[0].strip()
        try:
            length = int(raw_length)
        except ValueError as exc:
            handler.close_connection = True
            raise AppError(
                "VALIDATION_FAILED",
                "Content-Length 不合法",
                headers={"Connection": "close"},
            ) from exc
        if length < 0:
            handler.close_connection = True
            raise AppError("VALIDATION_FAILED", "Content-Length 不合法", headers={"Connection": "close"})
        if length > MAX_BODY_BYTES:
            handler.close_connection = True
            raise AppError(
                "PAYLOAD_TOO_LARGE",
                "请求体超过大小上限",
                {"maxBytes": MAX_BODY_BYTES, "contentLength": length},
                headers={"Connection": "close"},
            )
        if length:
            body = handler.rfile.read(length)
            if len(body) != length:
                handler.close_connection = True
                raise AppError(
                    "VALIDATION_FAILED",
                    "请求体读取不完整",
                    headers={"Connection": "close"},
                )

    return Request(
        method=handler.command.upper(),
        path=path,
        query=parse_qs(parts.query, keep_blank_values=True),
        headers=headers,
        body=body,
        request_id=request_id,
        client_ip=handler.client_address[0] if handler.client_address else "unknown",
        cookies=_parse_cookies(headers.get("Cookie")),
    )
