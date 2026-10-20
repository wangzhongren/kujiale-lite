"""Independent acceptance re-run for flow kujiale-lite-v1 (Proof / verifier)."""
from __future__ import annotations

import csv
import io
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
from http.client import HTTPConnection
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

R = Path(__file__).resolve().parents[2]
O = Path(__file__).resolve().parent / "kujiale-lite-v1-run"
H, P = "127.0.0.1", 8080
B = f"http://{H}:{P}"
PW = "Accept-" + secrets.token_hex(8)
COL = ["room_name", "area_m2", "furniture_count", "floor_material",
       "floor_area_m2", "wall_material", "wall_area_m2"]
TR = re.compile(r"/share/[A-Za-z0-9_-]{20,100}")
SR = re.compile(r'("(?:token|shareToken|csrfToken|password)"\s*:\s*")[^"]*"', re.I)
CH = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome",
                 "Application", "chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
K, ROWS = [], []


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def red(value):
    return SR.sub(r'\1[redacted]"', TR.sub("/share/[redacted]", str(value)))


def ck(name, ok, detail=None):
    K.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" :: {detail!r}"))
    return bool(ok)


class Res:
    def __init__(self, status, headers, body):
        self.status, self.h, self.b = status, headers, body

    def hd(self, name):
        return self.h.get(name.lower())

    def js(self):
        return json.loads(self.b.decode("utf-8"))


class Cl:
    def __init__(self):
        self.c = {}

    def q(self, method, path, b=None, j=None, h=None, csrf=None):
        hd = {"Accept": "application/json", **(h or {})}
        if j is not None:
            b = json.dumps(j, ensure_ascii=False).encode()
            hd["Content-Type"] = "application/json"
        if b is not None and "Content-Length" not in hd:
            hd["Content-Length"] = str(len(b))
        if self.c:
            hd["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.c.items())
        if csrf:
            hd["X-CSRF-Token"] = csrf
        co = HTTPConnection(H, P, timeout=30)
        co.request(method, path, body=b, headers=hd)
        r = co.getresponse()
        data, status = r.read(), r.status
        hs = {k.lower(): v for k, v in r.getheaders()}
        for raw in r.msg.get_all("Set-Cookie") or []:
            first = raw.split(";", 1)[0]
            if "=" in first:
                key, value = first.split("=", 1)
                self.c[key.strip()] = value.strip()
        co.close()
        return Res(status, hs, data)


def call(c, method, path, label, exp=None, **kw):
    r = c.q(method, path, **kw)
    code = ""
    try:
        payload = r.js()
        if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
            code = str(payload["error"].get("code") or "")
    except Exception:
        pass
    ROWS.append({"label": label, "method": method, "path": red(path),
                 "status": r.status, "requestId": r.hd("X-Request-Id") or "",
                 "code": code})
    if exp is not None and r.status != exp:
        ck(label, False, {"expected": exp, "got": r.status})
    return r


def tests():
    b = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
                       cwd=R, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=300)
    out = (b.stdout or "") + (b.stderr or "")
    (O / "tests-backend.txt").write_text(out, encoding="utf-8")
    ran = re.search(r"Ran (\d+) tests?", out)
    ck("后端 unittest 全绿", b.returncode == 0 and "\nOK\n" in out,
       {"exit": b.returncode, "ran": ran.group(1) if ran else None})
    files = ["tests/frontend/catalog-api.test.js", "tests/frontend/geometry.test.js",
             "tests/frontend/store.test.js", "tests/frontend/undo.test.js"]
    n = subprocess.run(["node", "--test", "--test-reporter=spec", *files], cwd=R,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=240)
    nout = (n.stdout or "") + (n.stderr or "")
    (O / "tests-frontend.txt").write_text(nout, encoding="utf-8")
    ps = re.search(r"(?:#|ℹ)\s*pass\s+(\d+)", nout)
    fs = re.search(r"(?:#|ℹ)\s*fail\s+(\d+)", nout)
    ck("前端 node:test 全绿", n.returncode == 0 and int(fs.group(1) if fs else 1) == 0,
       {"exit": n.returncode, "pass": ps.group(1) if ps else None})
    return {"backend_exit": b.returncode, "backend_ran": int(ran.group(1)) if ran else None,
            "node_exit": n.returncode, "node_pass": int(ps.group(1)) if ps else None,
            "node_fail": int(fs.group(1)) if fs else None}


def free():
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex((H, P)) != 0
    finally:
        s.close()


