import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../closure/artifacts.js";
import { previewWorkbook } from "../closure/spreadsheet.js";
import { PYTHON, runsRootFor } from "../closure/paths.js";
import { VISUAL_TASK_ID, VISUAL_TASK_POLICY } from "../closure/live-budget.js";
import type { LedgerAction } from "../closure/ledger.js";
import type { ArtifactRef, RunManifest, ValidationReport } from "../closure/models.js";
import type { ArtifactContent, BudgetView, RunDetail, RunSummary, TestEvidence } from "./types.js";
import { ConversationStore, WebError, safeError } from "./store.js";
import type { RunBinding } from "../closure/plan-types.js";

const PUBLIC_KINDS = new Set([
  "source", "working-interpretation", "requirements", "baseline-parser", "contract-conflict",
  "source-inventory", "source-regions", "document-evidence", "source-conversion", "conversion-map", "conversion-check", "conversion-report", "conversion", "model-direct-response",
  "plan", "parser", "raw-result", "final-result", "result-xlsx", "validation-report", "script-diff", "reference-parser",
  "contract", "contract-candidate", "contract-self-check", "answer",
  "execution-receipt", "failure", "execution-failure", "review", "previous-result", "previous-report", "previous-parser", "conversation-context",
]);
const TEXT_LIMIT = 256 * 1024;

export class RunProjection {
  readonly artifacts: ArtifactStore;
  readonly history = new Map<string, string>();
  private readonly evidence = new Map<string, { view: TestEvidence; path: string }>();
  constructor(readonly root: string, readonly conversations: ConversationStore) { this.artifacts = new ArtifactStore(root); }

