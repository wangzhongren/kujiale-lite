"""Security and negative-path end-to-end tests."""

from __future__ import annotations

import io
import sqlite3
import unittest

from app.obs.logging import configure_logging
from tests.e2e.client import HttpClient, raw_request
from tests.e2e.support import MutableClock, ServerContext

PASSWORD = "correct-horse-9"


def error_code(response) -> str:
    return response.json()["error"]["code"]


class SecurityTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.ctx = ServerContext()
        self.addCleanup(self.ctx.close)

    def register_and_login(self, username: str = "alice") -> HttpClient:
        client = self.ctx.client()
        registered = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": username, "password": PASSWORD},
        )
        self.assertEqual(registered.status, 201, registered.text)
        logged_in = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": username, "password": PASSWORD},
        )
        self.assertEqual(logged_in.status, 200, logged_in.text)
        return client

    # -------------------------------------------------------------------- csrf
    def test_csrf_double_submit_is_required_for_mutations(self) -> None:
        client = self.register_and_login()
        missing = client.request("POST", "/api/v1/plans", json_body={}, csrf=None)
        self.assertEqual(missing.status, 403)
        self.assertEqual(error_code(missing), "FORBIDDEN")
        self.assertEqual(missing.json()["error"]["details"]["reason"], "csrf")

        wrong = client.request(
            "POST", "/api/v1/plans", json_body={}, csrf="not-the-real-token"
        )
        self.assertEqual(wrong.status, 403)

        created = client.request("POST", "/api/v1/plans", json_body={})
        self.assertEqual(created.status, 201, created.text)
        plan = created.json()

        no_csrf_update = client.request(
            "PUT",
            f"/api/v1/plans/{plan['id']}",
            json_body={"expectedRevision": 1, "doc": plan["doc"]},
            csrf=None,
        )
        self.assertEqual(no_csrf_update.status, 403)

        no_csrf_delete = client.request(
            "DELETE", f"/api/v1/plans/{plan['id']}", csrf=None
        )
        self.assertEqual(no_csrf_delete.status, 403)

    # ------------------------------------------------------------------ origin
    def test_cross_origin_requests_are_rejected(self) -> None:
        client = self.register_and_login()
        evil = client.request(
            "POST",
            "/api/v1/plans",
            json_body={},
            headers={"Origin": "http://evil.example"},
        )
        self.assertEqual(evil.status, 403)
        self.assertEqual(error_code(evil), "FORBIDDEN")

        null_origin = client.request(
            "POST",
            "/api/v1/plans",
            json_body={},
            headers={"Origin": "null"},
        )
        self.assertEqual(null_origin.status, 403)

        same_origin = client.request(
            "POST",
            "/api/v1/plans",
            json_body={},
            headers={"Origin": f"http://127.0.0.1:{self.ctx.port}"},
        )
        self.assertEqual(same_origin.status, 201, same_origin.text)

        cross_site = client.request(
            "POST",
            "/api/v1/plans",
            json_body={},
            headers={"Sec-Fetch-Site": "cross-site"},
        )
        self.assertEqual(cross_site.status, 403)

        same_site = client.request(
            "POST",
            "/api/v1/plans",
            json_body={},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(same_site.status, 201, same_site.text)

    # -------------------------------------------------------------- rate limit
    def test_login_rate_limit(self) -> None:
        client = self.ctx.client()
        registered = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "ratelimit", "password": PASSWORD},
        )
        self.assertEqual(registered.status, 201, registered.text)

        for attempt in range(5):
            failed = client.request(
                "POST",
                "/api/v1/auth/login",
                json_body={"username": "ratelimit", "password": "wrong-password-1"},
            )
            self.assertEqual(failed.status, 401, f"attempt {attempt}: {failed.text}")
            self.assertEqual(error_code(failed), "AUTH_INVALID_CREDENTIALS")

        limited = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": "ratelimit", "password": "wrong-password-1"},
        )
        self.assertEqual(limited.status, 429)
        self.assertEqual(error_code(limited), "AUTH_RATE_LIMITED")
        self.assertGreater(int(limited.header("Retry-After")), 0)
        self.assertGreater(limited.json()["error"]["details"]["retryAfterSeconds"], 0)

        even_correct = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": "ratelimit", "password": PASSWORD},
        )
        self.assertEqual(even_correct.status, 429)

    # ------------------------------------------------------------------ limits
    def test_oversized_request_body_is_rejected_before_reading(self) -> None:
        request = (
            b"PUT /api/v1/plans/1 HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: 3000000\r\n"
            b"Connection: close\r\n\r\n"
        )
        response = raw_request(self.ctx.host, self.ctx.port, request)
        self.assertEqual(response.status, 413)
        self.assertIn(b"PAYLOAD_TOO_LARGE", response.body)

    def test_oversized_document_is_rejected(self) -> None:
        client = self.register_and_login()
        plan = client.request("POST", "/api/v1/plans", json_body={}).json()
        doc = plan["doc"]
        doc["blob"] = "x" * (2 * 1024 * 1024)
        response = client.request(
            "PUT",
            f"/api/v1/plans/{plan['id']}",
            json_body={"expectedRevision": 1, "doc": doc},
        )
        self.assertEqual(response.status, 413)
        self.assertEqual(error_code(response), "PAYLOAD_TOO_LARGE")

        unchanged = client.request("GET", f"/api/v1/plans/{plan['id']}")
        self.assertEqual(unchanged.json()["revision"], 1)

    def test_duplicate_json_keys_rejected(self) -> None:
        client = self.ctx.client()
        body = '{"username":"alice","username":"bob","password":"correct-horse-9"}'
        response = client.request(
            "POST",
            "/api/v1/auth/register",
            body=body,
            content_type="application/json",
        )
        self.assertEqual(response.status, 422)
        self.assertEqual(error_code(response), "VALIDATION_FAILED")

    # --------------------------------------------------------------- traversal
    def test_path_traversal_is_blocked(self) -> None:
        targets = [
            b"GET /../secret.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            b"GET /%2e%2e/secret.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            b"GET /assets/../../secret.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            b"GET /..%5csecret.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            b"GET /..%2fsecret.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        ]
        for target in targets:
            with self.subTest(target=target):
                response = raw_request(self.ctx.host, self.ctx.port, target)
                self.assertEqual(response.status, 404)
                self.assertNotIn(b"TOP-SECRET-SENTINEL", response.body)

    # --------------------------------------------------------------- injection
    def test_sql_injection_payloads_are_inert(self) -> None:
        client = self.ctx.client()
        bad_username = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "alice'--", "password": PASSWORD},
        )
        self.assertEqual(bad_username.status, 422)

        malicious_name = "x'); DROP TABLE plans;--"
        created = client.request(
            "POST", "/api/v1/auth/register", json_body={"username": "mallory", "password": PASSWORD}
        )
        self.assertEqual(created.status, 201)
        login = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": "mallory", "password": PASSWORD},
        )
        self.assertEqual(login.status, 200)

        plan = client.request(
            "POST", "/api/v1/plans", json_body={"name": malicious_name}
        )
        self.assertEqual(plan.status, 201, plan.text)
        self.assertEqual(plan.json()["name"], malicious_name)

        search = client.request(
            "GET", "/api/v1/plans?q=%27%20OR%201%3D1%20--"
        )
        self.assertEqual(search.status, 200)
        self.assertEqual(search.json()["total"], 0)

        still_there = client.request("GET", f"/api/v1/plans/{plan.json()['id']}")
        self.assertEqual(still_there.status, 200)
        self.assertEqual(still_there.json()["name"], malicious_name)

    # ------------------------------------------------------------------- logs
    def test_logs_are_structured_and_never_contain_secrets(self) -> None:
        buffer = io.StringIO()
        configure_logging("INFO", stream=buffer)
        self.addCleanup(configure_logging, "CRITICAL", io.StringIO())

        password = "logs-secret-pass-77"
        wrong_password = "wrong-secret-pass-77"
        client = self.ctx.client()
        registered = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "logcheck", "password": password},
        )
        self.assertEqual(registered.status, 201, registered.text)
        failed = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": "logcheck", "password": wrong_password},
        )
        self.assertEqual(failed.status, 401)
        logged_in = client.request(
            "POST", "/api/v1/auth/login", json_body={"username": "logcheck", "password": password}
        )
        self.assertEqual(logged_in.status, 200)
        created = client.request("POST", "/api/v1/plans", json_body={})
        self.assertEqual(created.status, 201)

        token = client.cookies["kj_session"]
        csrf = logged_in.json()["csrfToken"]
        logs = buffer.getvalue()

        self.assertIn('"event":"request"', logs)
        self.assertIn('"requestId":"', logs)
        self.assertIn('"route":"POST /api/v1/auth/login"', logs)
        self.assertIn('"status":200', logs)
        self.assertIn('"errCode":"AUTH_INVALID_CREDENTIALS"', logs)
        for secret in (password, wrong_password, token, csrf):
            self.assertNotIn(secret, logs)
        self.assertNotIn("Set-Cookie", logs)
        self.assertNotIn("kj_session", logs)

    # ---------------------------------------------------------------- methods
    def test_method_not_allowed(self) -> None:
        client = self.ctx.client()
        response = client.request("PATCH", "/api/v1/plans", body=b"{}", content_type="application/json")
        self.assertEqual(response.status, 405)
        allowed = response.header("Allow") or ""
        self.assertIn("GET", allowed)
        self.assertIn("POST", allowed)

        static_post = client.request("POST", "/", body=b"")
        self.assertEqual(static_post.status, 405)


class SessionExpiryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = MutableClock()
        self.ctx = ServerContext(clock=self.clock, session_ttl_hours=1)
        self.addCleanup(self.ctx.close)

    def test_session_expires_after_ttl(self) -> None:
        client = self.ctx.client()
        client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "expiring", "password": PASSWORD},
        )
        login = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": "expiring", "password": PASSWORD},
        )
        self.assertEqual(login.status, 200)
        self.assertEqual(client.request("GET", "/api/v1/auth/me").status, 200)

        self.clock.advance(3601)

        expired = client.request("GET", "/api/v1/auth/me")
        self.assertEqual(expired.status, 401)
        self.assertEqual(error_code(expired), "AUTH_REQUIRED")

        connection = sqlite3.connect(self.ctx.config.db_path)
        try:
            remaining = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(remaining, 0)


if __name__ == "__main__":
    unittest.main()
