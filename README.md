# 酷家乐简易版 · 后端（`app/`）

本仓库实现 flow `kujiale-lite-v1` 的后端：本机一条命令启动的 Web 应用后端，提供注册登录、方案 CRUD 与隔离、服务端权威几何/面积/统计、只读分享、按房间 CSV、家具/材质目录与样板间。前端位于 `web/`（由 frontend 角色交付），后端只通过 `/api/v1` 暴露数据，并负责静态文件服务与安全头。

- 运行时：Python 3.11+（当前验证 Python 3.14.0），**零第三方依赖**（全部标准库）。
- 质量档位：`production`；接口以冻结契约 `docs/contracts/kujiale-lite-interface-v1.md` v1 为准。
- 部署边界：单进程、单机、单人；默认只绑定 `127.0.0.1`，不支持公网多租户。

---

## 1. 快速启动

在项目根目录执行：

```bash
python -m app --port 8080
```

浏览器访问：<http://127.0.0.1:8080>

启动时会自动：

1. 创建/打开 `data/kujiale.db`（SQLite，WAL + `synchronous=FULL`）；
2. 执行 `PRAGMA user_version` 迁移（当前 v1），失败即拒绝启动；
3. 校验内置目录与样板间，加载 `web/` 静态目录；
4. 输出 JSON 行日志，`listening` 事件包含实际地址。

停止：`Ctrl+C`。数据库文件可删除以重置本地数据（应用下次启动会新建）。

### 配置（环境变量 / 命令行）

| 环境变量 | 命令行 | 默认值 | 说明 |
|---|---|---|---|
| `KUJIALE_HOST` | `--host` | `127.0.0.1` | 绑定地址，默认仅本机 |
| `KUJIALE_PORT` | `--port` | `8080` | 监听端口 |
| `KUJIALE_DATA_DIR` | `--data-dir` | `./data` | SQLite 数据目录 |
| `KUJIALE_STATIC_DIR` | `--static-dir` | `./web` | 前端静态目录 |
| `KUJIALE_LOG_LEVEL` | `--log-level` | `INFO` | `DEBUG/INFO/WARNING/ERROR/CRITICAL` |
| `KUJIALE_SESSION_TTL_HOURS` | `--session-ttl-hours` | `168`（7 天） | 会话有效期 |
| `KUJIALE_SECURE_COOKIE` | `--secure-cookie` | `false` | 为 Cookie 增加 `Secure`（HTTPS 部署） |

相对路径按项目根目录解析；启动日志打印生效配置（不含任何密钥）。

---

## 2. 目录与分层

```
app/
  __main__.py          启动入口：配置、迁移、目录校验、HTTP 服务
  config.py            配置读取/校验（环境变量 + 命令行）
  server.py            create_app() 工厂、BaseHTTPRequestHandler 桥接
  http/                router / request / response / static / middleware / api
  auth/                passwords(scrypt) / sessions / csrf / ratelimit
  plans/               schema / validate / geometry / stats / repository / service / migrate
  share/service.py     分享令牌签发、撤销、只读解析
  export/csv.py        CSV 列、RFC4180 转义、公式注入防护
  catalog/             loader.py + furniture.json + materials.json + sample-plan.json
  db/                  connection.py（PRAGMA） / migrations.py（user_version）
  obs/                 logging.py（JSON 行日志） / errors.py（错误码）
```

依赖方向（`tests/unit/test_import_graph.py` 静态扫描并断言无环）：

```
http → auth / plans / share / export → repository → db
geometry / schema / validate / migrate / csv  为纯函数层，不做 I/O
obs、config 为叶子；plans.service 不 import http；web/ 只经 /api/v1
```

---

## 3. 权限与安全模型