def start(data, log):
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    handle = log.open("ab")
    p = subprocess.Popen([sys.executable, "-m", "app", "--port", str(P),
                          "--data-dir", str(data)], cwd=R, stdout=handle,
                         stderr=subprocess.STDOUT, env=env)
    return p, handle


def stop(p, handle, hard):
    if p.poll() is None:
        p.kill() if hard else p.terminate()
        try:
            p.wait(15)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait(15)
    handle.flush()
    handle.close()
    return int(p.returncode or 0)


def ready(p, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if p.poll() is not None:
            raise RuntimeError(f"server exited: {p.returncode}")
        try:
            if Cl().q("GET", "/api/v1/catalog").status == 200:
                return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError("server not ready")


def facts(path):
    conn = sqlite3.connect(str(path), timeout=10)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for t in ("users", "sessions", "plans", "shares")}
    finally:
        conn.close()
    return {"user_version": int(version), "integrity": str(integrity),
            "journal_mode": str(journal), "counts": counts}


def sample(c):
    doc = json.loads(json.dumps(call(c, "GET", "/api/v1/sample", "样板间", 200).js()["doc"]))
    doc["furniture"] = [
        {"id": "f1", "catalogId": "sofa-2", "x": 1200, "y": 500, "rotation": 30},
        {"id": "f2", "catalogId": "coffee-table", "x": 1200, "y": 1500, "rotation": 30},
        {"id": "f5", "catalogId": "bed-double", "x": 5500, "y": 1200, "rotation": 30},
    ]
    doc["materials"] = {"floor": {"r1": "floor-oak", "r2": "floor-tile-grey"},
                        "wall": {"r1": "paint-warm-white", "r2": "paint-sage"}}
    return doc


def big():
    walls = [{"id": f"w{i}", "a": [i * 100, 0], "b": [i * 100 + 50, 0],
              "thickness": 120, "height": 2800} for i in range(400)]
    furniture = [{"id": f"f{i}", "catalogId": "sofa-2", "x": -90000 + i * 100,
                  "y": 50000, "rotation": 0} for i in range(400)]
    return {"schemaVersion": 1, "units": "mm", "walls": walls, "openings": [],
            "rooms": [], "furniture": furniture, "materials": {}}


def csvp(body):
    if not body.startswith(b"\xef\xbb\xbf"):
        return None, None, "no BOM"
    text = body[3:].decode("utf-8")
    if "\r\n" not in text or "\n" in text.replace("\r\n", ""):
        return None, None, "not CRLF"
    rows = list(csv.reader(io.StringIO(text)))
    return rows[0], rows[1:], ""


def cell(row, index):
    return row[index] if row and len(row) > index else None


def png(path):
    data = path.read_bytes()[:24]
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", data[16:24])


def chrome():
    for candidate in CH:
        if candidate and Path(candidate).is_file():
            return candidate
    return shutil.which("chrome") or shutil.which("msedge")


def shot(binary, url, target, width, height):
    profile = O / f"cp-{os.getpid()}-{time.time_ns()}"
    profile.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [binary, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--no-first-run", "--no-default-browser-check",
         "--force-device-scale-factor=1", f"--window-size={width},{height}",
         f"--user-data-dir={profile}", "--virtual-time-budget=9000",
         f"--screenshot={target}", url],
        cwd=R, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=90)
    for _ in range(20):
        if target.is_file() and target.stat().st_size:
            break
        time.sleep(0.1)
    with (O / "chrome-screenshot.log").open("a", encoding="utf-8") as handle:
        handle.write(f"{width}x{height} rc={result.returncode} url={red(url)}\n")
    shutil.rmtree(profile, ignore_errors=True)
    return result.returncode


