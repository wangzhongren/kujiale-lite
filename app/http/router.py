"""Route table with ``{param}`` patterns and 404/405 distinction."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from app.obs.errors import AppError

Handler = Callable[[Any, Any, dict[str, str], Any], Any]

_PARAM_SEGMENT = re.compile(r"^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$")


@dataclass(frozen=True)
class Route:
    method: str
    pattern: str
    handler: Handler
    auth: str
    csrf: bool
    name: str
    regex: re.Pattern[str]

    @property
    def requires_auth(self) -> bool:
        return self.auth == "required"


class Router:
    def __init__(self) -> None:
        self._routes: list[Route] = []

    def add(
        self,
        method: str,
        pattern: str,
        handler: Handler,
        *,
        auth: str = "none",
        csrf: bool = False,
    ) -> None:
        if auth not in {"none", "required"}:
            raise ValueError(f"invalid auth mode: {auth}")
        method = method.upper()
        regex = _compile_pattern(pattern)
        self._routes.append(
            Route(
                method=method,
                pattern=pattern,
                handler=handler,
                auth=auth,
                csrf=csrf,
                name=f"{method} {pattern}",
                regex=regex,
            )
        )

    def resolve(self, method: str, path: str) -> tuple[Route, dict[str, str]]:
        allowed: set[str] = set()
        for route in self._routes:
            match = route.regex.fullmatch(path)
            if not match:
                continue
            if route.method == method:
                return route, match.groupdict()
            allowed.add(route.method)
        if allowed:
            allow_header = ", ".join(sorted(allowed))
            raise AppError(
                "METHOD_NOT_ALLOWED",
                "该路径不支持此请求方法",
                {"allowed": sorted(allowed)},
                headers={"Allow": allow_header},
            )
        raise AppError("NOT_FOUND", "资源不存在")

    @property
    def routes(self) -> tuple[Route, ...]:
        return tuple(self._routes)


def _compile_pattern(pattern: str) -> re.Pattern[str]:
    if not pattern.startswith("/"):
        raise ValueError(f"route pattern must start with '/': {pattern}")
    segments = pattern.split("/")
    compiled: list[str] = []
    for segment in segments:
        param = _PARAM_SEGMENT.match(segment)
        if param:
            compiled.append(f"(?P<{param.group(1)}>[^/]+)")
        else:
            compiled.append(re.escape(segment))
    return re.compile("/".join(compiled))
