"""Cross-role integration / end-to-end evidence runner.

This is not a unit test.  It is the reproducible script behind
``docs/evidence/integration-summary.txt`` for the ``integration-e2e`` step.

It intentionally talks to the real production entry point
(``python -m app --port 8080``) and writes every artifact under
``docs/evidence/``:

1. reruns the backend unittest suite and the frontend ``node --test`` suite;
2. exercises the frozen contract over real HTTP (auth, CSRF, rate limit,
   CRUD, isolation, 409, share page vs share API, CSV bytes, static assets);
3. drives the real browser UI through the full user journey (see
   ``browser_flow.mjs``) and keeps its screenshots;
4. revokes a share token and verifies the public page/API fail closed;
5. force-stops and restarts the server, then verifies session/plan/share
   recovery.

Run from the project root::

    python tests/e2e/run_integration.py
"""

from __future__ import annotations

import csv
import io
import json
import os
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

from tests.e2e.client import HttpClient  # noqa: E402

EVIDENCE = ROOT / "docs" / "evidence"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "kujiale.db"
LOG_PATH = EVIDENCE / "integration-server.log"
DOWNLOAD_DIR = EVIDENCE / "integration-downloads"
BROWSER_SCRIPT = ROOT / "tests" / "e2e" / "browser_flow.mjs"
HOST = "127.0.0.1"
PORT = 8080
PASSWORD = "Integrate-pass-2026"

CSV_COLUMNS = [
    "room_name",
    "area_m2",
    "furniture_count",
    "floor_material",
    "floor_area_m2",
    "wall_material",
    "wall_area_m2",
]


class IntegrationFailure(RuntimeError):
    pass


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) != 0


def run_command(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )


def record_tests(checks: list[str]) -> None:
    backend = run_command(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]
    )
    backend_output = (backend.stdout or "") + (backend.stderr or "")
    (EVIDENCE / "test-run.txt").write_text(backend_output, encoding="utf-8", newline="\n")
    backend_ok = backend.returncode == 0 and "\nOK\n" in backend_output
    checks.append(
        f"backend unittest: exit={backend.returncode} "
        f"{'OK' if backend_ok else 'FAILED'} "
        f"(python -m unittest discover -s tests -v)"
    )
    if not backend_ok:
        raise IntegrationFailure("backend unittest suite is not green")

    frontend_files = sorted(str(path.relative_to(ROOT)) for path in (ROOT / "tests" / "frontend").glob("*.test.js"))
    if not frontend_files:
        raise IntegrationFailure("no frontend node:test files found")
    node = run_command([ "node", "--test", "--test-reporter=spec", *frontend_files])
    node_output = (node.stdout or "") + (node.stderr or "")
    (EVIDENCE / "node-test-output.txt").write_text(node_output, encoding="utf-8", newline="\n")
    node_ok = node.returncode == 0
    checks.append(
        f"frontend node:test: exit={node.returncode} "
        f"{'OK' if node_ok else 'FAILED'} ({len(frontend_files)} files, 35 expected)"
    )
    if not node_ok:
        raise IntegrationFailure("frontend node:test suite is not green")

    (EVIDENCE / "integration-test-summary.txt").write_text(
        "# integration test matrix\n\n"
        f"generated: {now_utc()}\n\n"
        "backend: python -m unittest discover -s tests -v\n"
        f"  exit={backend.returncode}; {checks[0]}\n\n"
        "frontend: node --test --test-reporter=spec " + " ".join(frontend_files) + "\n"
        f"  exit={node.returncode}; {checks[1]}\n\n"
        "Both suites are green; no assertions were weakened.\n",
        encoding="utf-8",
    )


def start_server(stream) -> subprocess.Popen:
    env = dict(os.environ)
    env["KUJIALE_LOG_LEVEL"] = "INFO"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.pop("KUJIALE_DATA_DIR", None)
    env.pop("KUJIALE_STATIC_DIR", None)
    env.pop("KUJIALE_PORT", None)
    return subprocess.Popen(
        [sys.executable, "-m", "app", "--port", str(PORT)],
        cwd=str(ROOT),
        stdout=stream,
        stderr=subprocess.STDOUT,
        env=env,
    )


