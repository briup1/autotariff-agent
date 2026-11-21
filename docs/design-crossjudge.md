# 架构候选交叉评审

日期：2026-11-02

评审对象：

- 候选 A：`/Users/ziyun/workdir/remote_project/autotariff-agent/docs/design-candidate-a.md`
- 候选 B：`/Users/ziyun/workdir/remote_project/autotariff-agent/docs/design-candidate-b.md`

评审目标是让第一批隔离原型跑通怡升昌样本的 `inspect -> prepare -> execute -> validate -> review`，并保留可恢复、可审计的边界。评分采用 1 至 5 分。5 分表示该设计已经明确、可落地且与第一批范围匹配。3 分表示原则正确但还需要补关键约束。1 分表示缺少该能力或会导致错误的业务结论。

## 评分

| 标准 | 候选 A | 候选 B | 评语 |
|---|---:|---:|---|
| 数据模型能表达状态和版本 | 5 | 5 | A 用带品牌的 ID、摘要、`RunPhase`、`TerminalDecision`、`Attempt` 和 `OracleBinding` 表达约束。B 用 `RunManifest.state.phase/outcome`、版本化解释和 `manifest_revision` 表达恢复指针。两者都满足，A 的 TypeScript 形状更接近当前项目。 |
| 副作用和恢复可幂等 | 5 | 4 | A 把 SQLite 的 `ActionLedger` 和预算预留作为权威事实源，定义原子产物写入、唯一幂等键、崩溃恢复和 `UNKNOWN`。B 的账本规则正确，但以追加日志和抽象事务边界描述为主，没有 A 的持久化唯一约束和单写者落点具体。 |
| 脚本执行有明确隔离边界 | 5 | 4 | A 明确子进程、只读输入、限定写目录、禁网、环境白名单、超时、资源限制、摘要和收据，并拒绝当前进程 `safe_exec`。B 明确子进程和读写根目录，但环境白名单、凭据排除和收据字段约束较少。 |
| Pi 只提出动作，宿主决定状态 | 5 | 5 | A 的网关校验范围、预算、动作收据和无 `finalize_pass` 很清楚。B 也明确 `submitTurn` 只产出行动提议，控制器拥有状态和副作用。 |
| 同一工作解释生成的预期不能触发业务 PASS | 5 | 5 | A 用 `OracleBinding` 和 `eligibleForPassGate: false` 固化限制。B 用 `derived_expectation_profile`、`AWAITING_HUMAN_REVIEW` 和独立校验门固化限制。 |
| 第一批范围足够小 | 5 | 5 | A 明确本地单运行控制器，不引入服务、队列或通用事件重放。B 明确控制器加一个 Pi，并把快照、账本和独立校验限定在第一批闭环。两者都能覆盖怡升昌样本而不扩展到多模板平台。 |
| **总分** | **30/30** | **28/30** | A 在落地细节和当前 TypeScript/SQLite 脚手架适配上更强。B 的状态语义和停止条件值得合并。 |

## 选定基础

选择候选 A 作为实现基础。

选择依据有三点。

1. A 的数据形状可以直接映射到当前项目的 TypeScript 和 SQLite 配置。它把摘要、产物归属、动作账本、预算预留和状态决策放在宿主边界内，后续实现不需要先补一个持久化事实源。
2. A 对隔离执行的约束最具体。它不仅要求子进程，还约束输入挂载、输出目录、网络、环境变量、超时、资源和收据，能直接支持“没有已验证隔离就返回 BLOCKED”。
3. A 已经覆盖完整闭环和人工复核终点。怡升昌样本在缺少独立业务预期时会停在 `AWAITING_HUMAN_REVIEW`，不会把自洽检查升级成 `PASS`。

这不是对候选 B 的否定。B 在状态命名、恢复指针、解释条款和停止条件上有更清楚的表达。下面的内容必须合并到 A，才能形成最终设计。

## 必须合并项

### 1. 合并 B 的阶段与终态分离方式

保留 A 的 `RunPhase` 与 `TerminalDecision` 两个字段，并加入 B 的显式清单修订号和提交规则。

建议最终形状包含：

- `phase` 表示当前工作阶段。
- `decision` 表示终态或人工复核状态。
- `manifestRevision` 作为 compare-and-swap 版本。
- 阶段产物先落盘并验证摘要，再原子更新清单指针。
- 外部显示可以使用 `REVIEW`，持久化状态使用 `AWAITING_HUMAN_REVIEW`，避免把校验报告状态和运行终态混淆。

