# AutoTariff Agent 第一批隔离原型

## 候选 B：控制器优先的可恢复闭环

日期：2026-11-02

本文是独立项目 `autotariff-agent` 的第一批隔离原型设计。它只定义数据模型、模块边界、状态转换和执行门，不修改旧项目生产代码，也不声称怡升昌字段结果已经通过业务验收。

候选 B 把宿主控制器作为唯一的状态和副作用入口。Pi 负责提出下一步行动，工具网关负责把行动转换成受预算、版本、权限和幂等规则约束的命令。原始文件、工作解释、脚本、结果和校验报告都作为带摘要的不可变产物保存；清单只保存指针和状态。

这条路线适合第一批原型，因为它先解决重试污染、恢复、预算和脚本权限边界，再接入更复杂的 Agent 决策。

## 1. 设计选择和不变量

候选 B 应用四项已读取的 pstack 原则。

- **Model the Domain** 改变了数据形状。运行阶段使用显式状态机，轮次使用 `Attempt`，副作用使用 `ActionLedger`，不再用多个布尔值和散落的 `if` 表示生命周期。
- **Foundational Thinking** 改变了实施顺序。先固定 `WorkingInterpretation`、`RunManifest`、`Attempt` 和产物引用，再接入 Pi 和执行器。后续模块只消费这些类型。
- **Boundary Discipline** 改变了边界。外部文件、Pi 消息、预算配置和脚本执行能力在控制器边界校验；内部校验器只接收已经解析的领域对象，业务判断保持纯函数。
- **Make Operations Idempotent** 改变了动作协议。每个有副作用的动作先登记幂等键和预算预留，再执行并写收据。重复调用读取原收据；不确定的收费外部调用不会被自动重跑。

系统必须保持以下不变量。

1. 一个 `run_id` 只绑定一份输入摘要、一份要求版本、一份工作解释版本和一份预算策略版本。
2. 一个 `attempt_id` 只产生一套候选方案、原始结果、后处理结果和校验报告。新修复必须新建 `attempt_id`。
3. `ArtifactStore` 中的内容由摘要寻址。旧轮次产物不覆盖，清单只原子更新指针。
4. `ActionLedger` 是副作用是否已完成的事实来源。模型自述、脚本日志和临时文件不能替代动作收据。
5. 业务 `PASS` 需要独立于抽取解释的验证依据。由同一 `WorkingInterpretation` 派生的预期最多证明一致性，不能单独产生 `PASS`。
6. 生成脚本没有已验证的隔离描述时，控制器直接返回 `BLOCKED`，不调用当前进程 `exec`。

## 2. 最小领域数据模型

以下是第一批原型的最小数据形状。它们可以用 TypeScript 的判别联合或等价的运行时 Schema 实现；文档不要求现在写生产代码。

### 2.1 WorkingInterpretation v001

`WorkingInterpretation` 是本次任务对人工说明的可复现工作解释。它不是业务批准书，也不是独立答案。

```text
WorkingInterpretation {
  interpretation_id: "wi-FREIGHT_YISHENGCHANG_EXCEL_01-v001"
  template_name: "FREIGHT_YISHENGCHANG_EXCEL_01"
  version: "v001"
  source_refs: [
    { artifact_id, sha256, path, line_start, line_end }
  ]
  clauses: [
    {
      clause_id: "WI-01",
      requirement_text: "源文件航线一栏拆分起运港和目的港",
      normalized_rule: { field: "起运港/目的港", operation: "split_route" },
      ambiguity: "unresolved | bounded | none",
      status: "working"
    }
  ]
  field_rules: { ... }
  relation_rules: [ ... ]
  unknowns: [ ... ]
  derived_expectation_profile: {
    origin: "interpretation-derived",
    allowed_outcomes: ["CONSISTENT", "REVIEW"],
    cannot_grant: "PASS"
  }
  approval: "unconfirmed"
}
```

每一条规则保留说明文件原文引用。字段规则、跨字段关系和未知项都带稳定 `clause_id`，便于检查报告回指。`derived_expectation_profile` 是显式的污染标记，阻止控制器把同一解释生成的预期当成独立真值。

怡升昌 v001 只把 `怡升昌说明.txt` 的字段映射和日期要求固化为工作解释。`上海宁波深圳运价表_real_values.xlsx` 只作为输入变体，不自动升级为业务真值。

### 2.2 RunManifest

`RunManifest` 是一次运行的不可变身份和可恢复指针。