- **口令**：`hashlib.scrypt`（N=16384, r=8, p=1），16 字节随机盐；存储格式 `scrypt$N$r$p$salt$hash`。口令策略：8–128 字符、非常见弱口令、非单字符重复、无控制字符。
- **会话**：32 字节随机令牌，仅以 SHA-256 哈希存 `sessions.token_hash`；Cookie `kj_session` 为 `HttpOnly; SameSite=Lax; Path=/`，默认 7 天，可配。注销立即删除服务端会话；重放旧 Cookie 返回 401。
- **CSRF**：双提交令牌。`kj_csrf` 为同源可读 Cookie（非 HttpOnly），所有登录后写请求必须携带 `X-CSRF-Token`，且与 Cookie 和服务端会话中的值一致；否则 403 `FORBIDDEN`。
- **Origin / Fetch Metadata**：所有非安全方法（POST/PUT/PATCH/DELETE）校验 `Origin`（若存在）必须属于本机允许来源，并拒绝 `Sec-Fetch-Site` 非 `same-origin`/`none` 的请求。
- **登录限速**：15 分钟窗口内同一用户名连续 5 次失败后返回 429 `AUTH_RATE_LIMITED`（带 `Retry-After`）；登录成功清除该用户名的失败记录。IP 仍记录在 `login_attempts` 供审计，但不因其他用户名的失败而误锁本账号。
- **方案隔离**：所有仓储 SQL 同时带 `id` 与 `user_id`；他人方案统一 404，不泄露存在性。
- **分享只读**：`/api/v1/share/{token}` 与 CSV 路由只注册 GET；写方法返回 405。令牌只存哈希，撤销后立即失效；签发新令牌会使旧令牌失效。
- **输入与传输**：请求体上限 2 MiB + 64 KiB、请求头 32 KiB、查询串 4 KiB；拒绝分块传输、重复 `Content-Length`、重复 JSON 键、`NaN/Infinity`、深层嵌套；JSON 只接受 `application/json`。
- **静态文件**：路径解码后拒绝 `..`、`.`、反斜杠、`:`、NUL；`resolve()` 后必须仍在静态根内；符号链接越界同样拒绝。
- **响应头**：CSP（`default-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Permissions-Policy`。
- **日志**：不记录请求体、密码、会话令牌、CSRF、Cookie、Authorization；敏感字段名即使误传也会被替换为 `[redacted]`。

> 限速按用户名计数（IP 仅记录用于审计）。这是单机单人边界下的取舍：避免同一回环地址上的其他账号被误锁；如需多用户公网部署，应在边缘层增加按 IP/设备的更严格限速，并接入反向代理可信 IP。

---

## 4. API v1

前缀：`/api/v1`。所有响应带 `X-Request-Id`。

### 4.1 统一错误体

```json
{"error":{"code":"VALIDATION_FAILED","message":"请求数据不合法","details":{"field":"name"},"requestId":"…"}}
```

| 错误码 | HTTP | 语义 |
|---|---:|---|
| `AUTH_REQUIRED` | 401 | 未登录 / 会话无效或过期 |
| `AUTH_INVALID_CREDENTIALS` | 401 | 用户名或密码错误 |
| `AUTH_RATE_LIMITED` | 429 | 登录失败次数过多 |
| `FORBIDDEN` | 403 | CSRF / Origin / 权限校验失败 |
| `NOT_FOUND` | 404 | 资源不存在（含他人方案、非法分享令牌） |
| `VALIDATION_FAILED` | 422 | 字段、语义或结构校验失败 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体、文档或查询串超限 |
| `CONFLICT_REVISION` | 409 | `expectedRevision` 与当前 revision 不符 |
| `UNSUPPORTED_SCHEMA_VERSION` | 422 | 方案文档 `schemaVersion` 高于服务端支持 |
| `INTERNAL` | 500 | 未预期错误（不泄露内部细节） |
| `CONFLICT_USERNAME` | 409 | 注册用户名重复（v1 新增，语义独立） |
| `METHOD_NOT_ALLOWED` | 405 | 路径存在但不支持该方法（带 `Allow`） |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 非 `application/json` 或分块传输 |

契约允许新增错误码，不允许改名或复用语义；本实现遵守该约束。

