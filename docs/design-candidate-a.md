# Design candidate A for the first isolated prototype

Date: 2026-11-02

This candidate defines the smallest host-owned loop for the independent `autotariff-agent` project. It covers `WorkingInterpretation v001`, `RunManifest`, `Attempt`, `ArtifactStore`, `ActionLedger`, budgets, the run state machine, the Pi tool gateway, and restricted script execution.

The prototype is a local, single-run controller. It writes only under the new project's `template_runs/` directory. It reads the legacy `autotariffextract` repository through an explicit fixture import or read-only reference step. It does not import the legacy Python package, its LangGraph state, its virtual environment, or its writable solution directories.

## Decision

Use one host process as the authority for business state. Store ledger rows in SQLite and store immutable run artifacts as files. Treat each attempt as a complete snapshot. Let Pi propose actions through a typed gateway. Let the host reserve budget, create action records, validate artifact ownership, execute the state transition, and decide whether the run enters review.

```text
fixture import
  -> WorkingInterpretation v001 and ContractBundle
  -> inspect_source
  -> prepare attempt-001
  -> execute attempt-001 in a restricted subprocess
  -> validate attempt-001 with independent program checks
  -> review packet
  -> AWAITING_HUMAN_REVIEW
```

The first prototype ends in review for the Yi Sheng Chang sample. It may prove that the loop is durable and that the output is internally checkable. It cannot claim business `PASS` when its expected records came from the same working interpretation that guided extraction.

## What the first prototype owns

The new project owns these facts.

- The run identifier, input digest, template name, contract digest, interpretation digest, budget, state, and final decision.
- The immutable source inventory and every attempt's plan, parser, execution receipt, raw result, final result, and validation report.
- The action lifecycle and budget reservations.
- The script isolation descriptor and the child-process receipt.
- The review packet and the reason that automatic business `PASS` is unavailable.

The legacy repository remains a read-only evidence source. The confirmed Yi Sheng Chang solution at `/Users/ziyun/workdir/remote_project/autotariffextract/solutions_confirmed/上海宁波深圳运价表/solution.json` and its parser at `/Users/ziyun/workdir/remote_project/autotariffextract/solutions_confirmed/上海宁波深圳运价表/blocks/extract_yishengchang.py` are reference inputs. The new run copies a reference into its own artifact store before editing or executing it.

The current new-project scaffold confirms this boundary. `/Users/ziyun/workdir/remote_project/autotariff-agent/README.md` says that source inventory, business validation, parser execution, and final `PASS` are not implemented. The only existing durable test is a scripted Pi turn in `/Users/ziyun/workdir/remote_project/autotariff-agent/tests/pi-durable.test.ts`.

## Minimal data model

The model separates a lifecycle phase from a terminal decision. This prevents a phase such as `VALIDATED` from being mistaken for business approval.

```ts
type Digest = string & { readonly __brand: "sha256" };
type RunId = string & { readonly __brand: "run" };
type AttemptId = string & { readonly __brand: "attempt" };
type ActionId = string & { readonly __brand: "action" };
type ArtifactId = string & { readonly __brand: "artifact" };

type RunPhase =
  | "PREPARE"
  | "INVENTORIED"
  | "ATTEMPT_READY"
  | "RUNNING"
  | "VALIDATED"
  | "REPAIR_PENDING";

type TerminalDecision =
  | "NONE"
  | "PASS"
  | "FAIL"
  | "BLOCKED"
  | "AWAITING_HUMAN_REVIEW";
```

### `WorkingInterpretationV001`

`WorkingInterpretationV001` is a versioned interpretation of the source note and the requested output fields. It is a working specification for the prototype. It is not an independent oracle.

```ts
type WorkingInterpretationV001 = {
  interpretationId: "yi-sheng-chang-v001";
  sourceNote: ArtifactRef;
  sourceNoteDigest: Digest;
  templateName: "FREIGHT_YISHENGCHANG_EXCEL_01";
  version: "v001";
  defaultYear: number;
  fieldMap: {
    origin: "航线 origin";
    destination: "航线 destination";
    price20gp: "20'GP | 20GP";
    price40gp: "40GP";
    price40hq: "40'HQ | 40HC";
    lss: "LSS";
    transit: "中转港";
    voyage: "航程";
    remark: "备注";
    etd: "预计开船日期 | 开船日期 | 有效日期";
    routeCode: "航线代码";
  };
  rules: {
    splitRoute: "dash-or-equals-then-slash-fallback";
    expandDestinationSlash: true;
    preserveNegativePrice: true;
    validityStart: "runtime-today";
    validityEnd: "selected-etd";
    historicalEtds: "keep";
  };
  assumptions: Array<{
    id: string;
    statement: string;
    evidence: ArtifactRef[];
    needsHumanConfirmation: boolean;
  }>;
  digest: Digest;
};
```