```text
RunManifest {
  run_id: string
  template_name: string
  input_refs: [{ artifact_id, sha256, original_path, media_type }]
  interpretation_ref: { artifact_id, sha256, version }
  contract_ref: { artifact_id, sha256, approval_status }
  budget_policy_ref: { artifact_id, sha256 }
  state: {
    phase: "INSPECT | PREPARE | EXECUTE | VALIDATE | REVIEW | TERMINAL"
    outcome: "ACTIVE | PASS | REVIEW | AWAITING_HUMAN_REVIEW | FAIL | BLOCKED"
  }
  current_attempt_id: string | null
  latest_artifacts: { source_inventory, plan, result, validation }
  budget_snapshot: BudgetSnapshot
  manifest_revision: number
  created_at: string
  updated_at: string
}
```

`RunManifest` 不内嵌大结果。每次阶段完成后先写产物，再以 compare-and-swap 方式增加 `manifest_revision`。恢复时只接受摘要匹配且状态已提交的阶段。

### 2.3 Attempt

`Attempt` 表示一次完整候选执行。它是重试和反馈的隔离单位。

```text
Attempt {
  attempt_id: string
  run_id: string
  parent_attempt_id: string | null
  route: "excel_script | converted_excel_script | direct_llm"
  plan_ref: ArtifactRef
  parser_ref: ArtifactRef | null
  execution_params_ref: ArtifactRef
  raw_result_ref: ArtifactRef | null
  post_processed_result_ref: ArtifactRef | null
  validation_report_ref: ArtifactRef | null
  feedback_refs: string[]
  state: "PREPARED | EXECUTING | EXECUTED | VALIDATING | VALIDATED | REPAIR_PENDING | ABANDONED"
  source_input_sha256: string
  created_at: string
}
```

`Attempt` 不允许直接写入最终业务接口。只有控制器在验证门通过后，才把结果引用提升为运行终态候选。

### 2.4 ArtifactRef 和 ArtifactStore

`ArtifactStore` 是内容寻址的只追加存储。每个文件先写入同目录临时文件，完成摘要后原子改名。

```text
ArtifactRef {
  artifact_id: string
  kind: "source | interpretation | inventory | plan | parser | raw_result |
         final_result | validation | feedback | ledger_receipt"
  sha256: string
  media_type: string
  size_bytes: number
  producer: { run_id, attempt_id, action_id }
  input_refs: string[]
  schema_version: string
  path: string
}
```

目录固定为项目根目录的 `template_runs/`。

```text
template_runs/<TEMPLATE_NAME>/
├── contract/
│   ├── requirements.v001.json
│   └── baseline.json
└── <RUN_ID>/
    ├── run_manifest.json
    ├── artifacts/<sha256>.<ext>
    ├── attempts/<ATTEMPT_ID>/
    │   ├── plan.json
    │   ├── parser.py
    │   ├── execution.json
    │   ├── raw_result.json
    │   ├── final_result.json
    │   └── feedback.json
    ├── inventory/
    ├── validation/<ATTEMPT_ID>/report.json
    └── action-ledger.jsonl
```

`parser.py` 在每轮完整保存。复制编辑只建立新 `ArtifactRef`，不覆盖参考脚本。`action-ledger.jsonl` 是审计索引；真正的大对象仍由 `ArtifactStore` 保存。

### 2.5 ActionLedger

`ActionLedger` 记录所有可能产生费用、文件、模型状态或外部副作用的动作。

```text
ActionLedgerEntry {
  action_id: string
  idempotency_key: string
  run_id: string
  attempt_id: string | null
  operation: "inspect | prepare | execute | post_process | validate | pi_turn"
  input_digest: string
  budget_reservation_id: string
  replay_policy: "local_replayable | provider_idempotent | never_auto_retry"
  state: "RESERVED | STARTED | COMPLETED | FAILED | UNCERTAIN"
  output_refs: string[]
  actual_usage: Usage | null
  error_class: string | null
  started_at: string
  finished_at: string | null
}
```

幂等键至少包含 `run_id + attempt_id + operation + input_digest + action_version`。控制器的处理规则如下。

- `COMPLETED` 且所有产物摘要匹配时，重复调用直接返回原收据。
- `STARTED` 但进程退出时，先检查产物和子进程证据。可重放的本地脚本动作可以重新执行；外部收费动作转为 `UNCERTAIN`。
- `UNCERTAIN` 不自动重复调用。它进入 `REVIEW` 或 `BLOCKED`，等待人工决定或供应方幂等确认。
- 原始抽取已完成而后处理未完成时，从 `raw_result` 恢复，不重新调用抽取。

## 3. 预算模型

预算不是内存中的计数器。它与动作登记同一事务边界持久化。