### 4.2 端点表

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/auth/register` | 公开 | 注册；重复用户名 409，弱口令 422 |
| POST | `/auth/login` | 公开 | 登录；连续失败 429 |
| POST | `/auth/logout` | 登录 + CSRF | 注销并清 Cookie |
| GET | `/auth/me` | 登录 | 当前用户与 CSRF 令牌 |
| GET | `/plans?page=&pageSize=&q=` | 登录 | 分页列表，默认 20、最大 100 |
| POST | `/plans` | 登录 + CSRF | 新建；可带 `name`/`doc`，缺省为 12.00 m² 空白房间 |
| GET | `/plans/{id}` | 登录 | 仅本人；他人一律 404 |
| PUT | `/plans/{id}` | 登录 + CSRF | 整份保存；`expectedRevision` 不符 409 |
| DELETE | `/plans/{id}` | 登录 + CSRF | 仅本人；级联删除分享 |
| POST | `/plans/{id}/share` | 登录 + CSRF | 签发只读令牌；旧令牌立即失效 |
| DELETE | `/plans/{id}/share` | 登录 + CSRF | 撤销当前令牌 |
| GET | `/plans/{id}/export.csv` | 登录 | 按房间 CSV |
| GET | `/share/{token}` | 公开 | 只读方案；该路由只允许 GET |
| GET | `/share/{token}/export.csv` | 公开 | 只读 CSV；只允许 GET |
| GET | `/catalog` | 公开 | 12 件家具、8 种材质 |
| GET | `/sample` | 登录 | 两室样板间模板 |

> 浏览器侧分享页面路径是 `/share/{token}`（SPA 路由）；API 数据路径是 `/api/v1/share/{token}`。

### 4.3 关键请求/响应示例

注册与登录：

```http
POST /api/v1/auth/register
Content-Type: application/json

{"username":"alice","password":"correct-horse-9"}
→ 201 {"user":{"id":1,"username":"alice","createdAt":"2026-10-20T12:00:00Z"}}

POST /api/v1/auth/login
→ 200 {"user":{...},"csrfToken":"…","expiresAt":"2026-10-27T12:00:00Z"}
   Set-Cookie: kj_session=…; HttpOnly; SameSite=Lax; Path=/
   Set-Cookie: kj_csrf=…; SameSite=Lax; Path=/
```

读取列表：

```json
{"items":[{"id":1,"name":"演示户型","revision":2,"createdAt":"…","updatedAt":"…",
           "roomCount":2,"totalAreaM2":21.0,"furnitureCount":7}],
 "page":1,"pageSize":20,"total":1,"totalPages":1}
```

保存：

```http
PUT /api/v1/plans/1
X-CSRF-Token: <kj_csrf 的值>
Content-Type: application/json

{"name":"演示户型","expectedRevision":2,"doc":{...}}
→ 200 {..., "revision":3}
→ 409 {"error":{"code":"CONFLICT_REVISION","details":{"expectedRevision":1,"currentRevision":2},...}}
```

读取方案（本人）：

```json
{"id":1,"name":"演示户型","revision":3,"createdAt":"…","updatedAt":"…",
 "doc":{...},
 "stats":{"rooms":[{"roomId":"r1","roomName":"客厅","areaM2":12.0,
                    "perimeterM":14.0,"wallAreaM2":33.32,"furnitureCount":4,
                    "floorMaterial":"floor-oak","wallMaterial":"paint-warm-white"}],
          "roomCount":2,"totalAreaM2":21.0,"furnitureCount":7}}
```

分享：

```http
POST /api/v1/plans/1/share
→ 201 {"token":"…","url":"/share/…","createdAt":"…"}

GET /api/v1/share/{token}
→ 200 {"name":"演示户型","revision":3,"updatedAt":"…","doc":{...},
        "stats":{...},"readOnly":true}

