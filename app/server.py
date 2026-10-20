"""HTTP server factory and the ``BaseHTTPRequestHandler`` bridge."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.catalog.loader import get_catalog, get_sample_plan
from app.db.connection import Database
from app.db.migrations import initialize_database
from app.http.api import build_router
from app.http.middleware import Application
from app.plans.migrate import migrate_document
from app.plans.validate import validate_document

READ_TIMEOUT_SECONDS = 30


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kujiale-lite/1.0"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        try:
            self.connection.settimeout(READ_TIMEOUT_SECONDS)
        except OSError:
            pass

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        self._dispatch()

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch()

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch()

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch()

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch()

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._dispatch()

    def do_TRACE(self) -> None:  # noqa: N802
        self._dispatch()

    def _dispatch(self) -> None:
        application = getattr(self.server, "app", None)
        if application is None:  # pragma: no cover - server always wires the app
            self.send_error(500)
            return
        try:
            application.handle(self)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        # Structured request logging is handled by app.http.middleware.
        return


class KujialeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler_class, application: Application) -> None:
        self.app = application
        super().__init__(address, handler_class)


def create_app(
    config,
    *,
    database: Database | None = None,
    catalog: dict | None = None,
    sample: dict | None = None,
    clock=None,
    db_path=None,
) -> KujialeHTTPServer:
    """Build a server; used by ``__main__`` and by tests (no globals).

    ``db_path`` is an optional test seam from the proposal: when no prepared
    :class:`Database` is supplied, the database is opened at this path instead
    of ``config.db_path``.
    """
    db = database or Database(db_path or config.db_path)
    initialize_database(db)
    catalog_data = catalog if catalog is not None else get_catalog()
    sample_data = sample if sample is not None else get_sample_plan()

    # Fail fast if the bundled sample cannot satisfy the same rules as user data.
    sample_document = migrate_document(sample_data["doc"])
    validate_document(sample_document, catalog_data)

    application = Application(config, db, catalog_data, sample_data, clock)
    application.router = build_router(application)
    server = KujialeHTTPServer((config.host, config.port), RequestHandler, application)
    application.port = server.server_address[1]
    return server
