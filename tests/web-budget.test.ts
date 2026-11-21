import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { Ledger } from "../src/closure/ledger.js";
import { VISUAL_TASK_ID, VISUAL_TASK_POLICY } from "../src/closure/live-budget.js";
import { DEFAULT_BUDGET } from "../src/closure/runtime.js";

it("new web authorization admits call 1000, denies 1001, and preserves the old task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-budget-"));
  const ledger = new Ledger(join(dir, "budget.sqlite"));
  const now = new Date().toISOString();
  try {
    ledger.create("all-batches-2026-11-03", { calls: 10, immutable: true });
    const old = ledger.db.prepare("SELECT * FROM runs WHERE id=?").get("all-batches-2026-11-03");
    ledger.create(VISUAL_TASK_ID, { limits: VISUAL_TASK_POLICY });
    ledger.reserve(VISUAL_TASK_ID, "previous-calls", "model_request", { agentTurns: 999 }, VISUAL_TASK_POLICY, now);
    const last = ledger.reserve(VISUAL_TASK_ID, "call-1000", "model_request", { agentTurns: 1 }, VISUAL_TASK_POLICY, now, "never_auto_retry");
    expect(last.status).toBe("STARTED");
    expect(() => ledger.reserve(VISUAL_TASK_ID, "call-1001", "model_request", { agentTurns: 1 }, VISUAL_TASK_POLICY, now, "never_auto_retry")).toThrow("Budget exhausted");
    expect(ledger.totals(VISUAL_TASK_ID).agentTurns).toBe(1000);
    expect(ledger.db.prepare("SELECT * FROM runs WHERE id=?").get("all-batches-2026-11-03")).toEqual(old);
    expect(DEFAULT_BUDGET.maxAgentTurns).toBe(12);
    expect(DEFAULT_BUDGET.maxAttempts).toBe(3);
    expect(DEFAULT_BUDGET.maxInputTokens).toBe(100000);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("classifies an explicit gateway refusal so the reservation is returned instead of kept", async () => {
  const { providerRefused } = await import("../src/closure/live-budget.js");
  expect(providerRefused("Our servers are currently overloaded. Please try again later.")).toBe(true);
  expect(providerRefused("429 Too Many Requests")).toBe(true);
  expect(providerRefused("503 Service Unavailable")).toBe(true);
  expect(providerRefused("request timed out after 120000ms")).toBe(false);
  expect(providerRefused(undefined)).toBe(false);
});

it("returns the reservation when the gateway refused the request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-budget-"));
  const ledger = new Ledger(join(dir, "budget.sqlite"));
  const now = new Date().toISOString();
  try {
    ledger.create(VISUAL_TASK_ID, { limits: VISUAL_TASK_POLICY });
    const action = ledger.reserve(VISUAL_TASK_ID, "refused-call", "model_request", { agentTurns: 1, externalActions: 1 }, VISUAL_TASK_POLICY, now, "never_auto_retry");
    expect(ledger.totals(VISUAL_TASK_ID).agentTurns).toBe(1);
    action.status = "REJECTED";
    action.actual = { agentTurns: 0, externalActions: 0, inputTokens: 0, outputTokens: 0 };
    ledger.put(VISUAL_TASK_ID, action);
    // A refusal served no tokens, so the reservation must not consume the pool.
    expect(ledger.totals(VISUAL_TASK_ID).agentTurns).toBe(0);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
