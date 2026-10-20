---
flowId: kujiale-lite-v1
version: 1
author: rapporteur
status: draft
createdAt: 2026-10-20
qualityTier: production
---

# 酷家乐简易版 · 提案 v1

> 这是提案，不是客户批准。质量档位：生产档（客户未指定，按默认执行，不放宽）。

## 1. 目标与边界

交付一个在本机一条命令启动的 Web 应用，完成「注册登录 → 画 2D 户型 → 3D 漫游 → 家具/材质 → 保存/重开 → 只读分享 → CSV 清单」的完整闭环。

- 包含：账号与方案数据隔离；墙体/门窗/房间编辑与撤销重做；2D/3D 同源几何；≥9 件家具与 ≥6 种地板/墙面材质；方案新建/命名/保存/列表/打开/删除；只读分享链接；按房间 CSV 导出；内置 1 套样板间。
- 不做（与意图一致）：照片级/GPU 光追与云渲染、真实商品库与支付、多人协同、移动 App、CAD 导出、AI 布局、第三方登录/短信/对象存储/CDN。
- 部署边界：单进程、单机、单人使用；默认仅绑定 `127.0.0.1`，不承诺公网多租户部署。

## 2. 技术选型与理由

- 运行时：Python 3.14（本机已确认可用）。后端零第三方依赖，一条命令启动，无 pip 安装步骤。
- 后端：`http.server.ThreadingHTTPServer` + 自研路由/中间件；`sqlite3`（WAL、`synchronous=FULL`、事务）；`hashlib.scrypt` 口令哈希；`secrets` 令牌；`logging` 结构化日志。代价是自研 HTTP 层需自证正确性，用集成/负例测试、严格报文上限、默认本机绑定兜底。
- 前端：原生 ES Modules、无构建步骤；`web/vendor/three/three.module.js`（固定版本 + MIT LICENSE，随包内置，运行时不访问 CDN）。3D 引擎自研风险高于收益，这是唯一第三方运行时文件；Canvas 2D 编辑器、撤销栈、状态管理均自写。
- 测试：Python `unittest`（单元/集成/HTTP 端到端）+ Node.js 24 内置 `node:test`（前端纯函数：撤销栈、吸附、几何预览）。
- 存储：`data/kujiale.db` 单文件 SQLite，启动时自动建库与迁移；样板间以 JSON 模板提供，用户可「从样板间新建」。

## 3. 架构方案

### 3.1 模块分解与职责

```
app/                       后端（Python 标准库）
  __main__.py              启动入口：参数/配置、初始化 DB、启动 HTTP 服务
  config.py                配置读取与校验（环境变量+命令行），不含密钥
  server.py                create_app() 工厂、路由注册、优雅关闭
  http/                    router.py 路由匹配 | request.py 报文解析与上限
                           response.py JSON/静态响应 | static.py 静态文件（防穿越）
                           middleware.py 请求ID/会话/CSRF/统一错误
  auth/                    passwords.py(scrypt) | sessions.py(令牌与TTL)
                           csrf.py(双提交令牌) | ratelimit.py(登录限速)
  plans/                   schema.py(文档结构与上限) | validate.py(语义校验)
                           geometry.py(纯函数：墙图/闭环/面积/开洞) | stats.py(按房间统计)
                           repository.py(参数化 SQL) | service.py(用例与权限隔离)
                           migrate.py(文档 schemaVersion 迁移链)
  share/service.py         分享令牌签发/撤销/只读解析
  export/csv.py            CSV 列定义、转义与公式注入防护
  catalog/                 loader.py + furniture.json + materials.json + sample-plan.json
  db/                      connection.py(SQLite 连接/PRAGMA) | migrations.py(user_version 迁移)
  obs/                     logging.py(JSON 行日志) | errors.py(错误码与 HTTP 映射)
web/                       前端（原生 ES Modules，无构建）
  index.html               应用壳
  js/app.js                bootstrap 与路由（/ 列表、/plans/:id 编辑、/s/:token 只读）
  js/api.js                统一 fetch 封装（错误码、requestId、401 跳转）
  js/store.js              当前文档状态 + 脏标记 + 保存(revision)
  js/undo.js               命令栈撤销/重做（上限 50）
  js/canvas2d.js           2D 绘制/命中测试/吸附/选中/拖拽
  js/geometry.js           前端预览几何（服务端为权威，用同一批基准用例对齐）
  js/three-view.js         同源生成 3D：墙体挤出+开洞、地面、家具基元；轨道/第一人称
  js/catalog.js            家具/材质目录
  js/ui.js                 加载/空/错误三态、对话框、可访问性
  js/share.js              只读查看模式（禁用编辑入口）
  vendor/three/            固定版本 Three.js + LICENSE
tests/                     unit/ integration/ e2e/ frontend/
README.md                  启动、架构、API、权限、schema、状态机、限制与权衡
```

