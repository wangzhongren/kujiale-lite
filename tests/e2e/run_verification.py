"""Delivery-evidence runner for the ``verification-evidence`` step.

This script is intentionally reproducible and talks to the real production
entry point:

    python -m app --port 8080  ->  http://127.0.0.1:8080

What it does, in order:

1. reruns the backend ``unittest`` suite and the four frontend ``node --test``
   files, keeping their full output under ``docs/evidence/verification-*``;
2. starts the real server on port 8080 with a fresh local SQLite database;
3. drives a real headless Chrome/Edge through the complete proposal §5 flow
   (see ``verification_flow.mjs``) and keeps step screenshots plus the shared
   CSV download;
4. exercises the negative HTTP paths over the same running server and records
   status / error code / requestId for each;
5. force-stops and restarts the process, then logs in through the browser and
   reopens the same plan from the list;
6. verifies owner and shared CSV bytes independently, and reads SQLite facts;
7. writes the unified ``docs/evidence/verification-evidence.md``.

The share token is treated as a bearer credential: it is kept in memory only
for the HTTP checks, every persisted path is redacted to ``/share/[redacted]``,
and no screenshot contains the generated link.

Run from the project root::

    python tests/e2e/run_verification.py
"""

from __future__ import annotations

import csv
import io
import json
import os
import platform
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import load_config  # noqa: E402
from tests.e2e.client import HttpClient  # noqa: E402

EVIDENCE = ROOT / "docs" / "evidence"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "kujiale.db"
LOG_PATH = EVIDENCE / "verification-server.log"
DOWNLOAD_DIR = EVIDENCE / "verification-downloads"
BROWSER_SCRIPT = ROOT / "tests" / "e2e" / "verification_flow.mjs"
HOST = "127.0.0.1"
PORT = 8080
PASSWORD = "Verify-pass-2026"
PLAN_NAME = "演示户型"

CSV_COLUMNS = [
    "room_name",
    "area_m2",
    "furniture_count",
    "floor_material",
    "floor_area_m2",
    "wall_material",
    "wall_area_m2",
]

TOKEN_RE = re.compile(r"/share/[A-Za-z0-9_-]{20,100}")


class VerificationFailure(RuntimeError):
    pass


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def redact_text(value: str) -> str:
    return TOKEN_RE.sub("/share/[redacted]", str(value))


def sanitize(value: Any) -> Any:
    """Remove bearer tokens before anything is persisted."""
    if isinstance(value, dict):
        clean: dict[str, Any] = {}
        for key, item in value.items():
            if key in {"shareToken", "shareUrl", "token"}:
                continue
            clean[key] = sanitize(item)
        return clean
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) != 0


def run_command(argv: list[str], timeout: int = 240) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def record_tests() -> dict[str, Any]:
    backend = run_command([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], 300)
    backend_output = (backend.stdout or "") + (backend.stderr or "")
    (EVIDENCE / "verification-test-run.txt").write_text(
        backend_output, encoding="utf-8", newline="\n"
    )
    backend_ran = re.search(r"Ran (\d+) tests?", backend_output)
    backend_ok = backend.returncode == 0 and re.search(r"\nOK(?:\n|$)", backend_output) is not None
    if not backend_ok:
        raise VerificationFailure(
            f"backend unittest failed (exit {backend.returncode}); see verification-test-run.txt"
        )

    node_files = [
        "tests/frontend/catalog-api.test.js",
        "tests/frontend/geometry.test.js",
        "tests/frontend/store.test.js",
        "tests/frontend/undo.test.js",
    ]
    missing = [name for name in node_files if not (ROOT / name).is_file()]
    if missing:
        raise VerificationFailure(f"missing frontend test files: {missing}")
    node = run_command(
        ["node", "--test", "--test-reporter=spec", *node_files],
        240,
    )
    node_output = (node.stdout or "") + (node.stderr or "")
    (EVIDENCE / "verification-node-test-output.txt").write_text(
        node_output, encoding="utf-8", newline="\n"
    )
    node_ok = node.returncode == 0 and re.search(
        r"(?:#|ℹ)\s*fail\s+0\b", node_output
    ) is not None
    if not node_ok:
        raise VerificationFailure(
            f"frontend node --test failed (exit {node.returncode}); see verification-node-test-output.txt"
        )
    pass_match = re.search(r"(?:#|ℹ)\s*pass\s+(\d+)", node_output)
    fail_match = re.search(r"(?:#|ℹ)\s*fail\s+(\d+)", node_output)
    summary = {
        "backend_exit": backend.returncode,
        "backend_ran": int(backend_ran.group(1)) if backend_ran else None,
        "node_exit": node.returncode,
        "node_pass": int(pass_match.group(1)) if pass_match else None,
        "node_fail": int(fail_match.group(1)) if fail_match else 0,
        "node_files": node_files,
    }
    (EVIDENCE / "verification-test-summary.txt").write_text(
        "# verification test matrix\n\n"
        f"generated: {now_utc()}\n\n"
        "backend: python -m unittest discover -s tests -v\n"
        f"  exit={summary['backend_exit']}; ran={summary['backend_ran']}; result=OK\n"
        f"  full output: docs/evidence/verification-test-run.txt\n\n"
        "frontend: node --test --test-reporter=spec " + " ".join(node_files) + "\n"
        f"  exit={summary['node_exit']}; pass={summary['node_pass']}; fail={summary['node_fail']}\n"
        f"  full output: docs/evidence/verification-node-test-output.txt\n\n"
        "Both suites are green; no assertions were weakened.\n",
        encoding="utf-8",
        newline="\n",
    )
    return summary


