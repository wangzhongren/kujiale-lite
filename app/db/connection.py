"""SQLite connection factory with the durability settings required by v1.

Every request gets its own short-lived connection (``ThreadingHTTPServer``).
Write transactions use ``BEGIN IMMEDIATE`` so concurrent saves serialise in
the database instead of failing halfway through.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

BUSY_TIMEOUT_MS = 5000


class Database:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            str(self.path),
            timeout=BUSY_TIMEOUT_MS / 1000,
            isolation_level=None,  # explicit transactions only
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        # WAL is persistent in the database header; setting it per connection
        # is idempotent and keeps a fresh database safe.
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        return connection

    @contextmanager
    def transaction(self, *, immediate: bool = True) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            try:
                yield connection
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            else:
                connection.execute("COMMIT")
        finally:
            connection.close()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            yield connection
        finally:
            connection.close()