The content above follows the read-only note at `/Users/ziyun/workdir/remote_project/autotariffextract/data/20260811-识别文件/怡升昌/怡升昌说明.txt`. The note says to split `航线` into origin and destination, map container headers to standard fields, preserve `LSS`, transit, voyage, remarks, route code, and derive validity start and end from today and ETD. The interpretation records those rules as data so later components do not repeat ad hoc conditionals.

The interpretation may generate a diagnostic expected fixture for the prototype. That fixture must carry this marker.

```ts
type ExpectedFixture = {
  artifact: ArtifactRef;
  derivedFrom: "working-interpretation-v001";
  evidenceScope: "self-consistency-only";
  eligibleForPassGate: false;
};
```

A future independent expected file must be created outside the extraction run, have a separate digest, and be marked `independent_expected`. A human-approved executable rule set may also be a pass basis. A fixture derived from `WorkingInterpretationV001` never becomes either one by renaming the file.

### `ArtifactRef` and `RunManifest`

```ts
type ArtifactKind =
  | "source_workbook"
  | "source_note"
  | "source_inventory"
  | "working_interpretation"
  | "contract_bundle"
  | "plan"
  | "parser"
  | "raw_result"
  | "final_result"
  | "execution_receipt"
  | "validation_report"
  | "review_packet"
  | "stdout"
  | "stderr";

type ArtifactRef = {
  artifactId: ArtifactId;
  runId: RunId;
  attemptId?: AttemptId;
  kind: ArtifactKind;
  relativePath: string;
  mediaType: string;
  digest: Digest;
  bytes: number;
  createdAt: string;
};

type OracleBinding =
  | { mode: "none" }
  | { mode: "working_interpretation_fixture"; fixture: ArtifactRef }
  | { mode: "independent_expected"; expected: ArtifactRef; approvedBy: string }
  | { mode: "executable_rules"; contract: ArtifactRef; approvedBy: string };

type RunManifest = {
  runId: RunId;
  templateName: string;
  input: ArtifactRef;
  contract: ArtifactRef;
  interpretation: ArtifactRef;
  oracle: OracleBinding;
  phase: RunPhase;
  decision: TerminalDecision;
  currentAttemptId?: AttemptId;
  budget: BudgetSnapshot;
  lastActionId?: ActionId;
  createdAt: string;
  updatedAt: string;
};
```

`RunManifest` is a materialized JSON view. SQLite rows are authoritative for state, actions, and reservations. The host updates the manifest only after the referenced artifacts pass digest and ownership checks.

### `Attempt`

An attempt is a full candidate run from fixed inputs. It never appends rows to a prior attempt.

```ts
type AttemptRoute = "excel_script" | "direct_llm" | "converted_excel_script";
type AttemptPhase = "PREPARED" | "EXECUTED" | "VALIDATED";

type Attempt = {
  attemptId: AttemptId;
  runId: RunId;
  parentAttemptId?: AttemptId;
  inputDigest: Digest;
  interpretationDigest: Digest;
  route: AttemptRoute;
  phase: AttemptPhase;
  plan: ArtifactRef;
  parser?: ArtifactRef;
  rawResult?: ArtifactRef;
  finalResult?: ArtifactRef;
  executionReceipt?: ArtifactRef;
  validationReport?: ArtifactRef;
  changedFromParent?: ArtifactRef;
  createdAt: string;
};
```

The host rejects an attempt whose parent belongs to another run, whose input digest differs from the manifest, or whose validation report points to a different result digest. `attempt-002` references `attempt-001` for comparison, but does not overwrite it.

### Validation and review records