def browser(mode, extra):
    env = dict(os.environ, **extra, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    result = subprocess.run(["node", "tests/e2e/verification_flow.mjs"], cwd=R,
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", env=env, timeout=420)
    out = (result.stdout or "") + (result.stderr or "")
    payload, kept = {}, []
    for line in out.splitlines():
        if line.startswith("VERIFICATION_RESULT "):
            try:
                payload = json.loads(line.split(" ", 1)[1])
            except ValueError:
                payload = {}
        else:
            kept.append(line)
    (O / f"browser-{mode}-console.txt").write_text(red("\n".join(kept)) + "\n",
                                                   encoding="utf-8")
    return result.returncode, payload


def main():
    O.mkdir(parents=True, exist_ok=True)
    if not free():
        print(f"port {P} busy", file=sys.stderr)
        return 2
    binary = chrome()
    ck("找到 Chrome/Edge", bool(binary), binary)
    T = tests()
    data = Path(tempfile.mkdtemp(prefix="kujiale-accept-"))
    db = data / "kujiale.db"
    log = O / "server.log"
    log.write_bytes(b"")
    stamp = int(time.time())
    user = f"accept_{stamp}_{secrets.token_hex(3)}"
    owner = f"proof_{stamp}_{secrets.token_hex(3)}"
    bp, bok, rp, before, after = {}, False, {}, {}, {}
    first, timing, pid, tok, ocsv, csrf = 0, {}, 0, "", b"", ""

    p, l = start(data, log)
    try:
        ready(p)
        ck("真实启动 python -m app --port 8080", True, {"base": B})
        rc, js = browser("full", {
            "VERIFICATION_MODE": "full", "VERIFICATION_BASE_URL": B,
            "VERIFICATION_USERNAME": user, "VERIFICATION_PASSWORD": PW,
            "VERIFICATION_EVIDENCE": str(O),
            "VERIFICATION_DOWNLOAD_DIR": str(O / "downloads")})
        items = js.get("checks") or js.get("steps") or []
        passed = js.get("ok")
        if passed is None:
            passed = not js.get("failures")
        bok = rc == 0 and bool(passed)
        ck("真实浏览器全流程", bok, {"exit": rc, "checks": len(items) if isinstance(items, list) else 0,
                               "failures": js.get("failures")})
        result_block = js.get("result") if isinstance(js.get("result"), dict) else {}
        bp = {"planId": js.get("planId") or result_block.get("planId"),
              "revision": js.get("revision") or result_block.get("revision"),
              "shareTokenLength": js.get("shareTokenLength") or len(js.get("shareToken") or ""),
              "checks": len(items) if isinstance(items, list) else 0}

        anon = Cl()
        root = call(anon, "GET", "/", "SPA", 200, h={"Accept": "text/html"})
        csp = root.hd("Content-Security-Policy") or ""
        ck("CSP/nosniff", "default-src 'self'" in csp
           and root.hd("X-Content-Type-Options") == "nosniff", {"csp": csp[:100]})
        cat = call(anon, "GET", "/api/v1/catalog", "目录", 200).js()
        ck("目录 >=9 家具 / >=6 材质", len(cat.get("furniture", [])) >= 9
           and len(cat.get("materials", [])) >= 6,
           {"furniture": len(cat.get("furniture", [])), "materials": len(cat.get("materials", []))})

        o = Cl()
        call(o, "POST", "/api/v1/auth/register", "注册", 201,
             j={"username": owner, "password": PW})
        login = call(o, "POST", "/api/v1/auth/login", "登录", 200,
                     j={"username": owner, "password": PW}, h={"Origin": B}).js()
        csrf = login.get("csrfToken") or ""
        ck("登录 CSRF Cookie", bool(csrf) and "kj_csrf" in o.c, sorted(o.c))
        ck("会话可用", call(o, "GET", "/api/v1/auth/me", "me", 200).js()
           .get("user", {}).get("username") == owner)
        ck("新账号列表为空", call(o, "GET", "/api/v1/plans?page=1&pageSize=20", "列表", 200)
           .js().get("total") == 0)

        created = call(o, "POST", "/api/v1/plans", "新建", 201,
                       j={"name": "验收演示户型"}, h={"Origin": B}, csrf=csrf).js()
        pid = int(created.get("id") or 0)
        cd, cs = created.get("doc") or {}, created.get("stats") or {}
        ck("默认 4 墙/1 房/12.00 m²", len(cd.get("walls", [])) == 4
           and bool(cd.get("rooms")) and round(float(cs.get("totalAreaM2", 0)), 2) == 12.0)

        doc = sample(o)
        saved = call(o, "PUT", f"/api/v1/plans/{pid}", "保存", 200,
                     j={"name": "验收演示户型", "expectedRevision": 1, "doc": doc},
                     h={"Origin": B}, csrf=csrf).js()
        sd, ss = saved.get("doc") or {}, saved.get("stats") or {}
        areas = sorted(round(float(room["areaM2"]), 2) for room in ss.get("rooms", []))
        ck("保存 revision=2、7 墙/4 门窗/3 家具/2 房", saved.get("revision") == 2
           and len(sd.get("walls", [])) == 7 and len(sd.get("openings", [])) == 4
           and len(sd.get("furniture", [])) == 3 and len(sd.get("rooms", [])) == 2)
        ck("面积 12.00/9.00 合计 21.00", areas == [9.0, 12.0]
           and round(float(ss.get("totalAreaM2", 0)), 2) == 21.0, {"areas": areas})
        mat = sd.get("materials") or {}
        ck("30° 旋转与两房材质", [x.get("rotation") for x in sd.get("furniture", [])] == [30, 30, 30]
           and (mat.get("floor") or {}) == {"r1": "floor-oak", "r2": "floor-tile-grey"}
           and (mat.get("wall") or {}) == {"r1": "paint-warm-white", "r2": "paint-sage"})

        ocsv = call(o, "GET", f"/api/v1/plans/{pid}/export.csv", "owner CSV", 200).b
        hd, rows, err = csvp(ocsv)
        (O / "owner-plan.csv").write_bytes(ocsv)
        rooms = {row[0]: row for row in (rows or []) if row}
        ck("CSV 列/BOM/CRLF/12.00/9.00/家具 2+1/材质", not err and hd == COL
           and len(rows or []) == 2 and cell(rooms.get("客厅"), 1) == "12.00"
           and cell(rooms.get("卧室"), 1) == "9.00"
           and cell(rooms.get("客厅"), 2) == "2" and cell(rooms.get("卧室"), 2) == "1"
           and cell(rooms.get("客厅"), 3) == "floor-oak"
           and cell(rooms.get("卧室"), 5) == "paint-sage",
           {"err": err, "header": hd, "rows": rows})

        shared = call(o, "POST", f"/api/v1/plans/{pid}/share", "分享", 201,
                      j={}, h={"Origin": B}, csrf=csrf).js()
        tok = str(shared.get("token") or "")
        ck("分享令牌长度 >=20", len(tok) >= 20, {"length": len(tok)})
        share = call(anon, "GET", f"/api/v1/share/{tok}", "分享读", 200).js()
        ck("匿名分享只读 revision=2", share.get("readOnly") is True
           and share.get("revision") == 2)
        scsv = call(anon, "GET", f"/api/v1/share/{tok}/export.csv", "分享 CSV", 200).b
        (O / "shared-http.csv").write_bytes(scsv)
        ck("owner/shared CSV 字节一致", ocsv == scsv, {"bytes": len(scsv)})

        ck("未登录 401", call(anon, "GET", f"/api/v1/plans/{pid}", "401", 401)
           .js().get("error", {}).get("code") == "AUTH_REQUIRED")
        ck("非法分享 404", call(anon, "GET", "/api/v1/share/" + "A" * 24, "404", 404)
           .js().get("error", {}).get("code") == "NOT_FOUND")
        r405 = call(anon, "PUT", f"/api/v1/share/{tok}", "405", 405, b=b"{}",
                    h={"Content-Type": "application/json"})
        ck("405 带 Allow: GET", "GET" in (r405.hd("Allow") or ""), {"allow": r405.hd("Allow")})

        x = Cl()
        xn = f"proof_other_{stamp}_{secrets.token_hex(3)}"
        call(x, "POST", "/api/v1/auth/register", "他人注册", 201,
             j={"username": xn, "password": PW})
        xl = call(x, "POST", "/api/v1/auth/login", "他人登录", 200,
                  j={"username": xn, "password": PW}, h={"Origin": B}).js()
        xc = xl.get("csrfToken") or ""
        ck("跨用户读 404", call(x, "GET", f"/api/v1/plans/{pid}", "跨读", 404)
           .js().get("error", {}).get("code") == "NOT_FOUND")
        call(x, "PUT", f"/api/v1/plans/{pid}", "跨写", 404,
             j={"expectedRevision": 2, "doc": doc}, h={"Origin": B}, csrf=xc)

        stale = call(o, "PUT", f"/api/v1/plans/{pid}", "旧 revision", 409,
                     j={"expectedRevision": 1, "doc": doc}, h={"Origin": B}, csrf=csrf)
        se = stale.js().get("error", {})
        ck("409 CONFLICT_REVISION + requestId", se.get("code") == "CONFLICT_REVISION"
           and se.get("requestId") == stale.hd("X-Request-Id"))
        ck("缺 CSRF 403", call(o, "POST", "/api/v1/plans", "csrf", 403,
                              j={"name": "x"}, h={"Origin": B})
           .js().get("error", {}).get("code") == "FORBIDDEN")
        v2 = json.loads(json.dumps(doc))
        v2["schemaVersion"] = 2
        ck("schemaVersion=2 422", call(o, "PUT", f"/api/v1/plans/{pid}", "v2", 422,
                                      j={"expectedRevision": 2, "doc": v2},
                                      h={"Origin": B}, csrf=csrf)
           .js().get("error", {}).get("code") == "UNSUPPORTED_SCHEMA_VERSION")
        ck("请求体超限 413", call(o, "POST", "/api/v1/plans", "413", 413, b=b"",
                                 h={"Content-Type": "application/json",
                                    "Content-Length": str(2 * 1024 * 1024 + 64 * 1024 + 1),
                                    "Origin": B}, csrf=csrf)
           .js().get("error", {}).get("code") == "PAYLOAD_TOO_LARGE")
        ck("pageSize 上限 100", call(o, "GET", "/api/v1/plans?page=1&pageSize=1000",
                                    "pageSize", 200).js().get("pageSize") == 100)
        call(o, "GET", "/api/v1/plans?page=0", "page=0", 422)

        payload = big()
        t0 = time.perf_counter()
        big_plan = call(o, "POST", "/api/v1/plans", "400/400 保存", 201,
                        j={"name": "容量上限", "doc": payload},
                        h={"Origin": B}, csrf=csrf).js()
        create_ms = (time.perf_counter() - t0) * 1000
        big_id = int(big_plan.get("id") or 0)
        t0 = time.perf_counter()
        big_doc = call(o, "GET", f"/api/v1/plans/{big_id}", "400/400 读取", 200).js().get("doc") or {}
        read_ms = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        big_csv = call(o, "GET", f"/api/v1/plans/{big_id}/export.csv", "400/400 CSV", 200)
        csv_ms = (time.perf_counter() - t0) * 1000
        timing = {"create_ms": round(create_ms, 1), "read_ms": round(read_ms, 1),
                  "csv_ms": round(csv_ms, 1)}
        ck("400 墙/400 家具可读写", len(big_doc.get("walls", [])) == 400
           and len(big_doc.get("furniture", [])) == 400 and big_csv.status == 200, timing)
        ck("400/400 单次请求 <2000ms", max(create_ms, read_ms, csv_ms) < 2000, timing)

        before = facts(db)
        ck("SQLite v1/integrity ok/WAL", before["user_version"] == 1
           and before["integrity"] == "ok" and before["journal_mode"].lower() == "wal", before)
    except Exception as exc:
        ck("首次运行阶段无异常中断", False, f"{type(exc).__name__}: {exc}")
    finally:
        first = stop(p, l, True)
    ck("强停（模拟崩溃）退出码非零", first != 0, {"exit": first})

    p, l = start(data, log)
    try:
        ready(p)
        ck("同一命令重启成功", True, {"first_exit": first})
        rr = Cl()
        call(rr, "POST", "/api/v1/auth/login", "重启登录", 200,
             j={"username": owner, "password": PW}, h={"Origin": B})
        resumed = call(rr, "GET", f"/api/v1/plans/{pid}", "重启读取", 200).js()
        rd = resumed.get("doc") or {}
        rm = rd.get("materials") or {}
        ck("重启后 revision=2、3 家具/30°/材质保留", resumed.get("revision") == 2
           and len(rd.get("furniture", [])) == 3
           and all(item.get("rotation") == 30 for item in rd.get("furniture", []))
           and (rm.get("floor") or {}).get("r2") == "floor-tile-grey",
           {"revision": resumed.get("revision")})
        rs = call(Cl(), "GET", f"/api/v1/share/{tok}", "重启分享", 200).js()
        ck("重启后分享仍只读且 revision=2", rs.get("readOnly") is True
           and rs.get("revision") == 2)
        after = facts(db)
        ck("重启后 integrity ok/WAL/数据行保留", after["integrity"] == "ok"
           and after["journal_mode"].lower() == "wal"
           and after["counts"]["plans"] >= 2, after)

        if bp.get("planId"):
            rc, rj = browser("restart", {
                "VERIFICATION_MODE": "restart", "VERIFICATION_BASE_URL": B,
                "VERIFICATION_USERNAME": user, "VERIFICATION_PASSWORD": PW,
                "VERIFICATION_PLAN_ID": str(bp["planId"]), "VERIFICATION_EVIDENCE": str(O)})
            items = rj.get("checks") or rj.get("steps") or []
            passed = rj.get("ok")
            if passed is None:
                passed = not rj.get("failures")
            ck("真实浏览器重启后重新登录并打开", rc == 0 and bool(passed),
               {"exit": rc, "failures": rj.get("failures")})
            rp = {"ok": passed, "checks": len(items) if isinstance(items, list) else 0}
        else:
            ck("真实浏览器重启后重新登录并打开", False, "no browser plan id")

        if binary:
            for name, url, width, height in [
                ("narrow-375-login.png", B + "/", 375, 812),
                ("narrow-375-share.png", f"{B}/share/{tok}", 375, 812),
                ("wide-1440-login.png", B + "/", 1440, 900)]:
                target = O / name
                rc = shot(binary, url, target, width, height)
                size = png(target) if target.exists() else None
                ck(f"{width}x{height} 真实截图", size == (width, height)
                   and target.stat().st_size > 5000,
                   {"rc": rc, "size": size,
                    "bytes": target.stat().st_size if target.exists() else 0})
    except Exception as exc:
        ck("重启阶段无异常中断", False, f"{type(exc).__name__}: {exc}")
    finally:
        stop(p, l, False)

    raw = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
    leaked = [needle for needle in (PW, "kj_session=", "Set-Cookie", "X-CSRF-Token")
              if needle in raw]
    ck("服务端日志不含口令/Cookie/CSRF/分享令牌", not leaked
       and (not tok or tok not in raw) and not TR.search(raw), {"leaked": leaked})

    files = sorted(item.name for item in O.iterdir()
                   if item.is_file() and item.suffix.lower() == ".png")
    expected = [f"verification-{index:02d}-" for index in range(1, 15)]
    missing = [prefix for prefix in expected if not any(n.startswith(prefix) for n in files)]
    small = [name for name in files if (O / name).stat().st_size < 4000]
    ck("14 张流程截图全部存在且非空", not missing and not small,
       {"missing": missing, "small": small, "files": files})

    summary = {"generated_at": now(),
               "verdict": "evidence-complete" if all(item["ok"] for item in K) else "evidence-incomplete",
               "quality_tier": "production",
               "start_command": "python -m app --port 8080 --data-dir <临时目录>",
               "url": B,
               "environment": {"python": sys.version.split()[0],
                               "node": subprocess.run(["node", "--version"], capture_output=True,
                                                      text=True).stdout.strip(),
                               "chrome": binary},
               "tests": T, "browser": {**bp, "ok": bok}, "browser_restart": rp,
               "timings_ms": timing, "first_exit": first,
               "db_before": before, "db_after": after,
               "http_checks": ROWS, "checks": K,
               "failed_checks": [item for item in K if not item["ok"]],
               "screenshots": files,
               "data_dir_note": "隔离临时目录；未修改项目 data/kujiale.db 或 docs/evidence"}
    (O / "summary.json").write_text(red(json.dumps(summary, ensure_ascii=False, indent=2)) + "\n",
                                    encoding="utf-8")
    http_lines = [f"{row['status']:>3} {row['method']} {row['path']} "
                  f"requestId={row['requestId'] or '-'} code={row['code'] or '-'} :: {row['label']}"
                  for row in ROWS]
    (O / "http-checks.txt").write_text("\n".join(http_lines) + "\n", encoding="utf-8")
    lines = ["# acceptance runner summary", f"generated: {now()}",
             f"verdict: {summary['verdict']}", f"command: {summary['start_command']}",
             f"url: {B}",
             f"tests: backend ran={T['backend_ran']} exit={T['backend_exit']}; "
             f"node pass={T['node_pass']} fail={T['node_fail']} exit={T['node_exit']}",
             f"browser: ok={bok} plan={bp.get('planId')} revision={bp.get('revision')}",
             f"restart: first_exit={first} db_before={before} db_after={after}",
             f"timings_ms: {timing}",
             f"checks: {sum(1 for item in K if item['ok'])}/{len(K)} passed", "",
             *[f"{'PASS' if item['ok'] else 'FAIL'} {item['name']}" for item in K], "",
             "# HTTP checks", *http_lines]
    (O / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("ACCEPTANCE_SUMMARY " + json.dumps({
        "verdict": summary["verdict"],
        "checks": f"{sum(1 for item in K if item['ok'])}/{len(K)}",
        "browser_plan": bp.get("planId"), "screenshots": len(files)}, ensure_ascii=False))
    shutil.rmtree(data, ignore_errors=True)
    return 0 if summary["verdict"] == "evidence-complete" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ACCEPTANCE_RUNNER_ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
