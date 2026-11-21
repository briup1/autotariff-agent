# 项目理解简报 · autotariff-agent

原始问题：autotariff-agent 为什么这样设计、否决了什么，当前代码/测试/账本到哪一步？

结论：设计取舍可逐条回到 `docs/design-synthesis.md` 与 `docs/design-crossjudge.md`；代码到账本的自证成立（老任务 76 条动作 SHA256 逐字节复现，清单与账本 3363/3364 一致）；但测试当前 83 项中 49 通过、25 失败、9 跳过（本会话 OS 拒绝 sandbox-exec，非代码回归），沙箱隔离、verify:live 只读性、网关金额、业务准确率四项未验证，怡升昌业务终态只能是 REVIEW。覆盖设计/代码/测试/账本四层；未覆盖旧项目需求原文与部署环境。

状态：分支 main（0 提交）| 环境 本机 macOS + Node 22.22 + 独立 Python 3.12 | 已发布 否（未部署、未推送）| 已验收 部分（工程测试 49/83、账本对账 3363/3364、真实怡升昌 REVIEW）

标注约定：无标记为事实，可回源核对；「推断」为基于事实的解释；「未验证」为本会话无法复核。

## 1. 设计初衷

把「拿到船公司/供应商的运价表和一份文字说明，人工判断表头变体、合并单元格、备注归属和价格含义，再逐格抄成结构化运价」这件重复、易漂移、事后无法证明对错的活，交给一个可恢复、可审计、由独立检查器重读原文核对的抽取闭环；系统只证明工程闭环，业务对错交人复核（`docs/design-synthesis.md:28`，`README.md:25-29`）。

| 决策 | 为什么这样定 | 否决了什么 |
|---|---|---|
| 独立 TypeScript 宿主 + Pi Durable，不依赖旧项目运行时 | 旧包、虚拟环境和可变全局配置会污染证据；新项目要能独立安装、独立复现（`README.md:3`，`docs/design-synthesis.md:14`） | LangGraph、旧项目运行时与包依赖 |
| SQLite 动作账本为唯一权威，`run_manifest.json` 只是可读快照 | 崩溃恢复与幂等需要持久事实：动作是否已完成、预算是否已扣，不能靠模型自述或内存计数（`docs/design-synthesis.md:18`，`README.md:70`） | 内存业务状态、JSONL 追加日志当唯一事实源 |
| 单运行单写者；`phase`（已提交位置）与 `decision`（终态）分离；阶段恢复 | 防止恢复时跳过阶段、防止并发写、防止把报告状态当运行终态（`docs/design-synthesis.md:16,18`） | 多 Agent 协同、分布式队列、通用事件重放 |
| 生成脚本在 macOS Seatbelt 沙箱执行；独立检查器重读原文，不采信候选自报 | 模型生成的代码不是权限边界；旧方案的根本缺陷是「自洽即通过」（`docs/design-synthesis.md:14,22`） | 宿主进程内执行、固定 parser、固定调用序列 |
| 预算先预留，未知回执记 UNCERTAIN 且不自动重试；契约必须人工确认 | 收费动作不可逆；契约回答「值意味着什么、怎么算对」，确认是 candidate 变 baseline 的唯一动作（`docs/design-synthesis.md:20`，`docs/contract-flow.md:38-41`） | 由系统声明业务 PASS、上报真实准确率、正式模板发布 |

其他被否决路线与理由：以候选 B 为基础（A 的 SQLite 事务与唯一幂等键更贴合 TS/SQLite 脚手架，B 只合并恢复语义，`docs/design-crossjudge.md:22-34,110`）；运行期无约束重生成（改为每次尝试脚本不可变 + 独立检查 + 新轮次修复，`docs/design-synthesis.md:18,22`）；固定 parser 或固定调用序列（`docs/goal-all-batches.md:13,67`）；候选冒充正式方案（无独立业务批准，`docs/design-synthesis.md:26`）。

## 2. 现状总览

成熟度只取四档：可用 / 受控可用 / 仅文档 / 未实现。括号内标注本会话限制。