  private readDatabase<T>(name: string, fn: (db: DatabaseSync) => T, fallback: T): T {
    const path = resolve(runsRootFor(this.root), name);
    if (!existsSync(path)) return fallback;
    const db = new DatabaseSync(path, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  }
  async initialize(): Promise<void> {
    const labels: Record<string, string> = { repair: "真实修复 · Excel", reuse: "真实复用 · Excel", pdf: "真实运行 · PDF", word: "真实运行 · Word", image: "真实运行 · 图片", switch: "真实路线切换" };
    const path = resolve(runsRootFor(this.root), "live-acceptance.json");
    if (existsSync(path)) {
      const entries = JSON.parse(await readFile(path, "utf8")) as Record<string, { runId: string }>;
      for (const [key, value] of Object.entries(entries)) if (labels[key] && /^[\w-]+$/.test(value.runId)) this.history.set(value.runId, labels[key]);
    }
    const verification = resolve(runsRootFor(this.root), "live-acceptance/verification.json");
    if (existsSync(verification)) {
      const value = JSON.parse(await readFile(verification, "utf8"));
      if (typeof value.realInput?.runId === "string") this.history.set(value.realInput.runId, "怡升昌 · 真实修复与复核");
    }
    await this.refreshEvidence();
  }
  private allowedRun(runId: string): boolean {
    return this.history.has(runId) || this.conversations.jobs().some((job) => job.runId === runId);
  }
  manifest(runId: string): RunManifest {
    if (!/^[\w-]+$/.test(runId) || !this.allowedRun(runId)) throw new WebError(404, "运行不存在或未登记到工作台。");
    const row = this.readDatabase("closure.sqlite", (db) => db.prepare("SELECT state FROM runs WHERE id=?").get(runId) as { state: string } | undefined, undefined);
    if (!row) throw new WebError(404, "运行尚未产生可读取的账本。");
    return JSON.parse(row.state) as RunManifest;
  }
  actions(runId: string): LedgerAction[] {
    return this.readDatabase("closure.sqlite", (db) => (db.prepare("SELECT data FROM actions WHERE run=? ORDER BY rowid").all(runId) as { data: string }[]).map((row) => JSON.parse(row.data)), []);
  }
  refs(manifest: RunManifest): ArtifactRef[] {
    const attempts = Object.values(manifest.attemptStates ?? {}).flatMap((attempt) => [attempt.plan, attempt.parser, attempt.rawResult, attempt.finalResult, attempt.resultXlsx, attempt.validation, attempt.failure, attempt.executionReceipt]);
    return [...new Map([...Object.values(manifest.refs ?? {}), manifest.interpretationRef, ...attempts]
      .filter((ref): ref is ArtifactRef => !!ref && PUBLIC_KINDS.has(ref.kind) && !ref.relativePath.startsWith("model/") && ref.artifactId.startsWith(`${manifest.runId}:`))
      .map((ref) => [ref.relativePath, ref])).values()];
  }
  async json<T>(ref: ArtifactRef): Promise<T> { return JSON.parse((await this.artifacts.read(ref)).toString()) as T; }
  async summary(runId: string): Promise<RunSummary> {
    const manifest = this.manifest(runId), job = this.conversations.jobs().find((entry) => entry.runId === runId);
    const result: RunSummary = {
      runId, label: this.history.get(runId) ?? basename(manifest.sourcePath), origin: job ? "live" : "history",
      phase: job?.state === "INTERRUPTED" ? "INTERRUPTED" : manifest.phase ?? manifest.status,
      decision: job?.state === "INTERRUPTED" ? "BLOCKED" : manifest.decision ?? "NONE",
      active: !!job && ["ADMITTED", "RUNNING"].includes(job.state), createdAt: manifest.usage.startedAt,
      sourceName: basename(manifest.sourcePath), attemptCount: manifest.attempts.length,
      ...(manifest.binding?.contractStatus ? { contractStatus: manifest.binding.contractStatus as "missing" | "candidate" | "confirmed" } : {}),
      ...(manifest.binding?.contractVersion ? { contractVersion: String(manifest.binding.contractVersion) } : {}),
      ...(manifest.binding?.requirementsDigest ? { requirementsDigest: String(manifest.binding.requirementsDigest) } : {}),
      ...(manifest.binding?.contractDigest ? { contractDigest: String(manifest.binding.contractDigest) } : {}),
      ...(manifest.binding?.contractSha256 ? { contractSha256: String(manifest.binding.contractSha256) } : {}),
      ...(job?.parentRunId ? { parentRunId: job.parentRunId } : {}), ...(job ? { conversationId: job.conversationId } : {}),
      ...(job?.error ? { error: job.error } : {}),
      ...(manifest.binding?.lastModelFailure
        ? { stopReason: safeError(manifest.binding.lastModelFailure) }
        : manifest.binding?.stopReason
          ? { stopReason: safeError(manifest.binding.stopReason) }
          : {}),
    };
    const binding = this.readDatabase("closure.sqlite", db => db.prepare("SELECT data FROM run_bindings WHERE run_id=?").get(runId) as {data:string}|undefined,undefined);
    if (binding) {
      const identity = JSON.parse(binding.data) as RunBinding;
      Object.assign(result,identity);
      result.reuseCheckStatus = "pending";
      result.businessApproval = false;
      const current = this.readDatabase("closure.sqlite",db=>db.prepare("SELECT data FROM plans WHERE id=?").get(identity.planId) as {data:string}|undefined,undefined);
      if (current) result.planCurrentName = (JSON.parse(current.data) as {name:string}).name;
    }
    const attempt = manifest.currentAttemptId ? manifest.attemptStates?.[manifest.currentAttemptId] : undefined;
    if (attempt?.validation) {
      try {
        const report = await this.json<ValidationReport>(attempt.validation);
        result.issueCount = report.issues.length;
        if (binding) result.reuseCheckStatus = report.status === "BLOCKED" && manifest.decision !== "REVIEW" ? "unavailable" : report.issues.length ? "findings" : "clean";
        if (report.uncheckedRules?.length) result.uncheckedRules = report.uncheckedRules;
      }
      catch {
        result.error = "检查报告缺失或摘要校验失败。";
        if (binding) result.reuseCheckStatus = "unavailable";
      }
    } else if (binding && (attempt?.status === "VALIDATED" || manifest.phase === "TERMINAL")) {
      result.reuseCheckStatus = "unavailable";
      result.error = "检查报告未登记，无法确认检查问题。";
    }
    if (attempt?.finalResult) {
      try { result.recordCount = (await this.json<unknown[]>(attempt.finalResult)).length; }
      catch { result.error = "结果产物缺失或摘要校验失败。"; }
    }
    return result;
  }
  async historyViews(): Promise<RunSummary[]> {
    const values: RunSummary[] = [];
    for (const id of this.history.keys()) {
      try { values.push(await this.summary(id)); }
      catch (error) {
        values.push({ runId: id, label: this.history.get(id)!, origin: "history", phase: "UNAVAILABLE", decision: "BLOCKED", active: false, createdAt: "", sourceName: "", attemptCount: 0, error: safeError(error) });
      }
    }
    return values;
  }
  // 只读投影登记产物的实际可用性，不补造或修复历史结果。
  async detail(runId: string, selected?: string, offset = 0, limit = 50): Promise<RunDetail> {
    const manifest = this.manifest(runId), attemptId = selected ?? manifest.currentAttemptId ?? undefined;
    const publicRefs = this.refs(manifest);
    // 与下载接口使用同一公开引用，避免暴露私有或被同路径引用覆盖的产物。
    const isPublic = (ref: ArtifactRef) => publicRefs.some((entry) => entry.relativePath === ref.relativePath && entry.artifactId === ref.artifactId && entry.sha256 === ref.sha256 && entry.kind === ref.kind);
    if (selected && !manifest.attempts.includes(selected)) throw new WebError(404, "该运行没有此轮次。");
    const attempt = attemptId ? manifest.attemptStates?.[attemptId] : undefined;
    const attempts: RunDetail["attempts"] = [];
    let issues: RunDetail["issues"] = [], records: Record<string, unknown>[] = [], artifactError: string | undefined;
    let recordStatus: RunDetail["records"]["status"] = attempt?.finalResult ? "error" : "pending";
    for (const entry of Object.values(manifest.attemptStates ?? {})) {
      const reportMissing = !entry.validation && (entry.status === "VALIDATED" || (manifest.binding?.planId && manifest.phase === "TERMINAL"));
      const view: RunDetail["attempts"][number] = { id: entry.attemptId, parentAttemptId: entry.parentAttemptId, status: entry.status, route: entry.route, reportStatus: entry.validation || reportMissing ? "error" : "pending", xlsxStatus: entry.resultXlsx ? "error" : "missing" };
      if (reportMissing) artifactError = "检查报告未登记，无法确认检查问题。";
      if (entry.resultXlsx && isPublic(entry.resultXlsx) && await this.artifacts.exists(entry.resultXlsx)) {
        view.xlsxStatus = "available";
        view.xlsxPath = entry.resultXlsx.relativePath;
      }
      try {
        if (entry.validation) {
          const report = await this.json<ValidationReport>(entry.validation);
          view.issueCount = report.issues.length; view.validationStatus = report.status; view.reportStatus = "available";
          if (entry.attemptId === attemptId) issues = report.issues;
        }
      } catch { artifactError = "检查报告缺失或摘要校验失败，请查看产物列表。"; }
      try {
        if (entry.finalResult) {
          const rows = await this.json<Record<string, unknown>[]>(entry.finalResult);
          if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("最终结果不是记录数组。");
          if (isPublic(entry.finalResult)) view.finalResultPath = entry.finalResult.relativePath;
          view.recordCount = rows.length;
          if (entry.attemptId === attemptId) { records = rows; recordStatus = "available"; }
        }
      } catch { artifactError = "部分已登记产物缺失或摘要校验失败，请查看产物列表。"; }
      attempts.push(view);
    }
    const actions = this.actions(runId), usage = { ...manifest.usage };
    for (const key of ["agentTurns", "attempts", "toolCalls", "externalActions", "inputTokens", "outputTokens"] as const)
      usage[key] = actions.reduce((sum, action) => sum + (action.actual?.[key] ?? action.reserved[key] ?? 0), 0);
    const run = await this.summary(runId);
    if (artifactError) run.error = artifactError;
    return {
      run, actions: actions.map((action) => ({ id: action.id, operation: action.operation, status: action.status, startedAt: action.startedAt, finishedAt: action.finishedAt, ...(action.error ? { error: safeError(action.error) } : {}) })),
      attempts, selectedAttemptId: attempt?.attemptId,
      records: { status: recordStatus, items: records.slice(offset, offset + limit), total: records.length, offset, limit }, issues,
      artifacts: this.refs(manifest).filter((ref) => !/attempt-\d+/.test(ref.relativePath) || !attemptId || ref.relativePath.includes(`${attemptId}/`)).map((ref) => ({ path: ref.relativePath, label: basename(ref.relativePath), kind: ref.kind, bytes: ref.bytes })),
      usage,
      ...(manifest.binding?.lastModelFailure
        ? { stopReason: safeError(manifest.binding.lastModelFailure) }
        : manifest.binding?.stopReason
          ? { stopReason: safeError(manifest.binding.stopReason) }
          : {}),
      ...(manifest.binding?.lastModelFailure ? { modelFailure: safeError(manifest.binding.lastModelFailure) } : {}),
    };
  }
  async artifact(runId: string, path: string): Promise<{ ref: ArtifactRef; bytes: Buffer }> {
    const manifest = this.manifest(runId), ref = this.refs(manifest).find((entry) => entry.relativePath === path);
    if (!ref) throw new WebError(404, "该产物未登记或不可公开读取。");
    try { return { ref, bytes: await this.artifacts.read(ref) }; }
    catch { throw new WebError(409, "产物缺失或摘要校验失败。"); }
  }
  async content(runId: string, path: string): Promise<ArtifactContent> {
    const { ref, bytes } = await this.artifact(runId, path);
    if (/\.xlsx$/i.test(path)) {
      const preview = await previewWorkbook(PYTHON, this.artifacts.path(runId, path));
      return { path, content: "", kind: ref.kind, bytes: bytes.length, truncated: preview.sheets.some((sheet) => sheet.truncated), sheets: preview.sheets };
    }
    const binary = /\.(docx|png|jpe?g|pdf)$/i.test(path);
    return { path, content: binary ? "这是原始二进制文件，请使用下载查看。" : bytes.subarray(0, TEXT_LIMIT).toString("utf8"), kind: ref.kind, bytes: bytes.length, truncated: !binary && bytes.length > TEXT_LIMIT };
  }
  budget(): BudgetView {
    const actions = this.readDatabase("live-budget.sqlite", (db) => (db.prepare("SELECT data FROM actions WHERE run=?").all(VISUAL_TASK_ID) as { data: string }[]).map((row) => JSON.parse(row.data) as LedgerAction), []);
    const models = actions.filter((action) => action.operation === "model_request");
    const usedCalls = models.reduce((sum, action) => sum + (action.actual?.agentTurns ?? 0), 0);
    const reservedCalls = models.reduce((sum, action) => sum + (action.actual ? 0 : action.reserved.agentTurns ?? 0), 0);
    return { taskId: VISUAL_TASK_ID, maxCalls: VISUAL_TASK_POLICY.maxAgentTurns, usedCalls, reservedCalls, remainingCalls: Math.max(0, VISUAL_TASK_POLICY.maxAgentTurns - usedCalls - reservedCalls), uncertainCalls: models.filter((action) => action.status === "UNCERTAIN").length, inputTokens: models.reduce((sum, action) => sum + (action.actual?.inputTokens ?? 0), 0), outputTokens: models.reduce((sum, action) => sum + (action.actual?.outputTokens ?? 0), 0), amount: null };
  }
  async refreshEvidence(): Promise<TestEvidence[]> {
    this.evidence.clear();
    const root = runsRootFor(this.root);
    const folders = existsSync(root) ? (await readdir(root)).filter((name) => /^offline-\d+$/.test(name)).sort().reverse() : [];
    const newest = folders.find((name) => existsSync(resolve(root, name, "vitest.json")));
    await this.registerEvidence("offline-tests", "工程测试 · 离线 Vitest", "offline", resolve(root, newest ?? "offline-missing", "vitest.json"));
    await this.registerEvidence("live-verification", "工程验收 · 历史真实调用", "live", resolve(root, "live-acceptance/verification.json"));
    await this.registerEvidence("pilot-verification", "规则复核 · 离线证据", "offline", resolve(root, "live-acceptance/current-pilot.json"));
    return [...this.evidence.values()].map((entry) => entry.view);
  }
  private async registerEvidence(id: string, label: string, origin: TestEvidence["origin"], path: string): Promise<void> {
    const view: TestEvidence = { id, label, origin, createdAt: "", status: "MISSING" };
    if (existsSync(path)) {
      const data = JSON.parse(await readFile(path, "utf8"));
      view.createdAt = (await stat(path)).mtime.toISOString();
      view.path = path.slice(this.root.length + 1);
      view.status = data.success === true || data.status === "PASS" ? "PASS" : "FAIL";
      if (typeof data.numTotalTests === "number") Object.assign(view, { total: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests, skipped: data.numPendingTests });
    }
    this.evidence.set(id, { view, path });
  }
  async test(id: string): Promise<{ evidence: TestEvidence; content: string; truncated: boolean }> {
    await this.refreshEvidence();
    const entry = this.evidence.get(id);
    if (!entry) throw new WebError(404, "测试报告未登记。");
    if (entry.view.status === "MISSING") throw new WebError(404, "测试报告尚未产生。");
    const bytes = await readFile(entry.path);
    return { evidence: entry.view, content: bytes.subarray(0, TEXT_LIMIT).toString(), truncated: bytes.length > TEXT_LIMIT };
  }
}