### 3.2 依赖方向（无环）

`http`（传输）→ `auth`/`plans`/`share`/`export`（用例）→ `repository` → `db`；`geometry`/`schema`/`validate`/`csv` 为纯函数层，不做 I/O；`obs`、`config` 为叶子模块，不反向依赖；服务层不得 import `http`；`web/` 只能经 `/api/v1` 访问后端。用 `tests/unit/test_import_graph.py` 静态扫描 imports 断言无环，作为回归门禁。

### 3.3 数据流（2D/3D 同源）

前端维护唯一文档 `doc`（墙/开洞/房间命名/家具/材质）→ 保存时整份提交 `PUT /api/v1/plans/{id}` → 服务端校验并计算房间与统计 → 入库。2D 画布与 3D 视图都只渲染同一份 `doc`；面积、家具数量、材质用量、CSV 全部由服务端计算，前端不另算一份用于导出，因此不存在第二套几何模型。

### 3.4 数据 schema v1（方案文档）

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

约束：墙 1..400 段、开洞 ≤400、家具 ≤400、单文档 ≤2 MiB；坐标 ∈ [-100000,100000]；名称 ≤80 字符；单方案房间 ≤50。`loopKey` 为构成房间的墙 id 排序后拼接，保证编辑后房间命名稳定。SQLite 表：`users / sessions / plans / shares / login_attempts`，全部参数化查询；`plans.revision` 支持乐观并发。

### 3.5 API 契约 v1（前缀 `/api/v1`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/auth/register` | 公开 | 注册；重复用户名 409；弱口令 422 |
| POST | `/auth/login` | 公开 | 登录；连续失败限速 429 |
| POST | `/auth/logout` | 登录 | 注销会话 |
| GET | `/auth/me` | 登录 | 当前用户 |
| GET | `/plans?page=&pageSize=&q=` | 登录 | 分页列表（默认 20，最大 100） |
| POST | `/plans` | 登录 | 新建（可带 doc） |
| GET | `/plans/{id}` | 登录 | 读取自己的方案，他人返回 404 |
| PUT | `/plans/{id}` | 登录 | 整份保存；`expectedRevision` 不符返回 409 |
| DELETE | `/plans/{id}` | 登录 | 删除自己的方案 |
| POST | `/plans/{id}/share` | 登录 | 生成只读令牌 |
| DELETE | `/plans/{id}/share` | 登录 | 撤销分享 |
| GET | `/plans/{id}/export.csv` | 登录 | 按房间 CSV |
| GET | `/share/{token}` | 公开 | 只读方案（只允许 GET） |
| GET | `/share/{token}/export.csv` | 公开 | 只读 CSV（只允许 GET） |
| GET | `/catalog` | 公开 | 家具与材质目录 |
| GET | `/sample` | 登录 | 样板间模板 |

错误体统一为 `{"error":{"code","message","details?","requestId"}}`；错误码：`AUTH_REQUIRED(401)`、`AUTH_INVALID_CREDENTIALS(401)`、`AUTH_RATE_LIMITED(429)`、`FORBIDDEN(403)`、`NOT_FOUND(404)`、`VALIDATION_FAILED(422)`、`PAYLOAD_TOO_LARGE(413)`、`CONFLICT_REVISION(409)`、`UNSUPPORTED_SCHEMA_VERSION(422)`、`INTERNAL(500)`。

### 3.6 版本、迁移、兼容与弃用

- API 以版本前缀隔离；破坏性变更升 `/api/v2`，v1 至少保留一个发布周期并在响应头 `Deprecation` 标注；字段与错误码只增不改语义。
- 方案文档 `schemaVersion` 单调递增，读取时逐级迁移（`plans/migrate.py`）；遇到更高版本拒绝并提示（`UNSUPPORTED_SCHEMA_VERSION`），不静默丢字段。
- 数据库用 `PRAGMA user_version` 顺序迁移，启动时在事务内执行；失败 fail-fast 拒绝启动，不自动改动既有数据文件。
- 分享令牌与文档版本解耦，始终解析最新文档；撤销后旧令牌立即失效（`revoked_at`）。