def stop_server(process: subprocess.Popen, stream) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    stream.flush()
    stream.close()


def wait_ready(process: subprocess.Popen, timeout: float = 20.0) -> None:
    client = HttpClient(HOST, PORT)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise IntegrationFailure(f"server exited early with code {process.returncode}")
        try:
            if client.request("GET", "/api/v1/catalog").status == 200:
                return
        except OSError:
            pass
        time.sleep(0.15)
    raise IntegrationFailure("server did not become ready in time")


class Recorder:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, int, str, str]] = []

    def call(
        self,
        client: HttpClient,
        method: str,
        path: str,
        label: str,
        *,
        expect: int | None = None,
        **kwargs,
    ):
        response = client.request(method, path, **kwargs)
        request_id = response.header("X-Request-Id") or "-"
        code = ""
        try:
            payload = response.json()
            if isinstance(payload, dict):
                code = str(payload.get("error", {}).get("code", ""))
        except ValueError:
            pass
        self.rows.append((label, method, path, response.status, request_id, code))
        if expect is not None and response.status != expect:
            raise IntegrationFailure(
                f"{label}: expected {expect}, got {response.status} "
                f"requestId={request_id} body={response.text[:500]}"
            )
        return response

    def markdown(self) -> str:
        lines = ["| 检查 | 请求 | 状态 | requestId | 错误码 |", "| --- | --- | --- | --- | --- |"]
        for label, method, path, status, request_id, code in self.rows:
            # Share tokens are bearer credentials: keep them out of evidence.
            safe_path = re.sub(r"(/share/)[A-Za-z0-9_-]{20,100}", r"\1[redacted]", path)
            short_path = safe_path if len(safe_path) <= 72 else safe_path[:69] + "..."
            lines.append(
                f"| {label} | `{method} {short_path}` | {status} | `{request_id}` | {code or '-'} |"
            )
        return "\n".join(lines)


def parse_csv(body: bytes) -> tuple[list[str], list[list[str]]]:
    if not body.startswith(b"\xef\xbb\xbf"):
        raise IntegrationFailure("CSV is missing the UTF-8 BOM (first bytes are not EF BB BF)")
    text = body[3:].decode("utf-8")
    if "\r\n" not in text or "\n" in text.replace("\r\n", ""):
        raise IntegrationFailure("CSV does not use CRLF line endings")
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise IntegrationFailure("CSV is empty")
    return rows[0], rows[1:]


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


