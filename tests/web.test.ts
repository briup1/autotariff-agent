import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { request } from "node:http";
import { createWorkbenchServer } from "../src/web/server.js";
import { WorkbenchService, type RunJobContext, type WorkbenchOptions } from "../src/web/service.js";
import { ArtifactStore } from "../src/closure/artifacts.js";
import { ClosureController } from "../src/closure/controller.js";
import { DEFAULT_BUDGET } from "../src/closure/runtime.js";
import { PROJECT_ROOT, PYTHON, runsRootFor } from "../src/closure/paths.js";
import { exportRecords } from "../src/closure/spreadsheet.js";
import { writeStoredContract, type Contract } from "../src/closure/contract.js";
import { VISUAL_TASK_ID } from "../src/closure/live-budget.js";
import type { ConversationDetail, RunDetail } from "../src/web/types.js";

let root: string;
let app: Awaited<ReturnType<typeof createWorkbenchServer>> | undefined;
let url: string;
const sourceBytes = Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.from("[Content_Types].xml xl/workbook.xml")]);

beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), "web-test-"));
  await writeFile(resolve(root, "source.xlsx"), sourceBytes);
  await writeFile(resolve(root, "requirements.txt"), "controlled test");
});
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  await rm(root, { recursive: true, force: true });
});

