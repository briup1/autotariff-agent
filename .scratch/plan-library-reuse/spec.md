Status: ready-for-agent
Labels: ready-for-agent

# 方案库：可管理方案与规则版本复用

## Problem Statement

当前 autotariff-agent 已能围绕文件、会话、运行和抽取契约完成观察、试抽、独立检查、修复轮次和结果导出。已确认的规则可以按说明摘要复用。

这仍不能满足日常使用：同一供应商下周再次发送新运价表时，用户必须依赖说明摘要或文件摘要命中契约，无法从一个可见的方案库中选择“怡升昌周报”并明确知道将使用哪一个规则版本。用户也无法稳定回答自己配置过哪些供应商、方案当前是否可用、某次运行为什么沿用了这套规则。

目标用户流程是：首次确认规则后保存为方案；后续上传同供应商新表时选择方案；运行记录绑定方案和不可变规则版本；异常时进入人工复核或生成新版本，旧运行继续可追溯。

## Solution

增加方案复用层，使已确认的抽取契约成为用户可管理的 `Plan` 资产。

用户可以查看方案库、创建方案、改名、停用和选择方案。上传新文件时，用户可以明确选择已确认且未停用的方案；系统在运行前展示供应商、单证类型和规则版本。运行记录保存 `planId`、`contractVersion`、运行时方案名称快照和结果结论。

现有按说明摘要的强确定复用继续保留，作为方案复用之外的入口。无说明时按方案匹配：唯一高置信候选可以预选但必须显式提示；多个候选必须由用户选择；无候选继续走首次观察、候选契约和人工确认流程。

规则发生实质变化时产生新的不可变规则版本。复用后独立检查发现异常时，运行标记为 `REVIEW`，提示可能发生版式变化，不自动升级方案状态或宣称业务正确。

## User Stories

1. As a freight operator, I want to save a confirmed extraction contract as a named plan, so that I can reuse it next time.
2. As a freight operator, I want to see all plans in a plan library, so that I know which suppliers and document types are configured.
3. As a freight operator, I want each plan to show status, last use, and last result, so that I can judge whether it is available.
4. As a freight operator, I want to rename a plan, so that the display name matches my working language without changing its rule identity.
5. As a freight operator, I want to upload a new file and choose an existing plan, so that I do not repeat the same extraction explanation.
6. As a freight operator, I want the selected supplier, document type, and rule version shown before running, so that I can catch a wrong choice.
7. As a freight operator, I want each run to record the selected plan and exact rule version, so that I can explain how the result was produced.
8. As a freight operator, I want an inactive plan excluded from future candidates, so that an obsolete rule is not reused accidentally.
9. As a freight operator, I want historical runs to remain readable after a plan is renamed or deactivated, so that audit evidence is not lost.
10. As a freight operator, I want a rule change to create a new immutable version, so that old runs continue to point to the rules they used.
11. As a freight operator, I want multiple matching plans presented for selection, so that the system never silently chooses the wrong plan.
12. As a freight operator, I want a high-confidence single match visibly preselected, so that reuse is fast but still explicit.
13. As a freight operator, I want an unconfirmed result excluded from automatic reuse, so that an observation is not treated as an approved rule.
14. As a freight operator, I want a reused run with independent-check findings marked `REVIEW`, so that layout changes are handled by a person.
15. As a freight operator, I want an empty plan library to show a creation path, so that the first setup is understandable.
16. As a freight operator, I want the existing requirements-digest reuse to continue working, so that this feature does not break the current strong-match path.

## Implementation Decisions