```ts
type ValidationStatus = "PASS" | "REVIEW" | "FAIL" | "BLOCKED";

type ValidationReport = {
  attemptId: AttemptId;
  resultDigest: Digest;
  status: ValidationStatus;
  coverage: {
    sheetsSeen: string[];
    sourceCellsClassified: number;
    sourceCellsPending: number;
    outputRecords: number;
  };
  checks: Array<{
    checkId: string;
    kind: "structure" | "relationship" | "coverage" | "independent_expected";
    status: "pass" | "fail" | "not_run" | "not_eligible";
    evidence: ArtifactRef[];
  }>;
  issues: Issue[];
  evidenceScope: "independent" | "self-consistency" | "mixed";
};

type Issue = {
  code: string;
  stage: "inventory" | "prepare" | "execute" | "postprocess" | "validate";
  severity: "blocking" | "review" | "info";
  sourceCoordinates: string[];
  resultRecordIds: string[];
  actual?: unknown;
  expected?: unknown;
  expectedSource: "independent_expected" | "executable_rules" | "working_interpretation_fixture" | "none";
  nextCheck: string;
};

type ReviewPacket = {
  runId: RunId;
  latestAttemptId: AttemptId;
  report: ArtifactRef;
  unresolvedIssues: Issue[];
  budget: BudgetSnapshot;
  passBlockedBy: "missing_independent_oracle" | "unresolved_issue" | "budget" | "dependency";
  humanDecisionRequired: true;
};
```

The validator may report that all self-consistency checks pass. The host still writes `AWAITING_HUMAN_REVIEW` when the only expected fixture was derived from the working interpretation.

## ArtifactStore

`ArtifactStore` owns path safety, content digests, atomic writes, and immutable references. Agents and workers never submit arbitrary paths to the host.

```ts
interface ArtifactStore {
  put(input: {
    runId: RunId;
    attemptId?: AttemptId;
    kind: ArtifactKind;
    mediaType: string;
    bytes: Uint8Array;
    idempotencyKey: string;
  }): Promise<ArtifactRef>;

  read(ref: ArtifactRef, view?: { maxBytes?: number }): Promise<{
    ref: ArtifactRef;
    bytes: Uint8Array;
    truncated: boolean;
  }>;

  verify(ref: ArtifactRef, scope: "run" | "attempt"): Promise<void>;
  list(runId: RunId, attemptId?: AttemptId): Promise<ArtifactRef[]>;
}
```

The first implementation uses a run root such as:

```text
template_runs/FREIGHT_YISHENGCHANG_EXCEL_01/<run-id>/
├── source/
├── contract/
├── attempts/attempt-001/
├── validation/
├── review/
└── run_manifest.json
```

The store rejects absolute paths, `..` traversal, symlinks, paths outside the run root, and references from another run. It writes to a temporary file, fsyncs the file, and renames it into place. A repeated `put` with the same run, kind, digest, and idempotency key returns the original `ArtifactRef`.

The source workbook and source note are imported into `source/` before `inspect_source`. This gives the independent project a stable input root and prevents the child process from reading arbitrary files in the legacy repository.

## ActionLedger

An action is the smallest host-tracked operation that can consume budget, call a process or model, or leave a durable artifact. The ledger records intent before execution.

```ts
type ActionName = "inspect_source" | "prepare_attempt" | "execute_attempt" | "validate_attempt" | "create_review";
type ActionState = "RESERVED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED";

type ActionRecord = {
  actionId: ActionId;
  runId: RunId;
  attemptId?: AttemptId;
  name: ActionName;
  state: ActionState;
  idempotencyKey: string;
  inputDigest: Digest;
  replaySafe: boolean;
  budgetReservationId: string;
  outputArtifacts: ArtifactRef[];
  errorCode?: string;
  startedAt?: string;
  finishedAt?: string;
};

interface ActionLedger {
  reserve(input: {
    runId: RunId;
    attemptId?: AttemptId;
    name: ActionName;
    idempotencyKey: string;
    inputDigest: Digest;
    replaySafe: boolean;
    budget: BudgetRequest;
  }): Promise<ActionRecord>;

  start(actionId: ActionId): Promise<ActionRecord>;
  succeed(actionId: ActionId, outputs: ArtifactRef[], usage: Usage): Promise<ActionRecord>;
  fail(actionId: ActionId, errorCode: string, usage?: Usage): Promise<ActionRecord>;
  markUnknown(actionId: ActionId, reason: string): Promise<ActionRecord>;
  findByIdempotencyKey(runId: RunId, key: string): Promise<ActionRecord | undefined>;
}
```

`reserve` and the budget reservation commit in one SQLite transaction. A crash after reservation leaves `RESERVED` or `RUNNING`; recovery inspects output artifacts and the child-process receipt before deciding whether to complete, retry, or mark the action `UNKNOWN`.