| 能力 | 代码证据 | 测试或运行证据 | 结论 |
|---|---|---|---|
| Excel 全量盘点（坐标/样式/合并/隐藏/公式缓存、分页） | `src/closure/source.ts:7-58`、`src/workers/inventory.py`、`src/closure/runtime.ts:313-390` | C06–C14 于 11-03 历史通过；本会话盘点类用例多因沙箱失败未复算 | 可用 |
| 三条抽取路由（excel_script / converted_excel_script / direct_llm） | `src/closure/runtime.ts:399-405,522-585` | `template_runs/live-acceptance.json` 6 场景覆盖三路由 | 可用 |
| 三阶段提交与阶段恢复（extract → post_process → validate） | `src/closure/runtime.ts:501-978`、`resume.ts` | C16/C17/C19 历史通过；本会话 SIGKILL 类用例失败 | 受控可用 |
| 修复轮次（新 attempt、脚本 diff、无进展计数） | `src/closure/runtime.ts:440-475,908-925` | 真实怡升昌两轮，144 差异保留（`run-1793666364570-579fa2de`） | 可用 |
| 独立复核（重开原件重扫 + 契约检查 + 后处理变异检测） | `src/closure/validation.ts:27-314`、`contract-checks.ts:32-160` | 现库 validate COMPLETED 2519 / FAILED 130；本轮验证类用例多在沙箱处失败 | 可用 |
| 终态判定（REVIEW / ANSWERED / BLOCKED；PASS 不可达） | `src/closure/controller.ts:189-203` | 现库 REVIEW 1639、BLOCKED 632、ANSWERED 4 | 可用 |
| macOS 沙箱执行（无网络、只读输入、只写 scratch） | `src/closure/execute.ts:107-200`（策略见 :159） | 本会话 25 条失败全部可归因 sandbox-exec；11-03 记录曾通过文件/网络/进程对抗 | 受控可用（当前环境无法验证） |
| 非 Excel 转换与直连抽取（PDF/DOCX/图片） | `src/closure/documents.ts:35-75`、`documents.py`、`ocr.swift` | C03/C05 历史通过；本会话失败；范围限本地可读表格、限定叙述语法、英文 OCR | 受控可用 |
| 契约流程（观察式候选 → 自检 → 人工确认 → 说明哈希复用） | `src/closure/contract.ts:108-345` | 真实契约 1 份（`08a9b66e…`）无 `approval.json`、未确认；另 1 份（`9f9525ae…`）为本会话测试产物 | 受控可用 |
| 单页工作台（HTTP API、会话与 job 持久化、requestId 幂等、上传签名校验） | `src/web/server.ts:17-92`、`service.ts:34`、`store.ts:21-127`、`web/app.js` | web 测试通过；仅绑 127.0.0.1、无鉴权 | 可用 |
| 验收命令（verify:offline / verify:live / verify:reinstall） | `src/verify-offline.ts:5-87`、`verify-live.ts:57-249`、`verify-reinstall.ts:8-104` | offline 当前 FAIL（83/49/25/9，missingCases 21）；live 6 场景 PASS；reinstall 历史 PASS | 受控可用 |
| 方案库（Plan 复用层） | 无代码（`src/`、`web/`、`config/` 三条 grep 零命中） | 仅 `docs/plan-library-baseline.md:3`「草案，不含实现」 | 仅文档 |
| 业务 PASS / 真实准确率 | 设计上不提供（`config/llm/system-prompt.md:10`） | 怡升昌 REVIEW，accuracy null | 未实现 |

## 3. 一条贯穿链路：上海宁波深圳运价表.xlsx + 怡升昌说明

口径说明：仓库里没有名为「怡升昌说明.txt」的文件；说明以文本形式归档在 `contract/source-requirements.txt`（事实）。真实运行取 `run-1793666364570-579fa2de`（2026-11-03T00:39:24Z 起，本地 08:39:24，+08:00；`template` = FREIGHT_YISHENGCHANG_EXCEL_01）。

```text
上传副本 上海宁波深圳运价表.xlsx(33,471 字节) + 说明文本
  ↓ 会话受理：请求 ID 幂等，一次只处理一条消息
建运行：账本写 runs 行（owner+pid 单写者租约）
  ↓
盘点原件：坐标/样式/合并/隐藏/公式缓存 + 分页证据
  ↓
契约：工作解释（字段、航线拆分、备注合并、检查项）；人工确认后才是基线
  ↓
试抽：航线拆起运港/目的港，20GP/40GP/40HQ 卖价；负价保留、合法重复保留
  ↓
沙箱执行生成脚本 → 执行回执（actionId / scriptSha256 / inputSha256）
  ↓
后处理：价格与日期归一化、箱型补值、备注与有效期关系
  ↓
独立重读原文检查：覆盖数、字段坐标、后处理变异
  ↓ 第二轮 144 个差异（141 字段不符 + 3 航线未拆分）
带坐标反馈 → 新 attempt 修复（旧脚本、差异、回执全部保留）
  ↓ 模型预算停止自动修复
终态 REVIEW：业务批准 false、准确率 null、金额 null ← 真实输入停在这里
  ↓
人工复核 → 确认契约 / 回答问题 / 补说明 → 同说明哈希复用
```