function options(extra: WorkbenchOptions = {}): WorkbenchOptions {
  return { projectRoot: root, modelConfigured: () => true, sources: [{ id: "sample-controlled", label: "试点输入", filename: "source.xlsx", requirementsName: "requirements.txt", sourcePath: resolve(root, "source.xlsx"), requirementsPath: resolve(root, "requirements.txt"), supported: true, kind: "sample", templateName: "controlled" }], ...extra };
}
async function start(extra: WorkbenchOptions = {}): Promise<void> {
  app = await createWorkbenchServer(options(extra)); url = await app.listen(0);
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function conversation(): Promise<ConversationDetail> {
  const response = await post("/api/conversations", { sourceId: "sample-controlled" });
  expect(response.status).toBe(201);
  return response.json() as Promise<ConversationDetail>;
}
async function makeRun(context: RunJobContext, hold?: Promise<void>): Promise<void> {
  const store = new ArtifactStore(root), controller = new ClosureController(store, root, DEFAULT_BUDGET);
  const manifest = await controller.startRun(context.source.sourcePath, { version: "test" }, "2026-11-03", 2026);
  try {
    context.bindRun(manifest.runId);
    await controller.action(manifest, "tool:inspect_source", {}, { toolCalls: 1 }, async () => {
      await hold;
      return { actualSource: (await store.read(manifest.refs!.input)).toString("base64") };
    });
    const raw = await store.put(manifest.runId, "outputs/attempt-001/raw_result.json", JSON.stringify([{ port: "SINGAPORE", price: 200, sourceId: "Sheet1!R2C1" }]), "raw-result");
    const final = await store.put(manifest.runId, "outputs/attempt-001/final_result.json", JSON.stringify([{ port: "SINGAPORE", price: 250, sourceId: "Sheet1!R2C1" }]), "final-result");
    const xlsx = await store.put(manifest.runId, "outputs/attempt-001/result.xlsx", await exportRecords(PYTHON, [{ port: "SINGAPORE", price: 250, sourceId: "Sheet1!R2C1" }]), "result-xlsx");
    const report = await store.put(manifest.runId, "validation/attempt-001/report.json", JSON.stringify({ attemptId: "attempt-001", status: "REVIEW", issues: [{ issueId: "review-1", code: "REVIEW", stage: "validation", sourceIds: ["Sheet1!R2C1"], resultIds: [], message: "待人工确认" }], checkedRuleIds: [], unresolvedRuleIds: [], generatedFromInterpretation: "test" }), "validation-report");
    const parser = await store.put(manifest.runId, "outputs/attempt-001/parser.py", "print('actual test parser')", "parser");
    const plan = await store.put(manifest.runId, "outputs/attempt-001/plan.json", "{}", "plan");
    manifest.refs!.private = await store.put(manifest.runId, "model/response.json", JSON.stringify({ thinking: "hidden", key: "secret" }), "model-response");
    manifest.attempts = ["attempt-001"]; manifest.currentAttemptId = "attempt-001";
    manifest.attemptStates = { "attempt-001": { attemptId: "attempt-001", parentAttemptId: null, status: "VALIDATED", rawResult: raw, finalResult: final, resultXlsx: xlsx, validation: report, parser, plan, inputSnapshotSha256: manifest.sourceSha256 } };
    context.assistantText("已读取原文件。结果仍需人工确认。");
    await controller.stop(manifest, "REVIEW", "Working interpretation consistent; independent business approval missing");
  } finally { controller.close(manifest); }
}

async function makeCandidateRun(context: RunJobContext, requirementsDigest: string, contract: Record<string, unknown> & { version: string }, issues: unknown[] = []): Promise<void> {
  const store = new ArtifactStore(root), controller = new ClosureController(store, root, DEFAULT_BUDGET);
  const manifest = await controller.startRun(context.source.sourcePath, { version: "test" }, "2026-11-03", 2026);
  try {
    context.bindRun(manifest.runId);
    const contractRef = await store.put(manifest.runId, "contract/drafts/contract-1.json", JSON.stringify(contract, null, 2), "contract");
    const validation = await store.put(manifest.runId, "validation/attempt-001/report.json", JSON.stringify({
      attemptId: "attempt-001", status: "REVIEW", issues, checkedRuleIds: [], unresolvedRuleIds: [], generatedFromInterpretation: "test",
    }), "validation-report");
    const parser = await store.put(manifest.runId, "outputs/attempt-001/parser.py", "print('candidate')", "parser");
    const plan = await store.put(manifest.runId, "outputs/attempt-001/plan.json", "{}", "plan");
    manifest.refs!.contract = contractRef;
    manifest.attempts = ["attempt-001"];
    manifest.currentAttemptId = "attempt-001";
    manifest.attemptStates = { "attempt-001": {
      attemptId: "attempt-001", parentAttemptId: null, status: "VALIDATED", validation, parser, plan, inputSnapshotSha256: manifest.sourceSha256,
    } };
    manifest.binding = {
      ...manifest.binding, requirementsDigest, contractDigest: requirementsDigest, contractVersion: contract.version,
      contractStatus: "candidate", contractSha256: contractRef.sha256,
    };
    await controller.stop(manifest, "REVIEW", "等待人工确认契约");
  } finally { controller.close(manifest); }
}

 describe("local conversational API", () => {
  it("browses without a model key and rejects sending with a useful reason", async () => {
    await start({ modelConfigured: () => false });
    const bootstrap = await (await fetch(url + "/api/bootstrap")).json();
    expect(bootstrap.modelConfigured).toBe(false);
    expect(bootstrap.budget).toMatchObject({ taskId: VISUAL_TASK_ID, usedCalls: 0, maxCalls: 1000 });
    const current = await conversation();
    const response = await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "no-key", content: "提取" });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("模型未配置");
    expect(app!.service.store.jobs()).toEqual([]);
  });

  it("deduplicates requests, exposes STARTED before completion, and persists linked followups", async () => {
    let release!: () => void;
    const hold = new Promise<void>((done) => { release = done; });
    let calls = 0;
    await start({ runner: async (context) => { calls++; await makeRun(context, calls === 1 ? hold : undefined); } });
    const current = await conversation(), path = `/api/conversations/${current.conversation.id}/messages`;
    const sent = await post(path, { requestId: "first", content: "提取原文件" });
    expect(sent.status).toBe(202);
    const detail = await sent.json() as ConversationDetail, runId = detail.conversation.activeRunId!;
    expect(runId).toBeTruthy();
    const before = await (await fetch(url + `/api/runs/${runId}`)).json() as RunDetail;
    expect(before.actions).toContainEqual(expect.objectContaining({ operation: "tool:inspect_source", status: "STARTED" }));
    expect((await post(path, { requestId: "first", content: "提取原文件" })).status).toBe(202);
    expect((await post(path, { requestId: "first", content: "更换含义" })).status).toBe(409);
    expect((await post(path, { requestId: "other", content: "另一个请求" })).status).toBe(409);
    expect(calls).toBe(1);
    release(); await app!.service.idle();
    const completed = await (await fetch(url + `/api/runs/${runId}`)).json() as RunDetail;
    expect(completed.run).toMatchObject({ decision: "REVIEW", active: false, recordCount: 1 });
    expect(completed.stopReason).toBe("抽取结果与当前工作解释一致，仍需人工确认业务正确性。");
    expect(completed.records.items).toEqual([{ port: "SINGAPORE", price: 250, sourceId: "Sheet1!R2C1" }]);
    expect(completed.actions[0].status).toBe("COMPLETED");
    const response = await post(path, { requestId: "followup", content: "解释结果" });
    expect(response.status).toBe(202);
    await app!.service.idle();
    const followup = await app!.service.conversation(current.conversation.id);
    expect(followup.runs).toHaveLength(2);
    expect(followup.runs[1].parentRunId).toBe(runId);
    expect(followup.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    await app!.close(); app = undefined;
    await start({ runner: async () => { throw new Error("must not redispatch"); } });
    const reloaded = await (await fetch(url + `/api/conversations/${current.conversation.id}`)).json() as ConversationDetail;
    expect(reloaded.messages).toEqual(followup.messages);
    expect((await post(path, { requestId: "followup", content: "解释结果" })).status).toBe(202);
    expect((await app!.service.projection.summary(runId)).decision).toBe("REVIEW");
    expect(calls).toBe(2);
  });

  it("serves only registered artifacts and detects tampering", async () => {
    await start({ runner: makeRun }); const current = await conversation();
    await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "run", content: "提取" });
    await app!.service.idle();
    const runId = (await app!.service.conversation(current.conversation.id)).conversation.runIds[0];
    const getArtifact = (path: string) => fetch(url + `/api/artifacts?runId=${runId}&path=${encodeURIComponent(path)}`);
    expect((await getArtifact("model/response.json")).status).toBe(404);
    expect((await getArtifact("../../.env.local")).status).toBe(404);
    expect((await getArtifact(resolve(root, "source.xlsx"))).status).toBe(404);
    const valid = await getArtifact("outputs/attempt-001/final_result.json");
    expect(valid.status).toBe(200);
    expect((await valid.json()).content).toContain("250");
    const workbook = await getArtifact("outputs/attempt-001/result.xlsx");
    expect(workbook.status).toBe(200);
    const preview = await workbook.json();
    expect(preview.content).toBe("");
    expect(preview.sheets[0].rows[1]).toEqual(["SINGAPORE", 250, "Sheet1!R2C1"]);
    const details = await app!.service.projection.detail(runId);
    expect(details.attempts[0].xlsxPath).toBe("outputs/attempt-001/result.xlsx");
    expect(details.artifacts.some((artifact) => artifact.kind === "result-xlsx")).toBe(true);
    expect(details.artifacts.some((artifact) => artifact.path.startsWith("model/"))).toBe(false);
    const resultPath = resolve(root, "template_runs", runId, "outputs/attempt-001/final_result.json");
    const originalResult = await readFile(resultPath);
    await writeFile(resolve(root, "template_runs", runId, "outputs/attempt-001/final_result.json"), "tampered");
    expect((await getArtifact("outputs/attempt-001/final_result.json")).status).toBe(409);
    expect((await app!.service.projection.detail(runId)).run.error).toContain("摘要校验失败");
    expect((await app!.service.projection.detail(runId)).records.status).toBe("error");
    await writeFile(resultPath, originalResult);
    await rm(resolve(root, "template_runs", runId, "validation/attempt-001/report.json"));
    const missingReport = await app!.service.projection.detail(runId);
    expect(missingReport.records).toMatchObject({ status: "available", total: 1 });
    expect(missingReport.attempts[0].reportStatus).toBe("error");
    expect(missingReport.run.recordCount).toBe(1);
    expect((await fetch(url + `/api/runs/${runId}?attempt=attempt-999`)).status).toBe(404);
    expect((await fetch(url + `/api/runs/${runId}?limit=-1`)).status).toBe(400);
  });

  it("rejects cross-origin, hostile Host, malformed payloads and arbitrary paths", async () => {
    await start();
    expect((await post("/api/conversations", { sourceId: "sample-controlled" }, { Origin: "https://attacker.example" })).status).toBe(403);
    const hostileHostStatus = await new Promise<number | undefined>((done, reject) => {
      const outgoing = request(url + "/api/bootstrap", { headers: { Host: "attacker.example" } }, (response) => { response.resume(); done(response.statusCode); });
      outgoing.on("error", reject); outgoing.end();
    });
    expect(hostileHostStatus).toBe(403);
    expect((await fetch(url + "/api/bootstrap", { headers: { Origin: "null" } })).status).toBe(403);
    expect((await fetch(url + "/api/conversations", { method: "POST", body: "{}" })).status).toBe(415);
    expect((await fetch(url + "/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
    expect((await post("/api/conversations", { sourceId: {} })).status).toBe(400);
    expect((await post("/api/conversations", { sourceId: "/etc/passwd" })).status).toBe(404);
    expect((await fetch(url + "/.env.local")).status).toBe(404);
    expect((await fetch(url + "/api/tests/not-registered")).status).toBe(404);
  });

  it("imports signed uploads, admits unknown requirements as a contractless document, and uses registered input", async () => {
    let imported = "", count = 0;
    await start({ runner: async (context) => { count++; imported = (await readFile(context.source.sourcePath)).toString("base64"); await makeRun(context); } });
    const requirementsText = await readFile(resolve(PROJECT_ROOT, "fixtures/controlled-requirements.txt"), "utf8");
    const body = { name: "upload.xlsx", base64: sourceBytes.toString("base64"), requirementsName: "说明.txt", requirementsText };
    expect((await post("/api/uploads", { ...body, name: "../../evil.xlsx" })).status).toBe(422);
    expect((await post("/api/uploads", { ...body, base64: Buffer.from("fake xlsx").toString("base64") })).status).toBe(422);
    expect((await post("/api/uploads", { ...body, requirementsName: "rules.pdf" })).status).toBe(422);
    const unmapped = await (await post("/api/uploads", { ...body, requirementsText: "invent new business rules" })).json();
    // A new document is admitted; it is gated by an undeclared contract instead of a whitelist.
    expect(unmapped).toMatchObject({ supported: true, contractStatus: "missing" });
    expect(count).toBe(0);
    const uploaded = await (await post("/api/uploads", body)).json();
    expect(uploaded).toMatchObject({ supported: true, filename: "upload.xlsx", requirementsName: "说明.txt" });
    expect(uploaded.sourcePath).toBeUndefined();
    const current = await (await post("/api/conversations", { sourceId: uploaded.id })).json() as ConversationDetail;
    await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "upload", content: "执行" });
    await app!.service.idle();
    expect(imported).toBe(body.base64);
    expect(count).toBe(1);
  });

  it.each([
    ["REVIEW", "Budget exhausted: inputTokens", undefined, true],
    ["BLOCKED", "Independent checker cannot establish coverage", undefined, false],
    ["BLOCKED", "Budget exhausted: inputTokens", undefined, true],
    ["BLOCKED", "Independent checker cannot establish coverage", "Budget exhausted: inputTokens", true],
    ["REVIEW", "Agent response completed", undefined, false],
  ] as const)("publishes all terminal facts for %s: %s / %s", async (decision, reason, modelStopReason, budgetStopped) => {
    await start({ runner: async (context) => {
      const controller = new ClosureController(new ArtifactStore(root), root, DEFAULT_BUDGET);
      const manifest = await controller.startRun(context.source.sourcePath, { version: "test" }, "2026-11-15", 2026);
      try {
        context.bindRun(manifest.runId);
        context.assistantText("我会读取文件并检查。");
        manifest.binding = { ...manifest.binding, ...(modelStopReason ? { modelStopReason } : {}) };
        await controller.stop(manifest, decision, reason);
      } finally { controller.close(manifest); }
    } });
    const current = await conversation();
    await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "budget-stop", content: "抽取并检查" });
    await app!.service.idle();
    const detail = await app!.service.conversation(current.conversation.id);
    const last = detail.messages[detail.messages.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toContain("独立检查报告缺失");
    if (budgetStopped) {
      expect(last.content).toContain("因运行预算停止");
      expect(last.content).toContain("继续试抽取并独立检查");
      expect(last.content).toContain("不代表检查通过");
    }
    if (decision === "BLOCKED") {
      expect(last.content).toContain("本次运行已阻断");
      expect(last.content).toContain("不能确认候选契约");
    }
  });

  it("approves only the candidate contract observed by a pending run and is idempotent", async () => {
    const requirementsText = "controlled test";
    const { createHash } = await import("node:crypto");
    const requirementsDigest = createHash("sha256").update(requirementsText).digest("hex");
    const contract: Contract = {
      version: "controlled-contract-v001", requirementsDigest, requirementsSource: "uploaded",
      fields: [{ name: "port", role: "text", aliases: ["PORT"], required: true }],
      route: { kind: "columns", separators: ["-"] },
      checks: [{ id: "port-required", kind: "required_fields", params: { fields: ["port"] }, quote: "PORT is required" }],
    };
    let calls = 0;
    await start({ runner: async (context) => { calls++; await makeCandidateRun(context, requirementsDigest, contract); } });
    expect((await post("/api/contracts/approve", { requirementsDigest: "not-a-digest" })).status).toBe(400);
    const current = await conversation();
    await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "candidate", content: "观察并生成候选契约" });
    await app!.service.idle();
    const runId = (await app!.service.conversation(current.conversation.id)).conversation.runIds[0];
    await writeStoredContract(root, contract);
    const run = await app!.service.projection.summary(runId);
    expect(run).toMatchObject({ runId, decision: "REVIEW", contractStatus: "candidate", requirementsDigest, contractSha256: expect.any(String) });
    const approved = await post("/api/contracts/approve", { runId, requirementsDigest, contractSha256: run.contractSha256 });
    expect(approved.status).toBe(200);
    const approval = await approved.json();
    expect(approval).toMatchObject({ requirementsDigest, contractVersion: "controlled-contract-v001", contractSha256: run.contractSha256 });
    const repeated = await post("/api/contracts/approve", { runId, requirementsDigest, contractSha256: run.contractSha256 });
    expect(await repeated.json()).toEqual(approval);
    expect(calls).toBe(1);
    await app!.close(); app = undefined;
    await start({ runner: async () => { throw new Error("must not redispatch"); } });
    const repeatedAfterRestart = await post("/api/contracts/approve", { runId, requirementsDigest, contractSha256: run.contractSha256 });
    expect(await repeatedAfterRestart.json()).toEqual(approval);
    const bootstrap = await (await fetch(url + "/api/bootstrap")).json();
    expect(bootstrap.sources[0]).toMatchObject({ contractStatus: "confirmed", contractVersion: "controlled-contract-v001" });
    await rm(resolve(root, "template_runs/contracts", requirementsDigest), { recursive: true, force: true });
  });

  it("rejects missing, mismatched, replaced and findings-bearing contract approval requests", async () => {
    const requirementsDigest = "a".repeat(64);
    const contract: Contract = { version: "candidate-v1", requirementsDigest, requirementsSource: "observed", fields: [{ name: "port", role: "text", aliases: ["PORT"], required: true }], route: { kind: "columns", separators: ["-"] }, checks: [] };
    await start({ runner: async (context) => makeCandidateRun(context, requirementsDigest, contract) });
    const current = await conversation();
    await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "candidate", content: "生成候选契约" });
    await app!.service.idle();
    const runId = (await app!.service.conversation(current.conversation.id)).conversation.runIds[0];
    const run = await app!.service.projection.summary(runId);
    expect((await post("/api/contracts/approve", { requirementsDigest, contractSha256: run.contractSha256 })).status).toBe(400);
    expect((await post("/api/contracts/approve", { runId: "other-run", requirementsDigest, contractSha256: run.contractSha256 })).status).toBe(404);
    expect((await post("/api/contracts/approve", { runId, requirementsDigest, contractSha256: "b".repeat(64) })).status).toBe(409);
    await writeStoredContract(root, { ...contract, fields: [{ name: "destination", role: "text", aliases: ["DEST"], required: true }] });
    expect((await post("/api/contracts/approve", { runId, requirementsDigest, contractSha256: run.contractSha256 })).status).toBe(409);
  });

  it("does not turn a run with independent-check findings into contract confirmation", async () => {
    const requirementsDigest = "c".repeat(64);
    const contract: Contract = { version: "candidate-findings", requirementsDigest, requirementsSource: "observed", fields: [{ name: "port", role: "text", aliases: ["PORT"], required: true }], route: { kind: "columns", separators: ["-"] }, checks: [] };
    await start({ runner: async (context) => makeCandidateRun(context, requirementsDigest, contract, [{ issueId: "finding-1", code: "FIELD_MISMATCH", message: "wrong value" }]) });
    const current = await conversation();
    await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "findings", content: "生成候选契约" });
    await app!.service.idle();
    const runId = (await app!.service.conversation(current.conversation.id)).conversation.runIds[0];
    await writeStoredContract(root, contract);
    const run = await app!.service.projection.summary(runId);
    expect(run.issueCount).toBe(1);
    expect((await post("/api/contracts/approve", { runId, requirementsDigest, contractSha256: run.contractSha256 })).status).toBe(409);
  });

  it("marks orphaned admission interrupted and prevents a second live server from taking ownership", async () => {
    await start(); const current = await conversation();
    const id = current.conversation.id;
    app!.service.store.admit(id, "orphan", "interrupted before bootstrap");
    expect(() => new WorkbenchService(options())).toThrow("另一个工作台服务");
    await app!.close(); app = undefined;
    await start();
    const reloaded = await app!.service.conversation(id);
    expect(reloaded.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("不会自动重发") });
    expect(app!.service.store.job(id, "orphan")?.state).toBe("INTERRUPTED");
    expect((await post(`/api/conversations/${id}/messages`, { requestId: "orphan", content: "interrupted before bootstrap" })).status).toBe(202);
  });

  it("rejects exhausted scoped budget and does not count old task calls", async () => {
    await start();
    const path = resolve(root, "template_runs/live-budget.sqlite"), db = new DatabaseSync(path);
    db.exec("CREATE TABLE actions(run TEXT, data TEXT)");
    db.prepare("INSERT INTO actions VALUES(?,?)").run("all-batches-2026-11-03", JSON.stringify({ operation: "model_request", status: "COMPLETED", actual: { agentTurns: 900 }, reserved: {} }));
    expect(app!.service.projection.budget().usedCalls).toBe(0);
    db.prepare("INSERT INTO actions VALUES(?,?)").run(VISUAL_TASK_ID, JSON.stringify({ operation: "model_request", status: "COMPLETED", actual: { agentTurns: 1000 }, reserved: {} }));
    db.close();
    const current = await conversation();
    expect((await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "over", content: "执行" })).status).toBe(429);
    expect(app!.service.store.jobs()).toHaveLength(0);
  });

  it("projects real offline report totals and uses a system message when no assistant text exists", async () => {
    await mkdir(resolve(root, "template_runs/offline-123"), { recursive: true });
    await writeFile(resolve(root, "template_runs/offline-123/vitest.json"), JSON.stringify({ success: true, numTotalTests: 7, numPassedTests: 6, numFailedTests: 0, numPendingTests: 1 }));
    await start({ runner: async () => {} });
    const evidence = await (await fetch(url + "/api/tests/offline-tests")).json();
    expect(evidence.evidence).toMatchObject({ origin: "offline", status: "PASS", total: 7, passed: 6, skipped: 1 });
    expect(evidence.content).toContain("numTotalTests");
    const current = await conversation();
    await post(`/api/conversations/${current.conversation.id}/messages`, { requestId: "empty", content: "执行" });
    const messages = (await app!.service.conversation(current.conversation.id)).messages;
    expect(messages.some((message) => message.role === "assistant")).toBe(false);
    expect(messages.at(-1)?.role).toBe("system");
  });
});