PUT /api/v1/share/{token}   → 405 Allow: GET
```

CSV 响应：`Content-Type: text/csv; charset=utf-8`，`Content-Disposition` 同时提供 ASCII 回退名与 UTF-8 文件名，正文为 UTF-8 BOM + CRLF。

---

## 5. 方案文档 schema v1

```json
{
  "schemaVersion": 1,
  "units": "mm",
  "walls": [{"id":"w1","a":[0,0],"b":[4000,0],"thickness":120,"height":2800}],
  "openings": [{"id":"o1","wallId":"w1","type":"door","offset":500,"width":900,"height":2100,"sill":0}],
  "rooms": [{"id":"r1","name":"客厅","loopKey":"w1|w2|w3|w4"}],
  "furniture": [{"id":"f1","catalogId":"sofa-2","x":1200,"y":800,"rotation":0}],
  "materials": {"floor":{"r1":"floor-oak"},"wall":{"r1":"paint-warm-white"}}
}
```

限制：

| 项目 | 限制 |
|---|---|
| 墙体 | 1–400 段；端点不同；坐标 ∈ [-100000, 100000] |
| 墙厚 / 墙高 | 10–1000 mm / 100–10000 mm |
| 开洞 | ≤400；`offset ≥ 0`；`offset+width ≤ 墙长`；`sill+height ≤ 墙高`；门 `sill=0`；同墙开洞不重叠 |
| 家具 | ≤400；`catalogId` 必须存在；`x/y` 在坐标范围；`rotation` 有限数值 |
| 房间 | ≤50；`name` 非空、≤80 字符、无控制字符；`loopKey` 为墙 id 排序后 `|` 拼接 |
| 单文档 | ≤2 MiB（序列化 UTF-8 字节） |
| 未知字段 | 原样保留，不静默丢弃（向前兼容） |
| 更高版本 | 拒绝 `UNSUPPORTED_SCHEMA_VERSION`（422） |

`loopKey` 规范形式：墙 id 升序拼接，例如 `"w1|w2|w3|w4"`；与输入顺序无关，保证房间命名稳定。房间边界必须首尾相接、单一闭环、非零面积、无自交；每面墙在房间内恰好出现一次。

---

## 6. 服务端权威几何、统计与 CSV

- 房间多边形取**墙中心线**；顶点顺序由墙图遍历得到，面积用鞋带公式，m² 保留 2 位。
- 基准：4000 × 3000 mm → **12.00 m²**；周长 14.00 m。
- 墙面用量：按房间的每面墙 `长度 × 墙高 − 该墙开洞面积` 求和；不足 0 时按 0 处理。
- 地面用量：等于房间面积。
- 家具计数：家具坐标点落在房间多边形内（边界算内）。同一家具在共享墙边界上可能同时落入两个房间，这是中心线口径的既定行为。
- CSV 列固定为：

```
room_name,area_m2,furniture_count,floor_material,floor_area_m2,wall_material,wall_area_m2
```

- 编码：UTF-8 BOM；行结束 CRLF；RFC 4180 转义（逗号、双引号、换行）；以 `= + - @` 开头的单元格前置 `'` 防公式注入。
- 2D、3D、统计、CSV 全部读取同一份服务端 `doc`；前端不做导出用的第二套几何。

---

## 7. 数据库与持久化

文件：`data/kujiale.db`（可通过 `--data-dir` 修改）。

表：

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | `id`, `username` NOCASE UNIQUE, `password_hash`, `created_at` | 用户名大小写不敏感唯一 |
| `sessions` | `user_id`, `token_hash` UNIQUE, `csrf_token`, `expires_at` | 仅存令牌哈希；过期查询时清理 |
| `plans` | `user_id`, `name`, `doc`(JSON 文本), `revision`, 时间戳 | `revision` 乐观并发 |
| `shares` | `plan_id`, `token_hash` UNIQUE, `created_at`, `revoked_at` | 撤销后保留审计行；级联删除 |
| `login_attempts` | `username`, `ip`, `attempted_at`, `success` | 15 分钟限速窗口；24 小时保留清理 |

设置：

- `PRAGMA journal_mode=WAL`、`PRAGMA synchronous=FULL`、`PRAGMA foreign_keys=ON`、`PRAGMA busy_timeout=5000`。
- 每个请求使用短生命周期连接；写事务 `BEGIN IMMEDIATE`，异常 `ROLLBACK`，成功 `COMMIT`。
- `PRAGMA user_version` 顺序迁移，每个版本在事务内执行；数据库版本高于程序支持时 fail-fast，拒绝启动且不改动数据。
- 保存流程：校验文档 → 事务内 `SELECT` 当前行（带 `user_id`）→ 比对 `expectedRevision` → `UPDATE ... WHERE revision = ?`；任一环节失败不产生半写状态。
- 重启恢复：WAL 文件由 SQLite 自动恢复；会话、方案、分享令牌均持久化，重新启动后可继续使用。

---

## 8. 状态机

**方案**

```
draft（revision=null，前端未保存）
  └─ POST /plans → saved(revision=1)
saved(revision=n) ── PUT expectedRevision=n ──→ saved(revision=n+1)
saved(revision=n) ── PUT expectedRevision≠n ──→ 409（保留原数据）
```

