"""Static file serving with traversal hardening and SPA fallback."""

from __future__ import annotations

from pathlib import Path

from app.http.response import Response
from app.obs.errors import AppError

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
}


def _content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    return CONTENT_TYPES.get(suffix, "application/octet-stream")


def _safe_relative(path: str) -> str:
    relative = path.lstrip("/")
    if not relative:
        return "index.html"
    for segment in relative.split("/"):
        if segment in {"", ".", ".."}:
            raise AppError("NOT_FOUND", "资源不存在")
        if ":" in segment or "\x00" in segment or "\\" in segment:
            raise AppError("NOT_FOUND", "资源不存在")
    return relative


def _resolve(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise AppError("NOT_FOUND", "资源不存在") from exc
    return candidate


def _accepts_html(request) -> bool:
    accept = request.header("Accept") or ""
    return "text/html" in accept.lower()


def serve_static(request, static_dir: Path) -> Response:
    root = static_dir.resolve()
    relative = _safe_relative(request.path)
    target = _resolve(root, relative)

    if target.is_dir():
        target = _resolve(root, f"{relative.rstrip('/')}/index.html")

    if not target.is_file():
        last_segment = relative.rsplit("/", 1)[-1]
        if _accepts_html(request) and "." not in last_segment:
            fallback = _resolve(root, "index.html")
            if fallback.is_file():
                target = fallback
            else:
                raise AppError("NOT_FOUND", "前端资源尚未安装")
        else:
            raise AppError("NOT_FOUND", "资源不存在")

    try:
        data = target.read_bytes()
    except OSError as exc:
        raise AppError("NOT_FOUND", "资源不存在") from exc

    cache_control = "public, max-age=3600" if "/vendor/" in request.path else "no-cache"
    # ``Response.send`` already emits the hardened security headers; adding
    # nosniff here again produced a duplicate header on every static asset.
    return Response.bytes(
        data,
        _content_type(target),
        cache_control=cache_control,
    )