### 3.7 扩展点（改哪里 / 不改哪里）

- 新家具/材质：只改 `catalog/furniture.json` / `materials.json`（id、名称、尺寸、颜色/基元），不改代码与 schema。
- 新导出列：`export/csv.py` 追加到列尾 + 测试；不改既有列语义（v1 兼容）。
- 新对象类型（如吊顶、柜体）：`plans/schema.py` 与 `validate.py` 增字段，`canvas2d.js`/`three-view.js` 增渲染适配；存储、认证、路由不动。
- 新认证方式：`auth/` 内新增提供者，`sessions` 与中间件不动。
- 明确不改：`http/` 传输层、`db/` 迁移框架、分享只读边界（分享路由只允许 GET）。

### 3.8 横切关注点归属

- 配置：`app/config.py`；环境变量 `KUJIALE_PORT/HOST/DATA_DIR/LOG_LEVEL/SESSION_TTL_HOURS/SECURE_COOKIE`；启动校验并打印生效项（不含密钥）。
- 错误：`obs/errors.py` 的 `AppError(code,status,message,details)`；中间件统一捕获；未捕获异常记 ERROR 并回 500。
- 日志：`obs/logging.py` 输出 JSON 行（ts/level/event/requestId/route/status/durationMs/errCode）；不记录密码、令牌、Cookie。
- 鉴权：`http/middleware.py` 解析会话注入 `ctx.user`，路由声明 `auth=none|required`；`plans/service.py` 再用 `user_id` 过滤（纵深防御）。
- 测试缝：`create_app(config, clock=None, db_path=None)` 工厂，无模块级全局状态；测试用临时目录与临时端口。

### 3.9 状态机

- 方案：`draft(未保存, revision=null)` → `saved(revision=n)` → `saved(revision=n+1)`；保存冲突 409，提示「已在别处更新」，提供覆盖/重载。
- 分享：`none → active → revoked`；撤销后不可复用。
- 会话：`active → expired`（默认 7 天，可配）。
- 编辑器：`clean ↔ dirty`；保存成功后 clean 并记录 revision。

### 3.10 关键算法约定（可人工核对）

- 房间：以墙体端点为节点构建平面图，按最小面环遍历得到闭合多边形；边界墙必须首尾相接，否则 `VALIDATION_FAILED`（未闭合）。
- 面积：房间多边形（墙中心线）鞋带公式，单位 m²，保留 2 位；基准用例 4000×3000mm → 12.00 m²。
- 开洞：`offset+width ≤ 墙长`，门窗高度与窗台高合法；3D 墙体按开洞分段挤出。
- 材质用量：地面面积 = 房间面积；墙面面积 = 房间周长 × 墙高 − 开洞面积，按房间汇总。
- CSV：UTF-8 BOM、CRLF、RFC4180 转义；以 `= + - @` 开头的单元格前置 `'` 防公式注入；列固定为 `room_name, area_m2, furniture_count, floor_material, floor_area_m2, wall_material, wall_area_m2`。

## 4. 质量基线与证据计划