**分享**

```
none ── POST /plans/{id}/share ──→ active
active ── POST /plans/{id}/share ──→ active（旧令牌失效，签发新令牌）
active ── DELETE /plans/{id}/share ──→ revoked（旧令牌立即 404）
revoked 不可复用；重新签发得到新令牌
```

**会话**

```
active ── 超过 TTL / 注销 / 服务端删除 ──→ expired（401）
```

**编辑器（前端）**

```
clean ↔ dirty；保存成功 → clean 并记录新 revision
保存冲突 → 保留本地内容，提示重载或覆盖（需以最新 revision 重试）
```

---

## 9. 可观测性

每个请求一行 JSON（stderr）：

```json
{"ts":"2026-10-20T12:00:00.000Z","level":"INFO","event":"request",
 "requestId":"…","method":"POST","route":"PUT /api/v1/plans/{plan_id}",
 "status":409,"durationMs":7.41,"errCode":"CONFLICT_REVISION","userId":1}
```

字段：`ts/level/event/requestId/route/status/durationMs/errCode`，登录用户附带 `userId`。启动/关闭/静态目录缺失等事件使用 `startup/listening/shutdown_*` 事件名。

- `requestId` 由服务端随机生成，同时写入响应头 `X-Request-Id` 与错误体 `error.requestId`。
- 不记录请求体、查询串、Cookie、Authorization、密码、令牌；敏感字段名会被替换为 `[redacted]`。
- 未捕获异常记 `ERROR` 事件并返回 500 `INTERNAL`；存储文档损坏、统计失败等关键错误不静默吞掉。

---

## 10. 分页、容量与性能边界

- 列表分页：`page` 默认 1；`pageSize` 默认 20，超过 100 按 100 处理；`q` 最长 80 字符，`LIKE` 通配符转义。
- 页码非法（<1、非整数、大到 SQLite 整数溢出）返回 422，不会 500。
- 单文档 ≤2 MiB；墙/开洞/家具/房间上限见第 5 节。
- 请求体上限 2 MiB + 64 KiB；请求头 32 KiB；查询串 4 KiB。
- SQLite 单写者：写事务短、`busy_timeout=5000`；单机单人边界内可接受。
- 目录在进程内缓存并返回防御性副本；目录文件增大只影响启动内存，不影响请求级状态。
- `login_attempts` 每次写入顺带清理 24 小时前记录；`sessions` 在登录时清理过期行；`shares` 撤销行保留以支持审计，长期使用可按需归档。

---

## 11. 扩展点、版本与弃用

- **新家具/材质**：只改 `app/catalog/furniture.json` / `materials.json`（id、名称、尺寸、颜色/基元），无需改代码或 schema；启动校验数量与字段。
- **新 CSV 列**：在 `app/export/csv.py` 的 `COLUMNS` 末尾追加，并补测试；不改既有列语义。
- **新对象类型**：在 `plans/schema.py`/`validate.py` 增字段与校验，前端渲染适配；存储/认证/路由不变。
- **新认证方式**：在 `auth/` 新增提供者，`sessions` 与中间件不变。
- **API 版本**：破坏性变更升 `/api/v2`；v1 至少保留一个发布周期并可用 `Deprecation` 响应头标注。字段与错误码只增不改语义。
- **方案文档版本**：`schemaVersion` 单调递增；`plans/migrate.py` 注册逐级迁移；更高版本拒绝而不是静默截断。
- **数据库版本**：`db/migrations.py` 追加迁移函数并提升 `LATEST_SCHEMA_VERSION`；每版事务内执行，禁止原地改旧迁移。

---

## 12. 测试

后端测试分为三层，全部使用标准库 `unittest`，不依赖第三方包：

```bash
# 推荐（从项目根目录；tests/ 父目录不在后端写区，无法添加 tests/__init__.py）
python -m unittest discover -s tests -v
```

覆盖：

- `tests/unit`：几何（闭环/自交/面积/周长/开洞/点包含）、schema 与语义校验、统计、CSV（BOM/CRLF/RFC4180/公式注入）、密码哈希策略、文档迁移、导入图无环与分层。
- `tests/integration`：SQLite PRAGMA、事务回滚、外键级联、迁移幂等/fail-fast、仓储分页/搜索/隔离、revision 冲突、重启恢复、会话/分享令牌哈希。
- `tests/e2e`：真实 HTTP 服务全流程；401/403/404/405/409/413/415/422/429；CSRF/Origin；路径穿越；SQL 注入；日志无敏感信息；会话过期；静态 SPA 回退。

