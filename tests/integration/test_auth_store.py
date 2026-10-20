"""Integration tests for sessions, rate limiting and share tokens."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from app.auth import ratelimit, sessions
from app.obs.errors import AppError
from app.plans import repository
from app.plans.service import default_document
from app.share import service as share_service
from tests.integration.support import IntegrationDatabase, iso_now

BASE = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


class SessionStoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.env = IntegrationDatabase()
        self.addCleanup(self.env.close)
        self.user_id = self.env.create_user("alice")

    def test_session_token_is_stored_only_as_hash(self) -> None:
        with self.env.db.transaction() as connection:
            created = sessions.create_session(connection, self.user_id, 7, BASE)
        token = created["token"]
        self.assertTrue(created["csrfToken"])
        with self.env.db.connection() as connection:
            stored = [row["token_hash"] for row in connection.execute("SELECT token_hash FROM sessions")]
        self.assertEqual(len(stored), 1)
        self.assertNotEqual(stored[0], token)
        self.assertEqual(stored[0], sessions.hash_token(token))

    def test_session_lookup_and_delete(self) -> None:
        with self.env.db.transaction() as connection:
            created = sessions.create_session(connection, self.user_id, 7, BASE)
        with self.env.db.connection() as connection:
            row = sessions.lookup_session(connection, created["token"], BASE)
            self.assertIsNotNone(row)
            self.assertEqual(int(row["user_id"]), self.user_id)
            self.assertEqual(row["csrf_token"], created["csrfToken"])
            self.assertIsNone(sessions.lookup_session(connection, "bogus-token", BASE))
            self.assertIsNone(sessions.lookup_session(connection, None, BASE))
        with self.env.db.transaction() as connection:
            self.assertTrue(sessions.delete_session(connection, created["token"]))
        with self.env.db.connection() as connection:
            self.assertIsNone(sessions.lookup_session(connection, created["token"], BASE))

    def test_session_expiry_is_enforced_and_pruned(self) -> None:
        with self.env.db.transaction() as connection:
            created = sessions.create_session(connection, self.user_id, 1, BASE)
        later = BASE + timedelta(hours=2)
        with self.env.db.connection() as connection:
            self.assertIsNone(sessions.lookup_session(connection, created["token"], later))
            remaining = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        self.assertEqual(remaining, 0)

    def test_creating_session_prunes_expired_rows(self) -> None:
        with self.env.db.transaction() as connection:
            first = sessions.create_session(connection, self.user_id, 1, BASE)
        later = BASE + timedelta(hours=5)
        with self.env.db.transaction() as connection:
            sessions.create_session(connection, self.user_id, 1, later)
        with self.env.db.connection() as connection:
            tokens = {
                row["token_hash"] for row in connection.execute("SELECT token_hash FROM sessions")
            }
            remaining = sessions.lookup_session(connection, first["token"], later)
        self.assertEqual(len(tokens), 1)
        self.assertIsNone(remaining)


class RateLimitTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.env = IntegrationDatabase()
        self.addCleanup(self.env.close)

    def test_failures_lock_and_success_resets(self) -> None:
        with self.env.db.transaction() as connection:
            for _ in range(5):
                ratelimit.record_attempt(connection, "alice", "127.0.0.1", False, BASE)
        with self.env.db.connection() as connection:
            self.assertTrue(ratelimit.is_rate_limited(connection, "alice", "127.0.0.1", BASE))
            self.assertGreater(
                ratelimit.retry_after_seconds(connection, "alice", "127.0.0.1", BASE), 0
            )
        with self.env.db.transaction() as connection:
            ratelimit.record_attempt(connection, "alice", "127.0.0.1", True, BASE)
        with self.env.db.connection() as connection:
            self.assertFalse(ratelimit.is_rate_limited(connection, "alice", "127.0.0.1", BASE))

    def test_window_expires(self) -> None:
        with self.env.db.transaction() as connection:
            for _ in range(5):
                ratelimit.record_attempt(connection, "bob", "10.0.0.1", False, BASE)
        later = BASE + timedelta(minutes=16)
        with self.env.db.connection() as connection:
            self.assertFalse(ratelimit.is_rate_limited(connection, "bob", "10.0.0.1", later))

    def test_failures_do_not_lock_another_username_on_same_ip(self) -> None:
        with self.env.db.transaction() as connection:
            for _ in range(5):
                ratelimit.record_attempt(connection, "alice", "127.0.0.1", False, BASE)
        with self.env.db.connection() as connection:
            self.assertTrue(ratelimit.is_rate_limited(connection, "alice", "127.0.0.1", BASE))
            self.assertFalse(ratelimit.is_rate_limited(connection, "bob", "127.0.0.1", BASE))

    def test_attempts_are_bounded(self) -> None:
        with self.env.db.transaction() as connection:
            ratelimit.record_attempt(connection, "old", "10.0.0.2", False, BASE - timedelta(days=2))
            ratelimit.record_attempt(connection, "new", "10.0.0.3", False, BASE)
        self.assertEqual(self.env.count("login_attempts"), 1)


class ShareStoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.env = IntegrationDatabase()
        self.addCleanup(self.env.close)
        self.alice = self.env.create_user("alice")
        self.bob = self.env.create_user("bob")
        with self.env.db.transaction() as connection:
            row = repository.create_plan(
                connection,
                self.alice,
                "分享方案",
                '{"schemaVersion":1}',
                iso_now(),
            )
        self.plan_id = int(row["id"])

    def test_share_is_hashed_and_resolves(self) -> None:
        issued = share_service.create_share(self.env.db, self.alice, self.plan_id, iso_now())
        token = issued["token"]
        self.assertGreaterEqual(len(token), 20)
        with self.env.db.connection() as connection:
            stored = [
                row["token_hash"]
                for row in connection.execute("SELECT token_hash FROM shares")
            ]
        self.assertEqual(stored, [share_service.hash_token(token)])
        resolved = share_service.resolve_share(self.env.db, token)
        self.assertEqual(int(resolved["id"]), self.plan_id)

    def test_new_share_revokes_previous_token(self) -> None:
        first = share_service.create_share(self.env.db, self.alice, self.plan_id, iso_now())["token"]
        second = share_service.create_share(self.env.db, self.alice, self.plan_id, iso_now())["token"]
        self.assertNotEqual(first, second)
        with self.assertRaises(AppError):
            share_service.resolve_share(self.env.db, first)
        self.assertEqual(int(share_service.resolve_share(self.env.db, second)["id"]), self.plan_id)

    def test_revoke_and_invalid_tokens(self) -> None:
        token = share_service.create_share(self.env.db, self.alice, self.plan_id, iso_now())["token"]
        self.assertTrue(share_service.revoke_share(self.env.db, self.alice, self.plan_id, iso_now()))
        for candidate in (token, "not-a-valid-token-000000", "short", ""):
            with self.subTest(candidate=candidate):
                with self.assertRaises(AppError) as caught:
                    share_service.resolve_share(self.env.db, candidate)
                self.assertEqual(caught.exception.code, "NOT_FOUND")

    def test_other_user_cannot_share_or_revoke(self) -> None:
        with self.assertRaises(AppError) as caught:
            share_service.create_share(self.env.db, self.bob, self.plan_id, iso_now())
        self.assertEqual(caught.exception.code, "NOT_FOUND")
        token = share_service.create_share(self.env.db, self.alice, self.plan_id, iso_now())["token"]
        with self.assertRaises(AppError):
            share_service.revoke_share(self.env.db, self.bob, self.plan_id, iso_now())
        self.assertIsNotNone(share_service.resolve_share(self.env.db, token))

    def test_deleting_plan_invalidates_share(self) -> None:
        token = share_service.create_share(self.env.db, self.alice, self.plan_id, iso_now())["token"]
        with self.env.db.transaction() as connection:
            self.assertTrue(repository.delete_plan(connection, self.alice, self.plan_id))
        with self.assertRaises(AppError):
            share_service.resolve_share(self.env.db, token)
        self.assertEqual(self.env.count("shares"), 0)


if __name__ == "__main__":
    unittest.main()
