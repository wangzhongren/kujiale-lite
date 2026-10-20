# 项目工作流 · kujiale-lite-v1

> 本文件为人读视图。流程门禁状态只以 `docs/flows/kujiale-lite-v1.yaml` 为准；本文件不承载 step `status` 的判定。

## 1. 基线
- flowId：`kujiale-lite-v1`；质量档位：`production`（生产档，不放宽）
- 依据：客户意图 `docs/intents/kujiale-lite-v1.md`；提案 `docs/proposals/kujiale-lite-v1-v1.md`（客户已接受，判断 agent 代批）
- 冻结契约：`docs/contracts/kujiale-lite-interface-v1.md`（v1，只读；变更须走 v2）
- 已任命项目角色：`backend`、`frontend`（角色卡见 `角色卡/backend/`、`角色卡/frontend/`）

## 2. 步骤与角色
| stepId | 执行角色 | 交付物 | 完成证据 |
|---|---|---|---|
| implementation-backend | backend | `app/` 全分层、`tests/unit|integration|e2e`、README | 测试全绿输出、真实启动、代码路径 |
| implementation-frontend | frontend | `web/`（2D/3D/编辑器/UI/分享）、`tests/frontend/` | `node --test` 全绿、截图/走查清单 |
| integration-e2e | backend（联调，frontend 配合） | 跨模块联调、全量测试矩阵 | `python -m unittest discover` + `node --test` 全绿、负例清单 |
| verification-evidence | backend | 交付证据归档 | 启动命令/地址、录屏/截图、样例 CSV、失败日志、重启恢复 |
| verification | app / Proof | 独立验收 | 由应用自动派发，统筹不占用 |

## 3. 架构与写区（提案 3.1–3.8）
- backend 写区：`app/`、`tests/unit/`、`tests/integration/`、`tests/e2e/`、`data/`、`README.md`、`docs/evidence/`
- frontend 写区：`web/`、`tests/frontend/`
- 依赖方向：`http → auth/plans/share/export → repository → db`；`geometry/schema/validate/csv` 为纯函数层；`obs`、`config` 为叶子；`web/` 只能经 `/api/v1` 访问后端
- 契约只读：`docs/contracts/**` 不得原地修改；接口破坏性变更走 v2

## 4. 工程质量基线（生产档，不可放宽）
1. 正确性：服务端权威几何/面积/统计；基准 4000×3000mm = 12.00 m²；无 TODO/占位/假数据；非法输入一致错误码
2. 健壮性：WAL + `synchronous=FULL` 原子写；重启恢复；409 乐观并发；报文/文档/对象上限
3. 安全：scrypt 加盐、令牌仅存哈希、CSRF、按 user_id 隔离、分享只读、参数化 SQL、防注入/穿越/XSS、日志无敏感数据
4. 可维护性：分层无环；README 含启动/架构/API/权限/schema/状态机/限制与权衡
5. 架构扩展：扩展点与版本/迁移/兼容/弃用策略按提案 3.6–3.8
6. 可观测性：requestId 贯穿、结构化日志、失败不静默吞错
7. 性能：分页默认 20 最大 100；容量边界写入 README
8. 前端：加载/空/错误三态；键盘可用；对比度/aria；≥375px 可用
9. 测试：单元+集成+端到端；权限与非法路径负例；不得为保绿弱化断言
10. 交付：验收前必须真实启动并演示

## 5. 真实启动演示（验收前置）
- 启动：`python -m app --port 8080`；地址：`http://127.0.0.1:8080`
- 演示全流程：注册 → 登录 → 新建 → 画 2 房间+门窗 → 3D 轨道/漫游 → 家具/材质 → 保存 → 重登打开 → 只读分享（PUT 被拒）→ CSV → 重启恢复
- 证据归档 `docs/evidence/`：启动日志与命令、截图/录屏、测试全绿输出、示例 CSV、401/403/404/409 日志摘录、重启恢复证据
- 未真实运行不得建议验收通过

## 6. 回交与完成口令
- 回交内容：改动路径、测试命令与全绿输出、证据路径、未完成/风险
- 口令：完成 `STEP_DONE <stepId>`；受阻 `STEP_BLOCKED <stepId> <原因>`；无需等待客户催办
- 步骤 `done` 由 Steward/Lead 核对账本证据后标记；实现角色不得自标 done

## 7. 变更与重验
- 契约/权限/质量下限变更：先提案（v2）再实施
- 内部实现变更：不突破契约，重跑相关测试并在回交中说明
- 返工：由工作流管理者用 `flow_step_supersede` 建新步骤（旧步骤保留 superseded），按新证据重验

## 8. 验收
- 全部实现与证据步骤齐备后，应用自动派 Proof / 验收；统筹不派发治理角色
- 验收依据：意图 acceptance + 契约质量下限 + 真实启动证据