断言不因“保绿”弱化；负例与正向流程同等对待。最近一次运行：**141 tests, OK**（见 `docs/evidence/test-run.txt`、`test-summary.txt`）。前端 `node --test` 35 项全绿，见 `docs/evidence/node-test-output.txt`；两端联调矩阵见 `docs/evidence/integration-summary.txt`。

> 说明：`tests/` 目录本身不在 backend 写区（只允许 `tests/unit|integration|e2e`），因此未添加 `tests/__init__.py`；从项目根目录运行 `python -m unittest discover` 默认不会下钻到非包目录 `tests/`。请使用上面的 `-s tests` 形式，或在 `tests/` 目录内执行 `python -m unittest discover -v`。

---

## 13. 交付证据（`docs/evidence/`）

| 文件 | 内容 |
|---|---|
| `startup.log` | 真实启动两次（首次 + 强制停止后重启）的完整 JSON 行日志 |
| `startup-events.txt` | 启动/监听事件摘要、数据目录、静态目录状态 |
| `demo-transcript.txt` | `python -m app --port 8080` 下的 HTTP 全流程与负例状态码/requestId（令牌已脱敏） |
| `test-run.txt` / `test-summary.txt` | 全量测试 verbose 输出与汇总 |
| `sample-export.csv` | 真实导出的按房间 CSV（UTF-8 BOM / CRLF） |
| `error-log-excerpts.txt` | 401/403/404/409/413/422/429 请求日志摘录 |
| `restart-recovery.txt` | 强制终止进程后重启的 SQLite `integrity_check`、会话/方案/分享恢复结果 |
| `integration-summary.txt` | 集成/端到端联调报告：契约逐项、分享页 vs API、CSV BOM 口径、浏览器全流程、撤销与重启 |
| `integration-test-summary.txt` / `node-test-output.txt` | 后端 141 tests + 前端 35 tests 的两端全绿矩阵 |
| `integration-*.png` | 真实 Chrome headless 全流程截图：登录、空列表、2D、3D、列表重开、只读分享 2D/3D、撤销错误态 |
| `browser-download.csv` / `sample-export.csv` | 浏览器下载与 owner/shared 导出的 CSV（UTF-8 BOM + CRLF） |
| `integration-error-log-excerpts.txt` / `integration-server.log` | 联调负例日志摘录与真实服务器 JSON 日志 |
| `verification-evidence.md` | 交付证据统合报告：真实启动命令/配置、环境版本、逐步请求与 requestId、截图清单、测试结果、CSV、失败路径、重启恢复、已知限制 |
| `verification-01..14-*.png` | 提案 §5 的真实 Chrome headless 逐步截图：注册、空列表、默认房间、第二房间、门窗、家具/材质、3D 轨道/第一人称、保存、重登、列表重开、只读分享 2D/3D、重启重开 |
| `verification-plan.csv` / `verification-share*.csv` | owner、shared HTTP 与浏览器下载的按房间 CSV（UTF-8 BOM / CRLF；12.00/9.00、家具数、材质 ID） |
| `verification-test-run.txt` / `verification-node-test-output.txt` / `verification-test-summary.txt` | 本轮复跑的 141 tests 后端输出与 35 tests 前端输出 |
| `verification-network.json` / `verification-checks.txt` | 浏览器真实 API 请求（method/path/status/requestId）与正向/负例检查矩阵（分享令牌已脱敏） |
| `verification-error-log-excerpts.txt` / `verification-server.log` | 401/403/404/405/409 日志摘录与完整真实服务器日志 |
| `verification-restart-console.txt` / `verification-startup-events.txt` | 强停重启后的浏览器重开检查与两次启动/监听事件 |

复现证据：

```bash
python tests/e2e/run_demo.py          # 后端 HTTP + 重启 + 日志/CSV 证据
python tests/e2e/run_integration.py   # 两端测试 + 真实浏览器全流程 + 联调报告
python tests/e2e/run_verification.py  # 交付证据：复跑测试 + 真实 8080 全流程 + 负例 + 强停重启 + 统合报告
```

