import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compactModelPayload } from "../src/models.js";
import { ClosureRuntime } from "../src/closure/runtime.js";
import { PYTHON } from "../src/closure/paths.js";
import { runProcess } from "../src/closure/execute.js";
import { scanExpected } from "../src/closure/oracle.js";
import { scanConfig } from "../src/closure/contract.js";
vi.mock("../src/index.js", () => ({ runPi: vi.fn() }));

let runtime: ClosureRuntime | undefined, root: string | undefined;
afterEach(async () => { runtime?.close(); runtime = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

it("replaces historical tool bodies with readable immutable evidence and preserves current errors", async () => {
  root = await mkdtemp(resolve(tmpdir(), "model-context-"));
  const source = resolve(root, "source.xlsx");
  await writeFile(source, "source identity");
  runtime = new ClosureRuntime({ projectRoot: root, provider: "offline", modelId: "none", sourcePath: source,
    pythonBin: PYTHON, runDate: "2026-11-15", runYear: 2026, storagePath: ":memory:", contractFirst: true });
  await runtime.bootstrap();
  const original = JSON.stringify({ regions: [{ sheet: "上海", fields: { route: 1 } }],
    cells: Array.from({ length: 100 }, (_, i) => ({ sourceId: `上海!R${i + 1}C1`, value: "宁波-新加坡".repeat(30), style: {} })) });
  const recent = JSON.stringify({ accepted: false, issues: [{ code: "CHECK_FIELD", message: "LSS must be declared" }] });
  const payload = { messages: [
    { role: "system", content: "Keep safety gates" },
    { role: "tool", tool_call_id: "inspect-1", content: original },
    { role: "assistant", content: null },
    { role: "tool", tool_call_id: "draft-1", content: recent },
  ] };
  await compactModelPayload(payload, runtime);
  expect(payload.messages[0].content).toBe("Keep safety gates");
  const old = JSON.parse(payload.messages[1].content!);
  expect(old.contextExcerpt).toBe(true);
  expect(Buffer.byteLength(payload.messages[1].content!)).toBeLessThan(8000);
  expect(old.omittedCells).toBe(96);
  expect(JSON.parse(payload.messages[3].content!).issues).toEqual(JSON.parse(recent).issues);
  let offset: number | null = 0;
  const pages: string[] = [];
  while (offset !== null) {
    const page = await runtime.readArtifact(old.fullResponse.relativePath, offset, 500) as { text: string; nextCursor: number | null };
    pages.push(page.text); offset = page.nextCursor;
  }
  expect(JSON.parse(pages.join("\n"))).toEqual(JSON.parse(original));
  const once = JSON.stringify(payload);
  await compactModelPayload(payload, runtime);
  expect(JSON.stringify(payload)).toBe(once);
});

it("keeps one complete key evidence page across turns and replaces exact duplicate pages", async () => {
  root = await mkdtemp(resolve(tmpdir(), "model-context-"));
  const source = resolve(root, "source.xlsx"); await writeFile(source, "source");
  runtime = new ClosureRuntime({ projectRoot: root, provider: "offline", modelId: "none", sourcePath: source,
    pythonBin: PYTHON, runDate: "2026-11-15", runYear: 2026, storagePath: ":memory:", contractFirst: true });
  await runtime.bootstrap();
  const page = JSON.stringify({ path: "contract/working-interpretation.json", text: "完整工作解释".repeat(100), nextCursor: null });
  const payload = { messages: [{ role: "tool", content: page }, { role: "tool", content: page }, { role: "assistant", content: "已读取说明，开始抽取" }] };
  await compactModelPayload(payload, runtime);
  expect(JSON.parse(payload.messages[0].content).contextExcerpt).toBe(true);
  expect(payload.messages[1].content).toBe(page);
  const drafted = { accepted: true, contract: { notes: ["redundant candidate".repeat(500)] },
    selfCheck: { expectedRecords: 262, issues: Array.from({ length: 100 }, () => ({ code: "AMBIGUOUS_HEADER", message: "待核对原文" })) } };
  const history = { messages: [{ role: "tool", content: JSON.stringify(drafted) }, { role: "assistant", content: "准备试抽取" }] };
  await compactModelPayload(history, runtime);
  const receipt = JSON.parse(history.messages[0].content);
  expect(receipt.accepted).toBe(true);
  expect(receipt.contract).toBeUndefined();
  expect(receipt.selfCheck).toMatchObject({ expectedRecords: 262, totalIssues: 100 });
  expect(receipt.selfCheck.issues).toHaveLength(8);
  const noGenericIssues = { messages: [{ role: "tool", content: JSON.stringify({ accepted: true,
    selfCheck: { scanIssues: drafted.selfCheck.issues, positiveIssues: drafted.selfCheck.issues } }) }] };
  await compactModelPayload(noGenericIssues, runtime);
  const check = JSON.parse(noGenericIssues.messages[0].content).selfCheck;
  expect(check).toMatchObject({ scanIssuesTotal: 100, positiveIssuesTotal: 100 });
  expect(check.totalIssues).toBeUndefined();
  expect(check.scanIssues).toHaveLength(8);
  const legacy = { messages: [{ role: "tool", content: JSON.stringify({ accepted: true, contract: drafted.contract,
    selfCheck: { scanIssues: drafted.selfCheck.issues.slice(0, 8) } }) }] };
  await compactModelPayload(legacy, runtime);
  const legacyCheck = JSON.parse(legacy.messages[0].content).selfCheck;
  expect(legacyCheck.scanIssuesTotal).toBeUndefined();
  expect(legacyCheck.scanIssuesSampleCount).toBe(8);
});

it("bounds a large current report without losing totals, full evidence or the failure state", async () => {
  root = await mkdtemp(resolve(tmpdir(), "model-context-"));
  const source = resolve(root, "source.xlsx"); await writeFile(source, "source");
  runtime = new ClosureRuntime({ projectRoot: root, provider: "offline", modelId: "none", sourcePath: source,
    pythonBin: PYTHON, runDate: "2026-11-15", runYear: 2026, storagePath: ":memory:", contractFirst: true });
  await runtime.bootstrap();
  const report = { decision: "BLOCKED", issues: Array.from({ length: 1899 }, (_, i) => ({ code: "FIELD_MISMATCH", message: `原文坐标${i}` })) };
  const payload = { messages: [{ role: "assistant", content: "check" }, { role: "tool", content: JSON.stringify(report) }] };
  await compactModelPayload(payload, runtime);
  const view = JSON.parse(payload.messages[1].content);
  expect(view.decision).toBe("BLOCKED"); expect(view.totalIssues).toBe(1899);
  expect(view.issues).toHaveLength(8); expect(view.fullResponse.relativePath).toBeTruthy();
  expect(Buffer.byteLength(payload.messages[1].content)).toBeLessThan(12000);
  const ref = Object.values(runtime.manifest.refs!).find(r => r.relativePath === view.fullResponse.relativePath)!;
  expect(JSON.parse((await runtime.store.read(ref)).toString())).toEqual(report);
});

it.each([true, false])("links only matching unconfirmed drafts (uploaded requirements: %s)", async (uploaded) => {
  const { WorkbenchService } = await import("../src/web/service.js");
  const { runPi } = await import("../src/index.js");
  root = await mkdtemp(resolve(tmpdir(), "model-followup-"));
  const source = resolve(root, "source.xlsx"), requirements = resolve(root, "rules.txt");
  await runProcess(PYTHON, ["-c", `import openpyxl
b=openpyxl.Workbook();s=b.active;s.append(["PORT"]);s.append(["SINGAPORE"]);b.save(${JSON.stringify(source)})`]);
  if (uploaded) await writeFile(requirements, "Original rules");
  vi.stubEnv("OPENAI_API_KEY", "offline-test-placeholder"); vi.stubEnv("PI_MODEL_ID", "offline");
  let calls = 0;
  const failures: unknown[] = [];
  vi.mocked(runPi).mockImplementation(async (r, prompt) => {
    calls++;
    try {
    if (calls === 1) {
      await r.inspect();
      await r.draftContract({ contract: JSON.stringify({ version: "unconfirmed-v1", fields: [{ name: "port", role: "text", aliases: ["PORT"], required: true }], route: { kind: "columns", separators: [] }, checks: [] }) });
      r.manifest.refs!["previous-result"] = await r.save("outputs/prior-result.json", { text: "HUGE_PRIOR_RESULT".repeat(5000) }, "final-result");
    } else {
      expect(prompt).not.toContain("HUGE_PRIOR_RESULT");
      expect(prompt).toContain("context/previous-result.json");
      expect(r.contract).toBeUndefined();
      if (calls === 2) {
        expect(prompt).toContain("context/previous-candidate-contract.json");
        const page = await r.readArtifact("context/previous-candidate-contract.json") as { text: string };
        expect(JSON.parse(page.text).version).toBe("unconfirmed-v1");
      } else expect(prompt).not.toContain("context/previous-candidate-contract.json");
    }
    await r.finish("Model budget exhausted: Budget exhausted: inputTokens");
    } catch (error) { failures.push(error); throw error; }
  });
  const service = new WorkbenchService({ projectRoot: root, sources: [{ id: "followup", label: "source", filename: "source.xlsx", requirementsName: "rules.txt",
    sourcePath: source, ...(uploaded ? { requirementsPath: requirements } : {}), templateName: "test-followup", supported: true, kind: "sample" }] });
  try {
    await service.initialize();
    const current = await service.create("followup"), id = current.conversation.id;
    await service.send(id, "first", "抽取并检查"); await service.idle();
    await service.send(id, "second", "继续试抽取并独立检查"); await service.idle();
    if (uploaded) await writeFile(requirements, "Changed rules");
    else await runProcess(PYTHON, ["-c", `import openpyxl
b=openpyxl.load_workbook(${JSON.stringify(source)});b.active["A2"]="SHANGHAI";b.save(${JSON.stringify(source)})`]);
    await service.send(id, "third", "按新说明检查"); await service.idle();
    expect(calls).toBe(3);
    expect(failures).toEqual([]);
    const detail = await service.conversation(id);
    expect(detail.messages.some(message => message.content.includes("因运行预算停止"))).toBe(true);
  } finally { await service.close(); vi.unstubAllEnvs(); vi.mocked(runPi).mockReset(); }
});

it("preserves true self-check totals through the source scan, draft receipt and model context", async () => {
  root = await mkdtemp(resolve(tmpdir(), "self-check-totals-"));
  const source = resolve(root, "source.xlsx");
  await runProcess(PYTHON, ["-c", `import openpyxl
b=openpyxl.Workbook();s=b.active;s.append(["PORT","PRICE"])
for n in range(30):s.append(["SINGAPORE",100+n])
b.save(${JSON.stringify(source)})`]);
  runtime = new ClosureRuntime({ projectRoot: root, provider: "offline", modelId: "none", sourcePath: source,
    pythonBin: PYTHON, runDate: "2026-11-15", runYear: 2026, storagePath: ":memory:", contractFirst: true });
  await runtime.bootstrap(); await runtime.inspect();
  const draft = await runtime.draftContract({ contract: JSON.stringify({ version: "observed-v1",
    fields: [{ name: "port", role: "text", aliases: ["PORT"] }, { name: "price", role: "price", aliases: ["MISSING_PRICE_HEADER"] }],
    route: { kind: "columns", separators: [] }, checks: [] }) }) as { accepted: boolean; selfCheck: Record<string, unknown> };
  expect(draft.accepted).toBe(true);
  const expected = scanExpected(runtime.inventory, scanConfig(runtime.contract!)).issues.length;
  expect(expected).toBeGreaterThan(8);
  expect(draft.selfCheck.scanIssuesTotal).toBe(expected);
  const payload = { messages: [{ role: "tool", content: JSON.stringify(draft) }] };
  await compactModelPayload(payload, runtime);
  expect(JSON.parse(payload.messages[0].content).selfCheck.scanIssuesTotal).toBe(expected);
  expect(draft.selfCheck.scanIssues).toHaveLength(8);
});
