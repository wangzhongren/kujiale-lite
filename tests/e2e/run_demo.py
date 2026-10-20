"""Real-start demonstration and evidence recorder (not a unit test).

This script is run manually to produce ``docs/evidence``:

1. runs the full unittest discovery and writes the verbose output;
2. starts the production entry point exactly as an operator would:
   ``python -m app --port 8080`` (default data directory ``data/``);
3. exercises the contract over real HTTP, including negative paths;
4. forcibly stops the process, restarts it, and verifies SQLite recovery;
5. writes transcripts, startup logs, a sample CSV and log excerpts.

Run from the project root::

    python tests/e2e/run_demo.py
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.e2e.client import HttpClient  # noqa: E402  (path bootstrap above)

EVIDENCE = ROOT / "docs" / "evidence"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "kujiale.db"
LOG_PATH = EVIDENCE / "startup.log"
HOST = "127.0.0.1"
PORT = 8080
PASSWORD = "Demo-pass-2026"


class DemoFailure(RuntimeError):
    pass


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) != 0


def record_tests() -> bool:
    """Run the suite in-process and persist the full verbose output."""
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    started = time.time()
    output_path = EVIDENCE / "test-run.txt"
    with output_path.open("w", encoding="utf-8", newline="\n") as stream:
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
        elapsed = time.time() - started
        stream.write("\n")
        stream.write(f"ran={result.testsRun} failures={len(result.failures)} ")
        stream.write(f"errors={len(result.errors)} skipped={len(result.skipped)} ")
        stream.write(f"successful={result.wasSuccessful()} elapsedSeconds={elapsed:.3f}\n")
    summary = (
        f"ran={result.testsRun} failures={len(result.failures)} "
        f"errors={len(result.errors)} successful={result.wasSuccessful()} "
        f"elapsedSeconds={elapsed:.3f}"
    )
    (EVIDENCE / "test-summary.txt").write_text(
        "command: python -m unittest discover -s tests -v\n"
        "note: tests/unit, tests/integration, tests/e2e are separate top-level "
        "packages; the parent tests/ directory is outside the backend write "
        "boundary, so discovery is rooted at tests/.\n"
        f"{summary}\n",
        encoding="utf-8",
    )
    print(f"[tests] {summary}")
    return bool(result.wasSuccessful())


def start_server(log_stream) -> subprocess.Popen:
    env = dict(os.environ)
    env["KUJIALE_LOG_LEVEL"] = "INFO"
    # Keep JSON log bytes UTF-8 even though Windows redirects stderr through a
    # locale-encoded handle; otherwise non-ASCII data paths become mojibake.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.pop("KUJIALE_DATA_DIR", None)
    env.pop("KUJIALE_STATIC_DIR", None)
    env.pop("KUJIALE_PORT", None)
    process = subprocess.Popen(
        [sys.executable, "-m", "app", "--port", str(PORT)],
        cwd=str(ROOT),
        stdout=log_stream,
        stderr=subprocess.STDOUT,
        env=env,
    )
    return process


def wait_ready(process: subprocess.Popen, timeout: float = 20.0) -> HttpClient:
    client = HttpClient(HOST, PORT)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise DemoFailure(f"server exited early with code {process.returncode}")
        try:
            response = client.request("GET", "/api/v1/catalog")
            if response.status == 200:
                return client
        except OSError:
            pass
        time.sleep(0.15)
    raise DemoFailure("server did not become ready in time")


def stop_server(process: subprocess.Popen, log_stream) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    log_stream.flush()
    log_stream.close()


class Recorder:
    def __init__(self) -> None:
        self.lines: list[str] = ["# backend real-start demo transcript", ""]
        self.secrets: list[str] = []

    def add(self, text: str = "") -> None:
        self.lines.append(text)
        print(text)

    def call(self, client: HttpClient, method: str, path: str, label: str, **kwargs):
        response = client.request(method, path, **kwargs)
        request_id = response.header("X-Request-Id") or "-"
        error_code = ""
        try:
            parsed = response.json()
            if isinstance(parsed, dict):
                error_code = str(parsed.get("error", {}).get("code", ""))
        except ValueError:
            pass
        suffix = f" err={error_code}" if error_code else ""
        self.add(f"{label:<34} {method:<6} {path:<42} -> {response.status} requestId={request_id}{suffix}")
        return response

    def write(self) -> None:
        text = "\n".join(self.lines) + "\n"
        # Evidence must not persist bearer/share tokens; the flow is still
        # demonstrated by method, path shape, status and requestId.
        for secret in self.secrets:
            if secret:
                text = text.replace(secret, "[redacted]")
        (EVIDENCE / "demo-transcript.txt").write_text(text, encoding="utf-8")


def exercise(client: HttpClient, recorder: Recorder) -> dict:
    stamp = int(time.time())
    username = f"demo_{stamp}"
    other = f"other_{stamp}"
    plan_name = f"演示户型 {stamp}"

    catalog = recorder.call(client, "GET", "/api/v1/catalog", "public catalog")
    catalog_data = catalog.json()
    recorder.add(
        f"catalog size: furniture={len(catalog_data['furniture'])} "
        f"materials={len(catalog_data['materials'])}"
    )

    registered = recorder.call(
        client,
        "POST",
        "/api/v1/auth/register",
        "register demo user",
        json_body={"username": username, "password": PASSWORD},
    )
    if registered.status != 201:
        raise DemoFailure(f"register failed: {registered.text}")
    login = recorder.call(
        client,
        "POST",
        "/api/v1/auth/login",
        "login demo user",
        json_body={"username": username, "password": PASSWORD},
    )
    if login.status != 200:
        raise DemoFailure(f"login failed: {login.text}")
    recorder.secrets.extend(
        value
        for value in (client.cookies.get("kj_session"), client.cookies.get("kj_csrf"))
        if value
    )
    recorder.call(client, "GET", "/api/v1/auth/me", "session check")

    anonymous = HttpClient(HOST, PORT)
    recorder.call(anonymous, "GET", "/api/v1/plans", "anonymous plans -> 401")

    sample = recorder.call(client, "GET", "/api/v1/sample", "sample plan")
    sample_data = sample.json()
    if len(sample_data["doc"]["rooms"]) != 2:
        raise DemoFailure("sample plan must contain two rooms")

    created = recorder.call(
        client,
        "POST",
        "/api/v1/plans",
        "create plan from sample",
        json_body={"name": plan_name, "doc": sample_data["doc"]},
    )
    if created.status != 201:
        raise DemoFailure(f"create failed: {created.text}")
    plan = created.json()
    plan_id = plan["id"]
    revision = plan["revision"]
    areas = ", ".join(
        f"{room['roomName']}={room['areaM2']:.2f}m2" for room in plan["stats"]["rooms"]
    )
    recorder.add(
        f"created plan id={plan_id} revision={revision} "
        f"totalAreaM2={plan['stats']['totalAreaM2']:.2f} rooms=[{areas}]"
    )

    document = json.loads(json.dumps(plan["doc"], ensure_ascii=False))
    document["rooms"][0]["name"] = "客厅（演示）"
    updated = recorder.call(
        client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "save plan (revision 1 -> 2)",
        json_body={"name": plan_name, "expectedRevision": revision, "doc": document},
    )
    if updated.status != 200:
        raise DemoFailure(f"update failed: {updated.text}")
    updated_plan = updated.json()
    if updated_plan["revision"] != revision + 1:
        raise DemoFailure("revision did not advance")
    if abs(updated_plan["stats"]["totalAreaM2"] - plan["stats"]["totalAreaM2"]) > 1e-9:
        raise DemoFailure("statistics changed unexpectedly on rename")
    recorder.add(
        f"updated plan revision={updated_plan['revision']} "
        f"totalAreaM2={updated_plan['stats']['totalAreaM2']:.2f}"
    )

    listed = recorder.call(
        client,
        "GET",
        f"/api/v1/plans?q={quote(plan_name, safe='')}",
        "search own plans",
    )
    if listed.status != 200 or listed.json()["total"] != 1:
        raise DemoFailure("search did not find the created plan")

    other_client = HttpClient(HOST, PORT)
    recorder.call(
        other_client,
        "POST",
        "/api/v1/auth/register",
        "register other user",
        json_body={"username": other, "password": PASSWORD},
    )
    other_login = recorder.call(
        other_client,
        "POST",
        "/api/v1/auth/login",
        "login other user",
        json_body={"username": other, "password": PASSWORD},
    )
    if other_login.status != 200:
        raise DemoFailure("other user login failed")
    recorder.call(
        other_client, "GET", f"/api/v1/plans/{plan_id}", "cross-user read -> 404"
    )
    recorder.call(
        other_client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "cross-user write -> 404",
        json_body={"expectedRevision": 2, "doc": document},
    )
    recorder.call(
        other_client,
        "POST",
        f"/api/v1/plans/{plan_id}/share",
        "cross-user share -> 404",
    )

    recorder.call(
        client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "missing CSRF -> 403",
        json_body={"expectedRevision": 2, "doc": document},
        csrf=None,
    )
    stale = recorder.call(
        client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "stale revision -> 409",
        json_body={"expectedRevision": 1, "doc": document},
    )
    if stale.status != 409:
        raise DemoFailure("stale revision was not rejected")

    recorder.call(
        anonymous, "GET", "/api/v1/share/not-a-valid-token", "invalid share -> 404"
    )

    share = recorder.call(
        client, "POST", f"/api/v1/plans/{plan_id}/share", "issue share link"
    )
    if share.status != 201:
        raise DemoFailure(f"share failed: {share.text}")
    token = share.json()["token"]
    recorder.secrets.append(token)
    anonymous_share = recorder.call(
        anonymous, "GET", f"/api/v1/share/{token}", "anonymous share view"
    )
    if anonymous_share.status != 200 or not anonymous_share.json().get("readOnly"):
        raise DemoFailure("share view is not read-only")
    recorder.call(
        anonymous,
        "PUT",
        f"/api/v1/share/{token}",
        "share write -> 405",
        body=b"",
        content_type="application/json",
    )

    csv_owner = recorder.call(
        client, "GET", f"/api/v1/plans/{plan_id}/export.csv", "owner CSV export"
    )
    csv_share = recorder.call(
        anonymous, "GET", f"/api/v1/share/{token}/export.csv", "shared CSV export"
    )
    if csv_owner.status != 200 or csv_share.status != 200:
        raise DemoFailure("CSV export failed")
    if csv_owner.body != csv_share.body:
        raise DemoFailure("owner and shared CSV differ")
    (EVIDENCE / "sample-export.csv").write_bytes(csv_owner.body)
    has_bom = csv_owner.body.startswith(b"\xef\xbb\xbf")
    has_crlf = b"\r\n" in csv_owner.body
    if not has_bom or not has_crlf:
        raise DemoFailure("CSV is missing the UTF-8 BOM or CRLF line endings")
    recorder.add(
        f"CSV bytes={len(csv_owner.body)} bom={has_bom} crlf={has_crlf}"
    )

    recorder.call(
        client, "DELETE", f"/api/v1/plans/{plan_id}/share", "revoke share"
    )
    recorder.call(
        anonymous, "GET", f"/api/v1/share/{token}", "revoked share -> 404"
    )

    second_share = recorder.call(
        client, "POST", f"/api/v1/plans/{plan_id}/share", "issue share for restart"
    )
    if second_share.status != 201:
        raise DemoFailure("second share failed")
    restart_token = second_share.json()["token"]
    recorder.secrets.append(restart_token)

    lock_client = HttpClient(HOST, PORT)
    lock_user = f"lock_{stamp}"
    recorder.call(
        lock_client,
        "POST",
        "/api/v1/auth/register",
        "register rate-limit user",
        json_body={"username": lock_user, "password": PASSWORD},
    )
    for attempt in range(5):
        recorder.call(
            lock_client,
            "POST",
            "/api/v1/auth/login",
            f"bad login {attempt + 1} -> 401",
            json_body={"username": lock_user, "password": "wrong-password-1"},
        )
    limited = recorder.call(
        lock_client,
        "POST",
        "/api/v1/auth/login",
        "rate limited -> 429",
        json_body={"username": lock_user, "password": PASSWORD},
    )
    if limited.status != 429:
        raise DemoFailure("rate limit did not trigger")

    return {
        "username": username,
        "plan_id": plan_id,
        "revision": updated_plan["revision"],
        "plan_name": plan_name,
        "restart_token": restart_token,
        "session_token": client.cookies.get("kj_session"),
        "csrf_token": client.cookies.get("kj_csrf"),
    }


def log_evidence(recorder: Recorder) -> None:
    text = LOG_PATH.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    startup = []
    requests = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get("event") in {"startup", "listening", "static_dir_missing"}:
            startup.append(
                f"{record.get('event')} ts={record.get('ts')} "
                f"url={record.get('url', '-')} dataDir={record.get('dataDir', '-')} "
                f"staticInstalled={record.get('staticInstalled', '-')}"
            )
        if record.get("event") == "request" and record.get("status") in {
            401,
            403,
            404,
            409,
            413,
            422,
            429,
        }:
            requests.append(
                f"ts={record.get('ts')} requestId={record.get('requestId')} "
                f"route={record.get('route')!r} status={record.get('status')} "
                f"durationMs={record.get('durationMs')} errCode={record.get('errCode')}"
            )

    (EVIDENCE / "startup-events.txt").write_text(
        "# startup events (both runs)\n" + "\n".join(startup) + "\n", encoding="utf-8"
    )
    (EVIDENCE / "error-log-excerpts.txt").write_text(
        "# request log excerpts for negative paths (401/403/404/409/413/422/429)\n"
        + "\n".join(requests[:120])
        + "\n",
        encoding="utf-8",
    )

    leaks = [secret for secret in recorder.secrets if secret and secret in text]
    if leaks:
        raise DemoFailure(f"sensitive value leaked into logs: {len(leaks)} value(s)")
    for forbidden in ("Demo-pass-2026", "correct-horse-9", "kj_session", "Set-Cookie"):
        if forbidden in text:
            raise DemoFailure(f"forbidden text in logs: {forbidden}")
    recorder.add(
        f"log scan: PASS ({len(lines)} lines, {len(requests)} negative-path request logs, "
        "no passwords/tokens/cookies)"
    )


def db_facts() -> str:
    connection = sqlite3.connect(DB_PATH)
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        counts = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("users", "sessions", "plans", "shares")
        }
    finally:
        connection.close()
    return (
        f"user_version={version} integrity_check={integrity} "
        f"users={counts['users']} sessions={counts['sessions']} "
        f"plans={counts['plans']} shares={counts['shares']}"
    )


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    if not port_is_free(HOST, PORT):
        print(f"port {PORT} is already in use; refusing to start demo", file=sys.stderr)
        return 1
    for stale in ("startup.log", "test-run.txt", "test-summary.txt"):
        path = EVIDENCE / stale
        if path.exists():
            path.unlink()

    if not record_tests():
        print("test suite failed; demo aborted", file=sys.stderr)
        return 1

    recorder = Recorder()
    recorder.add(f"started at {now_utc()}")
    recorder.add(f"command: python -m app --port {PORT}")
    recorder.add(f"address: http://{HOST}:{PORT}")
    recorder.add(f"python: {sys.version.split()[0]} platform={sys.platform}")
    recorder.add()

    log_stream = LOG_PATH.open("a", encoding="utf-8", newline="\n")
    process = start_server(log_stream)
    try:
        client = wait_ready(process)
        recorder.add("server ready (GET /api/v1/catalog -> 200)")
        recorder.add()
        state = exercise(client, recorder)
        recorder.add()
        recorder.call(client, "GET", "/api/v1/auth/me", "session before restart")
        share_before = recorder.call(
            HttpClient(HOST, PORT),
            "GET",
            f"/api/v1/share/{state['restart_token']}",
            "share before restart",
        )
        if share_before.status != 200:
            raise DemoFailure("restart share is not readable before restart")
        before_db = db_facts()
        recorder.add(f"sqlite before stop: {before_db}")
    finally:
        stop_server(process, log_stream)

    recorder.add()
    recorder.add("--- forced stop (terminate) and cold restart ---")
    log_stream = LOG_PATH.open("a", encoding="utf-8", newline="\n")
    process = start_server(log_stream)
    try:
        wait_ready(process)
        recorder.add("server ready after restart")
        resumed = recorder.call(client, "GET", "/api/v1/auth/me", "session after restart")
        if resumed.status != 200:
            raise DemoFailure("session did not survive restart")
        reloaded = recorder.call(
            client, "GET", f"/api/v1/plans/{state['plan_id']}", "plan after restart"
        )
        if reloaded.status != 200 or reloaded.json()["revision"] != state["revision"]:
            raise DemoFailure("plan did not survive restart")
        restored_share = recorder.call(
            HttpClient(HOST, PORT),
            "GET",
            f"/api/v1/share/{state['restart_token']}",
            "share after restart",
        )
        if restored_share.status != 200:
            raise DemoFailure("share did not survive restart")
        after_db = db_facts()
        recorder.add(f"sqlite after restart: {after_db}")
        (EVIDENCE / "restart-recovery.txt").write_text(
            "# restart recovery evidence\n\n"
            f"time: {now_utc()}\n"
            f"command: python -m app --port {PORT} (same data dir: data/)\n"
            "stop method: process.terminate() (forced stop, simulates a crash)\n\n"
            f"before stop: {before_db}\n"
            f"after restart: {after_db}\n"
            f"session after restart: HTTP {resumed.status}\n"
            f"plan after restart: HTTP {reloaded.status} revision={state['revision']}\n"
            f"share after restart: HTTP {restored_share.status} readOnly="
            f"{restored_share.json().get('readOnly')}\n\n"
            "The session cookie, plan document and share token were all issued before\n"
            "the forced stop; all three were served by the restarted process from the\n"
            "same SQLite database without re-login.\n",
            encoding="utf-8",
        )
    finally:
        stop_server(process, log_stream)

    log_evidence(recorder)
    recorder.add(f"plan id={state['plan_id']} name={state['plan_name']!r} "
                 f"revision={state['revision']}")
    recorder.add(f"finished at {now_utc()}")
    recorder.write()
    print("\nevidence written to docs/evidence/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
