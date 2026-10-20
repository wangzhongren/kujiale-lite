"""Minimal HTTP client used by end-to-end tests (no third-party packages)."""

from __future__ import annotations

import http.client
import json
import socket
from dataclasses import dataclass
from http.cookies import SimpleCookie
from typing import Any

_UNSET = object()
_AUTO = object()


@dataclass
class HttpResponse:
    status: int
    body: bytes
    headers: list[tuple[str, str]]

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))

    def header(self, name: str) -> str | None:
        lowered = name.lower()
        for key, value in self.headers:
            if key.lower() == lowered:
                return value
        return None

    def header_all(self, name: str) -> list[str]:
        lowered = name.lower()
        return [value for key, value in self.headers if key.lower() == lowered]

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class HttpClient:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.cookies: dict[str, str] = {}
        self.last: HttpResponse | None = None

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = _UNSET,
        body: Any = _UNSET,
        headers: dict[str, str] | None = None,
        csrf: Any = _AUTO,
        content_type: str | None = None,
    ) -> HttpResponse:
        send_headers: dict[str, str] = dict(headers or {})
        payload: bytes | None
        if json_body is not _UNSET:
            payload = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            send_headers.setdefault("Content-Type", "application/json")
        elif body is not _UNSET:
            if isinstance(body, bytes):
                payload = body
            else:
                payload = str(body).encode("utf-8")
            if content_type is not None:
                send_headers.setdefault("Content-Type", content_type)
        else:
            payload = None

        if csrf is _AUTO:
            if method not in {"GET", "HEAD"} and "kj_csrf" in self.cookies:
                send_headers.setdefault("X-CSRF-Token", self.cookies["kj_csrf"])
        elif csrf is not None:
            send_headers["X-CSRF-Token"] = str(csrf)

        if self.cookies:
            send_headers.setdefault(
                "Cookie", "; ".join(f"{name}={value}" for name, value in self.cookies.items())
            )

        connection = http.client.HTTPConnection(self.host, self.port, timeout=15)
        try:
            connection.request(method, path, body=payload, headers=send_headers)
            raw = connection.getresponse()
            data = raw.read()
            header_list = raw.getheaders()
            status = raw.status
        finally:
            connection.close()

        for name, value in header_list:
            if name.lower() == "set-cookie":
                self._store_cookie(value)

        self.last = HttpResponse(status=status, body=data, headers=header_list)
        return self.last

    def _store_cookie(self, header_value: str) -> None:
        jar: SimpleCookie = SimpleCookie()
        try:
            jar.load(header_value)
        except Exception:
            return
        for name, morsel in jar.items():
            if morsel["max-age"] == "0":
                self.cookies.pop(name, None)
            else:
                self.cookies[name] = morsel.value


@dataclass
class RawResponse:
    status: int
    headers: list[tuple[str, str]]
    body: bytes

    def header(self, name: str) -> str | None:
        lowered = name.lower()
        for key, value in self.headers:
            if key.lower() == lowered:
                return value
        return None


def raw_request(host: str, port: int, request_bytes: bytes, timeout: float = 10.0) -> RawResponse:
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(request_bytes)
        chunks: list[bytes] = []
        while True:
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
    payload = b"".join(chunks)
    head, _, body = payload.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status_line = lines[0].decode("latin-1") if lines else ""
    parts = status_line.split(" ", 2)
    status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        if b":" in line:
            key, _, value = line.partition(b":")
            headers.append((key.decode("latin-1").strip(), value.decode("latin-1").strip()))
    return RawResponse(status=status, headers=headers, body=body)