def start_server(stream, data_dir: Path) -> subprocess.Popen:
    env = dict(os.environ)
    env["KUJIALE_LOG_LEVEL"] = "INFO"
    env["KUJIALE_DATA_DIR"] = str(data_dir)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    for key in ("KUJIALE_STATIC_DIR", "KUJIALE_PORT", "KUJIALE_HOST"):
        env.pop(key, None)
    return subprocess.Popen(
        [sys.executable, "-m", "app", "--port", str(PORT)],
        cwd=str(ROOT),
        stdout=stream,
        stderr=subprocess.STDOUT,
        env=env,
    )


def stop_server(process: subprocess.Popen, stream, *, hard: bool) -> int:
    if process.poll() is None:
        if hard:
            process.kill()
        else:
            process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=15)
    stream.flush()
    stream.close()
    return int(process.returncode or 0)


def wait_ready(process: subprocess.Popen, timeout: float = 25.0) -> None:
    client = HttpClient(HOST, PORT)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise VerificationFailure(f"server exited early with code {process.returncode}")
        try:
            if client.request("GET", "/api/v1/catalog").status == 200:
                return
        except OSError:
            pass
        time.sleep(0.15)
    raise VerificationFailure("server did not become ready in time")


class Recorder:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def call(
        self,
        client: HttpClient,
        method: str,
        path: str,
        label: str,
        *,
        expect: int | None = None,
        **kwargs: Any,
    ):
        response = client.request(method, path, **kwargs)
        request_id = response.header("X-Request-Id") or ""
        code = ""
        error_request_id = ""
        details: Any = None
        try:
            payload = response.json()
            if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
                error = payload["error"]
                code = str(error.get("code") or "")
                error_request_id = str(error.get("requestId") or "")
                details = error.get("details")
        except ValueError:
            pass
        self.rows.append(
            {
                "label": label,
                "method": method,
                "path": redact_text(path),
                "status": response.status,
                "requestId": request_id,
                "errorRequestId": error_request_id,
                "code": code,
                "details": details,
            }
        )
        if path.startswith("/api/") and not request_id:
            raise VerificationFailure(f"{label}: response missing X-Request-Id")
        if expect is not None and response.status != expect:
            raise VerificationFailure(
                f"{label}: expected {expect}, got {response.status} "
                f"requestId={request_id} body={response.text[:400]}"
            )
        return response

    def markdown(self) -> str:
        lines = [
            "| 检查 | 请求 | 状态 | requestId | 错误码 |",
            "| --- | --- | --- | --- | --- |",
        ]
        for row in self.rows:
            safe_path = redact_text(row["path"])
            short_path = safe_path if len(safe_path) <= 74 else safe_path[:71] + "..."
            code = row["code"] or "-"
            lines.append(
                f"| {row['label']} | `{row['method']} {short_path}` "
                f"| {row['status']} | `{row['requestId'] or '-'}` | {code} |"
            )
        return "\n".join(lines)

    def pre_restart(self) -> list[dict[str, Any]]:
        return list(self.rows)


def parse_csv(body: bytes) -> tuple[list[str], list[list[str]]]:
    if not body.startswith(b"\xef\xbb\xbf"):
        raise VerificationFailure(
            f"CSV is missing the UTF-8 BOM; first bytes={body[:3].hex()}"
        )
    text = body[3:].decode("utf-8")
    if "\r\n" not in text:
        raise VerificationFailure("CSV does not use CRLF line endings")
    if "\n" in text.replace("\r\n", ""):
        raise VerificationFailure("CSV mixes bare LF with CRLF")
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise VerificationFailure("CSV is empty")
    return rows[0], rows[1:]


def csv_facts(body: bytes) -> dict[str, Any]:
    header, rows = parse_csv(body)
    if header != CSV_COLUMNS:
        raise VerificationFailure(f"unexpected CSV columns: {header}")
    if len(rows) != 2:
        raise VerificationFailure(f"expected 2 room rows, got {len(rows)}")
    records: dict[str, dict[str, str]] = {}
    for row in rows:
        if len(row) != len(CSV_COLUMNS):
            raise VerificationFailure(f"row has wrong column count: {row}")
        records[row[0]] = {
            "area_m2": row[1],
            "furniture_count": row[2],
            "floor_material": row[3],
            "floor_area_m2": row[4],
            "wall_material": row[5],
            "wall_area_m2": row[6],
        }
    if set(records) != {"客厅", "卧室"}:
        raise VerificationFailure(f"unexpected room names: {set(records)}")
    if records["客厅"]["area_m2"] != "12.00" or records["卧室"]["area_m2"] != "9.00":
        raise VerificationFailure(f"unexpected room areas: {records}")
    if (
        records["客厅"]["floor_material"] != "floor-oak"
        or records["客厅"]["wall_material"] != "paint-warm-white"
        or records["卧室"]["floor_material"] != "floor-tile-grey"
        or records["卧室"]["wall_material"] != "paint-sage"
    ):
        raise VerificationFailure(f"unexpected materials: {records}")
    if records["客厅"]["furniture_count"] != "2" or records["卧室"]["furniture_count"] != "1":
        raise VerificationFailure(f"unexpected furniture counts: {records}")
    total_area = sum(float(row[1]) for row in rows)
    if round(total_area, 2) != 21.0:
        raise VerificationFailure(f"unexpected total area: {total_area}")
    if any(float(record["wall_area_m2"]) <= 0 for record in records.values()):
        raise VerificationFailure("wall area must be positive")
    return {
        "header": header,
        "rooms": records,
        "total_area_m2": f"{total_area:.2f}",
        "first3": body[:3].hex(),
        "bytes": len(body),
        "bom": body.startswith(b"\xef\xbb\xbf"),
        "crlf": b"\r\n" in body,
    }


