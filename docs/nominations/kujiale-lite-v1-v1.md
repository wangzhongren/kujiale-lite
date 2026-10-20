---
flowId: kujiale-lite-v1
version: 1
author: nominator
status: proposed
qualityTier: production
createdAt: 2026-10-20
candidates: [backend, frontend]
recommended: [backend, frontend]
---

# 酷家乐简易版 · 提名 v1

> 本文件是提名，不是任命。客户在任命卡（cardKind=appointment）上作出的选择才是任命决定；写角色卡前还会逐文件确认。

## 1. 依据

- 客户已接受提案 `docs/proposals/kujiale-lite-v1-v1.md`（`accept`，判断 agent 代批）。
- 跨角色契约已冻结：`docs/contracts/kujiale-lite-interface-v1.md`（v1，status: frozen）。
- 流程 `docs/flows/kujiale-lite-v1.yaml` 的步骤 owner 已声明为 `backend` 与 `frontend`；本提名据此给出对应项目角色，不引入额外角色。
- 质量档位：`production`（生产档，不放宽）。

## 2. 架构模块 → 写区一一对应（无重叠）

| 架构模块（提案 3.1） | 写区（boundary.yaml 条目） | 属主角色 |
|---|---|---|
| `app/` 后端分层（http/auth/plans/share/export/catalog/db/obs） | `app/` | backend |
| 后端测试：单元 / 集成 / HTTP 端到端、导入图无环 | `tests/unit/`、`tests/integration/`、`tests/e2e/` | backend |
| 运行数据与迁移验证（本地 SQLite） | `data/` | backend |
| 项目说明与交付证据 | `README.md`、`docs/evidence/` | backend |
| `web/` 前端（原生 ES Modules、vendor/three、2D/3D/编辑器/UI/分享） | `web/` | frontend |
| 前端纯函数测试（node:test：撤销栈、吸附、几何预览） | `tests/frontend/` | frontend |

- 每个模块只有一个属主：`app/` 与后端测试只归 backend；`web/` 与前端测试只归 frontend。
- `tests/` 内部按子目录切分，互不交叉；不允许任一角色写对方目录。
- 契约文件 `docs/contracts/**` 已由 rapporteur 冻结，实现角色只读；需要变更走契约 v2 提案，不原地改。
- `web/` 只经 `/api/v1` 访问后端；不得 import `app/` 内模块，保证前后端写区与依赖方向一致。

## 3. 候选角色

### 3.1 backend（后端实现 / 集成 / 交付证据）

- **职责**：按契约 v1 实现 `app/` 全部分层——认证与会话（scrypt、令牌哈希、CSRF、限速）、SQLite 迁移与原子写、方案 CRUD 与乐观并发、几何校验与房间/面积/材质统计、只读分享、CSV 导出、目录与样板间、结构化日志与统一错误码；负责集成与端到端联调、真实启动演示与证据归档。
- **写区**：`app/`、`tests/unit/`、`tests/integration/`、`tests/e2e/`、`data/`、`README.md`、`docs/evidence/`。不得写 `web/`、`tests/frontend/`、`docs/contracts/`、审批与治理账本。
- **质量职责**：正确性（服务端权威几何，基准 4000×3000mm = 12.00 m²；无 TODO/占位/假数据）；健壮性（WAL + `synchronous=FULL`、重启恢复、409 冲突、报文/文档/对象上限）；安全（参数化 SQL、按 user_id 隔离、分享只读、防注入/穿越/XSS、日志无凭据）；可观测性（requestId 贯穿、不静默吞错）；性能（分页默认 20 最大 100、容量边界写入 README）；测试（单元+集成+HTTP 端到端，权限与非法路径负例，断言不弱化为保绿）。
- **证据责任**：`python -m unittest discover` 全绿输出、真实启动命令与地址（`python -m app --port 8080` / http://127.0.0.1:8080）、全流程演示截图或录屏、示例 CSV、401/403/404/409 日志摘录、重启恢复证据，归档到 `docs/evidence/`。
- **推荐理由**：流程中 `implementation-backend` / `integration-e2e` / `verification-evidence` 三个步骤 owner 均为 backend，且契约要求同一实现方对齐前后端并产出交付证据；单角色承接可避免联调责任分散，但必须接受 frontend 对 API 契约的独立对齐检查。

### 3.2 frontend（前端实现）

- **职责**：实现 `web/`——应用壳与路由（列表 / 编辑 / 只读分享）、统一 fetch 封装（错误码、requestId、401 跳转）、文档状态与脏标记/保存 revision、命令栈撤销重做（上限 50）、2D 画布绘制/命中/吸附/拖拽、前端预览几何、同源 3D（墙体挤出与开洞、地面、家具基元、轨道/第一人称）、家具与材质目录 UI、加载/空/错误三态、分享只读模式（禁用编辑入口）与可访问性；内置固定版本 Three.js（含 MIT LICENSE），运行时不访问 CDN。
- **写区**：`web/`、`tests/frontend/`。不得写 `app/`、后端测试目录、`data/`、`README.md`、`docs/contracts/`。
- **质量职责**：2D/3D 只渲染同一份 `doc`，不另算一份导出用几何（服务端为权威）；前端纯函数以同一批基准用例与服务端对齐；三态齐备（加载/空/错误，错误含 requestId 与重试）；键盘可用（删除、撤销/重做、焦点可见）、aria-label 与对比度 ≥4.5:1、≥375px 窄屏可用；XSS 防护（textContent / CSP 配合）；无构建步骤下 ES Modules 结构清晰。
- **证据责任**：`node --test` 全绿输出、375px 与桌面截图、键盘走查清单、2D/3D 同源对照演示材料，交付给 backend 汇入 `docs/evidence/`（frontend 不直接写该目录）。
- **推荐理由**：前端是独立架构模块（`web/`）且与后端仅经 `/api/v1` 契约交互，独立属主可保证写区不重叠、2D/3D 同源与可访问性有人负责；避免由 backend 兼任导致前后端耦合与自证。

## 4. 推荐集与任命

推荐：backend、frontend

- 仅提名项目角色，未列入任何内置治理角色（liaison / rapporteur / nominator / convener / verifier 不可任命，验收由内置 Proof / verifier 负责）。
- 客户在任命卡中选中后，Crew 将逐角色提交 `role-card.md` + `boundary.yaml` 的写盘确认卡（appointment-write），逐路径确认后才写入。
- 若客户只任命其中一个角色，Crew 将相应缩小范围并回报流程编排方（未获任命的模块不得由其他角色越界代写）。

## 5. 待客户决定

- 是否任命 backend、frontend（可多选；亦可全部不选并说明修改方向）。
- 如需调整写区切分（如把 `README.md` 或 `docs/evidence/` 划给其他角色），请在任命时说明，Crew 会先修订提名再发写卡确认。