| 基线项 | 实现 | 验证方式与证据 |
|---|---|---|
| 正确性 | 服务端权威几何/面积/统计；schema 与语义校验；非法输入统一错误码；无 TODO/占位/假数据 | 手工核对 12.00 m² 等基准用例；单元测试覆盖闭环/开洞/面积/CSV；负例：空名称、超长文本、非法坐标、重复注册；验收现场演示 |
| 健壮性 | SQLite WAL + `synchronous=FULL` 事务写；revision 乐观并发；重启恢复；正文/文档/对象上限 | 集成测试：并发保存 409；结束进程重启后数据可读；超限 413/422 |
| 安全 | scrypt 加盐哈希；会话令牌仅存哈希、HttpOnly+SameSite=Lax；CSRF 双提交 + Origin 校验；所有方案接口按 user_id 过滤；分享仅 GET；参数化 SQL；CSP 与 textContent 防 XSS；静态路径规范化防穿越；登录限速 | 负例测试：未登录 401、越权 404/403、通过分享令牌写入被拒、非法令牌 404、注入载荷、路径穿越；日志无敏感字段 |
| 可维护性 | 分层模块与无环依赖；README 含启动/架构/API/权限/schema/状态机/限制；只在约束处注释 | 导入图无环测试；README 评审；命名与错误码统一 |
| 架构与可扩展性 | 见 3.1–3.8：扩展点、依赖方向、schema/API 版本迁移与弃用策略、横切归属 | 扩展点演练：仅改 catalog JSON 新增 1 件家具并通过测试；更高 schemaVersion 拒绝用例 |
| 可观测性 | JSON 结构化日志（requestId 贯穿）；登录/保存/渲染/导出失败有 ERROR/WARN 与可读错误体 | 演示失败路径并展示日志摘录；代码与测试核查无静默吞错 |
| 性能与容量 | 列表分页（默认 20、最大 100）；文档/对象/点数上限；3D 变更时释放旧几何；容量边界写入 README | 400 墙 / 400 家具用例的响应时间记录；分页边界测试 |
| 前端 | 加载/空/错误三态；键盘删除/撤销重做/焦点可见；aria-label 与 ≥4.5:1 对比度；≥375px 响应式 | 375px 与桌面截图；键盘走查清单；错误态含 requestId 与重试 |
| 测试 | unittest 单元/集成/HTTP 端到端 + node:test 前端纯函数；权限与非法路径负例；断言不弱化 | `python -m unittest discover` 与 `node --test` 全绿输出；测试独立于实现细节 |
| 交付 | 真实启动并演示全流程；提供命令、地址、截图/录屏 | `python -m app --port 8080` → http://127.0.0.1:8080；现场走通第 5 节脚本并附证据 |

## 5. 验收标准与演示脚本

验收逐条对齐意图 acceptance，不放宽：功能闭环；正确性与单一几何源；原子写与重启恢复；认证/授权/分享只读/注入与穿越防护；模块边界与 README；结构化日志；分页与容量；前端三态与可访问性；单元+集成+端到端且含负例；真实启动演示。

现场演示步骤：
1. `python -m app --port 8080`，打开 http://127.0.0.1:8080（展示启动日志与首页）。
2. 注册 → 登录 → 新建「演示户型」。
3. 绘制两间相连房间（如 4000×3000 与 3000×3000），加 2 门 2 窗。
4. 切换 3D，轨道查看并进入第一人称漫游；核对 2D/3D 为同一户型。
5. 拖入 ≥3 件家具并旋转，替换地面与墙面材质。
6. 保存 → 退出 → 重新登录 → 从列表打开，内容与 revision 正确。
7. 生成只读分享链接，无痕窗口未登录打开 2D/3D/清单；用 PUT 尝试修改被拒（展示状态码与日志）。
8. 导出 CSV，用表格软件核对面积（如 12.00 m²）、家具数量、材质用量。
9. 重启进程后重新打开方案，数据仍在。
10. 负例：未登录访问方案接口 401、访问他人方案 404/403、非法分享令牌 404。

证据：启动命令与访问地址、演示截图/录屏、测试全绿输出、示例 CSV、失败路径日志摘录。

## 6. 风险、限制与权衡

- Three.js 需随包获取一次（实现阶段内置到 `web/vendor/`）。若当前环境无法获取，不静默降级，会回到客户处 revise（备选：自研最小 WebGL 渲染器，范围需调整）。
- 自研 HTTP 层是本方案主要技术风险：以严格报文上限、方法白名单、默认 127.0.0.1 绑定与集成负例兜底；不承诺公网部署。
- 面积采用墙中心线口径，与「内净面积」存在差异；README 明示口径与基准用例。
- SQLite 单写者：在单机单人边界内可接受；写事务短、`busy_timeout=5000` 兜底。
- 前端与服务端各有一份几何纯函数：服务端为唯一权威，导出与统计只走服务端；前端函数仅用于预览，以同一批基准用例对齐。
- 3D 为「简易」级别：基元拼装家具、纯色/程序化材质，不做贴图级真实感。

## 7. 里程碑

- M1：骨架 + 配置/日志/错误 + 认证 + SQLite 迁移 + 测试缝与首轮单元测试。
- M2：2D 编辑器 + 闭环/面积 + 方案 CRUD/分页 + 保存冲突。
- M3：同源 3D 渲染 + 轨道/第一人称漫游。
- M4：家具/材质目录 + 分享只读 + CSV 导出。
- M5：样板间 + 可访问性与三态 + 全量测试 + 真实启动演示 + README。