A completed idempotent action returns its existing output. An unknown external call is not replayed unless the provider and action are marked replay-safe. The first prototype treats script execution as replay-safe only when no receipt and no output exist. A process that may have run but whose receipt is missing becomes `BLOCKED` until a human resolves it.

## Budget model

Budget counters are host-owned and monotonic. Pi cannot increase them.

```ts
type BudgetLimits = {
  maxAgentTurns: number;
  maxAttempts: number;
  maxToolCalls: number;
  maxExternalActions: number;
  maxWallTimeSeconds: number;
  maxAttemptTimeSeconds: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxNoProgressAttempts: number;
  maxSameActionRetries: number;
};

type BudgetSnapshot = {
  limits: BudgetLimits;
  used: {
    agentTurns: number;
    attempts: number;
    toolCalls: number;
    externalActions: number;
    wallTimeSeconds: number;
    inputTokens: number;
    outputTokens: number;
  };
  reserved: {
    externalActions: number;
    inputTokens: number;
    outputTokens: number;
  };
  lastReservationId?: string;
};
```

The first Yi Sheng Chang run uses the values already present in `/Users/ziyun/workdir/remote_project/autotariff-agent/config/policies/budget.yaml`. Those values are development defaults, not business acceptance thresholds. The host stops with these results.

| Limit reached | Host decision |
| --- | --- |
| Agent turns, attempts, or tool calls | `AWAITING_HUMAN_REVIEW` |
| Wall time or missing execution dependency | `BLOCKED` |
| External action with uncertain completion | `BLOCKED` |
| No progress for the configured count | `AWAITING_HUMAN_REVIEW` |

The host writes used values, limits, last action, and unresolved issues into the review packet. Budget exhaustion never becomes `PASS`.

## State machine

The controller owns the only state transition function. Pi has no state mutation API.

```text
PREPARE
  -> INVENTORIED                 after inspect_source succeeds
  -> BLOCKED                     if input, contract, or budget is invalid

INVENTORIED
  -> ATTEMPT_READY               after prepare_attempt succeeds
  -> BLOCKED

ATTEMPT_READY
  -> RUNNING                     after execute reservation starts
  -> REPAIR_PENDING              only through a new attempt
  -> BLOCKED

RUNNING
  -> VALIDATED                   after execute and result persistence succeed
  -> BLOCKED                     on isolation or dependency failure

VALIDATED
  -> REPAIR_PENDING              when an issue is repairable and budget remains
  -> AWAITING_HUMAN_REVIEW       when interpretation, evidence, or budget needs a human
  -> FAIL                        when a confirmed rule fails and no acceptable candidate remains
  -> PASS                        only with an eligible independent oracle or separately approved executable rules

REPAIR_PENDING
  -> ATTEMPT_READY               after the host creates a new attempt
```

`REVIEW` is the external display label for `AWAITING_HUMAN_REVIEW`. The durable state keeps the longer name so it cannot be confused with a validation report whose status is `REVIEW`.

The controller rejects skipped transitions. It also rejects a validation report for an older attempt, a result whose digest changed after validation, and a repair that edits a final JSON file without creating a new attempt.

## Pi tool gateway

Pi receives a small tool set. The gateway converts untrusted JSON into typed requests, checks the run and attempt scope, reserves the action, and calls the controller. The gateway never exposes filesystem paths or lets Pi write a report.

```ts
type ToolName = "inspect_source" | "prepare_attempt" | "execute_attempt" | "validate_attempt" | "review_run";

type ToolRequest = {
  commandId: string;
  runId: RunId;
  contractDigest: Digest;
  tool: ToolName;
  arguments: unknown;
};

type ToolResult = {
  commandId: string;
  ok: boolean;
  actionId?: ActionId;
  artifacts: ArtifactRef[];
  next: "continue" | "repair" | "review" | "blocked" | "stop";
  error?: {
    code: string;
    retryable: boolean;
    detail: string;
  };
};

interface PiToolGateway {
  handle(request: ToolRequest): Promise<ToolResult>;
}
```

The gateway validates the command id, run id, contract digest, attempt parent, artifact references, and budget before the controller runs. It returns bounded report summaries. Pi can call `read_artifact` later if the first prototype adds that read-only tool, but it cannot pass a path, a raw SQL statement, or a final status.

