"""Request middleware: requestId, auth, CSRF, error mapping and structured logs."""

from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any

from app.auth.csrf import SAFE_METHODS, check_fetch_site, check_origin, verify_double_submit
from app.auth.sessions import CSRF_COOKIE, SESSION_COOKIE, lookup_session
from app.http.request import read_request
from app.http.response import Response, error_response
from app.http.static import serve_static
from app.obs.errors import AppError
from app.obs.logging import get_logger, log_event
from app.plans.service import PlanService

CSRF_HEADER = "X-CSRF-Token"


class Application:
    def __init__(self, config, database, catalog: dict[str, Any], sample: dict[str, Any], clock=None):
        self.config = config
        self.db = database
        self.catalog = catalog
        self.sample = sample
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.logger = get_logger("http")
        self.plans = PlanService(database, catalog, self.clock, get_logger("plans"))
        self.router = None
        self.port = config.port

    def now(self) -> datetime:
        return self.clock()

    def allowed_origins(self) -> frozenset[str]:
        return self.config.allowed_origins(self.port)

    # ------------------------------------------------------------------ request
    def handle(self, handler) -> None:
        started = time.perf_counter()
        request_id = secrets.token_hex(16)
        meta: dict[str, Any] = {"route": "unmatched", "userId": None}
        request = None
        status = 500
        error_code: str | None = "INTERNAL"

        try:
            request = read_request(handler, request_id)
            response = self._dispatch(request, meta)
            status = response.status
            error_code = None
        except AppError as exc:
            status = exc.status
            error_code = exc.code
            response = error_response(exc, request_id)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:  # pragma: no cover - defensive boundary
            log_event(
                self.logger,
                logging.ERROR,
                "unhandled_error",
                requestId=request_id,
                route=meta["route"],
                excType=type(exc).__name__,
            )
            status = 500
            error_code = "INTERNAL"
            response = error_response(AppError("INTERNAL"), request_id)

        try:
            response.send(handler, request_id)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000.0, 2)
            fields: dict[str, Any] = {
                "requestId": request_id,
                "method": request.method if request else getattr(handler, "command", "-"),
                "route": request.route if request else meta["route"],
                "status": status,
                "durationMs": duration_ms,
                "errCode": error_code,
            }
            if meta.get("userId") is not None:
                fields["userId"] = meta["userId"]
            if status >= 500:
                level = logging.ERROR
            elif status >= 400 and status != 404:
                level = logging.WARNING
            else:
                level = logging.INFO
            log_event(self.logger, level, "request", **fields)

    def _dispatch(self, request, meta: dict[str, Any]) -> Response:
        if request.path != "/api" and not request.path.startswith("/api/"):
            meta["route"] = "static"
            request.route = "static"
            if request.method not in {"GET", "HEAD"}:
                raise AppError(
                    "METHOD_NOT_ALLOWED",
                    "静态资源只支持 GET",
                    {"allowed": ["GET"]},
                    headers={"Allow": "GET"},
                )
            return serve_static(request, self.config.static_dir)

        route, params = self.router.resolve(request.method, request.path)
        meta["route"] = route.name
        request.route = route.name

        if request.method not in SAFE_METHODS:
            check_origin(request.header("Origin"), self.allowed_origins())
            check_fetch_site(request.header("Sec-Fetch-Site"))

        connection = self.db.connect()
        try:
            session = None
            token = request.cookie(SESSION_COOKIE)
            request.session_token = token
            if token or route.requires_auth:
                session = lookup_session(connection, token, self.now())
            if route.requires_auth and session is None:
                raise AppError("AUTH_REQUIRED", "请先登录")
            if session is not None:
                request.session = session
                request.user_id = int(session["user_id"])
                meta["userId"] = request.user_id
            if route.csrf and request.method not in SAFE_METHODS:
                stored = session["csrf_token"] if session is not None else None
                if not verify_double_submit(
                    request.cookie(CSRF_COOKIE), request.header(CSRF_HEADER), stored
                ):
                    raise AppError(
                        "FORBIDDEN", "CSRF 校验失败", {"reason": "csrf"}
                    )
            return route.handler(self, request, params, connection)
        finally:
            connection.close()
