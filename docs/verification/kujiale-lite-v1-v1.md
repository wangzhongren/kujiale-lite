# kujiale-lite-v1 验收核对报告

- 核对角色：Proof / 验收（verifier）
- 流程：`kujiale-lite-v1`，质量档：production
- 本轮独立复跑：2026-10-20T13:47:46Z 至 13:48:17Z（新生成 `docs/verification/kujiale-lite-v1-run/`）
- 报告性质：本文件是验收核对报告，**不是客户批准或客户决定**；最终由客户在验收卡选择。
- 核对结论：真实启动与演示完成；工程质量基线逐项有证据；实现与提案 §3 架构声明一致；独立复跑 **41/41 通过**；**未发现阻断项，建议客户在验收卡选择 `accept`**。这不代替客户批准。

## 1. 真实启动与演示（本轮独立复跑）

- 启动命令：`python -m app --port 8080 --data-dir <隔离临时目录>`；启动日志 `event=startup` / `event=listening` 记录实际地址。
- 访问地址：`http://127.0.0.1:8080`。
- 环境：Windows 11；Python 3.14.0；Node v24.11.1；真实 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）。
- 隔离性：data 目录使用 `tempfile.mkdtemp(prefix="kujiale-accept-")`，未修改项目 `data/kujiale.db`、`docs/evidence` 或交付代码；结束后删除临时目录。
- 真实演示：由本角色运行 `docs/verification/acceptance-runner.py`，以真实 Chrome 完成注册→新建→2D 编辑→3D 轨道/第一人称→保存→退出重登→列表打开→只读分享→分享 CSV→强停重启后重新打开，生成 14 张流程截图；另生成 375×812 登录/分享与 1440×900 登录截图，共 17 张。
- 无屏幕录制：以 17 张真实截图提供演示证据，已如实说明，不声称录屏。
- 测试结果：后端 `unittest` **141 项，exit 0，OK**；前端 `node:test` **35 pass / 0 fail，exit 0**。
- 浏览器检查：主流程 **19 项全 PASS，0 failures**；重启后 **3 项全 PASS**。
- 关键数字：方案 revision=2；7 墙 / 4 门窗 / 3 家具 / 2 房；面积 12.00 与 9.00 m²（合计 21.00）；3 件家具旋转 30°；分享令牌长度 43；CSV 202 字节，owner 与 shared 字节一致。
- 证据目录：`docs/verification/kujiale-lite-v1-run/`；汇总 `summary.json` / `summary.txt` / `http-checks.txt`。

## 2. 工程质量基线逐项核对

### 2.1 正确性 — 通过

- 验收标准逐条可演示：浏览器 19 项检查覆盖空列表、默认 12 m²、2D 键盘缩放、绘制第二间房（7 墙/2 房）、门窗落位、3 家具与材质、3D 轨道、第一人称、保存 revision=2、重登列表打开、只读分享 2D/3D、分享 CSV；全部 PASS（`browser-full-console.txt`）。
- 服务端独立核对：默认方案 4 墙/1 房/12.00 m²；保存后 7 墙/4 门窗/3 家具/2 房；面积 12.00/9.00 合计 21.00；3 件家具旋转均为 30°；两房材质正确（`summary.json` checks）。
- CSV：固定 7 列；UTF-8 BOM；CRLF；客厅 12.00/2 家具/floor-oak/33.32，卧室 9.00/1 家具/floor-tile-grey/30.03；owner 与 shared 字节一致（`owner-plan.csv`、`shared-http.csv`、`summary.json`）。
- 无 TODO/占位/假数据：本角色对本项目代码执行 `findstr` 检索，`app/*.py` 与 `tests/*` 无 TODO/FIXME；自有 `web/js`、`web/css` 的 placeholder 均为正常 UI 属性；仅第三方 `web/vendor/three/three.module.js` 保留上游 TODO，属随包依赖，不计为实现占位。
- 边界与非法输入：非法分享 404、跨用户 404、旧 revision 409、schemaVersion=2 422、缺 CSRF 403、超限请求体 413、page=0 422（`http-checks.txt`）。

### 2.2 健壮性 — 通过

