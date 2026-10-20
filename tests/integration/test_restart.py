"""Integration tests for restart recovery, durability and fail-fast migrations."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.auth import sessions
from app.catalog.loader import get_catalog, get_sample_plan
from app.db.connection import Database
from app.db.migrations import LATEST_SCHEMA_VERSION, MigrationError, initialize_database
from app.obs.errors import AppError
from app.plans.service import PlanService
from app.share import service as share_service
from tests.integration.support import IntegrationDatabase

BASE = datetime(2026, 1, 1, 9, 0, 0, tzinfo=timezone.utc)


class RestartRecoveryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.env = IntegrationDatabase()
        self.addCleanup(self.env.close)
        self.catalog = get_catalog()
        self.user_id = self.env.create_user("alice")

    def _service(self) -> PlanService:
        return PlanService(self.env.db, self.catalog, now=lambda: BASE)

    def test_data_session_and_share_survive_reopen(self) -> None:
        service = self._service()
        sample = get_sample_plan()["doc"]
        created = service.create(self.user_id, {"name": "重启验证", "doc": sample})
        plan_id = created["id"]
        self.assertEqual(created["revision"], 1)

        updated = service.update(
            self.user_id,
            plan_id,
            {"expectedRevision": 1, "name": "重启验证 v2", "doc": sample},
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["doc"], sample)

        with self.env.db.transaction() as connection:
            session = sessions.create_session(connection, self.user_id, 7, BASE)
        share = share_service.create_share(self.env.db, self.user_id, plan_id, "2026-01-01T09:00:00Z")

        # Simulate a process restart: all connections above are short-lived and
        # closed; now open the same file afresh and run migrations again.
        reopened = Database(self.env.path)
        self.assertEqual(initialize_database(reopened), LATEST_SCHEMA_VERSION)
        reopened_service = PlanService(reopened, self.catalog, now=lambda: BASE)
        reloaded = reopened_service.get(self.user_id, plan_id)
        self.assertEqual(reloaded["name"], "重启验证 v2")
        self.assertEqual(reloaded["revision"], 2)
        self.assertEqual(reloaded["doc"], sample)
        self.assertEqual(reloaded["stats"]["totalAreaM2"], 21.0)

        with reopened.connection() as connection:
            session_row = sessions.lookup_session(connection, session["token"], BASE)
            self.assertIsNotNone(session_row)
            self.assertEqual(int(session_row["user_id"]), self.user_id)
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        self.assertEqual(integrity, "ok")
        share_row = share_service.resolve_share(reopened, share["token"])
        self.assertEqual(int(share_row["id"]), plan_id)

    def test_failed_update_does_not_change_existing_data(self) -> None:
        service = self._service()
        plan = service.create(self.user_id, {"name": "原文"})
        plan_id = plan["id"]

        with self.assertRaises(AppError) as caught:
            service.update(
                self.user_id,
                plan_id,
                {
                    "expectedRevision": 1,
                    "name": "不应生效",
                    "doc": {**plan["doc"], "schemaVersion": 2},
                },
            )
        self.assertEqual(caught.exception.code, "UNSUPPORTED_SCHEMA_VERSION")

        reloaded = service.get(self.user_id, plan_id)
        self.assertEqual(reloaded["name"], "原文")
        self.assertEqual(reloaded["revision"], 1)

        with self.assertRaises(AppError):
            service.update(
                self.user_id,
                plan_id,
                {"expectedRevision": 5, "name": "不应生效", "doc": plan["doc"]},
            )
        reloaded = service.get(self.user_id, plan_id)
        self.assertEqual(reloaded["name"], "原文")
        self.assertEqual(reloaded["revision"], 1)

    def test_expired_session_not_restored(self) -> None:
        with self.env.db.transaction() as connection:
            session = sessions.create_session(connection, self.user_id, 1, BASE)
        reopened = Database(self.env.path)
        later = BASE + timedelta(hours=2)
        with reopened.connection() as connection:
            self.assertIsNone(sessions.lookup_session(connection, session["token"], later))


class MigrationFailFastTestCase(unittest.TestCase):
    def test_newer_database_refuses_to_start(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kujiale-migration-") as temp:
            path = Path(temp) / "future.db"
            connection = sqlite3.connect(path)
            try:
                connection.execute("PRAGMA user_version=99")
                connection.commit()
            finally:
                connection.close()
            database = Database(path)
            with self.assertRaises(MigrationError):
                initialize_database(database)
            connection = sqlite3.connect(path)
            try:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
            finally:
                connection.close()
            self.assertEqual(version, 99)

    def test_migrations_are_idempotent(self) -> None:
        env = IntegrationDatabase()
        try:
            first = initialize_database(env.db)
            second = initialize_database(env.db)
            self.assertEqual(first, LATEST_SCHEMA_VERSION)
            self.assertEqual(second, LATEST_SCHEMA_VERSION)
            self.assertEqual(env.count("users"), 0)
        finally:
            env.close()


if __name__ == "__main__":
    unittest.main()