| 步骤 | 落点 | 证据 |
|---|---|---|
| 上传副本 | `template_runs/<runId>/inputs/上海宁波深圳运价表.xlsx` | 原件只读，运行时用导入副本（`README.md:54`） |
| 说明文本 | `template_runs/<runId>/contract/source-requirements.txt` 与 `working-interpretation.json` | 真实 run 的 contract 目录 |
| 运行登记 | `template_runs/closure.sqlite` 的 `runs(id,state,owner,pid)` | `src/closure/ledger.ts:38-40` |
| 盘点 | `outputs/source_inventory.json`、`outputs/source_regions.json` | `src/closure/runtime.ts:313-390` |
| 契约 | `contract/working-interpretation.json`；确认后 `template_runs/contracts/<sha256>/contract.json` + `approval.json` | `src/closure/contract.ts:297-345` |
| 脚本与计划 | `outputs/attempt-002/{plan.json,parser.py}` | `src/closure/runtime.ts:391-500` |
| 执行 | `outputs/attempt-00N/raw_result.json`、`execution-receipt-<actionId>-<retry>.json`；账本动作 STARTED→COMPLETED | `src/closure/execute.ts:107`、`runtime.ts:595-613` |
| 后处理 | `outputs/attempt-00N/final_result.json`（+ `result.xlsx`） | `runtime.ts:650-701`、`spreadsheet.ts:44` |
| 独立检查 | `validation/attempt-00N/{report.json,comparison.json,script-diff.json}` | `src/closure/validation.ts:27-314` |
| 终态 | 账本 `phase=TERMINAL`、`decision=REVIEW`；`review_packet.json` | `controller.ts:189-203`；真实 run 的 reason 为「Model budget stopped automatic repair; 144 independently located issues retained for business review」 |

失败与 REVIEW 时怎么走：

- 沙箱不可用：直接 `BLOCKED: verified OS sandbox unavailable`，不执行生成脚本（`execute.ts:113-119`）。本会话 25 条测试失败可归因于此（24 条 Worker exited 71；1 条 SIGKILL 形态同源）。
- 检查有差异：进入 `REPAIR_PENDING`，新 attempt 保留旧脚本与差异，不覆盖上一轮（`runtime.ts:440-475`）。
- 模型预算到限或连续两轮无进展：停止修复，终态 REVIEW，差异全部保留（真实 run 的 review_packet）。
- 说明未命中或要求变更冲突：在模型派发前 BLOCKED（`README.md:80`、`contract.ts:291-345`）。
- 本真实输入未产出 `result.xlsx`：该 run 的 outputs 只有 JSON 与脚本；最早带 `result.xlsx` 的运行是本地 14:16 启动的 `run-1793686570577-ae855166`，该文件实际写入 15:11:21（事实）。全库 1903 份 `result.xlsx` 的最早写入时间同为 15:11（事实）。21 个使用该运价表的运行均无 `result.xlsx`（事实）。原因是导出能力晚于该运行、后续为批量补写，具体机制未验证（推断）。

## 4. 当前约束

- live 预算按任务分开，两套预算任务同库并存（事实；`template_runs/live-budget.sqlite`）：

| 任务 | 额度 | 已用 / 剩余 | 明细 | 口径 |
|---|---|---|---|---|
| all-batches-2026-11-03 | 顶层 10 | 10/10，剩 0 | input 414,903/1,000,000，output 14,322/300,000，UNCERTAIN 0 | `README.md:66,82` 只对此任务成立 |
| visual-center-2026-11-03 | 1000 次计费调用 | 70/1000，剩 930 | 模型 COMPLETED 51 / UNCERTAIN 18 / STARTED 1 / REJECTED 12；顶层运行 33 | `README.md:21` 的独立任务授权；新增模型任务仍需另行明确授权 |