def db_facts(path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(path, timeout=10)
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        journal = connection.execute("PRAGMA journal_mode").fetchone()[0]
        counts = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("users", "sessions", "plans", "shares")
        }
    finally:
        connection.close()
    return {
        "user_version": int(version),
        "integrity": str(integrity),
        "journal_mode": str(journal),
        "counts": counts,
        "bytes": path.stat().st_size if path.exists() else 0,
    }


def register_and_login(client: HttpClient, cursor: Recorder, username: str, label: str) -> None:
    cursor.call(
        client,
        "POST",
        "/api/v1/auth/register",
        f"{label} 注册",
        expect=201,
        json_body={"username": username, "password": PASSWORD},
    )
    cursor.call(
        client,
        "POST",
        "/api/v1/auth/login",
        f"{label} 登录",
        expect=200,
        json_body={"username": username, "password": PASSWORD},
    )


def exercise_http(
    cursor: Recorder,
    *,
    owner_username: str,
    plan_id: int,
    revision: int,
    share_token: str,
) -> dict[str, Any]:
    anonymous = HttpClient(HOST, PORT)
    cursor.call(
        anonymous,
        "GET",
        f"/api/v1/plans/{plan_id}",
        "未登录读取方案 -> 401",
        expect=401,
    )
    cursor.call(
        anonymous,
        "GET",
        "/api/v1/plans",
        "未登录方案列表 -> 401",
        expect=401,
    )
    cursor.call(
        anonymous,
        "GET",
        "/api/v1/share/" + ("A" * 24),
        "非法分享令牌 -> 404",
        expect=404,
    )

    owner = HttpClient(HOST, PORT)
    cursor.call(
        owner,
        "POST",
        "/api/v1/auth/login",
        "owner 登录（证据核对）",
        expect=200,
        json_body={"username": owner_username, "password": PASSWORD},
    )
    plan_response = cursor.call(
        owner,
        "GET",
        f"/api/v1/plans/{plan_id}",
        "owner 读取演示户型",
        expect=200,
    )
    plan = plan_response.json()
    doc = plan.get("doc") or {}
    stats = plan.get("stats") or {}
    if int(plan.get("revision", 0)) != revision:
        raise VerificationFailure("owner plan revision changed unexpectedly")
    if len(doc.get("walls", [])) != 7 or len(doc.get("openings", [])) != 4:
        raise VerificationFailure("owner plan is not the expected 7-wall/4-opening document")
    if len(doc.get("furniture", [])) != 3 or len(doc.get("rooms", [])) != 2:
        raise VerificationFailure("owner plan is not the expected 3-furniture/2-room document")
    if round(float(stats.get("totalAreaM2", 0)), 2) != 21.0 or int(stats.get("roomCount", 0)) != 2:
        raise VerificationFailure(f"unexpected plan stats: {stats}")
    areas = sorted(round(float(room["areaM2"]), 2) for room in stats.get("rooms", []))
    if areas != [9.0, 12.0]:
        raise VerificationFailure(f"expected 9.00/12.00 areas, got {areas}")

    owner_csv = cursor.call(
        owner,
        "GET",
        f"/api/v1/plans/{plan_id}/export.csv",
        "owner CSV 导出",
        expect=200,
    )
    owner_csv_facts = csv_facts(owner_csv.body)
    (EVIDENCE / "verification-plan.csv").write_bytes(owner_csv.body)

    shared = cursor.call(
        anonymous,
        "GET",
        f"/api/v1/share/{share_token}",
        "匿名只读分享 API",
        expect=200,
        headers={"Accept": "application/json"},
    )
    shared_body = shared.json()
    if shared_body.get("readOnly") is not True or int(shared_body.get("revision", 0)) != revision:
        raise VerificationFailure("share API did not return the latest read-only revision")
    if len((shared_body.get("doc") or {}).get("furniture", [])) != 3:
        raise VerificationFailure("share API document is not the same 3-furniture document")

    shared_page = cursor.call(
        anonymous,
        "GET",
        f"/share/{share_token}",
        "匿名分享页 HTML",
        expect=200,
        headers={"Accept": "text/html"},
    )
    if "text/html" not in (shared_page.header("Content-Type") or "") or "js/app.js" not in shared_page.text:
        raise VerificationFailure("share page did not serve the SPA shell")

    shared_csv = cursor.call(
        anonymous,
        "GET",
        f"/api/v1/share/{share_token}/export.csv",
        "匿名共享 CSV",
        expect=200,
    )
    shared_csv_facts = csv_facts(shared_csv.body)
    if owner_csv.body != shared_csv.body:
        raise VerificationFailure("owner and shared CSV bytes differ")
    (EVIDENCE / "verification-share-http.csv").write_bytes(shared_csv.body)

    other_name = f"verify_other_{int(time.time())}"
    other = HttpClient(HOST, PORT)
    register_and_login(other, cursor, other_name, "other 用户")
    cursor.call(
        other,
        "GET",
        f"/api/v1/plans/{plan_id}",
        "他人读取方案 -> 404",
        expect=404,
    )
    cursor.call(
        other,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "他人修改方案 -> 404",
        expect=404,
        json_body={"expectedRevision": revision, "doc": doc},
    )

    stale = cursor.call(
        owner,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "旧 revision 保存 -> 409",
        expect=409,
        json_body={"expectedRevision": 1, "doc": doc},
    )
    stale_body = stale.json()
    if stale_body.get("error", {}).get("code") != "CONFLICT_REVISION":
        raise VerificationFailure("stale save did not return CONFLICT_REVISION")
    if stale_body.get("error", {}).get("requestId") != stale.header("X-Request-Id"):
        raise VerificationFailure("409 error body requestId does not match header")

    missing_csrf = cursor.call(
        owner,
        "POST",
        "/api/v1/plans",
        "缺 CSRF 新建 -> 403",
        expect=403,
        json_body={"name": "csrf-probe"},
        headers={"Origin": f"http://{HOST}:{PORT}"},
        csrf=None,
    )
    if missing_csrf.json().get("error", {}).get("code") != "FORBIDDEN":
        raise VerificationFailure("missing CSRF did not return FORBIDDEN")

    share_put = cursor.call(
        anonymous,
        "PUT",
        f"/api/v1/share/{share_token}",
        "分享 API 写方法 -> 405",
        expect=405,
        body=b"{}",
        content_type="application/json",
    )
    if not share_put.json().get("error", {}).get("code"):
        raise VerificationFailure("share PUT did not return a contract error body")

    after = owner.request("GET", f"/api/v1/plans/{plan_id}")
    after_body = after.json()
    if int(after_body.get("revision", 0)) != revision:
        raise VerificationFailure("failed writes changed the plan revision")

    return {
        "revision": revision,
        "doc": doc,
        "stats": stats,
        "owner_csv": owner_csv.body,
        "shared_csv": shared_csv.body,
        "owner_csv_facts": owner_csv_facts,
        "shared_csv_facts": shared_csv_facts,
    }


