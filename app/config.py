"""Configuration loading and validation.

Environment variables and command line flags are merged here.  No secret is
read from or written to the configuration: passwords and session tokens are
generated at runtime and persisted only as hashes.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

LOG_LEVELS = frozenset({"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"})


class ConfigError(ValueError):
    """Raised when configuration values are invalid."""


@dataclass(frozen=True)
class Config:
    host: str = "127.0.0.1"
    port: int = 8080
    data_dir: Path = PROJECT_ROOT / "data"
    static_dir: Path = PROJECT_ROOT / "web"
    log_level: str = "INFO"
    session_ttl_hours: int = 168
    secure_cookie: bool = False

    @property
    def db_path(self) -> Path:
        return self.data_dir / "kujiale.db"

    def allowed_origins(self, port: int | None = None) -> frozenset[str]:
        """Origins accepted for state-changing browser requests.

        The application is a same-origin single-host tool.  Because a bound
        port of ``0`` is only used by tests, the caller may pass the actual
        port after binding.
        """
        actual = self.port if port is None else port
        hosts = {"127.0.0.1", "localhost", "[::1]"}
        if self.host not in {"0.0.0.0", "::", ""}:
            hosts.add(self.host)
        origins: set[str] = set()
        for host in hosts:
            origins.add(f"http://{host}:{actual}")
            origins.add(f"https://{host}:{actual}")
        return frozenset(origins)

    def describe(self) -> dict[str, object]:
        """Non-sensitive, loggable view of the effective configuration."""
        return {
            "host": self.host,
            "port": self.port,
            "dataDir": str(self.data_dir),
            "dbPath": str(self.db_path),
            "staticDir": str(self.static_dir),
            "logLevel": self.log_level,
            "sessionTtlHours": self.session_ttl_hours,
            "secureCookie": self.secure_cookie,
        }


def _parse_bool(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be a boolean (1/0, true/false, yes/no, on/off)")


def _int_in_range(value: str, name: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if not minimum <= parsed <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _path_value(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()


def load_config(argv: list[str] | None = None, environ: dict[str, str] | None = None) -> Config:
    env = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(
        prog="python -m app",
        description="kujiale-lite: local single-user floor plan editor",
    )
    parser.add_argument("--host", default=env.get("KUJIALE_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=env.get("KUJIALE_PORT", "8080"))
    parser.add_argument("--data-dir", default=env.get("KUJIALE_DATA_DIR", str(PROJECT_ROOT / "data")))
    parser.add_argument("--static-dir", default=env.get("KUJIALE_STATIC_DIR", str(PROJECT_ROOT / "web")))
    parser.add_argument("--log-level", default=env.get("KUJIALE_LOG_LEVEL", "INFO"))
    parser.add_argument("--session-ttl-hours", default=env.get("KUJIALE_SESSION_TTL_HOURS", "168"))
    parser.add_argument("--secure-cookie", action="store_true", default=False)

    args = parser.parse_args(argv)

    host = str(args.host).strip()
    if not host:
        raise ConfigError("host must not be empty")
    port = _int_in_range(str(args.port), "port", 0, 65535)
    session_ttl_hours = _int_in_range(
        str(args.session_ttl_hours), "session-ttl-hours", 1, 24 * 365
    )
    log_level = str(args.log_level).strip().upper()
    if log_level not in LOG_LEVELS:
        raise ConfigError(f"log-level must be one of {sorted(LOG_LEVELS)}")

    secure_cookie = bool(args.secure_cookie)
    env_secure = env.get("KUJIALE_SECURE_COOKIE")
    if env_secure is not None and not args.secure_cookie:
        secure_cookie = _parse_bool(env_secure, "KUJIALE_SECURE_COOKIE")

    return Config(
        host=host,
        port=port,
        data_dir=_path_value(str(args.data_dir)),
        static_dir=_path_value(str(args.static_dir)),
        log_level=log_level,
        session_ttl_hours=session_ttl_hours,
        secure_cookie=secure_cookie,
    )