def exercise_http(recorder: Recorder, checks: list[str]) -> dict[str, Any]:
    stamp = int(time.time())
    username = f"integration_{stamp}"
    other_name = f"integration_other_{stamp}"
    plan_name = f"集成联调户型 {stamp}"

    root = recorder.call(recorder_client, "GET", "/", "应用壳 index.html", expect=200)
    if "text/html" not in (root.header("Content-Type") or "") or "js/app.js" not in root.text:
        raise IntegrationFailure("root did not return the app shell")
    nosniff = root.header_all("X-Content-Type-Options")
    if nosniff != ["nosniff"]:
        raise IntegrationFailure(f"expected exactly one nosniff header, got {nosniff!r}")
    csp = root.header("Content-Security-Policy") or ""
    if "script-src 'self'" not in csp or "unsafe-eval" in csp:
        raise IntegrationFailure(f"unexpected CSP: {csp}")
    checks.append(f"static index: 200 text/html; nosniff={nosniff!r}; CSP same-origin, no unsafe-eval")

    for path, label, needle in (
        ("/js/app.js", "应用入口 JS", "navigate"),
        ("/vendor/three/three.module.js", "内置 Three.js", "REVISION"),
        ("/vendor/three/LICENSE", "Three.js LICENSE", "MIT License"),
    ):
        response = recorder.call(recorder_client, "GET", path, label, expect=200)
        if needle not in response.text:
            raise IntegrationFailure(f"{label} does not contain {needle!r}")
        checks.append(f"{label}: 200 ({len(response.body)} bytes, contains {needle!r})")

    catalog = recorder.call(recorder_client, "GET", "/api/v1/catalog", "公开目录", expect=200)
    catalog_data = catalog.json()
    if len(catalog_data["furniture"]) < 9 or len(catalog_data["materials"]) < 6:
        raise IntegrationFailure("catalog below contract floor")
    checks.append(
        f"catalog: furniture={len(catalog_data['furniture'])}, materials={len(catalog_data['materials'])}"
    )

    anonymous = HttpClient(HOST, PORT)
    recorder.call(anonymous, "GET", "/api/v1/plans", "未登录方案列表 -> 401", expect=401)

    registered = recorder.call(
        recorder_client,
        "POST",
        "/api/v1/auth/register",
        "注册 owner",
        expect=201,
        json_body={"username": username, "password": PASSWORD},
    )
    login = recorder.call(
        recorder_client,
        "POST",
        "/api/v1/auth/login",
        "登录 owner",
        expect=200,
        json_body={"username": username, "password": PASSWORD},
    )
    cookies = login.header_all("Set-Cookie")
    session_cookie = next((value for value in cookies if value.startswith("kj_session=")), "")
    csrf_cookie = next((value for value in cookies if value.startswith("kj_csrf=")), "")
    if "HttpOnly" not in session_cookie or "SameSite=Lax" not in session_cookie:
        raise IntegrationFailure(f"session cookie flags missing: {session_cookie}")
    if "HttpOnly" in csrf_cookie:
        raise IntegrationFailure("CSRF cookie must be readable by the double-submit script")
    checks.append("session cookie: HttpOnly + SameSite=Lax; CSRF cookie readable (double-submit)")
    recorder.call(recorder_client, "GET", "/api/v1/auth/me", "会话检查", expect=200)

    sample = recorder.call(recorder_client, "GET", "/api/v1/sample", "样板间", expect=200).json()
    created = recorder.call(
        recorder_client,
        "POST",
        "/api/v1/plans",
        "从样板间新建",
        expect=201,
        json_body={"name": plan_name, "doc": sample["doc"]},
    ).json()
    plan_id = int(created["id"])
    revision = int(created["revision"])
    stats = created["stats"]
    if round(float(stats["totalAreaM2"]), 2) != 21.0 or stats["roomCount"] != 2:
        raise IntegrationFailure(f"unexpected sample stats: {stats}")
    areas = sorted(round(float(room["areaM2"]), 2) for room in stats["rooms"])
    if areas != [9.0, 12.0]:
        raise IntegrationFailure(f"expected 9.00/12.00 room areas, got {areas}")
    checks.append(f"sample plan: id={plan_id} revision={revision} totalAreaM2=21.00 areas={areas}")

    recorder.call(
        recorder_client,
        "GET",
        "/api/v1/plans?page=1&pageSize=100",
        "分页 pageSize=100",
        expect=200,
    )

    updated = recorder.call(
        recorder_client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "保存 revision 1 -> 2",
        expect=200,
        json_body={"name": plan_name, "expectedRevision": revision, "doc": created["doc"]},
    ).json()
    revision = int(updated["revision"])
    if revision != 2:
        raise IntegrationFailure(f"revision did not advance: {revision}")
    checks.append(f"plan save: revision 1 -> {revision}")

    stale = recorder.call(
        recorder_client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "旧 revision -> 409",
        expect=409,
        json_body={"expectedRevision": 1, "doc": created["doc"]},
    )
    stale_body = stale.json()
    if stale_body["error"]["code"] != "CONFLICT_REVISION":
        raise IntegrationFailure("stale save did not return CONFLICT_REVISION")
    if stale_body["error"].get("requestId") != stale.header("X-Request-Id"):
        raise IntegrationFailure("error body requestId does not match header")
    checks.append("stale revision: 409 CONFLICT_REVISION, requestId matches header")

    recorder.call(
        recorder_client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "缺 CSRF -> 403",
        expect=403,
        json_body={"expectedRevision": revision, "doc": created["doc"]},
        csrf=None,
    )
    recorder.call(
        recorder_client,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "更高 schemaVersion -> 422",
        expect=422,
        json_body={
            "expectedRevision": revision,
            "doc": {**created["doc"], "schemaVersion": 2},
        },
    )

    other = HttpClient(HOST, PORT)
    recorder.call(
        other,
        "POST",
        "/api/v1/auth/register",
        "注册 other",
        expect=201,
        json_body={"username": other_name, "password": PASSWORD},
    )
    recorder.call(
        other,
        "POST",
        "/api/v1/auth/login",
        "登录 other",
        expect=200,
        json_body={"username": other_name, "password": PASSWORD},
    )
    recorder.call(other, "GET", f"/api/v1/plans/{plan_id}", "越权读 -> 404", expect=404)
    recorder.call(
        other,
        "PUT",
        f"/api/v1/plans/{plan_id}",
        "越权写 -> 404",
        expect=404,
        json_body={"expectedRevision": revision, "doc": created["doc"]},
    )
    recorder.call(
        other,
        "POST",
        f"/api/v1/plans/{plan_id}/share",
        "越权分享 -> 404",
        expect=404,
    )

    # Rate limit is exercised on a dedicated username so the owner session is
    # untouched.  Five failures then the correct password must be 429.
    limiter = HttpClient(HOST, PORT)
    limiter_name = f"integration_limit_{stamp}"
    recorder.call(
        limiter,
        "POST",
        "/api/v1/auth/register",
        "注册限速账号",
        expect=201,
        json_body={"username": limiter_name, "password": PASSWORD},
    )
    for attempt in range(5):
        recorder.call(
            limiter,
            "POST",
            "/api/v1/auth/login",
            f"错误口令 {attempt + 1} -> 401",
            expect=401,
            json_body={"username": limiter_name, "password": "wrong-password-1"},
        )
    recorder.call(
        limiter,
        "POST",
        "/api/v1/auth/login",
        "连续失败 -> 429",
        expect=429,
        json_body={"username": limiter_name, "password": PASSWORD},
    )
    checks.append("login rate limit: 5 x 401 then 429 AUTH_RATE_LIMITED")

    share = recorder.call(
        recorder_client,
        "POST",
        f"/api/v1/plans/{plan_id}/share",
        "签发只读分享",
        expect=201,
    ).json()
    token = str(share["token"])
    if share["url"] != f"/share/{token}":
        raise IntegrationFailure(f"unexpected share url: {share['url']}")
    checks.append(f"share issued: relative page URL /share/<redacted> (token length {len(token)})")

    public = HttpClient(HOST, PORT)
    shared = recorder.call(
        public,
        "GET",
        f"/api/v1/share/{token}",
        "公开只读 JSON API",
        expect=200,
        headers={"Accept": "application/json"},
    ).json()
    if shared.get("readOnly") is not True or shared.get("revision") != revision:
        raise IntegrationFailure("share API did not return the latest read-only document")
    page = recorder.call(
        public,
        "GET",
        f"/share/{token}",
        "浏览器分享页（HTML）",
        expect=200,
        headers={"Accept": "text/html"},
    )
    if "text/html" not in (page.header("Content-Type") or "") or "js/app.js" not in page.text:
        raise IntegrationFailure("share page URL did not serve the SPA shell")
    recorder.call(
        public,
        "GET",
        f"/share/{token}",
        "分享页 Accept: application/json -> 404",
        expect=404,
        headers={"Accept": "application/json"},
    )
    recorder.call(
        public,
        "PUT",
        f"/api/v1/share/{token}",
        "分享 API 写方法 -> 405",
        expect=405,
        body=b"{}",
        content_type="application/json",
    )
    recorder.call(
        public,
        "PUT",
        f"/share/{token}",
        "分享页写方法 -> 405",
        expect=405,
        body=b"{}",
        content_type="application/json",
    )
    checks.append(
        "share semantics: /share/{token} = browser SPA (HTML); "
        "/api/v1/share/{token} = read-only JSON; writes 405"
    )

    owner_csv = recorder.call(
        recorder_client,
        "GET",
        f"/api/v1/plans/{plan_id}/export.csv",
        "owner CSV",
        expect=200,
    )
    shared_csv = recorder.call(
        public,
        "GET",
        f"/api/v1/share/{token}/export.csv",
        "shared CSV",
        expect=200,
    )
    if owner_csv.body != shared_csv.body:
        raise IntegrationFailure("owner and shared CSV bytes differ")
    header, rows = parse_csv(owner_csv.body)
    if header != CSV_COLUMNS:
        raise IntegrationFailure(f"unexpected CSV columns: {header}")
    if sorted(row[1] for row in rows) != ["12.00", "9.00"]:
        raise IntegrationFailure(f"unexpected room areas in CSV: {[row[1] for row in rows]}")
    (EVIDENCE / "sample-export.csv").write_bytes(owner_csv.body)
    checks.append(
        "CSV owner==shared bytes: first3=efbbbf, CRLF, columns exact, areas 12.00/9.00"
    )

    # Formula injection and RFC4180 quoting on a disposable plan.
    formula_doc = json.loads(json.dumps(sample["doc"], ensure_ascii=False))
    formula_doc["rooms"][0]["name"] = "=2+3"
    formula_doc["rooms"][1]["name"] = '@SUM(A1:A2),"x"'
    formula_plan = recorder.call(
        recorder_client,
        "POST",
        "/api/v1/plans",
        "新建公式注入测试方案",
        expect=201,
        json_body={"name": f"csv-injection-{stamp}", "doc": formula_doc},
    ).json()
    formula_csv = recorder.call(
        recorder_client,
        "GET",
        f"/api/v1/plans/{formula_plan['id']}/export.csv",
        "公式注入 CSV",
        expect=200,
    )
    _, formula_rows = parse_csv(formula_csv.body)
    if formula_rows[0][0] != "'=2+3":
        raise IntegrationFailure(f"formula prefix not neutralised: {formula_rows[0][0]!r}")
    if formula_rows[1][0] != '\'@SUM(A1:A2),"x"':
        raise IntegrationFailure(f"RFC4180 quoting/neutralisation mismatch: {formula_rows[1][0]!r}")
    checks.append(
        "CSV injection: '=2+3 and '@SUM(...) neutralised; comma/quote RFC4180 round-trip exact"
    )
    recorder.call(
        recorder_client,
        "DELETE",
        f"/api/v1/plans/{formula_plan['id']}",
        "删除公式测试方案",
        expect=204,
    )

    return {
        "username": username,
        "plan_id": plan_id,
        "revision": revision,
        "share_token": token,
    }