```text
Budget {
  max_agent_turns: 12
  max_attempts: 3
  max_tool_calls: 40
  max_external_actions: 12
  max_wall_time_seconds: 1200
  max_attempt_time_seconds: 360
  max_input_tokens: 100000
  max_output_tokens: 30000
  max_no_progress_attempts: 2
  max_same_action_retries: 1
}

BudgetSnapshot {
  reserved: Usage
  actual: Usage
  remaining: Usage
  last_reservation_id: string | null
}
```

每次 Pi 回合、工具调用、脚本执行和模型续写都先预留预算。适配器收到截止时间和取消信号。模型包装器内部重试必须回写到同一 `pi_turn` 预算记录，不得形成隐藏的第二重循环。预算不足时控制器停止在 `REVIEW`；依赖或隔离缺失时停止在 `BLOCKED`。

## 4. 状态机和控制器

阶段和终态分开存储，避免把 `REVIEW` 同时当作运行阶段和失败原因。

```text
INSPECT
  └─ inventory written ───────────────▶ PREPARE
                                         │
                                         ├─ plan/parser written ─▶ EXECUTE
                                         │                           │
                                         │                           ├─ raw + post result ─▶ VALIDATE
                                         │                           │                         │
                                         │                           │                         ├─ independent checks pass ─▶ TERMINAL/PASS
                                         │                           │                         ├─ unresolved ambiguity ─────▶ REVIEW
                                         │                           │                         ├─ repairable issues ────────▶ REVIEW
                                         │                           │                         └─ missing dependency ───────▶ BLOCKED
                                         │
REVIEW ── new feedback + budget ────────▶ PREPARE(new attempt)
REVIEW ── no progress / budget end ─────▶ TERMINAL/REVIEW
```

控制器只允许以下转换。

| 当前阶段 | 动作 | 前置条件 | 成功后的状态 |
|---|---|---|---|
| `INSPECT` | `inspect_source` | 输入摘要和解释版本已固定 | `PREPARE` |
| `PREPARE` | `prepare_attempt` | 源目录可读，参考脚本只读 | `EXECUTE` |
| `EXECUTE` | `execute_attempt` | 脚本和隔离描述通过门禁 | `VALIDATE` |
| `VALIDATE` | `validate_attempt` | 原始结果和后处理结果存在 | `TERMINAL`、`REVIEW` 或 `BLOCKED` |
| `REVIEW` | `prepare_attempt` | 新 `attempt_id`、反馈和剩余预算存在 | `EXECUTE` |
| 任一活动阶段 | `resume` | 最后动作和产物可判定 | 原阶段或明确终态 |

控制器拒绝以下行为。

- 直接修改 `final_result.json` 作为修复。
- 用上一轮报告检查新一轮结果。
- 把 Agent 的“通过”文本当成校验结果。
- 在没有预算预留时调用 Pi、脚本或转换服务。
- 在没有 `IsolationDescriptor` 时执行生成脚本。

## 5. Pi 工具网关

Pi Durable 只负责持久化对话和回合。业务状态、预算和副作用由控制器拥有。Pi 的系统上下文只接收当前 `RunManifest` 摘要、最新 `Attempt` 摘要、验证反馈和可按需读取的产物引用，不把全文件塞入上下文。

### 5.1 网关接口

```text
PiGateway.submitTurn({
  run_id,
  expected_manifest_revision,
  context_refs,
  user_goal,
  budget_reservation_id
}) -> {
  turn_id,
  proposed_actions: ToolCommand[],
  assistant_text_ref,
  usage
}

ToolGateway.invoke(command: ToolCommand) -> ToolReceipt
```

`submitTurn` 只产生结构化行动提议。`ToolGateway` 逐项检查 `run_id`、状态、版本、预算、允许路径和动作幂等键，再调用控制器。Pi 不持有写文件句柄，也不能跳过校验器直接发布结果。

### 5.2 第一批工具

| 工具 | 作用 | 写入产物 |
|---|---|---|
| `inspect_source` | 全量读取 Sheet、区域、隐藏事实、样式事实和坐标 | `source_inventory` |
| `read_artifact` | 按引用读取完整或分页证据 | 无 |
| `prepare_attempt` | 新建、复制或局部编辑本轮 `parser.py` 和计划 | `plan`、`parser` |
| `execute_attempt` | 受限子进程运行脚本并执行完整后处理 | `raw_result`、`final_result` |
| `validate_attempt` | 独立执行程序、覆盖、关系和语义检查 | `validation_report` |
| `compare_attempts` | 比较修好、新增、退化和未解决项 | `feedback` |