`run_demo.py` 先跑全量测试，再以 `python -m app --port 8080` 启动真实进程，执行注册/登录/样板间/保存/越权/CSRF/409/分享/撤销/CSV/限速，随后强制停止并冷启动验证恢复，最后扫描日志确认无口令/令牌/Cookie 泄露。`run_integration.py` 额外复跑前端 `node --test`、驱动真实 Chrome 走完注册→新建→2D 编辑→3D→保存→列表重开→只读分享→CSV 下载，并验证撤销后页面与 API 同时失效。

> 分享令牌属于 bearer 凭据：联调报告中的路径统一脱敏为 `/share/[redacted]`，真实令牌不写入证据文件。

---

## 14. 已知限制与权衡

1. **单机单人**：SQLite 单写者；登录限速按用户名（IP 记录审计）；不做公网多租户、反向代理可信 IP、分布式会话。
2. **面积口径**：墙中心线多边形，不是内净面积；与 CAD 的内墙面积会有差异，README 与测试统一以 4000×3000 mm = 12.00 m² 为基准。
3. **房间检测**：服务端按 `loopKey` 验证用户提交的边界，不自动猜测“最小面环”；前端负责在编辑时生成/对账 `loopKey`，服务端负责权威校验与计算。
4. **家具计数**：按家具锚点是否落在房间多边形内；共享墙边界可能同时计入相邻房间（中心线口径）。
5. **3D**：由前端基元级渲染；后端只提供同一份文档与目录，不做服务端渲染。
6. **静态资源**：后端只负责安全地提供 `web/`；前端入口与构建产物由 frontend 角色交付。若静态目录缺失，API 仍可用，根路径返回 404/占位提示。
7. **分享历史**：撤销的分享行保留用于审计，不自动物理删除；长期大量签发可按运维策略归档。
8. **本地编码**：Windows 下将 stderr 重定向到文件时，建议设置 `PYTHONIOENCODING=utf-8`（演示脚本已设置），否则非 ASCII 路径可能显示为乱码。

---

## 15. 前端对接约定

- API 基址固定为 `/api/v1`；同源 `fetch(..., {credentials: 'same-origin'})`。
- 登录/注册响应返回 `csrfToken`，同时设置 `kj_csrf` Cookie；写请求必须带 `X-CSRF-Token`（值与 `kj_csrf` 相同）。前端 `web/js/api.js` 同时兼容 `csrf_token/csrf/XSRF-TOKEN` 读取。
- 会话 Cookie `kj_session` 为 HttpOnly，前端不要尝试读取；401 时跳转登录并保留本地编辑内容。
- 错误统一读取 `error.code`、`error.message`、`error.details`、`error.requestId`；界面应展示错误码与 requestId 便于排查。
- 分享页只调用 GET；不要提供保存/删除入口。分享令牌撤销后服务端返回 404。
- CSV 下载使用 `response.blob()` 与 `Content-Disposition` 文件名；不要在前端重新计算面积/用量。

---

## 16. 后端验收演示脚本（真实运行）

```bash
python -m app --port 8080
# 另一个终端 / 浏览器：
# 1) GET  /api/v1/catalog            → 200，12 家具 / 8 材质
# 2) POST /api/v1/auth/register      → 201
# 3) POST /api/v1/auth/login         → 200 + kj_session/kj_csrf
# 4) GET  /api/v1/sample             → 200 两室样板间
# 5) POST /api/v1/plans              → 201，totalAreaM2=21.00
# 6) PUT  /api/v1/plans/1            → 200 revision+1；旧 revision → 409
# 7) GET  /api/v1/plans/1            → 200；他人账号 → 404
# 8) POST /api/v1/plans/1/share      → 201；匿名 GET 分享 → 200 readOnly=true
#    PUT  /api/v1/share/{token}      → 405 Allow: GET
# 9) GET  /api/v1/plans/1/export.csv → 200，BOM+CRLF，客厅 12.00 m²
# 10) 终止进程并重启，重新 GET 方案 / 分享 → 200，数据仍在
```

未真实运行不得建议验收通过；本仓库的 `docs/evidence/` 记录了上述流程的实际输出。