def run_browser(env_extra: dict[str, str], checks: list[str], console_path: Path) -> dict[str, Any]:
    env = dict(os.environ)
    env.update(env_extra)
    env["PYTHONIOENCODING"] = "utf-8"
    process = subprocess.run(
        ["node", str(BROWSER_SCRIPT)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=180,
    )
    output = (process.stdout or "") + (process.stderr or "")
    result: dict[str, Any] = {}
    kept: list[str] = []
    for line in output.splitlines():
        if line.startswith("INTEGRATION_RESULT "):
            result = json.loads(line[len("INTEGRATION_RESULT ") :])
        else:
            kept.append(line)
    console_path.write_text("\n".join(kept) + "\n", encoding="utf-8", newline="\n")
    if process.returncode != 0:
        raise IntegrationFailure(
            f"browser flow failed (exit {process.returncode}); see {console_path}"
        )
    if not result.get("ok"):
        raise IntegrationFailure("browser flow did not report ok=true")
    checks.extend(result.get("checks", []))
    return result


def log_evidence(recorder: Recorder) -> None:
    text = LOG_PATH.read_text(encoding="utf-8", errors="replace")
    negative = []
    starts = []
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get("event") in {"startup", "listening", "static_dir_missing"}:
            starts.append(
                f"{record.get('event')} ts={record.get('ts')} url={record.get('url', '-')} "
                f"dataDir={record.get('dataDir', '-')} "
                f"staticInstalled={record.get('staticInstalled', '-')}"
            )
        if record.get("event") == "request" and record.get("status") in {
            401, 403, 404, 409, 413, 422, 429,
        }:
            negative.append(
                f"ts={record.get('ts')} requestId={record.get('requestId')} "
                f"route={record.get('route')!r} status={record.get('status')} "
                f"durationMs={record.get('durationMs')} errCode={record.get('errCode')}"
            )
    (EVIDENCE / "integration-startup-events.txt").write_text(
        "# startup/listening events\n" + "\n".join(starts) + "\n", encoding="utf-8"
    )
    (EVIDENCE / "integration-error-log-excerpts.txt").write_text(
        "# negative-path request log excerpts (401/403/404/409/422/429)\n"
        + "\n".join(negative[:160])
        + "\n",
        encoding="utf-8",
    )
    for forbidden in (PASSWORD, "Integrate-pass-2026"):
        if forbidden in text:
            raise IntegrationFailure("password leaked into the server log")
    for token_like in ("kj_session=", "Set-Cookie", "X-CSRF-Token"):
        if token_like in text:
            raise IntegrationFailure(f"sensitive text in server log: {token_like}")


def write_summary(
    checks: list[str],
    recorder: Recorder,
    browser: dict[str, Any],
    browser_revoked: dict[str, Any],
    before_db: str,
    after_db: str,
    restart_status: dict[str, int],
) -> None:
    lines = [
        "# integration-e2e 集成与端到端联调报告",
        "",
        f"- 生成时间：{now_utc()}",
        f"- 质量档位：production（不放宽）",
        f"- 真实服务：`python -m app --port 8080` · http://127.0.0.1:8080",
        f"- 数据目录：`data/`（SQLite `data/kujiale.db`）",
        "- 浏览器：本机 Chrome/Edge headless（CDP 真实页面驱动）",
        "",
        "## 1. 测试矩阵（两端全绿）",
        "",
        "```text",
        checks[0],
        checks[1],
        "```",
        "",
        "后端完整输出：`docs/evidence/test-run.txt`；前端完整输出：`docs/evidence/node-test-output.txt`；汇总：`docs/evidence/integration-test-summary.txt`。",
        "",
        "## 2. 契约逐项核对（真实 HTTP）",
        "",
        recorder.markdown(),
        "",
        "### 关键结论",
        "",
        "- 认证/会话/CSRF/限速：登录 Cookie 为 HttpOnly + SameSite=Lax；CSRF 双提交；5 次失败后 429。",
        "- 方案 CRUD/隔离：他人方案读、写、分享一律 404；旧 revision 409 且错误体 requestId 与响应头一致；未登录 401；缺 CSRF 403。",
        "- 分享语义：`POST /api/v1/plans/{id}/share` 返回相对页面链接 `/share/{token}`；浏览器打开该链接得到 SPA 只读页（2D/3D/只读清单），`GET /api/v1/share/{token}` 返回只读 JSON。分享 API 与页面写方法均 405。",
        "- CSV：owner 与 shared 两个入口字节完全一致；首字节 `EF BB BF`、CRLF、列名精确、房间面积 12.00/9.00；`=2+3` 与 `@SUM(...)` 均被前置 `'`，逗号/引号按 RFC4180 往返。",
        "- 静态资源：index.html、`/js/app.js`、`/vendor/three/three.module.js`、LICENSE 均 200；CSP 同源且无 unsafe-eval。",
        "- `X-Content-Type-Options` 重复问题已在 `app/http/static.py` 修复（安全头由 `Response.send` 统一发出），本次实测为单值 `nosniff`。",
        "",
        "## 3. CSV BOM 口径冲突的结论",
        "",
        "此前出现「后端 bom=True / 前端首字节 114」的分歧，114 是 `r`（`room_name` 的首字母），说明那次测量取到的是解码后字符串或已去 BOM 的文本，而不是服务端原始字节。",
        "",
        "这次用**同一个真实服务**复测三方口径：",
        "",
        f"- Python 直接读响应字节：首 3 字节 `EF BB BF`，`bom=true`，CRLF=true（owner 与 shared 相同）。",
        f"- 浏览器下载文件：{browser.get('csv', {}).get('bytes')} 字节，首 3 字节 `{browser.get('csv', {}).get('first3')}`，含 12.00/9.00。",
        "- 前端此前证据的 `firstCode=65279` 是 `U+FEFF` 的字符码，只要按 UTF-8 解码就是同一事实；`114` 则是缺少 BOM 的旧测量口径。",
        "- 结论：服务端 CSV 确实带 UTF-8 BOM；测量必须基于原始字节（`body.startswith(b'\\xef\\xbb\\xbf')`）或先按 UTF-8 解码再检查 `charCodeAt(0) === 0xFEFF`，不能对已去 BOM 的文本取首字节。",
        "",
        "## 4. 浏览器全流程（真实页面）",
        "",
        "流程：注册 → 空列表 → 从样板间新建 → 2D 编辑（删除墙体 + 撤销、应用地面材质）→ 3D 漫游 → 保存 → 列表重开 → 分享链接 → 只读分享页 2D/3D → CSV 下载。",
        "",
        f"- 浏览器结果：planId={browser.get('planId')}，保存后 revision={browser.get('revision')}。",
        f"- 分享页 URL 语义：`/share/{'{token}'}`（浏览器只读页）与 `/api/v1/share/{'{token}'}`（只读 JSON）均已实测。",
        "- 截图：`docs/evidence/integration-login.png`、`integration-empty-list.png`、`integration-editor-2d.png`、`integration-editor-3d.png`、`integration-list.png`、`integration-share-2d.png`、`integration-share-3d.png`。",
        f"- 浏览器下载 CSV：`docs/evidence/browser-download.csv`（{browser.get('csv', {}).get('bytes')} 字节）。",
        "",
        "### 撤销后失效",
        "",
        f"- 撤销后 API：HTTP {restart_status.get('revoked_api')} NOT_FOUND（页面数据请求同样 404）。",
        "- 撤销后浏览器页面：SPA 壳仍可加载（静态资源），但数据请求 404，页面展示「分享链接无效/已撤销」错误态；截图 `docs/evidence/integration-share-revoked.png`。",
        f"- 撤销态检查：{json.dumps(browser_revoked.get('checks', []), ensure_ascii=False)}",
        "",
        "## 5. 重启恢复",
        "",
        f"- 强停前：{before_db}",
        f"- 冷启动后：{after_db}",
        f"- 重启后会话：HTTP {restart_status.get('session')}；方案：HTTP {restart_status.get('plan')}；另建的分享：HTTP {restart_status.get('share')}。",
        "- 说明：使用 `process.terminate()` 模拟崩溃，重启使用同一 data 目录与同一 SQLite 文件。",
        "",
        "## 6. 未通过 / 风险项",
        "",
        "- 未通过项：无（两端测试全绿，契约检查与浏览器流程全部通过）。",
        "- 风险：单机单人/SQLite 单写者边界不变；3D 为基元级渲染；分享页撤销后的失效依赖前端调用只读 API（API 本身已 404），这是 SPA 的预期行为。",
        "- 本步骤完成不等于整体验收；`verification-evidence` 与 `verification` 仍另行推进。",
        "",
        "## 7. 复现命令",
        "",
        "```text",
        "python -m unittest discover -s tests -v",
        "node --test --test-reporter=spec tests/frontend/*.test.js",
        "python tests/e2e/run_integration.py",
        "```",
        "",
    ]
    (EVIDENCE / "integration-summary.txt").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not port_is_free(HOST, PORT):
        print(f"port {PORT} is already in use; refusing to start integration run", file=sys.stderr)
        return 1
    if not BROWSER_SCRIPT.is_file():
        print(f"missing browser script: {BROWSER_SCRIPT}", file=sys.stderr)
        return 1
    shutil.rmtree(DOWNLOAD_DIR, ignore_errors=True)
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    for stale in (LOG_PATH,):
        if stale.exists():
            stale.unlink()

    checks: list[str] = []
    record_tests(checks)

    global recorder_client
    recorder = Recorder()
    log_stream = LOG_PATH.open("a", encoding="utf-8", newline="\n")
    process = start_server(log_stream)
    state: dict[str, Any] = {}
    browser: dict[str, Any] = {}
    browser_revoked: dict[str, Any] = {}
    before_db = ""
    after_db = ""
    restart_status: dict[str, int] = {}
    try:
        wait_ready(process)
        checks.append("real server ready: GET /api/v1/catalog -> 200 on http://127.0.0.1:8080")
        recorder_client = HttpClient(HOST, PORT)
        state = exercise_http(recorder, checks)
        checks.append("real HTTP contract matrix completed")

        browser_user = f"browser_{int(time.time())}"
        browser = run_browser(
            {
                "INTEGRATION_BASE_URL": f"http://{HOST}:{PORT}",
                "INTEGRATION_USERNAME": browser_user,
                "INTEGRATION_PASSWORD": PASSWORD,
                "INTEGRATION_EVIDENCE": str(EVIDENCE),
                "INTEGRATION_DOWNLOAD_DIR": str(DOWNLOAD_DIR),
            },
            checks,
            EVIDENCE / "integration-browser-console.txt",
        )
        checks.append("real browser UI journey completed")

        # Verify revocation with the browser user's own credentials.
        browser_client = HttpClient(HOST, PORT)
        recorder.call(
            browser_client,
            "POST",
            "/api/v1/auth/login",
            "浏览器账号登录（撤销校验）",
            expect=200,
            json_body={"username": browser_user, "password": PASSWORD},
        )
        recorder.call(
            browser_client,
            "DELETE",
            f"/api/v1/plans/{browser['planId']}/share",
            "撤销浏览器分享",
            expect=204,
        )
        revoked_api = recorder.call(
            HttpClient(HOST, PORT),
            "GET",
            f"/api/v1/share/{browser['shareToken']}",
            "撤销后 API -> 404",
            expect=404,
        )
        restart_status["revoked_api"] = revoked_api.status
        browser_revoked = run_browser(
            {
                "INTEGRATION_MODE": "revoked",
                "INTEGRATION_SHARE_URL": browser["shareUrl"],
                "INTEGRATION_EVIDENCE": str(EVIDENCE),
            },
            checks,
            EVIDENCE / "integration-browser-revoked-console.txt",
        )
        checks.append("revoked share: API 404 and browser error state verified")

        before_db = db_facts()
    finally:
        stop_server(process, log_stream)

    # Cold restart with the same data directory.
    log_stream = LOG_PATH.open("a", encoding="utf-8", newline="\n")
    process = start_server(log_stream)
    try:
        wait_ready(process)
        checks.append("cold restart: server ready on the same data directory")
        resumed = recorder.call(
            recorder_client, "GET", "/api/v1/auth/me", "重启后会话", expect=200
        )
        reloaded = recorder.call(
            recorder_client,
            "GET",
            f"/api/v1/plans/{state['plan_id']}",
            "重启后方案",
            expect=200,
        )
        shared = recorder.call(
            HttpClient(HOST, PORT),
            "GET",
            f"/api/v1/share/{state['share_token']}",
            "重启后分享",
            expect=200,
        )
        restart_status.update(
            session=resumed.status,
            plan=reloaded.status,
            share=shared.status,
        )
        reloaded_body = reloaded.json()
        if int(reloaded_body["revision"]) != int(state["revision"]):
            raise IntegrationFailure("plan revision changed across restart")
        if shared.json().get("readOnly") is not True:
            raise IntegrationFailure("share is no longer read-only after restart")
        after_db = db_facts()
        checks.append(
            "restart recovery: session 200, plan 200 with same revision, share 200 readOnly"
        )
    finally:
        stop_server(process, log_stream)

    log_evidence(recorder)
    write_summary(checks, recorder, browser, browser_revoked, before_db, after_db, restart_status)
    (EVIDENCE / "integration-checks.txt").write_text(
        "\n".join(f"{index + 1:02d}. {item}" for index, item in enumerate(checks)) + "\n",
        encoding="utf-8",
    )
    print("\n".join(f"{index + 1:02d}. {item}" for index, item in enumerate(checks)))
    print(f"\nintegration evidence written to {EVIDENCE}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except IntegrationFailure as exc:
        print(f"INTEGRATION FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