工具没有隐式下一步。每次调用只完成一个动作并返回收据。是否继续、修复或停止由控制器根据状态机和预算判断。

## 6. 受限脚本执行

候选脚本执行器暴露一个窄接口，不把 Python `exec` 暴露给 Agent。

```text
IsolationDescriptor {
  provider: "sandboxed_subprocess"
  verified_at: string
  read_roots: ["<run>/inputs"]
  write_roots: ["<run>/attempts/<attempt_id>"]
  network: "disabled"
  timeout_seconds: 360
  memory_bytes: number | null
  cpu_seconds: number | null
  allowed_command: string
}

ParserExecutionRequest {
  parser_ref: ArtifactRef
  input_refs: ArtifactRef[]
  attempt_id: string
  isolation: IsolationDescriptor
  deadline: string
}
```

执行前检查脚本摘要、输入摘要、读写根目录、网络状态和超时。输入文件以只读方式挂载；输出只能写当前 `attempt_id` 目录。标准输出、标准错误、退出码、资源使用和子进程摘要都写入动作收据。

`trusted_existing_only` 可以作为旧已确认脚本的兼容适配器，但不能执行新生成脚本。第一批原型若无法验证子进程隔离，必须返回 `BLOCKED`，不能退回当前进程 `safe_exec`。

## 7. 独立校验和 PASS 边界

校验器读取以下事实。

1. 原始输入和完整 `source_inventory`，包括隐藏 Sheet、隐藏行列、样式事实和读取告警。
2. 当前 `Attempt` 的计划、脚本、原始结果、后处理结果和动作收据。
3. 当前模板已确认的 `contract` 或其缺失状态。
4. 可选的独立业务预期。它不能由本次 `WorkingInterpretation` 自动生成后伪装成独立真值。

校验分三层。

- **程序检查**。检查必需字段、类型、价格与箱型关系、日期格式、来源映射、重复源身份和后处理前后变化。
- **源覆盖检查**。由校验器独立扫描源区域，判断每个区域是记录、表头、上下文、规则允许的排除或待确认。它不采信脚本自报的行数。
- **语义复核**。只读取冲突区域、备注作用范围和本轮修改影响范围。未知项影响结果时报告 `REVIEW`。

结果状态语义如下。

```text
PASS                 = 已确认独立业务标准 + 全部必需检查通过
REVIEW               = 有候选结果，但存在未决解释、预算停止或可人工复核问题
AWAITING_HUMAN_REVIEW= 工作解释一致，但没有独立业务真值或人工确认
FAIL                 = 已确认标准被违反，且当前候选不可接受
BLOCKED              = 输入、依赖、权限或隔离能力缺失
```

由 `WorkingInterpretation v001` 派生的预期只能生成 `CONSISTENT` 或 `REVIEW`。即使每条规则与输出一致，也只能结束为 `AWAITING_HUMAN_REVIEW`。这条限制直接阻断“解释自己生成答案，再用答案证明自己正确”的闭环。

## 8. 怡升昌样本的闭环路径

旧项目提供了可复用的试点事实。

- 原文件为 `data/20260811-识别文件/怡升昌/上海宁波深圳运价表.xlsx`。
- 说明为 `data/20260811-识别文件/怡升昌/怡升昌说明.txt`。
- 模板名为 `FREIGHT_YISHENGCHANG_EXCEL_01`。
- 旧确认方案 `solutions_confirmed/上海宁波深圳运价表/solution.json` 将 `上海`、`宁波`、`深圳` 三个 Sheet 各定义为一个 `main_fare` block，并共用 `blocks/extract_yishengchang.py`。
- 旧模板字段含起运港、目的港、中转港、航程、航线代码、ETD、有效期、20GP、40GP、40HQ 和单条报价备注。模板配置还固定了空行、空列阈值和 ETD 有效期约束。

第一批原型按以下步骤运行。

```text
原始 xlsx + 怡升昌说明.txt
        │
        ▼
inspect_source
  读取全部 Sheet 和原始坐标，记录隐藏事实、样式事实、合并单元格、表头和候选区域
  固化 WorkingInterpretation v001 和 source_inventory.json
        │
        ▼
prepare_attempt(attempt-001)
  固定 route=excel_script
  参考旧确认脚本，复制到本轮 parser.py
  保存上海、宁波、深圳的区域计划和字段映射
        │
        ▼
execute_attempt(attempt-001)
  受限子进程只读输入，写入 attempt-001
  先产生 raw_result，再运行完整后处理并写 final_result
        │
        ▼
validate_attempt(attempt-001)
  独立检查三张 Sheet 的源覆盖、记录身份、日期和箱型关系
  对照后处理前后差异，不接受脚本自报覆盖
        │
        ├─ 若只是解释未确认或没有独立真值
        │       └─ AWAITING_HUMAN_REVIEW
        │
        ├─ 若报告指出可定位的漏港、错价或后处理变更
        │       ▼
        │  compare_attempts → feedback.json
        │       ▼
        │  prepare_attempt(attempt-002, parent=attempt-001)
        │       ▼
        │  复制并最小编辑 parser.py，整文件重跑，再全量校验
        │
        └─ 若预算耗尽、动作不确定或隔离能力缺失
                └─ REVIEW 或 BLOCKED
```