- 输入校验与上限：`app/http/request.py` 限制 body 2 MiB+64 KiB、header 32 KiB、query 4096 字节；拒绝 chunked、重复 Content-Length、重复 JSON key、NaN/Infinity、过深嵌套。实测超限返回 413 `PAYLOAD_TOO_LARGE`。
- 数据一致性：`app/db/connection.py` 使用 WAL、`synchronous=FULL`、`BEGIN IMMEDIATE`、`busy_timeout=5000`；`app/db/migrations.py` 每个版本事务内迁移、失败回滚、数据库版本高于支持版本时拒绝启动。
- 失败不破坏已有数据：409 旧 revision 不覆盖 revision=2；413/422 请求不改变方案；重启后同一方案 revision=2、3 家具/30°/材质保留。
- 重启恢复：强停退出码 1；重启后 `user_version=1`、`integrity_check=ok`、`journal_mode=wal`，plans/shares 行保留，分享仍为只读 revision=2（`summary.json`、`server.log`）。
- 并发/重入策略：方案更新使用 `WHERE revision = ?` 乐观并发；冲突返回 409 `CONFLICT_REVISION` 且错误体 requestId 与响应头一致（`app/plans/repository.py`、`http-checks.txt`）。

### 2.3 安全 — 通过

- 认证/授权边界：会话 Cookie + 服务端会话表；未登录方案接口 401 `AUTH_REQUIRED`；跨用户读/写均 404 `NOT_FOUND`，不泄露资源存在性。
- 口令与会话：`app/auth/passwords.py` 使用 scrypt（N=16384,r=8,p=1）加盐哈希；会话令牌仅存 SHA-256 哈希；Cookie 设置 HttpOnly/SameSite（生产 HTTPS 可启用 `--secure-cookie`）。
- CSRF：双提交 Cookie + 请求头，并校验 Origin/Sec-Fetch-Site（`app/auth/csrf.py`、`app/http/middleware.py`）；缺 CSRF 实测 403 `FORBIDDEN`。
- 注入/路径穿越：SQL 全部参数化并按 `user_id` 限定（`app/plans/repository.py`）；静态资源 `_safe_relative` / `_resolve` 拒绝 `..`、`.`、`:`、NUL、反斜杠，解析必须落在静态根内（`app/http/static.py`）。
- 请求限制与错误码：body/header/query 上限；413/422/405/409 等一致；405 带 `Allow: GET`。
- 响应头：CSP `default-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`、`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、CORP、Permissions-Policy（`app/http/response.py`）；实测 CSP/nosniff 生效。
- 敏感数据：HTTP 证据路径中的分享令牌已替换为 `[redacted]`；服务端日志只记录路由模板（如 `GET /api/v1/share/{token}`），不含原始 token、口令、`kj_session=`、`Set-Cookie`、`X-CSRF-Token`；日志核对 PASS。
- 依赖：后端零第三方依赖（Python 标准库）；前端 Three.js 本地 vendored，运行时不访问 CDN。

### 2.4 可维护性 — 通过

- 模块边界：`app/http`（传输）、`app/auth`、`app/plans`（领域）、`app/share`、`app/export`、`app/db`、`app/catalog`、`app/obs`；前端 `web/js` 按 app/api/store/undo/canvas2d/geometry/three-view/catalog/ui/share/editor 分层；命名一致。
- 依赖方向：`http → auth/plans/share/export → repository → db`；`geometry/stats/schema/validate/csv` 为纯函数层；`tests/unit/test_import_graph.py` 校验无环、服务层不 import http、repository 不 import service。
- README：包含启动、配置、架构分层、API v1、权限、状态机、统计/CSV、数据库/迁移、观测、分页/容量、扩展点、测试、已知限制与权衡（`README.md`）。
- 注释只在约束处：如请求上限、迁移原子性、几何边界；无大段装饰性注释。
- 测试独立于实现：测试通过 HTTP/仓储/纯函数接口断言行为，不复制实现逻辑；负例单独覆盖。

### 2.5 架构与可扩展性 — 通过

- 模块分解与职责、依赖方向（无环）、数据流清晰：与提案 §3.1–3.3 一致；浏览器同一文档在 2D/3D/分享/CSV 中一致。
- 扩展点明确：新增家具/材质只改 `app/catalog/*.json`（当前 12 家具/8 材质，满足 ≥9/≥6）；新增 schema 版本走 `app/plans/migrate.py` 的 `MIGRATIONS`；新增 API 在 `/api/v1` 下注册；CSV 列在 `app/export/csv.py` 末尾追加；前端按模块扩展。
- 版本/迁移/兼容/弃用：`LATEST_SCHEMA_VERSION=1`、`CURRENT_SCHEMA_VERSION=1`、`PRAGMA user_version=1`；迁移事务化、失败回滚、数据库更新版本拒绝启动；更高文档版本 422 `UNSUPPORTED_SCHEMA_VERSION`；API 路径 `/api/v1`；README/契约写明 v1 冻结与变更流程。
- 横切关注点：配置（`app/config.py`）、错误（`app/obs/errors.py`）、日志（`app/obs/logging.py`）、鉴权（`app/auth`）、测试缝（`create_app(..., database=, catalog=, sample=, clock=)`）均有归属。
- 结论：提案 §3 架构方案存在且实现一致；未发现模块越界、反向依赖、缺失扩展点或版本迁移偏离。

### 2.6 可观测性 — 通过

- 结构化 JSON 日志：`event=request` 包含 `requestId`、`method`、`route`、`status`、`durationMs`、`errCode`，认证请求含 `userId`；启动/监听事件含配置摘要（无敏感值）。
- 关键失败可诊断：4xx/5xx 分级日志；错误响应体带 `error.code` 与 `requestId`；409 实测响应头/错误体 requestId 一致。
- 不静默吞错：损坏文档/统计失败记录 `plan_document_corrupt` / `plan_stats_failed` 并返回 INTERNAL；未处理异常记录 `unhandled_error`。
- 日志卫生：服务端日志不含令牌/口令/Cookie/CSRF；`server.log` 可核对。
- 残余噪声：客户端提前断开 keep-alive 连接时，Python `socketserver` 会在 stderr 打印 `ConnectionAbortedError` traceback（本轮 `server.log` 中可见一条，无请求上下文）。它不是业务失败、不改变响应与数据，属于已知日志噪声；未发现静默吞错或敏感信息泄露。

### 2.7 性能与容量 — 通过

- 容量边界：墙 ≤400、门窗 ≤400、家具 ≤400、房间 ≤50、文档 ≤2 MiB、坐标 ±100000、名称 ≤80 字符；列表 pageSize 上限 100；请求 body/header/query 上限明确。
- 400 墙/400 家具实测：创建 21.5 ms、读取 13.2 ms、CSV 9.7 ms（含 HTTP 往返，单用户本机）；均远低于 2000 ms。
- 不无限增长：列表分页；撤销栈上限 50；日志按请求一行、无请求体/令牌；分享创建会撤销旧活动分享。
- 已知容量边界：单用户 SQLite、单进程；未做多用户并发/压力基准（见限制）。

### 2.8 前端与可访问性 — 通过（有残余风险）

- 加载/空/错误态：`web/js/ui.js` 的 `renderLoading` / `renderEmpty` / `renderError`（含 code/requestId）；`app.js`、`share.js` 使用三态；分享页 404 错误态存在。
- 键盘可用：`editor.js` 全局 `keydown` 处理 Delete/Backspace、Escape、`?`；canvas 支持旋转、方向键微调、缩放等；浏览器实测 2D 键盘缩放后两房可达；3D 第一人称键盘模式激活。
- 标签与语义：`index.html` 有 lang、viewport、skip link、live region、noscript；工具栏/视图切换/对话框/撤销按钮有 aria-label 与焦点管理；文本一律 `textContent` 构造。
- 视觉/响应式：`:focus-visible`、`prefers-reduced-motion`；断点 1100/900/600/380px；真实截图 375×812（登录 28,972 B、分享 46,112 B）与 1440×900（42,028 B）均可用，分享页 2D/3D 正常且无编辑控件。
- 残余风险：未运行 axe/WCAG AA 自动化审计；当前证据为源码核对 + 键盘路径 + 真实窄屏截图。若客户要求 WCAG AA 认证，需补做自动化/人工审计；这不是本次生产级基线阻断项。

### 2.9 测试矩阵 — 通过

- 后端 141 项：单元（catalog/csv/geometry/import graph/migrate/schema/stats/passwords）、集成（auth store/repository/restart）、端到端（API/security），exit 0 OK。
- 前端 35 项：目录归一化、几何、store、undo/redo、CSRF cookie、键盘/房间/材质/上限；35 pass / 0 fail。
- 负例：401/403/404/405/409/413/422、跨用户、非法分享、缺 CSRF、超限、schema v2、page=0 均覆盖；权限与非法路径有断言。
- 独立复跑：本角色重新执行两端测试并保存输出 `tests-backend.txt`、`tests-frontend.txt`；测试未因复跑被弱化。
- 未做 mutation testing / 覆盖率门禁；不属于本次阻断项。

### 2.10 交付与真实演示 — 通过

- 已真实启动并演示：启动命令、URL、隔离目录、真实 Chrome 全流程、17 张截图、测试输出、HTTP 状态/requestId、CSV、重启日志均在 `docs/verification/kujiale-lite-v1-run/`。
- 未使用假数据：浏览器流程由真实 UI 操作生成；服务端独立 HTTP 流程另行创建用户/方案并断言。
- 无屏幕录制：已如实说明并以 14 张流程截图 + 3 张响应式截图替代；不据此声称录屏。

## 3. 提案架构声明逐项核对

| 提案声明 | 实现核对 | 证据 | 结论 |
|---|---|---|---|
| §3.1 模块分解 | `app/http`、`app/auth`、`app/plans`、`app/share`、`app/export`、`app/db`、`app/catalog`、`app/obs`；前端按模块拆分 | 源码目录、README 架构章节 | 一致 |
| §3.2 依赖方向/无环 | HTTP → 领域服务 → repository → db；纯几何/统计/校验层；无反向依赖 | `tests/unit/test_import_graph.py` 通过 | 一致 |
| §3.3 数据流 | 单一 JSON 文档；服务端权威统计；2D/3D/分享/CSV 同源 | 浏览器 19 项 + API 12.00/9.00 + CSV 33.32/30.03 | 一致 |
| §3.4 数据 schema v1 | schemaVersion=1、units=mm、400/400/400/50 上限、2 MiB、坐标范围 | `app/plans/schema.py`、`validate.py`；v2 返回 422 | 一致 |
| §3.5 API v1 | `/api/v1` 路由、错误码、CSRF/认证、分享只读 | `app/http/api.py`、`http-checks.txt` | 一致 |
| §3.6 版本/迁移/兼容/弃用 | `user_version=1`、事务迁移、更新版本拒绝启动、文档版本迁移链、API v1 路径 | `app/db/migrations.py`、`app/plans/migrate.py`、README | 一致 |
| §3.7 扩展点 | 目录 JSON、迁移链、API 注册、前端模块；新增家具/材质无需改代码 | `app/catalog/loader.py`、`app/plans/migrate.py`、README | 一致 |
| §3.8 横切关注点 | 配置/错误/日志/鉴权/测试缝均有归属 | `app/config.py`、`app/obs/*`、`app/auth/*`、`create_app` 注入 | 一致 |
| §3.9 状态机 | 方案 revision 乐观并发；分享 active/revoked；会话/登录限流 | 409 实测、分享 404、重启会话、`tests/e2e/test_security.py` | 一致 |
| §3.10 算法 | 墙中线多边形、鞋带面积、周长×墙高−洞口、家具点在多边形、CSV 统计 | `app/plans/geometry.py`、`stats.py`、浏览器/CSV 数值 | 一致 |

说明：提案 §3.1 未逐一列举 `app/http/api.py` 与 `web/js/editor.js`，二者是已声明层内的实现细分（路由处理器、编辑器视图），未新增跨层依赖或改变边界，不构成架构偏离。

结论：提案包含完整架构方案章节；实现与声明一致，未发现模块边界、依赖方向、扩展点、schema/API 版本迁移方面的偏离。

## 4. 负例与边界实测（本轮 requestId）

| 场景 | 结果 | requestId / 证据 |
|---|---|---|
| 未登录读取方案 | 401 `AUTH_REQUIRED` | `0efabaca1cfe482c2bfb4b8016d14e80` |
| 非法分享令牌 | 404 `NOT_FOUND` | `2b17c3c7d7e1038ee973c0c8896b6c92` |
| 分享链接写方法 | 405 `METHOD_NOT_ALLOWED`，`Allow: GET` | `a820dc4effd2ccb1a6a57721f1112965` |
| 跨用户读 / 写 | 404 `NOT_FOUND` | `18cc68aaa862610ccd60107bf7d30b48` / `ea53df97632d44fa6fd118ee72231a7a` |
| 旧 revision 更新 | 409 `CONFLICT_REVISION`，requestId 一致 | `f71a45187f8f59a14b06cb44bc44a7b2` |
| 缺 CSRF | 403 `FORBIDDEN` | `d2c857aecc299fdb7b4c994142108b49` |
| schemaVersion=2 | 422 `UNSUPPORTED_SCHEMA_VERSION` | `4fbfcf9ab6c14dbed2ea23212a8bba2c` |
| 超限请求体 | 413 `PAYLOAD_TOO_LARGE` | `1053e9763296670b04cbacb6e2302bae` |
| pageSize=1000 / page=0 | 上限 100 / 422 `VALIDATION_FAILED` | `71650d5bfc16201949dcf4d6b3706d30` / `100d3a373e3ef0a45bdbbd506b704cb6` |
| 400 墙/400 家具 | 201 保存、200 读取、200 CSV；21.5/13.2/9.7 ms | `summary.json` |
| 强停重启 | 退出码 1；`user_version=1`、`integrity=ok`、`journal_mode=wal`；revision=2 保留 | `summary.json`、`server.log` |

## 5. 重启恢复证据

- 强停前：users=3、sessions=3、plans=3、shares=2；`user_version=1`、`integrity=ok`、`journal_mode=wal`。
- 强停：`TerminateProcess` 方式终止进程，退出码 1。
- 重启后：同一命令启动成功；登录后读取同一方案 revision=2；3 家具/30°/两房材质保留；分享仍只读 revision=2；浏览器重启后重新登录并从列表打开，3 项检查 PASS。
- 数据库：users=3、sessions=4（重启登录新增会话）、plans=3、shares=2；`integrity=ok`、WAL。
- 证据：`summary.json`、`server.log`、`browser-restart-console.txt`、`verification-14-restart-reopened.png`。

## 6. 截图与敏感信息核对

- 流程截图：`verification-01-login.png` … `verification-14-restart-reopened.png`，共 14 张；全部存在且 >4 KB（`summary.json` 清单）。
- 响应式截图：`narrow-375-login.png`（375×812，28,972 B）、`narrow-375-share.png`（375×812，46,112 B）、`wide-1440-login.png`（1440×900，42,028 B）；PNG 签名与尺寸校验通过。
- 浏览器控制台：主流程 19 项全 PASS、0 failures；重启 3 项全 PASS（`browser-full-console.txt`、`browser-restart-console.txt`）。
- 敏感信息：HTTP 证据路径中的分享令牌已替换为 `[redacted]`；`summary.json` 再经脱敏写出；服务端日志只记录路由模板；未检出原始分享 token、口令、`kj_session` Cookie 或 `shareToken` 字段。分享令牌只用于当次请求，不写入证据。
- 无屏幕录制：已如实说明，不以截图冒充录屏。

## 7. 已知限制与残余风险

1. 无屏幕录制；以 17 张真实截图提供演示证据。
2. 浏览器为 headless Chrome；第一人称指针锁定未在 headless 中验证，已通过键盘模式激活检查；真实桌面指针锁定仍需人工确认。
3. 浏览器全流程复用仓库现有 CDP 测试驱动 `tests/e2e/verification_flow.mjs`（本角色未修改）；本角色另做了独立 HTTP 检查与独立启动/重启/截图，但仍属同一测试夹具。
4. 400 墙/400 家具容量用例使用 50 mm 合成短墙，仅验证上限与耗时，不用于面积正确性；面积正确性由两室样板与浏览器流程验证。
5. 未做 axe/WCAG AA 自动化审计；可访问性证据为源码核对、键盘路径与 375px 真实截图。
6. 单用户 SQLite、单进程；未做多用户并发/压力基准；生产容量边界以此为前提。
7. 分享令牌是 URL bearer 凭据，分享链接应视为可访问该方案只读内容的秘密；撤销后立即失效。
8. 客户端提前断开 keep-alive 连接时，`socketserver` 可能打印一条无请求上下文的 `ConnectionAbortedError` traceback；不影响业务响应与数据，属日志噪声。
9. 共享页面仅提供 CSV 下载；3D 编辑控件不出现。

以上均为已声明的残余风险，未发现与提案/契约冲突的阻断项。

## 8. 证据索引

- 独立复跑：`docs/verification/acceptance-runner.py`
- 汇总：`docs/verification/kujiale-lite-v1-run/summary.json`、`summary.txt`、`http-checks.txt`
- 测试：`tests-backend.txt`、`tests-frontend.txt`
- 日志：`server.log`、`browser-full-console.txt`、`browser-restart-console.txt`、`chrome-screenshot.log`
- 数据：`owner-plan.csv`、`shared-http.csv`
- 截图：`verification-01-login.png` … `verification-14-restart-reopened.png`、`narrow-375-login.png`、`narrow-375-share.png`、`wide-1440-login.png`
- 交付侧交叉证据：`docs/evidence/verification-evidence.md`、`docs/evidence/verification-checks.txt`、`docs/evidence/verification-test-summary.txt`
- 提案/契约：`docs/proposals/kujiale-lite-v1-v1.md`、`docs/contracts/kujiale-lite-interface-v1.md`、`README.md`

## 9. 客户验收建议

- 核对未发现阻断项：真实启动/演示、质量基线逐项证据、架构声明一致性均满足 production 档要求。
- 建议客户在验收卡选择 `accept`；这是核对建议，不是本角色的批准，也不是客户决定。
- 若客户要求屏幕录制或自动化 WCAG AA 审计，可先选择 `reject` 或要求补充证据；这两项属于已声明残余风险，不影响本次演示证据的完整性。
- 最终决定以客户在验收卡上的选择为准；本报告不构成客户批准。
