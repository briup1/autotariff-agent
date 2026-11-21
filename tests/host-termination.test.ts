import { it, expect, vi } from "vitest";
import { createConfiguredModels } from "../src/models.js";
import type { LiveAudit } from "../src/closure/live-budget.js";
vi.mock("../src/closure/live-budget.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  LiveAudit: class {
    constructor(readonly runtime: unknown) {}
    async cached() { return undefined; }
    async before() { throw new Error("Budget exhausted: inputTokens"); }
    close() {}
  },
}));

it("retains the model budget stop when host finalization independently blocks the result", async () => {
  const { ClosureRuntime } = await import("../src/closure/runtime.js");
  const { runPi } = await import("../src/index.js");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { PYTHON } = await import("../src/closure/paths.js");
  const root = await mkdtemp(resolve(tmpdir(), "budget-finalize-")), source = resolve(root, "source.xlsx");
  await writeFile(source, "source identity");
  const runtime = new ClosureRuntime({ projectRoot: root, provider: "openai", modelId: "offline", sourcePath: source,
    pythonBin: PYTHON, runDate: "2026-11-15", runYear: 2026, storagePath: ":memory:", contractFirst: true });
  vi.stubEnv("OPENAI_API_KEY", "offline-test-placeholder");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  try {
    await runtime.bootstrap();
    runtime.attempt = { rawResult: { artifactId: "test-only" } } as never;
    vi.spyOn(runtime, "postprocess").mockImplementation(async () => { runtime.attempt.finalResult = {} as never; return {}; });
    const validate = vi.spyOn(runtime, "validate").mockImplementation(async () => {
      await runtime.controller.stop(runtime.manifest, "BLOCKED", "Independent checker cannot establish coverage");
      return { attemptId: "test-only", status: "BLOCKED", issues: [], checkedRuleIds: [], unresolvedRuleIds: [], generatedFromInterpretation: "test-only" };
    });
    await runPi(runtime, "continue extraction");
    expect(validate).toHaveBeenCalledOnce();
    expect(runtime.manifest.decision).toBe("BLOCKED");
    expect(runtime.manifest.binding?.modelStopReason).toContain("Budget exhausted: inputTokens");
    expect(runtime.manifest.binding?.stopReason).toBe("Independent checker cannot establish coverage");
    expect(network).not.toHaveBeenCalled();
  } finally { runtime.close(); await rm(root, { recursive: true, force: true }); network.mockRestore(); vi.unstubAllEnvs(); }
});
it("terminal host state denies another provider dispatch without spending tokens or using the network", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected network"));
  const before = vi.fn();
  vi.stubEnv("OPENAI_API_KEY", "offline-test-key");
  try {
    const audit = {
      runtime: { manifest: { phase: "TERMINAL" } },
      before,
    } as unknown as LiveAudit;
    const models = createConfiguredModels(
      {
        provider: "openai",
        modelId: "offline",
        sourcePath: "unused",
        pythonBin: "unused",
        runDate: "2026-11-03",
        runYear: 2026,
        maxAgentTurns: 12,
        storagePath: ":memory:",
      },
      audit,
    );
    const model = models.getModel("openai", "offline")!;
    const reply = await models.completeSimple(model, {
      messages: [
        { role: "user", content: "must not dispatch", timestamp: Date.now() },
      ],
    });
    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toContain("HOST_TERMINAL");
    expect(before).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    vi.unstubAllEnvs();
  }
});
it("a completed paid response replays from its artifact without another provider dispatch or reservation", async () => {
  const { fauxAssistantMessage, fauxText } =
    await import("@earendil-works/pi-ai");
  const response = fauxAssistantMessage([fauxText("CACHED")]);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected network"));
  const before = vi.fn();
  vi.stubEnv("OPENAI_API_KEY", "offline-test-key");
  try {
    const audit = {
      runtime: { manifest: { phase: "RUNNING" } },
      cached: async () => response,
      before,
    } as unknown as LiveAudit;
    const models = createConfiguredModels(
      {
        provider: "openai",
        modelId: "offline",
        sourcePath: "unused",
        pythonBin: "unused",
        runDate: "2026-11-03",
        runYear: 2026,
        maxAgentTurns: 12,
        storagePath: ":memory:",
      },
      audit,
    );
    const reply = await models.completeSimple(
      models.getModel("openai", "offline")!,
      {
        messages: [
          { role: "user", content: "same durable request", timestamp: 0 },
        ],
      },
    );
    expect(reply.content).toEqual(response.content);
    expect(before).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    vi.unstubAllEnvs();
  }
});
it("C17 initial source dependency failure stops at the actual tool gateway before another model dispatch", async () => {
  const { ClosureRuntime, createClosureExtension } =
    await import("../src/closure/runtime.js");
  const { PROJECT_ROOT } = await import("../src/closure/paths.js");
  const { resolve } = await import("node:path");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const r = new ClosureRuntime({
    provider: "offline",
    modelId: "none",
    sourcePath: resolve(PROJECT_ROOT, "template_runs/live-fixtures/small.xlsx"),
    pythonBin: resolve(PROJECT_ROOT, ".tmp/missing-python"),
    runDate: "2026-11-03",
    runYear: 2026,
    maxAgentTurns: 12,
    storagePath: ":memory:",
  });
  try {
    await r.bootstrap();
    const inspect = createClosureExtension(r).tools!.find(
      (t) => t.name === "inspect_source",
    )!;
    await inspect.execute(
      {},
      { callId: "initial-missing-dependency" } as never,
      BACKGROUND_CONTEXT,
    );
    expect(r.manifest.decision).toBe("BLOCKED");
    expect(r.manifest.usage.agentTurns).toBe(0);
  } finally {
    r.close();
  }
});
