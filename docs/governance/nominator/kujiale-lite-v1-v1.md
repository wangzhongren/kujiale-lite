# Crew / 组队 治理记录 · kujiale-lite-v1（v1）

- 日期：2026-10-20
- 角色：nominator（Crew / 组队）
- 流程：`kujiale-lite-v1`（qualityTier: production）
- 依据：已接受提案 `docs/proposals/kujiale-lite-v1-v1.md`；已冻结契约 `docs/contracts/kujiale-lite-interface-v1.md`（v1）；流程步骤 owner 为 backend / frontend。

## 动作与结果

1. 读取流程与提案，确认需要两个项目角色：backend（`app/` 及后端测试、README、交付证据）与 frontend（`web/` 与前端测试）。
2. 写提名文件 `docs/nominations/kujiale-lite-v1-v1.md`：模块—写区一一对应、无重叠；`recommended: [backend, frontend]`；未含内置治理角色。
3. 发任命卡（`cardKind=appointment`，多选）：判断 agent 代决策选中 backend 与 frontend（非客户本人点击）。
4. 发写卡确认卡（`cardKind=appointment-write`，4 路径）：判断 agent 代批；随后写入：
   - `角色卡/backend/role-card.md`
   - `角色卡/backend/boundary.yaml`（role: backend；entries 7 条）
   - `角色卡/frontend/role-card.md`
   - `角色卡/frontend/boundary.yaml`（role: frontend；entries 2 条）
5. 边界格式仅使用 `role` / `entries` 顶层键；无 `version`/`roleId`/`root` 顶层键；条目未写 `root`。

## 写区切分（无重叠）

- backend：`app/`、`tests/unit/`、`tests/integration/`、`tests/e2e/`、`data/`、`README.md`、`docs/evidence/`
- frontend：`web/`、`tests/frontend/`
- 双方均只读 `docs/contracts/**`；治理账本、提案、流程、角色卡与提名文件不在其写区。

## 边界与限制

- 本记录不构成任命或客户批准；任命决定与写盘许可以应用签发的治理回执为准（本次为判断 agent 代批）。
- 未创建额外治理角色；未推荐/任命内置治理角色；验收仍由内置 Proof / verifier 负责。
- 技能/MCP 未安装（客户未明示），不改变任何角色写边界。

## 待办（交由流程编排方）

- 由应用完成角色卡/边界确定性校验；通过后由 Steward / Lead 按账本证据推进 `nomination` 与后续实现步骤派发。