The gateway does not provide `finalize_pass`. The host creates `PASS` only after the validation report and the oracle gate pass. For the Yi Sheng Chang prototype, `review_run` creates the review packet and stops the agent.

## Restricted script execution

The legacy `safe_exec` implementation at `/Users/ziyun/workdir/remote_project/autotariffextract/src/utils/python_excute_env.py` executes code inside the current Python process. The first isolated prototype must not use it for generated parser code.

Use a child process with an explicit isolation descriptor.

```ts
type IsolationDescriptor = {
  provider: "sandboxed_subprocess";
  readRoots: string[];
  writeRoot: string;
  network: "disabled";
  timeoutSeconds: number;
  memoryBytes?: number;
  cpuSeconds?: number;
  environmentKeys: string[];
  descriptorDigest: Digest;
};

type ScriptExecutionRequest = {
  actionId: ActionId;
  parser: ArtifactRef;
  inputRoot: ArtifactRef;
  outputRoot: string;
  isolation: IsolationDescriptor;
};

type ScriptExecutionReceipt = {
  actionId: ActionId;
  status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "KILLED";
  exitCode?: number;
  stdout: ArtifactRef;
  stderr: ArtifactRef;
  rawResult?: ArtifactRef;
  isolation: IsolationDescriptor;
  startedAt: string;
  finishedAt: string;
};
```

The child process receives a copied input root mounted read-only. It can write only to the current attempt's output directory. Network access is disabled. The environment is an allowlist without model keys. The host sets a hard timeout and records the exact descriptor in the receipt.

The parser worker uses a dedicated Python environment with the libraries needed by the fixture. It does not import `autotariffextract`. The host injects the current input path, file name, sheet name, and range into a run-bound parser artifact before execution. A parser that attempts to open a path outside `readRoots`, write outside `writeRoot`, or create a network connection is rejected or killed and becomes `BLOCKED`.

## Yi Sheng Chang walk-through

The sample is `/Users/ziyun/workdir/remote_project/autotariffextract/data/20260811-识别文件/怡升昌/上海宁波深圳运价表.xlsx`. Its note is `/Users/ziyun/workdir/remote_project/autotariffextract/data/20260811-识别文件/怡升昌/怡升昌说明.txt`.

1. The fixture importer copies the workbook and note into the new run's `source/` directory and records SHA-256 digests. The `_real_values.xlsx` file remains a comparison input, not a business oracle.
2. The host creates `WorkingInterpretation v001` from the note, binds the template name `FREIGHT_YISHENGCHANG_EXCEL_01`, and records the assumptions about route splitting, container price aliases, ETD selection, and validity dates.
3. `inspect_source` scans the copied workbook before any filtering. It writes a source inventory with sheet names, coordinates, values, hidden and merged facts, style facts, and unsupported facts. The read-only confirmed solution declares sheets `上海`, `宁波`, and `深圳` with one main-fare block each. It declares ranges `1..168 x 9`, `1..76 x 11`, and `1..31 x 11`, respectively. Those declarations are references for the plan, not proof that the new inventory is complete.
4. `prepare_attempt` creates `attempt-001`. It stores the extraction plan, a copy of the legacy parser as a reference artifact, and a run-bound parser artifact. The legacy file is not edited in place. The attempt records the chosen route as `excel_script` and binds the input and interpretation digests.
5. `execute_attempt` reserves an action and budget, starts the restricted subprocess, and captures the parser's raw JSON, stdout, stderr, and isolation receipt. A repeated call with the same input digest and idempotency key returns the existing receipt.
6. `validate_attempt` reads the source inventory and the attempt artifacts. It checks record shape, required fields, route expansion, price sign preservation, ETD formatting, validity dates, source-coordinate mappings, duplicate identity, and post-processing changes. It calculates coverage from the inventory rather than trusting a parser-reported row count.
7. The validator may compare the output with a diagnostic fixture generated from `WorkingInterpretation v001`. That comparison is marked `self-consistency-only` and `eligibleForPassGate: false`. It can identify a likely missing destination or a changed amount for human review. It cannot prove business correctness.
8. `review_run` writes a review packet with the latest report, artifacts, budget usage, unresolved assumptions, and the explicit blocker `missing_independent_oracle`. The host transitions the run to `AWAITING_HUMAN_REVIEW`, displayed as `REVIEW`, and stops Pi.

