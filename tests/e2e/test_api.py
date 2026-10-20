"""End-to-end API behaviour: catalog, auth, plans, share links, CSV, static."""

from __future__ import annotations

import unittest

from tests.e2e.client import HttpClient
from tests.e2e.support import ServerContext

PASSWORD = "correct-horse-9"


def error_code(response) -> str:
    return response.json()["error"]["code"]


class ApiTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.ctx = ServerContext()
        self.addCleanup(self.ctx.close)

    def new_client(self) -> HttpClient:
        return self.ctx.client()

    def register_and_login(
        self,
        username: str = "alice",
        password: str = PASSWORD,
        client: HttpClient | None = None,
    ) -> HttpClient:
        client = client or self.new_client()
        registered = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": username, "password": password},
        )
        self.assertEqual(registered.status, 201, registered.text)
        logged_in = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": username, "password": password},
        )
        self.assertEqual(logged_in.status, 200, logged_in.text)
        return client

    def sample_doc(self, client: HttpClient) -> dict:
        response = client.request("GET", "/api/v1/sample")
        self.assertEqual(response.status, 200, response.text)
        return response.json()["doc"]

    def create_sample_plan(self, client: HttpClient, name: str = "演示户型") -> dict:
        created = client.request(
            "POST",
            "/api/v1/plans",
            json_body={"name": name, "doc": self.sample_doc(client)},
        )
        self.assertEqual(created.status, 201, created.text)
        return created.json()

    # ------------------------------------------------------------------ catalog
    def test_catalog_is_public_and_complete(self) -> None:
        client = self.new_client()
        response = client.request("GET", "/api/v1/catalog")
        self.assertEqual(response.status, 200)
        payload = response.json()
        self.assertGreaterEqual(len(payload["furniture"]), 9)
        self.assertGreaterEqual(len(payload["materials"]), 6)
        self.assertIn("default-src 'self'", response.header("Content-Security-Policy"))
        self.assertEqual(response.header("X-Content-Type-Options"), "nosniff")
        self.assertTrue(response.header("X-Request-Id"))
        self.assertFalse(response.header_all("Set-Cookie"))

    # --------------------------------------------------------------------- auth
    def test_auth_required_returns_401_with_request_id(self) -> None:
        client = self.new_client()
        response = client.request("GET", "/api/v1/plans")
        self.assertEqual(response.status, 401)
        body = response.json()
        self.assertEqual(body["error"]["code"], "AUTH_REQUIRED")
        self.assertEqual(body["error"]["requestId"], response.header("X-Request-Id"))

        sample = client.request("GET", "/api/v1/sample")
        self.assertEqual(sample.status, 401)
        self.assertEqual(error_code(sample), "AUTH_REQUIRED")

    def test_register_login_me_logout_flow(self) -> None:
        client = self.new_client()
        registered = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "alice", "password": PASSWORD},
        )
        self.assertEqual(registered.status, 201)
        self.assertEqual(registered.json()["user"]["username"], "alice")
        self.assertNotIn("password", registered.text.lower())

        duplicate = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "ALICE", "password": PASSWORD},
        )
        self.assertEqual(duplicate.status, 409)
        self.assertEqual(error_code(duplicate), "CONFLICT_USERNAME")

        weak = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "bob", "password": "short"},
        )
        self.assertEqual(weak.status, 422)
        self.assertEqual(error_code(weak), "VALIDATION_FAILED")

        wrong = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": "alice", "password": "wrong-password-1"},
        )
        self.assertEqual(wrong.status, 401)
        self.assertEqual(error_code(wrong), "AUTH_INVALID_CREDENTIALS")

        logged_in = client.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": "alice", "password": PASSWORD},
        )
        self.assertEqual(logged_in.status, 200)
        self.assertTrue(logged_in.json()["csrfToken"])
        session_cookie = client.cookies.get("kj_session")
        self.assertTrue(session_cookie)
        self.assertNotIn(session_cookie, logged_in.text)

        set_cookies = logged_in.header_all("Set-Cookie")
        session_headers = [value for value in set_cookies if value.startswith("kj_session=")]
        csrf_headers = [value for value in set_cookies if value.startswith("kj_csrf=")]
        self.assertTrue(session_headers)
        self.assertTrue(csrf_headers)
        self.assertIn("HttpOnly", session_headers[0])
        self.assertIn("SameSite=Lax", session_headers[0])
        self.assertNotIn("HttpOnly", csrf_headers[0])

        me = client.request("GET", "/api/v1/auth/me")
        self.assertEqual(me.status, 200)
        self.assertEqual(me.json()["user"]["username"], "alice")

        logged_out = client.request("POST", "/api/v1/auth/logout")
        self.assertEqual(logged_out.status, 204)
        self.assertNotIn("kj_session", client.cookies)

        # Replay the old cookie: the server-side session must be gone.
        client.cookies["kj_session"] = session_cookie
        replay = client.request("GET", "/api/v1/plans")
        self.assertEqual(replay.status, 401)
        self.assertEqual(error_code(replay), "AUTH_REQUIRED")

    def test_register_requires_json_and_valid_fields(self) -> None:
        client = self.new_client()
        wrong_type = client.request(
            "POST",
            "/api/v1/auth/register",
            body='{"username":"alice","password":"correct-horse-9"}',
            content_type="text/plain",
        )
        self.assertEqual(wrong_type.status, 415)
        self.assertEqual(error_code(wrong_type), "UNSUPPORTED_MEDIA_TYPE")

        invalid_json = client.request(
            "POST",
            "/api/v1/auth/register",
            body="{not json",
            content_type="application/json",
        )
        self.assertEqual(invalid_json.status, 422)
        self.assertEqual(error_code(invalid_json), "VALIDATION_FAILED")

        bad_username = client.request(
            "POST",
            "/api/v1/auth/register",
            json_body={"username": "a b", "password": PASSWORD},
        )
        self.assertEqual(bad_username.status, 422)

    # -------------------------------------------------------------------- plans
    def test_plan_crud_stats_and_isolation(self) -> None:
        alice = self.register_and_login("alice")
        created = self.create_sample_plan(alice)
        plan_id = created["id"]
        self.assertEqual(created["revision"], 1)
        self.assertEqual(created["doc"]["schemaVersion"], 1)

        rooms = created["stats"]["rooms"]
        self.assertEqual(len(rooms), 2)
        self.assertEqual(rooms[0]["areaM2"], 12.0)
        self.assertEqual(rooms[0]["roomName"], "客厅")
        self.assertEqual(rooms[0]["furnitureCount"], 4)
        self.assertEqual(rooms[1]["areaM2"], 9.0)
        self.assertEqual(created["stats"]["totalAreaM2"], 21.0)
        self.assertEqual(rooms[0]["wallAreaM2"], 33.32)
        self.assertEqual(rooms[1]["wallAreaM2"], 30.03)

        fetched = alice.request("GET", f"/api/v1/plans/{plan_id}")
        self.assertEqual(fetched.status, 200)
        self.assertEqual(fetched.json()["doc"], created["doc"])

        bob = self.register_and_login("bob")
        for method in ("GET", "DELETE"):
            response = bob.request(method, f"/api/v1/plans/{plan_id}")
            self.assertEqual(response.status, 404, f"{method} should hide other plans")
            self.assertEqual(error_code(response), "NOT_FOUND")

        bob_list = bob.request("GET", "/api/v1/plans").json()
        self.assertEqual(bob_list["total"], 0)

        alice_list = alice.request("GET", "/api/v1/plans").json()
        self.assertEqual(alice_list["total"], 1)
        self.assertEqual(alice_list["items"][0]["id"], plan_id)
        self.assertEqual(alice_list["items"][0]["roomCount"], 2)

        deleted = alice.request("DELETE", f"/api/v1/plans/{plan_id}")
        self.assertEqual(deleted.status, 204)
        self.assertEqual(alice.request("GET", f"/api/v1/plans/{plan_id}").status, 404)

    def test_default_plan_and_revision_conflict(self) -> None:
        client = self.register_and_login("carol")
        created = client.request("POST", "/api/v1/plans", json_body={"name": "空白"})
        self.assertEqual(created.status, 201, created.text)
        plan = created.json()
        self.assertEqual(plan["revision"], 1)
        self.assertEqual(plan["stats"]["totalAreaM2"], 12.0)
        plan_id = plan["id"]

        without_revision = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={"doc": plan["doc"]},
        )
        self.assertEqual(without_revision.status, 422)
        self.assertEqual(error_code(without_revision), "VALIDATION_FAILED")

        first = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={"expectedRevision": 1, "doc": plan["doc"]},
        )
        self.assertEqual(first.status, 200, first.text)
        self.assertEqual(first.json()["revision"], 2)

        stale = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={"expectedRevision": 1, "doc": plan["doc"]},
        )
        self.assertEqual(stale.status, 409)
        self.assertEqual(error_code(stale), "CONFLICT_REVISION")
        self.assertEqual(stale.json()["error"]["details"]["currentRevision"], 2)

        current = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={"expectedRevision": 2, "doc": plan["doc"], "name": "改名"},
        )
        self.assertEqual(current.status, 200)
        self.assertEqual(current.json()["revision"], 3)
        self.assertEqual(current.json()["name"], "改名")

    def test_schema_version_and_document_validation(self) -> None:
        client = self.register_and_login("dave")
        plan = client.request("POST", "/api/v1/plans", json_body={}).json()
        plan_id = plan["id"]
        doc = plan["doc"]

        unsupported = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={"expectedRevision": 1, "doc": {**doc, "schemaVersion": 2}},
        )
        self.assertEqual(unsupported.status, 422)
        self.assertEqual(error_code(unsupported), "UNSUPPORTED_SCHEMA_VERSION")

        empty_walls = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={"expectedRevision": 1, "doc": {**doc, "walls": [], "rooms": []}},
        )
        self.assertEqual(empty_walls.status, 422)

        bad_coordinate = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={
                "expectedRevision": 1,
                "doc": {**doc, "walls": [dict(doc["walls"][0], a=[-100001, 0])]},
            },
        )
        self.assertEqual(bad_coordinate.status, 422)

        opening_beyond_wall = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={
                "expectedRevision": 1,
                "doc": {
                    **doc,
                    "openings": [
                        {
                            "id": "o1",
                            "wallId": "w1",
                            "type": "window",
                            "offset": 3900,
                            "width": 900,
                            "height": 1400,
                            "sill": 900,
                        }
                    ],
                },
            },
        )
        self.assertEqual(opening_beyond_wall.status, 422)

        unknown_furniture = client.request(
            "PUT",
            f"/api/v1/plans/{plan_id}",
            json_body={
                "expectedRevision": 1,
                "doc": {
                    **doc,
                    "furniture": [{"id": "f1", "catalogId": "does-not-exist", "x": 0, "y": 0}],
                },
            },
        )
        self.assertEqual(unknown_furniture.status, 422)

        still_revision_one = client.request("GET", f"/api/v1/plans/{plan_id}")
        self.assertEqual(still_revision_one.json()["revision"], 1)

    def test_pagination_and_search(self) -> None:
        client = self.register_and_login("erin")
        for name in ("方案 A", "方案 B", "方案 C", "100%", "100x"):
            response = client.request("POST", "/api/v1/plans", json_body={"name": name})
            self.assertEqual(response.status, 201, response.text)

        page_one = client.request("GET", "/api/v1/plans?page=1&pageSize=2").json()
        self.assertEqual(page_one["total"], 5)
        self.assertEqual(page_one["pageSize"], 2)
        self.assertEqual(page_one["totalPages"], 3)
        self.assertEqual(len(page_one["items"]), 2)

        page_three = client.request("GET", "/api/v1/plans?page=3&pageSize=2").json()
        self.assertEqual(len(page_three["items"]), 1)

        clamped = client.request("GET", "/api/v1/plans?pageSize=500").json()
        self.assertEqual(clamped["pageSize"], 100)

        bad_page = client.request("GET", "/api/v1/plans?page=0")
        self.assertEqual(bad_page.status, 422)
        huge_page = client.request("GET", "/api/v1/plans?page=18446744073709551616")
        self.assertEqual(huge_page.status, 422)
        self.assertEqual(error_code(huge_page), "VALIDATION_FAILED")
        bad_page_size = client.request("GET", "/api/v1/plans?pageSize=abc")
        self.assertEqual(bad_page_size.status, 422)

        search = client.request("GET", "/api/v1/plans?q=100%25").json()
        self.assertEqual([item["name"] for item in search["items"]], ["100%"])

    # -------------------------------------------------------------------- share
    def test_share_is_read_only_and_revocable(self) -> None:
        owner = self.register_and_login("frank")
        plan = self.create_sample_plan(owner)
        plan_id = plan["id"]

        issued = owner.request("POST", f"/api/v1/plans/{plan_id}/share")
        self.assertEqual(issued.status, 201, issued.text)
        token = issued.json()["token"]
        self.assertEqual(issued.json()["url"], f"/share/{token}")

        anonymous = self.new_client()
        share_page = anonymous.request(
            "GET", f"/share/{token}", headers={"Accept": "text/html"}
        )
        self.assertEqual(share_page.status, 200)
        self.assertIn("text/html", share_page.header("Content-Type"))
        self.assertIn("kujiale test", share_page.text)
        share_page_as_json = anonymous.request(
            "GET", f"/share/{token}", headers={"Accept": "application/json"}
        )
        self.assertEqual(share_page_as_json.status, 404)
        self.assertEqual(error_code(share_page_as_json), "NOT_FOUND")

        shared = anonymous.request("GET", f"/api/v1/share/{token}")
        self.assertEqual(shared.status, 200, shared.text)
        payload = shared.json()
        self.assertTrue(payload["readOnly"])
        self.assertEqual(payload["doc"], plan["doc"])
        self.assertNotIn("userId", payload)
        self.assertEqual(payload["stats"]["totalAreaM2"], 21.0)

        for method in ("POST", "PUT", "DELETE"):
            rejected = anonymous.request(method, f"/api/v1/share/{token}")
            self.assertEqual(rejected.status, 405, method)
            self.assertEqual(error_code(rejected), "METHOD_NOT_ALLOWED")
            self.assertEqual(rejected.header("Allow"), "GET")

        share_csv = anonymous.request("GET", f"/api/v1/share/{token}/export.csv")
        self.assertEqual(share_csv.status, 200)
        self.assertTrue(share_csv.body.startswith(b"\xef\xbb\xbf"))
        self.assertIn("客厅".encode("utf-8"), share_csv.body)

        other = self.register_and_login("grace")
        denied = other.request("DELETE", f"/api/v1/plans/{plan_id}/share")
        self.assertEqual(denied.status, 404)

        revoked = owner.request("DELETE", f"/api/v1/plans/{plan_id}/share")
        self.assertEqual(revoked.status, 204)
        self.assertEqual(anonymous.request("GET", f"/api/v1/share/{token}").status, 404)
        self.assertEqual(
            anonymous.request("GET", f"/api/v1/share/{token}/export.csv").status, 404
        )

        invalid = anonymous.request("GET", "/api/v1/share/not-a-real-token-000000")
        self.assertEqual(invalid.status, 404)
        self.assertEqual(error_code(invalid), "NOT_FOUND")

        short = anonymous.request("GET", "/api/v1/share/short")
        self.assertEqual(short.status, 404)

    # ---------------------------------------------------------------------- csv
    def test_csv_export_format(self) -> None:
        client = self.register_and_login("henry")
        plan = self.create_sample_plan(client)
        response = client.request("GET", f"/api/v1/plans/{plan['id']}/export.csv")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.header("Content-Type"), "text/csv; charset=utf-8")
        self.assertIn("filename*=UTF-8''", response.header("Content-Disposition"))
        self.assertTrue(response.body.startswith(b"\xef\xbb\xbf"))

        text = response.body.decode("utf-8-sig")
        lines = text.split("\r\n")
        self.assertEqual(
            lines[0],
            "room_name,area_m2,furniture_count,floor_material,floor_area_m2,wall_material,wall_area_m2",
        )
        self.assertEqual(lines[1], "客厅,12.00,4,floor-oak,12.00,paint-warm-white,33.32")
        self.assertEqual(lines[2], "卧室,9.00,3,floor-walnut,9.00,paint-sage,30.03")
        self.assertEqual(lines[3], "")

    def test_csv_formula_injection_and_escaping(self) -> None:
        client = self.register_and_login("ivy")
        plan = client.request("POST", "/api/v1/plans", json_body={}).json()
        doc = plan["doc"]
        doc["rooms"][0]["name"] = '=SUM(A1), "x"'
        updated = client.request(
            "PUT",
            f"/api/v1/plans/{plan['id']}",
            json_body={"expectedRevision": 1, "doc": doc},
        )
        self.assertEqual(updated.status, 200, updated.text)

        response = client.request("GET", f"/api/v1/plans/{plan['id']}/export.csv")
        self.assertEqual(response.status, 200)
        text = response.body.decode("utf-8-sig")
        data_line = text.split("\r\n")[1]
        self.assertTrue(data_line.startswith("\"'=SUM(A1), \"\"x\"\"\""), data_line)

    # -------------------------------------------------------------------- static
    def test_static_files_and_spa_fallback(self) -> None:
        client = self.new_client()
        root = client.request("GET", "/", headers={"Accept": "text/html"})
        self.assertEqual(root.status, 200)
        self.assertIn("kujiale test", root.text)
        self.assertEqual(root.header_all("X-Content-Type-Options"), ["nosniff"])

        deep_link = client.request("GET", "/plans/123", headers={"Accept": "text/html"})
        self.assertEqual(deep_link.status, 200)
        self.assertIn("kujiale test", deep_link.text)

        asset = client.request("GET", "/assets/app.js")
        self.assertEqual(asset.status, 200)
        self.assertEqual(asset.header("Content-Type"), "text/javascript; charset=utf-8")

        missing_asset = client.request("GET", "/assets/missing.js")
        self.assertEqual(missing_asset.status, 404)

        unknown_api = client.request(
            "GET", "/api/v1/does-not-exist", headers={"Accept": "text/html"}
        )
        self.assertEqual(unknown_api.status, 404)
        self.assertEqual(error_code(unknown_api), "NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
