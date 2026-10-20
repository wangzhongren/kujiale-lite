"""``PRAGMA user_version`` migration chain.

Migrations run inside a transaction per version and are fail-fast: a broken or
newer database refuses to start rather than silently changing user data.
"""

from __future__ import annotations

import sqlite3

LATEST_SCHEMA_VERSION = 1


class MigrationError(RuntimeError):
    """Database schema is unusable or newer than this build."""


_SCHEMA_V1 = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    doc TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_plans_user_updated ON plans(user_id, updated_at DESC);

CREATE TABLE shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE INDEX idx_shares_plan ON shares(plan_id);

CREATE TABLE login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    success INTEGER NOT NULL CHECK (success IN (0, 1))
);
CREATE INDEX idx_attempts_username ON login_attempts(username, attempted_at);
CREATE INDEX idx_attempts_ip ON login_attempts(ip, attempted_at);
"""


def _migration_v1(connection: sqlite3.Connection) -> None:
    # ``executescript`` would implicitly COMMIT the surrounding transaction, so
    # each DDL statement is executed individually to keep migration atomic.
    for statement in _SCHEMA_V1.split(";"):
        if statement.strip():
            connection.execute(statement)


MIGRATIONS = {1: _migration_v1}


def current_version(connection: sqlite3.Connection) -> int:
    row = connection.execute("PRAGMA user_version").fetchone()
    return int(row[0]) if row else 0


def migrate(connection: sqlite3.Connection) -> int:
    version = current_version(connection)
    if version > LATEST_SCHEMA_VERSION:
        raise MigrationError(
            f"database schema version {version} is newer than supported "
            f"{LATEST_SCHEMA_VERSION}; refusing to start"
        )
    for target in range(version + 1, LATEST_SCHEMA_VERSION + 1):
        migration = MIGRATIONS.get(target)
        if migration is None:
            raise MigrationError(f"missing migration for schema version {target}")
        connection.execute("BEGIN IMMEDIATE")
        try:
            migration(connection)
            connection.execute(f"PRAGMA user_version={target:d}")
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        else:
            connection.execute("COMMIT")
    return current_version(connection)


def initialize_database(database) -> int:
    """Run migrations for a :class:`app.db.connection.Database` instance."""
    connection = database.connect()
    try:
        return migrate(connection)
    finally:
        connection.close()