第一批实现只允许 `inspect -> prepare -> execute -> validate -> review` 及恢复和新 Attempt 重试，不允许跳过阶段。

### 2. 合并 B 的 Attempt 细粒度状态和后处理引用

A 的 `AttemptPhase` 需要补足 B 的执行中状态和恢复状态。最终至少应区分：

`PREPARED`、`EXECUTING`、`EXECUTED`、`VALIDATING`、`VALIDATED`、`REPAIR_PENDING`、`ABANDONED`。

同时保留三个独立引用：

- `rawResultRef`
- `postProcessedResultRef`
- `finalResultRef`

这样可以在后处理失败时从原始结果恢复，不重新调用抽取，也可以单独审计后处理前后的变化。修复必须创建新的 `attempt_id`，不得直接编辑上一轮的最终结果。

### 3. 用 B 的 replay policy 替换 A 的布尔 replaySafe

A 的 `replaySafe: boolean` 不足以表达本地脚本、可确认的供应方幂等动作和不可自动重试的外部动作。应改成枚举：

- `local_replayable`
- `provider_idempotent`
- `never_auto_retry`

`UNCERTAIN` 动作不得自动重跑。恢复程序先检查收据、输出摘要和子进程证据。原始结果已经存在时，后处理从原始结果继续。无法判断外部动作是否完成时进入 `BLOCKED` 或 `REVIEW`，具体由动作类型和人工决策确定。

A 的 SQLite、唯一幂等键和单写者约束继续保留。B 的追加日志可以作为审计导出，不替换 SQLite 事实源。

### 4. 合并 B 的条款级 WorkingInterpretation

保留 A 的字段映射、规则和假设，同时加入 B 的条款级追踪字段：

- 稳定的 `clause_id`。
- 要求文件原文引用。
- 字段规则和跨字段关系规则。
- 未知项和歧义状态。
- 显式的 `derived_expectation_profile`。

这样校验报告可以回指具体条款，且不会把说明文件派生的预期误当作独立业务标准。解释派生预期的允许结果只能是自洽或复核，不能是业务 `PASS`。

### 5. 合并 B 的停止条件和独立覆盖约束

最终控制器必须采用以下停止规则：

- 没有可验证的隔离描述时直接返回 `BLOCKED`，禁止退回当前进程 `exec`。
- 外部动作处于 `UNCERTAIN` 且没有供应方幂等确认时停止自动重试。
- 校验器无法从原始工作簿建立覆盖证据时停止。
- 连续无进展、预算耗尽或解释仍未获确认时进入人工复核。
- 校验当前 Attempt 时只使用当前 Attempt 的结果和报告，不能复用上一轮报告作为新一轮结论。
- 覆盖数必须由独立扫描源区域计算，不能采信脚本自报行数。

## 不合并的内容

- 不把 B 的 JSONL 账本作为唯一事实源。当前项目已有 SQLite 持久化边界，A 的事务和唯一键更适合承载恢复与幂等。
- 不在第一批实现多 Agent 协同、分布式队列、通用事件重放或跨模板规则平台。两份候选都没有证明这些扩展是怡升昌闭环的必要条件。
- 不把诊断预期文件改名为独立预期文件。文件名变化不能改变证据来源和 `PASS` 资格。
- 不开放给 Pi 直接写文件、执行任意路径、传入原始 SQL 或提交最终状态。Pi 的输出仍然只能是结构化动作提议。

## 交叉评审结论

候选 A 是基础设计。候选 B 提供五类必须 graft 的约束，分别是清晰的阶段和终态提交语义、细粒度 Attempt 状态、动作重放策略、条款级解释追踪和明确停止条件。

合并后，第一批闭环的预期结果仍是怡升昌样本生成完整的审计和复核包。只有独立业务预期或人工批准的可执行规则存在，并且全部独立检查通过时，运行才可以进入业务 `PASS`。

## 验证记录

本评审已逐段读取候选 A 和候选 B 的设计文档，并检查当前项目的 `package.json` 与 `README.md`。当前项目是 TypeScript/Node 项目，已有 SQLite Pi Durable 存储入口；这支持将 A 的 SQLite 账本和强类型网关作为实现基础。

本文件只记录评审结论和合并要求。未修改候选文档或任何源码。

