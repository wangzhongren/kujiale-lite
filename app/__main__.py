"""``python -m app`` entry point."""

from __future__ import annotations

import logging
import sys

from app.catalog.loader import get_catalog, get_sample_plan
from app.config import ConfigError, load_config
from app.db.connection import Database
from app.db.migrations import initialize_database
from app.obs.logging import configure_logging, log_event
from app.server import create_app


def main(argv: list[str] | None = None) -> int:
    try:
        config = load_config(argv)
    except ConfigError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 2

    logger = configure_logging(config.log_level)
    log_event(logger, logging.INFO, "startup", **config.describe())

    server = None
    try:
        database = Database(config.db_path)
        schema_version = initialize_database(database)
        catalog = get_catalog()
        sample = get_sample_plan()
        server = create_app(
            config, database=database, catalog=catalog, sample=sample
        )
    except Exception as exc:
        log_event(
            logger,
            logging.ERROR,
            "startup_failed",
            excType=type(exc).__name__,
            error=str(exc),
        )
        return 1

    host, port = server.server_address[0], server.server_address[1]
    log_event(
        logger,
        logging.INFO,
        "listening",
        url=f"http://{host}:{port}",
        host=host,
        port=port,
        schemaVersion=schema_version,
        dataDir=str(config.data_dir),
        staticDir=str(config.static_dir),
        staticInstalled=config.static_dir.is_dir(),
    )
    if not config.static_dir.is_dir():
        log_event(
            logger,
            logging.WARNING,
            "static_dir_missing",
            staticDir=str(config.static_dir),
            message="前端静态目录不存在；API 仍可用，根路径返回 404",
        )

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        log_event(logger, logging.INFO, "shutdown_requested", reason="keyboard_interrupt")
    finally:
        server.server_close()
        log_event(logger, logging.INFO, "shutdown_complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
