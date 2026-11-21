import { it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROJECT_ROOT, PYTHON, runsRootFor } from "../src/closure/paths.js";
import { runProcess } from "../src/closure/execute.js";
import { ClosureRuntime } from "../src/closure/runtime.js";
import { Ledger } from "../src/closure/ledger.js";
import { DEFAULT_BUDGET } from "../src/closure/runtime.js";
const fixtures = resolve(PROJECT_ROOT, "template_runs/controlled-fixtures");
beforeAll(async () => {
  await runProcess(PYTHON, [
    resolve(PROJECT_ROOT, "src/workers/fixtures.py"),
    fixtures,
  ]);
}, 20000);
const config = {
  provider: "offline",
  modelId: "none",
  sourcePath: resolve(fixtures, "small.xlsx"),
  pythonBin: PYTHON,
  runDate: "2026-11-03",
  runYear: 2026,
  maxAgentTurns: 12,
  storagePath: ":memory:",
};
it("C16 actual SIGKILL at extraction/postprocess/checkpoint boundaries resumes without re-extraction", async () => {
  for (const point of [
    "after-extract",
    "before-postprocess",
    "before-validate",
    "after-validate",
  ]) {
    const killed = await new Promise<{
      stdout: string;
      signal: string | undefined;
    }>((yes) => {
      execFile(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/verify-worker.ts",
          config.sourcePath,
          "fixtures/reference_parser.py",
        ],
        {
          cwd: PROJECT_ROOT,
          env: {
            PATH: process.env.PATH,
            PI_FAULT_POINT: point,
            PI_RUN_ROOT: process.env.PI_RUN_ROOT,
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
        (error, stdout) =>
          yes({
            stdout,
            signal: (error as (Error & { signal?: string }) | null)?.signal,
          }),
      );
    });
    expect(killed.signal).toBe("SIGKILL");
    const runId = JSON.parse(
      killed.stdout
        .trim()
        .split("\n")
        .find((l) => l.startsWith("{"))!,
    ).runId;
    await runProcess(process.execPath, [
      "--import",
      "tsx",
      "src/verify-worker.ts",
      config.sourcePath,
      "fixtures/reference_parser.py",
      runId,
    ]);
    const runtime = new ClosureRuntime(config);
    await runtime.bootstrap(runId);
    expect(runtime.manifest.decision).toBe("REVIEW");
    expect(
      runtime.controller.ledger
        .list(runId)
        .filter((a) => a.operation === "extract"),
    ).toHaveLength(1);
    const raw = JSON.parse(
      (await runtime.store.read(runtime.attempt.rawResult!)).toString(),
    );
    expect(raw).toHaveLength(3);
    expect(runtime.manifest.attempts).toHaveLength(1);
    await runtime.save(
      "validation/recovery-proof.json",
      {
        faultPoint: point,
        signal: killed.signal,
        resumed: true,
        extractActions: 1,
        recordCount: raw.length,
        attempts: runtime.manifest.attempts,
      },
      "recovery-proof",
    );
    runtime.close();
  }
}, 30000);
it("C19 tools can be called singly, duplicate extraction returns same artifact; active writer rejected", async () => {
  const runtime = new ClosureRuntime(config);
  await runtime.bootstrap();
  await runtime.inspect();
  await runtime.prepare(
    await readFile(
      resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
      "utf8",
    ),
    { route: "excel_script", reason: "single-tool test" },
  );
  const first = await runtime.execute(),
    again = await runtime.execute();
  expect(again).toEqual(first);
  expect(runtime.manifest.phase).toBe("EXTRACTED");
  const other = new ClosureRuntime(config);
  await expect(other.bootstrap(runtime.manifest.runId)).rejects.toThrow(
    "active writer",
  );
  other.close();
  runtime.close();
});
it("C17 reservations enforce all limits before actions and uncertain paid calls cannot replay", async () => {
  const ledger = new Ledger(
      resolve(
        runsRootFor(PROJECT_ROOT),
        `budget-test-${Date.now()}.sqlite`,
      ),
    ),
    id = "test";
  ledger.create(id, {});
  const budget = { ...DEFAULT_BUDGET, maxToolCalls: 1 };
  ledger.reserve(
    id,
    "one",
    "read",
    { toolCalls: 1 },
    budget,
    new Date().toISOString(),
  );
  expect(() =>
    ledger.reserve(
      id,
      "two",
      "read",
      { toolCalls: 1 },
      budget,
      new Date().toISOString(),
    ),
  ).toThrow("Budget exhausted");
  ledger.reserve(
    id,
    "paid",
    "model",
    { inputTokens: 5 },
    DEFAULT_BUDGET,
    new Date().toISOString(),
    "never_auto_retry",
  );
  expect(
    ledger.reserve(
      id,
      "paid",
      "model",
      { inputTokens: 5 },
      DEFAULT_BUDGET,
      new Date().toISOString(),
      "never_auto_retry",
    ).status,
  ).toBe("UNCERTAIN");
  ledger.close();
});
it("C17 every budget dimension and wall deadline rejects work before side effects; safe retries capped at one", () => {
  const ledger = new Ledger(
    resolve(runsRootFor(PROJECT_ROOT), `limits-test-${Date.now()}.sqlite`),
  );
  const pairs = [
    ["agentTurns", "maxAgentTurns"],
    ["attempts", "maxAttempts"],
    ["toolCalls", "maxToolCalls"],
    ["externalActions", "maxExternalActions"],
    ["inputTokens", "maxInputTokens"],
    ["outputTokens", "maxOutputTokens"],
  ] as const;
  for (const [field, limit] of pairs) {
    const id = field;
    ledger.create(id, {});
    expect(() =>
      ledger.reserve(
        id,
        "over",
        "probe",
        { [field]: 2 },
        { ...DEFAULT_BUDGET, [limit]: 1 },
        new Date().toISOString(),
      ),
    ).toThrow("Budget exhausted");
    expect(ledger.list(id)).toHaveLength(0);
  }
  ledger.create("time", {});
  expect(() =>
    ledger.reserve(
      "time",
      "late",
      "probe",
      {},
      DEFAULT_BUDGET,
      "2000-01-01T00:00:00Z",
    ),
  ).toThrow("wall time");
  ledger.create("retry", {});
  let action = ledger.reserve(
    "retry",
    "safe",
    "probe",
    { toolCalls: 1 },
    DEFAULT_BUDGET,
    new Date().toISOString(),
  );
  action.status = "FAILED";
  ledger.put("retry", action);
  action = ledger.reserve(
    "retry",
    "safe",
    "probe",
    { toolCalls: 1 },
    DEFAULT_BUDGET,
    new Date().toISOString(),
  );
  expect(action.retries).toBe(1);
  expect(action.reserved.toolCalls).toBe(2);
  action.status = "FAILED";
  ledger.put("retry", action);
  expect(() =>
    ledger.reserve(
      "retry",
      "safe",
      "probe",
      { toolCalls: 1 },
      DEFAULT_BUDGET,
      new Date().toISOString(),
    ),
  ).toThrow("retry budget");
  ledger.close();
});
it("C16 restarting after a paid intent without receipt marks uncertainty and refuses new automated work", async () => {
  const r = new ClosureRuntime(config);
  await r.bootstrap();
  const id = r.manifest.runId;
  r.controller.ledger.reserve(
    id,
    "paid-intent",
    "model_request",
    { inputTokens: 100, outputTokens: 100 },
    DEFAULT_BUDGET,
    r.manifest.usage.startedAt,
    "never_auto_retry",
  );
  r.close();
  const resumed = new ClosureRuntime({ ...config, maxAgentTurns: 1 });
  try {
    await resumed.bootstrap(id);
    expect(resumed.manifest.decision).toBe("BLOCKED");
    expect(resumed.budget.maxAgentTurns).toBe(12);
    expect(resumed.controller.ledger.get(id, "paid-intent")?.status).toBe(
      "UNCERTAIN",
    );
    await expect(resumed.resumeForRepair()).rejects.toThrow(
      "manual reconciliation",
    );
  } finally {
    resumed.close();
  }
});
it("C17 host records timeout as BLOCKED, while a parser exception creates evidence for a fresh repair attempt", async () => {
  const timed = new ClosureRuntime(config, {
    ...DEFAULT_BUDGET,
    maxAttemptTimeSeconds: 0.2,
  });
  try {
    await timed.bootstrap();
    await timed.inspect();
    await timed.prepare("while True: pass", {
      route: "excel_script",
      reason: "bounded timeout fixture",
    });
    await expect(timed.execute()).rejects.toThrow("timeout");
    expect(timed.manifest.decision).toBe("BLOCKED");
    expect(timed.attempt.failure).toBeDefined();
  } finally {
    timed.close();
  }
  const repaired = new ClosureRuntime(config);
  try {
    await repaired.bootstrap();
    await repaired.inspect();
    await repaired.prepare('raise ValueError("controlled parser failure")', {
      route: "excel_script",
      reason: "exception fixture",
    });
    await expect(repaired.execute()).rejects.toThrow(
      "controlled parser failure",
    );
    expect(repaired.manifest.phase).toBe("REPAIR_PENDING");
    await repaired.prepare(
      await readFile(
        resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
        "utf8",
      ),
      { route: "excel_script", reason: "repair actual execution exception" },
    );
    await repaired.execute();
    await repaired.postprocess();
    expect((await repaired.validate()).issues).toEqual([]);
    expect(repaired.attempt.feedbackRefs?.[0]).toContain("execution-failure");
  } finally {
    repaired.close();
  }
}, 10000);
it("C17 gateway reserves rejected calls before validation and does not double count nested host stages", async () => {
  const r = new ClosureRuntime(config, { ...DEFAULT_BUDGET, maxToolCalls: 2 });
  try {
    await r.bootstrap();
    await expect(
      r.withToolCall("prepare_attempt", {}, "rejected-1", () =>
        r.prepare("invalid parser body", {
          route: "excel_script",
          reason: "must reject",
        }),
      ),
    ).rejects.toThrow("Invalid phase");
    expect(r.controller.ledger.totals(r.manifest.runId).toolCalls).toBe(1);
    await r.withToolCall("inspect_source", {}, "inspect-2", () => r.inspect());
    expect(r.controller.ledger.totals(r.manifest.runId).toolCalls).toBe(2);
    await expect(
      r.withToolCall("inspect_source", { limit: 1 }, "over-3", () =>
        r.inspect(0, 1),
      ),
    ).rejects.toThrow("Budget exhausted");
    expect(r.manifest.attempts).toHaveLength(0);
  } finally {
    r.close();
  }
});
it("C17 inherited absolute deadline kills a worker before its longer local timeout", async () => {
  const { executionDeadline } = await import("../src/closure/execute.js");
  const start = Date.now();
  await expect(
    executionDeadline.run(Date.now() + 100, () =>
      runProcess(PYTHON, ["-c", "import time; time.sleep(5)"], {
        timeoutMs: 10000,
      }),
    ),
  ).rejects.toThrow("timeout");
  expect(Date.now() - start).toBeLessThan(1500);
});
it("C16 C17 duplicate paid intent is blocked by the provider adapter before any redispatch", async () => {
  const { LiveAudit } = await import("../src/closure/live-budget.js");
  const r = new ClosureRuntime(config);
  await r.bootstrap();
  const global = new Ledger(
    resolve(
      runsRootFor(PROJECT_ROOT),
      `isolated-audit-${Date.now()}.sqlite`,
    ),
  );
  global.create("isolated", {});
  const audit = Object.assign(Object.create(LiveAudit.prototype), {
    runtime: r,
    global,
    globalId: "isolated",
    policy: DEFAULT_BUDGET,
    startedAt: r.manifest.usage.startedAt,
  }) as InstanceType<typeof LiveAudit>;
  try {
    await audit.before({ messages: [] }, "same-request");
    await expect(
      audit.before({ messages: [] }, "same-request"),
    ).rejects.toThrow("do not redispatch");
    expect(
      r.controller.ledger.get(r.manifest.runId, "model:same-request")?.status,
    ).toBe("UNCERTAIN");
    expect(global.list("isolated")).toHaveLength(1);
    expect(global.list("isolated")[0].key).toContain(r.manifest.runId);
  } finally {
    audit.close();
    r.close();
  }
});
