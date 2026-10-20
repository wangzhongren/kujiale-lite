"""Shared helpers for integration tests."""

from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path

from app.auth.passwords import hash_password
from app.db.connection import Database
from app.db.migrations import initialize_database


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class IntegrationDatabase:
    def __init__(self) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="kujiale-integration-")
        self.path = Path(self._temp.name) / "kujiale.db"
        self.db = Database(self.path)
        initialize_database(self.db)

    def close(self) -> None:
        self._temp.cleanup()

    def create_user(self, username: str = "alice", password: str = "correct-horse-9") -> int:
        with self.db.transaction() as connection:
            cursor = connection.execute(
                "INSERT INTO users(username, password_hash, created_at) VALUES(?, ?, ?)",
                (username, hash_password(password), iso_now()),
            )
            return int(cursor.lastrowid)

    def count(self, table: str) -> int:
        with self.db.connection() as connection:
            return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