这条路径承接了旧项目已经验证的脚本事实。旧测试证明确认方案应直接执行，缺少方案时不能沿用旧状态，且重复相同源行不能被去重。候选 B 将这些约束放到 `Attempt`、`ActionLedger` 和独立校验边界中，而不是继续依赖 LangGraph 的可变累加状态。

本流程可以证明闭环能走通，但不能凭说明文件或同一解释生成的预期证明业务准确率。直到补齐独立业务预期和确认状态，最终状态仍应为 `AWAITING_HUMAN_REVIEW` 或 `REVIEW`。

## 9. 旧项目边界的适配关系

候选 B 只把旧项目能力包成适配器，不把旧图状态直接搬入新控制器。

- `src/nodes/processors.py::execute_script` 当前同时执行脚本、校验空结果、保存方案并选择重试路径。新 `execute_attempt`、`validate_attempt` 和控制器分别拥有这些职责。
- `src/utils/python_excute_env.py::safe_exec` 是当前进程内执行。它不能作为生成脚本的正式隔离边界。
- `src/models/state.py` 通过累加列表承载结果。新项目按 `attempt_id` 保存完整快照，不把重试结果追加到上一轮。
- `src/utils/parser_script_guard.py` 的输入、脚本和空结果保护可以作为执行适配器的低层检查，但独立校验仍需从源目录重新计算覆盖。
- `src/app/standalone/reflection/validation_processor.py` 会直接应用模型修正。新网关只保存反馈，修复必须编辑新轮次脚本后重新执行。

## 10. 第一批原型的停止条件

以下条件任一成立，候选 B 不继续自动修复。

- `WorkingInterpretation` 或要求文件摘要不匹配。
- 生成脚本没有可验证的隔离描述。
- 外部动作处于 `UNCERTAIN`，且供应方没有可确认的幂等键。
- 校验器无法从原始文件建立源覆盖证据。
- 连续两轮未减少未解决问题，或新结果使已通过记录退化。
- 预算耗尽，或者完整结果只能依赖本轮解释生成的预期。

这些情况分别进入 `BLOCKED`、`REVIEW` 或 `AWAITING_HUMAN_REVIEW`。控制器不会把“有文件、有结果”升级成业务通过。

## 11. 设计取舍

候选 B 选择快照加动作账本，而不是第一批就采用纯事件重放。快照让 Agent 可以直接读取某一轮的脚本、结果和报告；动作账本补上收费调用、崩溃恢复和幂等判断。两者的职责不同，不互相替代。

候选 B 选择一个控制器配一个 Pi，而不是多个业务 Agent 互相决定状态。第一批需要证明工具协议、独立校验和恢复语义；增加 Agent 数量不会自动提高业务正确性。

候选 B 允许脚本在运行中生成和复制编辑，因为本次目标明确要求这一能力，但把脚本执行放在受限子进程中，并把业务 `PASS` 留给独立校验。这样既保留纠错能力，也不把模型生成的代码当作权限边界。

## 12. 只读证据

候选 B 依据以下旧项目文件设计，未修改这些文件。

- `docs/需求/Agent抽取闭环需求.md`
- `docs/方案设计/Agent抽取闭环设计.md`
- `docs/方案设计/Agent抽取闭环技术设计.md`
- `src/config/filename_patterns.json`
- `solutions_confirmed/上海宁波深圳运价表/solution.json`
- `solutions_confirmed/上海宁波深圳运价表/blocks/extract_yishengchang.py`
- `test/test_yishengchang_template.py`
- `tests/unit/test_iterate_blocks_solution_state.py`
- `src/nodes/processors.py`
- `src/utils/parser_script_guard.py`
- `src/utils/python_excute_env.py`
- `data/20260811-识别文件/怡升昌/怡升昌说明.txt`

这些文件证明旧模板的字段、Sheet、共享脚本、日期关系和当前执行边界。它们不构成第一批原型的独立业务答案。