- `Plan` is the user-visible reuse unit. It has `planId`, workspace scope, user-facing name, normalized supplier key, normalized document-type key, status, current version ID, created/updated timestamps, and derived `lastUsedAt` and `lastResult` fields.
- `PlanVersion` has `planVersionId`, `planId`, immutable `contractVersion`, `requirementsDigest`, `contractSha256`, source-signature reference, approval timestamp, and creation timestamp. It points to an immutable contract artifact; it never overwrites another version.
- `RunBinding` has `planId`, `planVersionId`, `contractVersion`, `requirementsDigest`, and an immutable `planNameSnapshot`. It is written to the closure ledger and is optional for legacy runs.
- The closure ledger is authoritative for RunBinding and run state. The web conversation store keeps request/job idempotency and a binding receipt. New contract artifacts use a versioned PlanVersion location; the existing requirements-digest location remains readable for legacy contracts and strong lookup.
- A plan version binds to exactly one confirmed contract version. This keeps rule ownership unambiguous. A future multi-source plan is outside this spec.
- A plan version is immutable. A substantive rule change appends a new PlanVersion under the same `planId`; it never rewrites the version used by an old run.
- The initial status set is `candidate`, `confirmed`, and `inactive`. Only `confirmed` and non-inactive plans are eligible for reuse.
- “Delete” is implemented as deactivation for this first version. Historical runs and their snapshots remain queryable.
- Renaming changes display metadata only. It does not change `planId`, `contractVersion`, extracted data, or historical decisions.
- Run records store only the immutable `planNameSnapshot`; current names are projected by looking up `planId`. Historical views therefore show the snapshot and may also show the current name.
- The plan library is scoped to the current local workspace. Authentication and multi-tenant ownership are outside this spec.
- The existing requirements-digest reuse remains a separate strong-match path. Selecting a plan is an explicit user choice and must not silently fall back to another plan or version.
- Normalization version `norm-v1` applies Unicode NFKC, case-folding, trim, and internal whitespace collapse; punctuation is preserved. A normalized duplicate name within a workspace is rejected.
- `sourceSignature-v1` is the SHA-256 of canonical JSON containing normalized document type, ordered sheet names, normalized header labels, and structural region identifiers; prices, row values, and timestamps are excluded.
- After contract approval, the archive form pre-fills `name`, `supplier`, and `docType` from known source data; the trimmed name is required, normalized duplicate names within a workspace are rejected, and repeated submission with the same request ID returns the original Plan.
- Candidate matching uses exact normalized `supplier + docType + sourceSignature-v1`. A unique match may be visibly preselected; multiple matches require a user choice; no fuzzy threshold or “most recently used” automatic decision exists.
- The upload flow gains a plan-selection state. The run request carries `planId` and `planVersionId` through the existing execution path.
- The web store reserves the request/job, the closure ledger commits RunBinding with a unique request ID, and the web store records a binding receipt. On restart, ADMITTED/RUNNING jobs reconcile by request ID: an existing ledger binding is returned; an unbound job is admitted once; no second run is created.
- A stale selection returns a typed conflict (`PLAN_VERSION_STALE`); duplicate request IDs return the original run. Binding success updates `lastUsedAt`; the latest terminal run decision updates `lastResult`. Running, interrupted, and rejected attempts do not replace `lastResult`.
- Inactive plans can be explicitly restored to `confirmed`; restoration never changes historical versions.
- A substantive rule change does not auto-create a version. A person must explicitly click “创建新版本”, confirm the new contract, and then the system appends a new PlanVersion under the same Plan.
- Independent checks remain the source of run findings. A clean check does not become business approval, and an exception does not automatically update a plan.
- The implementation must preserve existing run evidence, contract evidence, request idempotency, single-writer protection, and failure handling.

## Testing Decisions

- Tests assert observable behavior through the plan library, upload selection, run details, persistence boundary, and existing requirements-digest reuse path. They must not assert private helper structure.
- Add coverage for plan creation from a confirmed contract, archive-field validation, normalized duplicate names, idempotent retry, list fields and empty state, rename identity stability, explicit plan selection, exact candidate matching, inactive filtering, immutable version creation, historical traceability, restoration, and deactivation behavior.
- Add negative coverage for candidate plans, inactive plans, source-signature mismatch, multiple candidates, stale version selections, duplicate request IDs, cancelled archive/rename/deactivate actions, missing or corrupt contract artifacts, and unconfirmed results.
- Keep the existing contract, durable-run, web, registry, and sandbox tests as regression coverage. Add the smallest new fixtures needed for plans, versions, and historical runs.
- The manual acceptance baseline is AC-1 through AC-9 from the plan-library requirements. The minimum implementation gate is AC-1, AC-2, AC-3, AC-7, and AC-9; AC-4, AC-5, AC-6, and AC-8 remain required before broader rollout.
- Tests must record evidence that the same run binds one `planId`, `planVersionId`, `contractVersion`, `requirementsDigest`, and `planNameSnapshot` from selection through persistence, restart, and result display.
- Cross-store tests must cover reserve → ledger commit → receipt, restart reconciliation after each boundary, duplicate request IDs, and a failed binding that leaves no phantom run.
- No test may treat a script existing, a model response existing, or a zero-error engineering report as business approval.

## Out of Scope

- Persisting extracted tariffs into a business database.
- Price search, quote analysis, or downstream tariff query APIs.
- Cloud deployment, multi-user authentication, and tenant permissions.
- Completely silent automatic extraction on first use.
- Physical deletion of historical evidence.
- A general approval workflow for business accuracy.
- Arbitrary OCR, unsupported document semantics, or a promise of universal supplier-format coverage.

## Further Notes

- The current code has the contract and run evidence foundations but no implemented plan object or plan-library UI. This spec is an additive reuse layer over those foundations.
- The repository currently has uncommitted business changes. Implementers must inspect and preserve them; they must not reset or overwrite unrelated work.
- Existing source-of-truth documents are `docs/plan-library-baseline.md`, `docs/project-brief.md`, `docs/acceptance-matrix.md`, and the current implementation evidence.
- Current business correctness remains human-reviewed. This feature improves reuse and traceability; it does not turn engineering checks into business PASS.
