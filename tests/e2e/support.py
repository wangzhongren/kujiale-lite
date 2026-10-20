"""Shared fixtures for end-to-end tests: real HTTP server on a temp database."""

from __future__ import annotations

import io
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import Config
from app.obs.logging import configure_logging
from app.server import create_app
from tests.e2e.client import HttpClient

INDEX_HTML = "<!doctype html><html><head><title>kujiale test</title></head><body>shell</body></html>"


def silence_logs() -> None:
    configure_logging("CRITICAL", stream=io.StringIO())


class MutableClock:
    def __init__(self) -> None:
        self.current = datetime.now(timezone.utc)

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current = self.current + timedelta(seconds=seconds)


class ServerContext:
    def __init__(self, clock=None, session_ttl_hours: int = 1) -> None:
        silence_logs()
        self._temp = tempfile.TemporaryDirectory(prefix="kujiale-e2e-")
        self.root = Path(self._temp.name)
        self.static_dir = self.root / "web"
        self.static_dir.mkdir()
        (self.static_dir / "index.html").write_text(INDEX_HTML, encoding="utf-8")
        assets = self.static_dir / "assets"
        assets.mkdir()
        (assets / "app.js").write_text("export const ok = true;\n", encoding="utf-8")
        (self.root / "secret.txt").write_text("TOP-SECRET-SENTINEL", encoding="utf-8")

        self.config = Config(
            host="127.0.0.1",
            port=0,
            data_dir=self.root / "data",
            static_dir=self.static_dir,
            log_level="CRITICAL",
            session_ttl_hours=session_ttl_hours,
        )
        self.server = create_app(self.config, clock=clock)
        self.host = "127.0.0.1"
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        self.thread.start()

    def client(self) -> HttpClient:
        return HttpClient(self.host, self.port)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self._temp.cleanup()
