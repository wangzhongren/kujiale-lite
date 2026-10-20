"""Application error codes and the unified error body.

Codes are part of the frozen v1 contract.  The contract allows *adding* new
codes but forbids renaming or reusing existing ones, so the additions below
keep their own distinct semantics.
"""

from __future__ import annotations

from typing import Any, Mapping

# code -> (HTTP status, default message)
ERROR_DEFINITIONS: dict[str, tuple[int, str]] = {
    "AUTH_REQUIRED": (401, "请先登录"),
    "AUTH_INVALID_CREDENTIALS": (401, "用户名或密码不正确"),
    "AUTH_RATE_LIMITED": (429, "登录尝试过于频繁，请稍后再试"),
    "FORBIDDEN": (403, "没有权限执行该操作"),
    "NOT_FOUND": (404, "资源不存在"),
    "METHOD_NOT_ALLOWED": (405, "该路径不支持此请求方法"),
    "VALIDATION_FAILED": (422, "请求数据不合法"),
    "PAYLOAD_TOO_LARGE": (413, "请求或文档超过大小上限"),
    "CONFLICT_REVISION": (409, "方案已在别处更新，请重新载入"),
    "CONFLICT_USERNAME": (409, "用户名已被占用"),
    "UNSUPPORTED_SCHEMA_VERSION": (422, "不支持的方案文档版本"),
    "UNSUPPORTED_MEDIA_TYPE": (415, "请求内容类型不受支持"),
    "INTERNAL": (500, "服务器内部错误"),
}


class AppError(Exception):
    """An expected, user-facing failure mapped to a contract error code."""

    def __init__(
        self,
        code: str,
        message: str | None = None,
        details: Mapping[str, Any] | None = None,
        *,
        status: int | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        if code not in ERROR_DEFINITIONS:
            raise ValueError(f"unknown application error code: {code}")
        default_status, default_message = ERROR_DEFINITIONS[code]
        super().__init__(message or default_message)
        self.code = code
        self.status = default_status if status is None else status
        self.message = message or default_message
        self.details = dict(details) if details else None
        self.headers = dict(headers) if headers else {}

    def to_body(self, request_id: str) -> dict[str, Any]:
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "requestId": request_id,
        }
        if self.details:
            error["details"] = self.details
        return {"error": error}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"AppError(code={self.code!r}, status={self.status})"


def validation_error(message: str, field: str | None = None, **details: Any) -> AppError:
    payload: dict[str, Any] = {}
    if field:
        payload["field"] = field
    payload.update(details)
    return AppError("VALIDATION_FAILED", message, payload or None)
