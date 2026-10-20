"""Integration tests for SQLite settings, migrations and the plan repository."""

from __future__ import annotations

import json
import unittest

from app.db.migrations import LATEST_SCHEMA_VERSION
from app.obs.errors import AppError
from app.plans import repository
from app.plans.service import default_document
from tests.integration.support import IntegrationDatabase, iso_now


class DatabaseSettingsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.env = IntegrationDatabase()
        self.addCleanup(self.env.close)

    def test_pragmas_and_schema_version(self) -> None:
        with self.env.db.connection() as connection:
            journal = connection.execute("PRAGMA journal_mode").fetchone()[0]
            synchronous = connection.execute("PRAGMA synchronous").fetchone()[0]
            foreign_keys = connection.execute("PRAGMA foreign_keys").fetchone()[0]
            busy_timeout = connection.execute("PRAGMA busy_timeout").fetchone()[0]
            user_version = connection.execute("PRAGMA user_version").fetchone()[0]
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        self.assertEqual(journal, "wal")
        self.assertEqual(synchronous, 2)  # FULL
        self.assertEqual(foreign_keys, 1)
        self.assertEqual(busy_timeout, 5000)
        self.assertEqual(user_version, LATEST_SCHEMA_VERSION)
        self.assertEqual(integrity, "ok")

    def test_expected_tables_exist(self) -> None:
        with self.env.db.connection() as connection:
            names = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        for table in {"users", "sessions", "plans", "shares", "login_attempts"}:
            self.assertIn(table, names)

    def test_transaction_rollback_leaves_no_rows(self) -> None:
        with self.assertRaises(RuntimeError):
            with self.env.db.transaction() as connection:
                connection.execute(
                    "INSERT INTO users(username, password_hash, created_at) VALUES(?, ?, ?)",
                    ("rollback", "hash", iso_now()),
                )
                raise RuntimeError("boom")
        self.assertEqual(self.env.count("users"), 0)

    def test_foreign_keys_enforce_cascades(self) -> None:
        user_id = self.env.create_user()
        now_iso = iso_now()
        with self.env.db.transaction() as connection:
            cursor = connection.execute(
                "INSERT INTO plans(user_id, name, doc, revision, created_at, updated_at) "
                "VALUES(?, ?, ?, 1, ?, ?)",
                (user_id, "p", json.dumps(default_document()), now_iso, now_iso),
            )
            plan_id = int(cursor.lastrowid)
            connection.execute(
                "INSERT INTO shares(plan_id, token_hash, created_at) VALUES(?, ?, ?)",
                (plan_id, "token-hash", now_iso),
            )
        with self.env.db.transaction() as connection:
            connection.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
        self.assertEqual(self.env.count("shares"), 0)


class PlanRepositoryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.env = IntegrationDatabase()
        self.addCleanup(self.env.close)
        self.alice = self.env.create_user("alice")
        self.bob = self.env.create_user("bob")
        self.doc_json = json.dumps(default_document(), ensure_ascii=False)

    def _create(self, user_id: int, name: str = "方案") -> int:
        with self.env.db.transaction() as connection:
            row = repository.create_plan(connection, user_id, name, self.doc_json, iso_now())
        return int(row["id"])

    def test_create_and_scope_by_user(self) -> None:
        plan_id = self._create(self.alice)
        with self.env.db.connection() as connection:
            self.assertIsNotNone(repository.get_plan(connection, self.alice, plan_id))
            self.assertIsNone(repository.get_plan(connection, self.bob, plan_id))

    def test_list_pagination_and_isolation(self) -> None:
        for index in range(3):
            self._create(self.alice, f"方案 {index}")
        self._create(self.bob, "别人的方案")
        with self.env.db.connection() as connection:
            rows, total = repository.list_plans(connection, self.alice, limit=2, offset=0)
            self.assertEqual(total, 3)
            self.assertEqual(len(rows), 2)
            second_page, _ = repository.list_plans(connection, self.alice, limit=2, offset=2)
            self.assertEqual(len(second_page), 1)
            bob_rows, bob_total = repository.list_plans(connection, self.bob, limit=20, offset=0)
            self.assertEqual(bob_total, 1)
            self.assertEqual(bob_rows[0]["name"], "别人的方案")

    def test_search_escapes_like_wildcards(self) -> None:
        percent = self._create(self.alice, "100%")
        self._create(self.alice, "100x")
        underscore = self._create(self.alice, "under_score")
        self._create(self.alice, "underXscore")
        with self.env.db.connection() as connection:
            rows, total = repository.list_plans(
                connection, self.alice, limit=20, offset=0, query="100%"
            )
            self.assertEqual(total, 1)
            self.assertEqual(int(rows[0]["id"]), percent)

            rows, total = repository.list_plans(
                connection, self.alice, limit=20, offset=0, query="under_"
            )
            self.assertEqual(total, 1)
            self.assertEqual(int(rows[0]["id"]), underscore)

    def test_update_revision_and_conflict(self) -> None:
        plan_id = self._create(self.alice)
        with self.env.db.transaction() as connection:
            updated = repository.update_plan(
                connection,
                self.alice,
                plan_id,
                name="改名",
                document_json=self.doc_json,
                expected_revision=1,
                now_iso=iso_now(),
            )
        self.assertEqual(int(updated["revision"]), 2)
        self.assertEqual(updated["name"], "改名")

        with self.assertRaises(AppError) as caught:
            with self.env.db.transaction() as connection:
                repository.update_plan(
                    connection,
                    self.alice,
                    plan_id,
                    name="再次",
                    document_json=self.doc_json,
                    expected_revision=1,
                    now_iso=iso_now(),
                )
        self.assertEqual(caught.exception.code, "CONFLICT_REVISION")
        self.assertEqual(caught.exception.details["currentRevision"], 2)

    def test_update_other_users_plan_is_not_found(self) -> None:
        plan_id = self._create(self.alice)
        with self.assertRaises(AppError) as caught:
            with self.env.db.transaction() as connection:
                repository.update_plan(
                    connection,
                    self.bob,
                    plan_id,
                    name="hijack",
                    document_json=self.doc_json,
                    expected_revision=1,
                    now_iso=iso_now(),
                )
        self.assertEqual(caught.exception.code, "NOT_FOUND")

    def test_delete_is_scoped(self) -> None:
        plan_id = self._create(self.alice)
        with self.env.db.transaction() as connection:
            self.assertFalse(repository.delete_plan(connection, self.bob, plan_id))
        with self.env.db.transaction() as connection:
            self.assertTrue(repository.delete_plan(connection, self.alice, plan_id))
        with self.env.db.connection() as connection:
            self.assertIsNone(repository.get_plan(connection, self.alice, plan_id))

    def test_parameterised_queries_round_trip_sql_text(self) -> None:
        name = "x'); DROP TABLE plans;--"
        plan_id = self._create(self.alice, name)
        with self.env.db.connection() as connection:
            row = repository.get_plan(connection, self.alice, plan_id)
        self.assertEqual(row["name"], name)
        self.assertEqual(self.env.count("plans"), 1)

    def test_concurrent_writers_second_gets_conflict(self) -> None:
        from app.db.connection import Database

        plan_id = self._create(self.alice)
        second = Database(self.env.path)
        with self.env.db.transaction() as first_connection:
            repository.update_plan(
                first_connection,
                self.alice,
                plan_id,
                name="first",
                document_json=self.doc_json,
                expected_revision=1,
                now_iso=iso_now(),
            )
        with self.assertRaises(AppError) as caught:
            with second.transaction() as second_connection:
                repository.update_plan(
                    second_connection,
                    self.alice,
                    plan_id,
                    name="second",
                    document_json=self.doc_json,
                    expected_revision=1,
                    now_iso=iso_now(),
                )
        self.assertEqual(caught.exception.code, "CONFLICT_REVISION")


if __name__ == "__main__":
    unittest.main()