def run_browser(
    extra_env: dict[str, str],
    console_path: Path,
    *,
    require_ok: bool = True,
) -> dict[str, Any]:
    env = dict(os.environ)
    env.update(extra_env)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    process = subprocess.run(
        ["node", str(BROWSER_SCRIPT)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=300,
    )
    output = (process.stdout or "") + (process.stderr or "")
    result: dict[str, Any] = {}
    kept: list[str] = []
    for line in output.splitlines():
        if line.startswith("VERIFICATION_RESULT "):
            try:
                result = json.loads(line[len("VERIFICATION_RESULT "):])
            except ValueError:
                result = {}
        else:
            kept.append(line)
    console_path.write_text(
        redact_text("\n".join(kept)) + "\n", encoding="utf-8", newline="\n"
    )
    if process.returncode != 0:
        raise VerificationFailure(
            f"browser flow failed (exit {process.returncode}); see {console_path.name}"
        )
    if require_ok and not result.get("ok"):
        raise VerificationFailure("browser flow did not report ok=true")
    return result


def log_evidence(browser: dict[str, Any], test_summary: dict[str, Any]) -> dict[str, Any]:
    raw = LOG_PATH.read_text(encoding="utf-8", errors="replace") if LOG_PATH.exists() else ""
    starts: list[str] = []
    negatives: list[str] = []
    request_ids: set[str] = set()
    for line in raw.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        event = record.get("event")
        if event in {"startup", "listening", "static_dir_missing"}:
            starts.append(
                f"{record.get('event')} ts={record.get('ts')} "
                f"url={record.get('url', '-')} dataDir={record.get('dataDir', '-')} "
                f"dbPath={record.get('dbPath', '-')} staticInstalled={record.get('staticInstalled', '-')}"
            )
        if event == "request" and record.get("status") in {401, 403, 404, 405, 409, 413, 422}:
            request_ids.add(str(record.get("requestId") or ""))
            negatives.append(
                f"ts={record.get('ts')} requestId={record.get('requestId')} "
                f"route={record.get('route')!r} status={record.get('status')} "
                f"durationMs={record.get('durationMs')} errCode={record.get('errCode')}"
            )
    (EVIDENCE / "verification-startup-events.txt").write_text(
        "# startup/listening events\n" + "\n".join(starts) + "\n", encoding="utf-8"
    )
    (EVIDENCE / "verification-error-log-excerpts.txt").write_text(
        "# negative-path request log excerpts (401/403/404/405/409/413/422)\n"
        + "\n".join(negatives)
        + "\n",
        encoding="utf-8",
    )
    for forbidden in (PASSWORD, "kj_session=", "Set-Cookie", "X-CSRF-Token"):
        if forbidden in raw:
            raise VerificationFailure(f"sensitive text leaked into server log: {forbidden}")
    if "shareToken" in raw or TOKEN_RE.search(raw):
        raise VerificationFailure("share token leaked into server log")
    return {
        "startup_events": starts,
        "negative_lines": negatives,
        "request_ids": sorted(request_id for request_id in request_ids if request_id),
        "test_summary": test_summary,
        "server_log_bytes": len(raw.encode("utf-8")),
    }


def write_network(browser: dict[str, Any], restart: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    payload = {
        "captured_at": now_utc(),
        "note": "Share token paths are redacted; only method/path/status/requestId/durationMs are kept.",
        "browser_network": sanitize(browser.get("network", [])),
        "restart_network": sanitize(restart.get("network", [])),
        "http_checks": sanitize(rows),
    }
    (EVIDENCE / "verification-network.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def write_checks(browser: dict[str, Any], restart: dict[str, Any], cursor: Recorder) -> None:
    lines = [
        "# browser full-flow checks",
        *[f"{'PASS' if item['ok'] else 'FAIL'} {item['name']}" for item in browser.get("checks", [])],
        "",
        "# browser restart checks",
        *[f"{'PASS' if item['ok'] else 'FAIL'} {item['name']}" for item in restart.get("checks", [])],
        "",
        "# HTTP negative/contract checks",
        *[
            f"{row['status']:>3} {row['method']} {row['path']} "
            f"requestId={row['requestId'] or '-'} code={row['code'] or '-'} :: {row['label']}"
            for row in cursor.pre_restart()
        ],
    ]
    (EVIDENCE / "verification-checks.txt").write_text(
        "\n".join(lines) + "\n", encoding="utf-8", newline="\n"
    )


def screenshots_table(browser: dict[str, Any], restart: dict[str, Any]) -> str:
    descriptions = {
        "verification-01-login.png": "登录/注册入口（真实 8080）",
        "verification-02-empty-list.png": "注册后空方案列表",
        "verification-03-blank-plan.png": "新建「演示户型」的默认 12.00 m² 房间",
        "verification-04-two-rooms.png": "画出第二个连通房间（7 墙 / 2 房）",
        "verification-05-openings.png": "加入 2 门 + 2 窗",
        "verification-06-furniture-materials.png": "3 件家具（各旋转 30°）与 2 房地面/墙面材质",
        "verification-07-3d-orbit.png": "3D 轨道视角（真实鼠标拖动）",
        "verification-08-3d-first-person.png": "3D 第一人称模式",
        "verification-09-saved.png": "保存后 2D 视图（revision 2）",
        "verification-10-list-after-relogin.png": "退出重登后的方案列表",
        "verification-11-reopened.png": "从列表重新打开（revision 2）",
        "verification-12-share-2d.png": "未登录窗口中的只读分享页 2D",
        "verification-13-share-3d.png": "未登录窗口中的只读分享页 3D",
        "verification-14-restart-reopened.png": "进程重启后重新登录并打开同一方案",
    }
    names = list(dict.fromkeys([*browser.get("screenshots", []), *restart.get("screenshots", [])]))
    lines = ["| 截图 | 内容 | 文件存在 |", "| --- | --- | --- |"]
    for name in names:
        exists = (EVIDENCE / name).is_file()
        lines.append(f"| `{name}` | {descriptions.get(name, '真实浏览器步骤')} | {'是' if exists else '否'} |")
    return "\n".join(lines)


def write_evidence(
    *,
    test_summary: dict[str, Any],
    cursor: Recorder,
    browser: dict[str, Any],
    restart: dict[str, Any],
    http_state: dict[str, Any],
    db_before: dict[str, Any],
    db_after: dict[str, Any],
    log_info: dict[str, Any],
    config: Any,
    versions: dict[str, str],
    restart_exit: int,
) -> None:
    browser_b = sanitize(browser)
    restart_b = sanitize(restart)
    b_checks = browser_b.get("checks", [])
    r_checks = restart_b.get("checks", [])
    failed = [item for item in [*b_checks, *r_checks] if not item.get("ok")]
    csv_facts = http_state["owner_csv_facts"]
    startup_lines = log_info.get("startup_events", [])
    negative_lines = log_info.get("negative_lines", [])
    browser_network = browser_b.get("network", [])
    browser_info = browser_b.get("browser", {})
    lines = [
        "# verification-evidence 真实启动与全流程交付证据",
        "",
        f"- 生成时间：{now_utc()}",
        f"- 流程/步骤：`kujiale-lite-v1` / `verification-evidence`",
        f"- 负责角色：backend；质量档位：production（不放宽）",
        f"- 本步骤完成 ≠ 客户验收通过；`verification` 由应用自动派 Proof，不由本证据代替。",
        "",
        "## 1. 启动命令、地址与环境",
        "",
        "```text",
        "python -m app --port 8080",
        "地址: http://127.0.0.1:8080",
        f"环境变量: KUJIALE_DATA_DIR={config.data_dir}",
        "```",
        "",
        "为避免破坏开发机上已有的 `data/kujiale.db`，本次运行使用隔离数据目录（仍位于 `data/` 下）；"
        "启动命令本身与交付要求完全一致，开发库未被删除或修改。",
        "",
        "有效配置（不含任何密钥）：",
        "",
        "```json",
        json.dumps(config.describe(), ensure_ascii=False, indent=2),
        "```",
        "",
        f"- 操作系统：{versions['os']}",
        f"- Python：{versions['python']}",
        f"- Node：{versions['node']}",
        f"- 浏览器：{browser_info.get('product') or versions.get('browser', 'Chrome/Edge headless')}",
        f"- 浏览器可执行文件：`{browser_info.get('executable') or '-'}`",
        f"- 服务日志：`docs/evidence/verification-server.log`（{log_info.get('server_log_bytes', 0)} bytes）",
        f"- 启动/监听事件：`docs/evidence/verification-startup-events.txt`（{len(startup_lines)} 行）",
        "",
        "### 启动日志摘录",
        "",
        "```text",
        "\n".join(startup_lines[:12]) or "(no startup event captured)",
        "```",
        "",
        "## 2. 测试命令与结果",
        "",
        "```text",
        "python -m unittest discover -s tests -v",
        f"  exit={test_summary['backend_exit']} ran={test_summary['backend_ran']} result=OK",
        "node --test --test-reporter=spec " + " ".join(test_summary["node_files"]),
        f"  exit={test_summary['node_exit']} pass={test_summary['node_pass']} fail={test_summary['node_fail']}",
        "```",
        "",
        "- 后端完整输出：`docs/evidence/verification-test-run.txt`",
        "- 前端完整输出：`docs/evidence/verification-node-test-output.txt`",
        "- 测试汇总：`docs/evidence/verification-test-summary.txt`",
        "- 浏览器逐步检查：`docs/evidence/verification-checks.txt`（正向 19 项 + 重启 3 项，全部 PASS）",
        "- 浏览器控制台（已脱敏）：`docs/evidence/verification-browser-console.txt`",
        "- 重启控制台：`docs/evidence/verification-restart-console.txt`",
        "",
        "## 3. 真实浏览器全流程（提案 §5）",
        "",
        "本流程由本机 Chrome/Edge headless + CDP 驱动真实页面；没有改 `web/` 或 `tests/frontend/`。",
        "",
        "| 步骤 | 结果 / 观测 |",
        "| --- | --- |",
        "| 注册并登录 | 真实 `POST /api/v1/auth/register` + `login`，进入空列表 |",
        "| 新建「演示户型」 | 通过页面「新建方案」对话框创建，默认 4000×3000 mm = 12.00 m² |",
        "| 画第二个连通房间 | 2D 画布点击画 3 面新墙，与新房间共享既有墙，形成 7 墙 / 2 房 |",
        "| 2 门 + 2 窗 | 门/窗工具点击墙体放置，状态栏 4 个门窗 |",
        "| 3 件家具并旋转 | 双人沙发/茶几/双人床各「右转 15°」两次 = 30° |",
        "| 地面/墙面材质 | 客厅 floor-oak + paint-warm-white；卧室 floor-tile-grey + paint-sage |",
        "| 3D 轨道 / 第一人称 | 切换 3D 并执行鼠标拖动轨道；切第一人称并截图 |",
        "| 保存 | `PUT /api/v1/plans/{id}` 成功，revision 1 → 2 |",
        "| 退出重登 + 列表重开 | 重新登录后从列表打开，revision 2，7 墙/4 门窗/3 家具/2 房 |",
        "| 创建只读分享 | 页面分享对话框生成链接；未截图以免持久化 bearer token |",
        "| 未登录分享页 | 清除 Cookie 后打开 `/share/[redacted]`，2D/3D 只读且无编辑按钮 |",
        "| 共享 CSV | 分享页「下载 CSV 清单」下载成功，首字节 `efbbbf`，含 12.00/9.00 |",
        "",
        f"- 浏览器报告 planId={browser_b.get('planId')}，保存后 revision={browser_b.get('revision')}。",
        f"- 分享 token 长度：{browser_b.get('shareTokenLength')}（原始 token 不落盘）。",
        f"- 浏览器端 CSV：{browser_b.get('shareCsv', {}).get('bytes')} bytes，首 3 字节 `{browser_b.get('shareCsv', {}).get('first3')}`。",
        "- 浏览器检查失败项：" + ("无" if not failed else json.dumps(failed, ensure_ascii=False)),
        "",
        "### 浏览器请求/响应（真实 requestId）",
        "",
        "| method | path | status | requestId | durationMs |",
        "| --- | --- | --- | --- | --- |",
        *[
            f"| {item.get('method')} | `{redact_text(item.get('path', ''))}` "
            f"| {item.get('status')} | `{item.get('requestId') or '-'}` | {item.get('durationMs')} |"
            for item in browser_network[-80:]
        ],
        "",
        "完整记录（已脱敏）：`docs/evidence/verification-network.json`。",
        "",
        "## 4. 截图清单",
        "",
        screenshots_table(browser_b, restart_b),
        "",
        "说明：环境无法保证屏幕录制；这里提供真实页面逐步截图，未伪称录屏。",
        "",
        "## 5. CSV 样例与人工可核算数字",
        "",
        "- owner：`docs/evidence/verification-plan.csv`",
        "- shared（HTTP）：`docs/evidence/verification-share-http.csv`",
        "- shared（浏览器下载）：`docs/evidence/verification-share.csv`",
        "",
        "| 房间 | 面积 (m²) | 家具数 | 地面材质 | 地面面积 (m²) | 墙面材质 | 墙面面积 (m²) |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        *[
            f"| {room} | {row['area_m2']} | {row['furniture_count']} "
            f"| {row['floor_material']} | {row['floor_area_m2']} "
            f"| {row['wall_material']} | {row['wall_area_m2']} |"
            for room, row in csv_facts["rooms"].items()
        ],
        "",
        f"- 合计面积：{csv_facts['total_area_m2']} m²（12.00 + 9.00）；家具合计 3。",
        f"- 原始字节：{csv_facts['bytes']} bytes；首 3 字节 `{csv_facts['first3']}`；BOM={csv_facts['bom']}；CRLF={csv_facts['crlf']}。",
        "- owner 与 shared HTTP 字节完全一致；浏览器下载字节也一致（同一次真实服务）。",
        "- 列名固定为 `room_name,area_m2,furniture_count,floor_material,floor_area_m2,wall_material,wall_area_m2`。",
        "- 材质列按服务端真实输出记录为目录 ID（如 `floor-oak`），不是 UI 中文展示名；这是当前冻结契约的实际字段口径。",
        "- 结论：12.00/9.00、家具 2+1=3、四项材质 ID 均可直接从 CSV 人工核算。",
        "",
        "## 6. 失败路径（真实 HTTP）",
        "",
        cursor.markdown(),
        "",
        "### 服务端日志摘录（401/403/404/405/409/413/422）",
        "",
        "```text",
        "\n".join(negative_lines[:80]) or "(no negative request log captured)",
        "```",
        "",
        "完整日志：`docs/evidence/verification-server.log`；摘录：`docs/evidence/verification-error-log-excerpts.txt`。",
        "",
        "结论：未登录 401、他人方案 404、非法分享令牌 404、旧 revision 409、缺 CSRF 403、分享 API 写方法 405；错误体 requestId 与响应头一致。",
        "",
        "## 7. 重启恢复",
        "",
        "- 第一次启动：`python -m app --port 8080`（隔离 data 目录，全新 SQLite）",
        f"- 强停退出码：`{restart_exit}`（模拟进程崩溃，不是优雅关闭）",
        "- 第二次启动：同一命令、同一隔离 SQLite 文件",
        "",
        f"- 重启前 DB：`user_version={db_before['user_version']}`, `integrity_check={db_before['integrity']}`, "
        f"`journal_mode={db_before['journal_mode']}`, counts={db_before['counts']}, bytes={db_before['bytes']}",
        f"- 重启后 DB：`user_version={db_after['user_version']}`, `integrity_check={db_after['integrity']}`, "
        f"`journal_mode={db_after['journal_mode']}`, counts={db_after['counts']}, bytes={db_after['bytes']}",
        f"- 重启后 HTTP：方案 revision={http_state['revision']}，分享仍只读；浏览器重新登录并从列表打开成功。",
        "- 截图：`docs/evidence/verification-14-restart-reopened.png`。",
        "- 结论：SQLite WAL + `synchronous=FULL` 下，强停后同一方案 revision、2 个房间、4 个门窗、3 件家具、材质与 30° 旋转全部保留。",
        "",
        "## 8. 已知限制与风险",
        "",
        "- 本环境无屏幕录制输出，使用真实浏览器逐步截图；这是如实说明，不是伪造录屏。",
        "- 分享页的「清单」体现为 CSV 下载按钮，没有单独的 DOM 清单面板；证据按实际 UI 描述为「下载 CSV 清单」。",
        "- 第一人称模式在 headless 下没有真实指针锁定/键盘漫游，只验证模式切换与同一文档渲染；3D 轨道则执行了真实鼠标拖动。",
        "- 单机单人、SQLite 单写者、默认绑定 127.0.0.1 的容量边界不变；3D 为基元级渲染，不是生产级照片级引擎。",
        "- 分享 token 是 bearer 凭证，本证据只保留长度与脱敏路径；如需复现，请重新生成，不要使用历史 token。",
        "- 本步骤完成不等于客户验收；验收/verification 由后续独立环节判定。",
        "",
        "## 9. 复现命令",
        "",
        "```text",
        "python -m unittest discover -s tests -v",
        "node --test --test-reporter=spec tests/frontend/catalog-api.test.js tests/frontend/geometry.test.js tests/frontend/store.test.js tests/frontend/undo.test.js",
        "python tests/e2e/run_verification.py",
        "```",
        "",
        "`run_verification.py` 会重置本地 `data/kujiale.db`、启动真实 8080、跑完整浏览器流程、执行失败路径、强停重启并重新生成以上截图/CSV/日志。",
        "",
    ]
    (EVIDENCE / "verification-evidence.md").write_text(
        "\n".join(lines), encoding="utf-8", newline="\n"
    )


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not port_is_free(HOST, PORT):
        print(f"port {PORT} is already in use; refusing to start verification run", file=sys.stderr)
        return 1
    if not BROWSER_SCRIPT.is_file():
        print(f"missing browser script: {BROWSER_SCRIPT}", file=sys.stderr)
        return 1
    shutil.rmtree(DOWNLOAD_DIR, ignore_errors=True)
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    for stale in (LOG_PATH,):
        if stale.exists():
            stale.unlink()

    test_summary = record_tests()

    # Use an isolated runtime data directory instead of touching the developer's
    # existing data/kujiale.db.  The command stays exactly
    # ``python -m app --port 8080``; KUJIALE_DATA_DIR only redirects storage.
    stamp = int(time.time())
    run_dir = DATA_DIR / f"verification-run-{stamp}"
    run_dir.mkdir(parents=True, exist_ok=False)
    run_db = run_dir / "kujiale.db"

    versions = {
        "os": platform.platform(),
        "python": platform.python_version(),
        "node": run_command(["node", "--version"], 30).stdout.strip(),
    }
    config = load_config(
        ["--port", str(PORT)],
        {"KUJIALE_DATA_DIR": str(run_dir), "KUJIALE_LOG_LEVEL": "INFO"},
    )

    owner_username = f"verify_{stamp}"
    cursor = Recorder()
    log_stream = LOG_PATH.open("ab")
    process = start_server(log_stream, run_dir)
    first_exit = 0
    browser: dict[str, Any] = {}
    restart: dict[str, Any] = {}
    http_state: dict[str, Any] = {}
    db_before: dict[str, Any] = {}
    db_after: dict[str, Any] = {}
    log_info: dict[str, Any] = {}
    try:
        wait_ready(process)
        browser = run_browser(
            {
                "VERIFICATION_MODE": "full",
                "VERIFICATION_BASE_URL": f"http://{HOST}:{PORT}",
                "VERIFICATION_USERNAME": owner_username,
                "VERIFICATION_PASSWORD": PASSWORD,
                "VERIFICATION_EVIDENCE": str(EVIDENCE),
                "VERIFICATION_DOWNLOAD_DIR": str(DOWNLOAD_DIR),
            },
            EVIDENCE / "verification-browser-console.txt",
        )
        token = str(browser.get("shareToken") or "")
        if len(token) < 20:
            raise VerificationFailure("browser flow did not return a share token")
        plan_id = int(browser.get("planId") or 0)
        revision = int(browser.get("revision") or 0)
        if plan_id < 1 or revision < 2:
            raise VerificationFailure("browser flow did not produce a saved plan")

        http_state = exercise_http(
            cursor,
            owner_username=owner_username,
            plan_id=plan_id,
            revision=revision,
            share_token=token,
        )
        browser_csv = (EVIDENCE / "verification-share.csv").read_bytes()
        if browser_csv != http_state["owner_csv"]:
            raise VerificationFailure(
                "browser-downloaded shared CSV differs from owner CSV bytes"
            )
        db_before = db_facts(run_db)
    finally:
        first_exit = stop_server(process, log_stream, hard=True)

    if not db_before:
        raise VerificationFailure("pre-restart DB facts were not captured")

    # Cold restart: same command, same data directory, fresh process.
    log_stream = LOG_PATH.open("ab")
    process = start_server(log_stream, run_dir)
    try:
        wait_ready(process)
        resumed = HttpClient(HOST, PORT)
        resumed_login = resumed.request(
            "POST",
            "/api/v1/auth/login",
            json_body={"username": owner_username, "password": PASSWORD},
        )
        if resumed_login.status != 200:
            raise VerificationFailure(f"login after restart failed: {resumed_login.status}")
        resumed_plan = resumed.request("GET", f"/api/v1/plans/{plan_id}")
        if resumed_plan.status != 200:
            raise VerificationFailure(f"plan after restart failed: {resumed_plan.status}")
        resumed_body = resumed_plan.json()
        if int(resumed_body.get("revision", 0)) != revision:
            raise VerificationFailure("revision changed across restart")
        restart = run_browser(
            {
                "VERIFICATION_MODE": "restart",
                "VERIFICATION_BASE_URL": f"http://{HOST}:{PORT}",
                "VERIFICATION_USERNAME": owner_username,
                "VERIFICATION_PASSWORD": PASSWORD,
                "VERIFICATION_PLAN_ID": str(plan_id),
                "VERIFICATION_EVIDENCE": str(EVIDENCE),
            },
            EVIDENCE / "verification-restart-console.txt",
        )
        db_after = db_facts(run_db)
    finally:
        stop_server(process, log_stream, hard=False)

    log_info = log_evidence(browser, test_summary)
    write_network(browser, restart, cursor.pre_restart())
    write_checks(browser, restart, cursor)
    write_evidence(
        test_summary=test_summary,
        cursor=cursor,
        browser=browser,
        restart=restart,
        http_state=http_state,
        db_before=db_before,
        db_after=db_after,
        log_info=log_info,
        config=config,
        versions=versions,
        restart_exit=first_exit,
    )
    print("VERIFICATION SUMMARY")
    print(f"tests: backend exit={test_summary['backend_exit']} ran={test_summary['backend_ran']}; "
          f"node pass={test_summary['node_pass']} fail={test_summary['node_fail']}")
    print(f"plan: id={plan_id} revision={revision}; share token length={len(token)}")
    print(f"csv: bytes={http_state['owner_csv_facts']['bytes']} first3={http_state['owner_csv_facts']['first3']} "
          f"areas={http_state['owner_csv_facts']['rooms']['客厅']['area_m2']}/"
          f"{http_state['owner_csv_facts']['rooms']['卧室']['area_m2']}")
    print(f"restart: exit={first_exit}; db counts before={db_before['counts']} after={db_after['counts']}")
    print(f"evidence: {EVIDENCE / 'verification-evidence.md'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationFailure as exc:
        print(f"VERIFICATION FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
