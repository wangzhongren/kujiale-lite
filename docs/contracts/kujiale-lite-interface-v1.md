---
contractId: kujiale-lite-interface
version: 1
flowId: kujiale-lite-v1
status: frozen
frozenAt: 2026-10-20
supersedes: none
---

# 酷家乐简易版 · 跨角色契约 v1

## 1. 生效范围与依据

- 适用于 flow `kujiale-lite-v1` 的实现、验收与交付。
- 依据：客户意图 `docs/intents/kujiale-lite-v1.md`；提案 `docs/proposals/kujiale-lite-v1-v1.md`。
- 提案卡结果为 `accept`（由客户委托的判断 agent 代批，非客户本人点击），据此冻结本契约。
- 本文件版本化冻结；任何变更只能新增 v2，不原地修改。

## 2. 交付边界

- 必须交付：本机一条命令启动的 Web 应用，含注册登录与方案隔离、2D 户型编辑（墙/门窗/房间、撤销重做）、同源 3D 漫游、≥9 件家具与 ≥6 种材质、方案 CRUD、只读分享、按房间 CSV、1 套样板间。
- 不做：照片级/云渲染、真实商品与支付、多人协同、移动 App、CAD 导出、AI 布局、第三方登录/短信/对象存储/CDN。
- 部署边界：单进程、单机、单人；默认绑定 `127.0.0.1`；不承诺公网多租户。

## 3. 冻结接口

### 3.1 API v1（前缀 `/api/v1`）

| 方法 | 路径 | 权限 | 契约 |
|---|---|---|---|
| POST | `/auth/register` | 公开 | 重复用户名 409；弱口令 422 |
| POST | `/auth/login` | 公开 | 连续失败限速 429 |
| POST | `/auth/logout` | 登录 | 注销会话 |
| GET | `/auth/me` | 登录 | 当前用户 |
| GET | `/plans?page=&pageSize=&q=` | 登录 | 分页，默认 20、最大 100 |
| POST | `/plans` | 登录 | 新建 |
| GET | `/plans/{id}` | 登录 | 仅本人；他人一律 404 |
| PUT | `/plans/{id}` | 登录 | 整份保存；`expectedRevision` 不符 409 |
| DELETE | `/plans/{id}` | 登录 | 仅本人 |
| POST | `/plans/{id}/share` | 登录 | 签发只读令牌 |
| DELETE | `/plans/{id}/share` | 登录 | 撤销，旧令牌立即失效 |
| GET | `/plans/{id}/export.csv` | 登录 | 按房间 CSV |
| GET | `/share/{token}` | 公开 | 只读方案；该路由只允许 GET |
| GET | `/share/{token}/export.csv` | 公开 | 只读 CSV；只允许 GET |
| GET | `/catalog` | 公开 | 家具与材质目录 |
| GET | `/sample` | 登录 | 样板间模板 |

新增端点与响应字段允许（须向后兼容）；删除端点、改变已有字段语义或权限模型须走契约 v2。

### 3.2 错误体与错误码

统一错误体：`{"error":{"code","message","details?","requestId"}}`。

`AUTH_REQUIRED(401)`、`AUTH_INVALID_CREDENTIALS(401)`、`AUTH_RATE_LIMITED(429)`、`FORBIDDEN(403)`、`NOT_FOUND(404)`、`VALIDATION_FAILED(422)`、`PAYLOAD_TOO_LARGE(413)`、`CONFLICT_REVISION(409)`、`UNSUPPORTED_SCHEMA_VERSION(422)`、`INTERNAL(500)`。错误码语义不得复用或改名；只允许新增。

### 3.3 方案文档 schema v1

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

上限：墙 1..400、开洞 ≤400、家具 ≤400、房间 ≤50、单文档 ≤2 MiB、坐标 ∈ [-100000,100000]、名称 ≤80 字符。字段只增不改语义；更高 `schemaVersion` 必须拒绝（`UNSUPPORTED_SCHEMA_VERSION`），不得静默丢字段。

### 3.4 统计与 CSV 口径

- 房间为墙中心线闭合多边形；面积按鞋带公式，m² 保留 2 位；基准 4000×3000mm = 12.00 m²。
- 地面材质用量 = 房间面积；墙面材质用量 = 周长 × 墙高 − 开洞面积。
- CSV：UTF-8 BOM、CRLF、RFC4180 转义，`= + - @` 开头单元格前置 `'`；列为 `room_name, area_m2, furniture_count, floor_material, floor_area_m2, wall_material, wall_area_m2`（新增列只追加在末尾）。

## 4. 质量下限（不可放宽）

1. 正确性：服务端权威计算；2D/3D 与导出共用同一文档；无 TODO/占位/假数据；非法输入有一致错误码。
2. 健壮性：SQLite WAL + `synchronous=FULL` 事务原子写；重启可恢复；保存冲突 409；报文与对象有上限。
3. 安全：scrypt 加盐哈希；会话令牌仅存哈希、HttpOnly + SameSite=Lax；CSRF 双提交 + Origin 校验；方案接口按 user_id 隔离；分享只读；参数化 SQL；CSP 防 XSS；静态文件防穿越；登录限速。
4. 可维护性：分层无环；README 含启动、架构、API、权限模型、schema、状态机、已知限制与权衡。
5. 架构与可扩展性：扩展点与版本/迁移/兼容/弃用策略按提案 3.6–3.8 执行。
6. 可观测性：结构化日志含 requestId；关键失败不静默吞错。
7. 性能与容量：列表分页；上限与容量边界写入 README；加载/空/错误三态齐备。
8. 前端：键盘可用（删除、撤销/重做）、标签与对比度、≥375px 可用。
9. 测试：单元 + 集成 + 端到端；权限与非法路径负例；断言不得为保绿弱化。
10. 交付：验收前必须真实启动应用并演示。

## 5. 角色责任与证据

- 实现角色：按本契约交付代码、测试、README 与演示材料；不得用假数据或跳过负例。
- 验收角色：独立复跑测试与现场演示，核对负例与证据；不得仅凭实现方报告通过。
- Lead/主理与 Steward：流程编排与账本证据核对；步骤 `done` 以账本证据为准。
- Draft/提案：解释契约、受理变更提案；不代替客户验收，不代替实现。
- 客户：最终验收决定。

验收证据至少包含：启动命令与访问地址；全流程演示录屏或截图；测试命令与全绿输出；示例 CSV；401/403/404/409 失败路径日志摘录；重启恢复证据。

## 6. 变更流程

- 契约变更须先经客户提案决定，再冻结为 v2；v1 保留可追溯，不原地修改。
- 未涉及接口、权限与质量下限的内部实现细节可由实现角色自行决定，但不得突破本契约。

## 7. 已知限制

- 单机单人；SQLite 单写者；面积为中心线口径；3D 为基元级简易渲染；Three.js 随包内置，运行时不依赖 CDN。