- 无版本历史：`git rev-list` 无 HEAD，全部文件未跟踪；`.gitignore` 排除 `template_runs/*` 与 `*.sqlite`，账本与证据不入库（事实）。
- 业务终态只能是 REVIEW：没有独立业务答案或人工批准；144 个差异保留；不报告真实准确率（事实，`docs/delivery-report.md:5,44`）。
- 单机单写者：每运行一把租约（owner+pid）；工作台单实例锁；每会话单活跃 job；不同会话可并发起运行，共用同一账本与预算，无队列/限流（事实，`ledger.ts:58-77`、`store.ts:30-41`）。
- 当前环境沙箱不可验证：25 条失败断言中 24 条 failureMessages 明写 `sandbox-exec: sandbox_apply: Operation not permitted`，第 25 条（C16 SIGKILL）断言 signal=null；沙箱探针 `sandbox-exec` exit 71、signal null 复现同形态；`src/` 与 `tests/` 自 11-03 16:49 全绿后无改动，故判为非代码回归（事实 + 推断）。
- 测试口径带时点：54 项（11-03 12:09 全绿）→ 66 项（11-03 14:41 全绿）→ 83 项（11-03 16:49 全绿）；当前 49 通过 / 25 失败 / 9 跳过；`verify:offline` 退出码 1，missingCases 21（事实，`template_runs/offline-1794556513402/vitest.json`）。
- 账本现状：3364 个运行（含本会话测试新增 64）/ 17,657 条动作；REVIEW 1639、BLOCKED 632、REPAIR_PENDING 385、INVENTORIED 357、PREPARE 260、ANSWERED 4；末次真实运行 2026-11-03T08:50:09Z；3363/3364 份 manifest 与账本一致，唯一差异 `run-1793695087609-f77aebec`（账本 revision 5 / 清单 4，status/phase/decision 相同）（事实）。

## 5. 缺口与下一步

- 方案库只有需求草案：Plan 对象模型、三条用户路径、9 条验收用例都是文字；待评审 3 问——绑定粒度（1:1 还是多说明哈希）、删除语义（物理删除还是仅停用）、历史运行显示哪个方案名（`docs/plan-library-baseline.md:90-94`）。
- 复用有两条入口：说明哈希强复用（已实现，换说明才需重新确认）；方案库便捷层（未实现）（`docs/contract-flow.md:41`、`plan-library-baseline.md:68`）。
- 可观测性与运维缺口：无 CI、无提交历史、账本不入库、无部署、无鉴权/多租户；网关金额 `pricing:"unknown"`、上游内部重试不可观测（事实）。
- 代码层半成品：状态机转移表只被测试引用，运行时代码直接赋值（`state.ts:3-21`）；`assertBudget` 无调用方（死代码）；`source_coverage` 检查分支为空占位（`contract-checks.ts:148-150`）；单文档硬编码（价格字段、LEGACY_SCAN、registry token 表、缺省 `yishengchang-v002`、仓外默认路径）。
- 证据卫生：测试运行与历史运行混放同一账本（本会话新增 64 条），未区分真实/仿真。本次 registry 套件的 beforeAll 因 sandbox-exec 失败被记为 failed，9 条用例因此标 skip（11-03 绿灯时 9 条全部通过）；模板版本管理证据链本轮未复算。
- 建议下一步（建议，非事实）：先修 `README.md:66,82` 的预算与测试口径；在允许 `sandbox-exec` 的 macOS 环境复跑 83 项；方案库 3 问评审后实现；把测试运行单独归档。

## 6. 证据索引

| 结论 | 证据（相对路径） |
|---|---|
| 初衷、设计取舍与否决路线 | `docs/design-synthesis.md:3,14-28`；`docs/design-crossjudge.md:22-34,103-110`；`docs/goal-all-batches.md:24,52,65,71`；`README.md:3,25-29` |
| 账本权威与状态模型 | `src/closure/ledger.ts:38-40,58-77`；`src/closure/controller.ts:93,189-203`；`src/closure/runtime.ts:281-676` |
| 预算预留 / 结算 / UNCERTAIN | `src/closure/live-budget.ts:76-110,146-204`；`config/policies/budget.yaml:3-12`；`docs/design-synthesis.md:20` |
| 账本即权威的自证 | `template_runs/closure.sqlite`；`template_runs/run-1793695087609-f77aebec/run_manifest.json`；`template_runs/visual-center-acceptance/budget-before.json`（SHA256 `0c5383…`） |
| 测试时点与当前结果 | `template_runs/offline-1794556513402/vitest.json`；`template_runs/offline-latest.json`；`template_runs/offline-1793695774794/vitest.json`（83 全绿历史） |
| 真实怡升昌链路 | `template_runs/run-1793666364570-579fa2de/{run_manifest.json,contract/,outputs/attempt-002/,validation/attempt-002/,review_packet.json}` |
| 预算两套任务 | `template_runs/live-budget.sqlite`；`README.md:21,66,82` |
| 方案库只有草案 | `docs/plan-library-baseline.md:3,7,68,90-94` |
| 支持边界 | `docs/delivery-report.md:62-66`；`README.md:68` |
| 汇总过程与核查方法 | `.tmp/team-brief/01-intent.md`；`.tmp/team-brief/02-current-state.md`；`.tmp/team-brief/03-evidence.md` |