The flow therefore reaches the requested `inspect -> prepare -> execute -> validate -> review` chain while preserving every attempt and every action. A later human can attach an independently prepared expected file or approve a separately versioned executable contract, then start a new run with a new contract digest. The prior review packet remains unchanged.

## Artifact and ledger layout

```text
template_runs/
├── ledger.sqlite
└── FREIGHT_YISHENGCHANG_EXCEL_01/<run-id>/
    ├── source/
    │   ├── source_workbook.xlsx
    │   └── source_note.txt
    ├── contract/
    │   ├── working-interpretation-v001.json
    │   └── contract-bundle.json
    ├── attempts/
    │   └── attempt-001/
    │       ├── plan.json
    │       ├── parser.py
    │       ├── raw_result.json
    │       ├── final_result.json
    │       ├── execution_receipt.json
    │       ├── stdout.txt
    │       └── stderr.txt
    ├── validation/
    │   └── attempt-001/report.json
    ├── review/
    │   └── review-packet.json
    └── run_manifest.json
```

SQLite tables are limited to `runs`, `attempts`, `artifacts`, `actions`, `budget_reservations`, and `reviews`. Each table has a stable primary key and a unique idempotency key where retries are possible. A single host writer owns one run at a time. Separate runs use separate run roots and can be processed concurrently without sharing mutable attempt files.

## Why this is the smallest useful cut

This design does not add a generic event-sourcing layer, a distributed queue, a service API, or a cross-template rule engine. The ledger is enough to recover intent and usage. The artifact tree is enough to inspect every candidate without replaying a model session. The state machine is enough to prevent stale reports and accidental pass decisions. The gateway is enough to keep Pi outside the business boundary.

The structure follows four principles.

- **Model the domain.** Separate `RunPhase`, `TerminalDecision`, `Attempt`, and `ActionRecord` encode lifecycle rules that would otherwise become flags spread across Pi and the host.
- **Foundational thinking.** Define digested artifact references and host-owned ledgers before adding model calls. Every later worker receives a stable input shape.
- **Boundary discipline.** Validate JSON, paths, digests, contract versions, and isolation descriptors at the gateway and worker boundary. Internal controller functions receive typed records and do not re-parse transport data.
- **Make operations idempotent.** Artifact writes, action reservations, execution receipts, and manifest updates use idempotency keys and atomic commits. A retry returns an existing result when the same work already completed and stops when the prior external action is uncertain.

## What this document does not claim

This is a design candidate. It does not prove the parser output, the workbook's full cell inventory, the child-process restrictions, or business correctness. Those require the first prototype implementation and scenario tests in the new project.

The prototype's successful outcome is a durable review packet for the Yi Sheng Chang sample. The outcome is not a business `PASS` derived from an expected file generated by `WorkingInterpretation v001`.

## Read-only evidence index

- `/Users/ziyun/workdir/remote_project/autotariff-agent/README.md` records the current scaffold and its missing business capabilities.
- `/Users/ziyun/workdir/remote_project/autotariff-agent/src/config.ts` and `/Users/ziyun/workdir/remote_project/autotariff-agent/src/index.ts` show the current Pi Durable bootstrap and configuration boundary.
- `/Users/ziyun/workdir/remote_project/autotariff-agent/tests/pi-durable.test.ts` shows the existing faux-model durable smoke test.
- `/Users/ziyun/workdir/remote_project/autotariffextract/docs/方案设计/Agent抽取闭环技术设计.md` defines the legacy project's proposed run, attempt, artifact, ledger, budget, and independent-validation constraints.
- `/Users/ziyun/workdir/remote_project/autotariffextract/docs/方案设计/Pi Durable LLM运行契约模板.md` defines the legacy project's tool and terminal-state contract.
- `/Users/ziyun/workdir/remote_project/autotariffextract/data/20260811-识别文件/怡升昌/怡升昌说明.txt` supplies the working field interpretation.
- `/Users/ziyun/workdir/remote_project/autotariffextract/solutions_confirmed/上海宁波深圳运价表/solution.json` supplies the read-only confirmed sheet and block declarations.
- `/Users/ziyun/workdir/remote_project/autotariffextract/solutions_confirmed/上海宁波深圳运价表/blocks/extract_yishengchang.py` supplies the read-only parser reference.
- `/Users/ziyun/workdir/remote_project/autotariffextract/src/utils/python_excute_env.py` shows why current-process `exec` is not the isolation boundary for generated code.
