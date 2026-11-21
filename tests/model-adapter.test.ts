import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createConfiguredModels } from "../src/models.js";
import type { RuntimeConfig } from "../src/config.js";
import type { LiveAudit } from "../src/closure/live-budget.js";

const oldKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldKey;
});

it("persists an actual gateway stream in Pi while monetary cost remains outside the protocol", async () => {
  process.env.OPENAI_API_KEY = "local-test-placeholder";
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (delta: unknown, finish: string | null, usage?: unknown): string => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    response.end(event({ role: "assistant", content: "已读取真实测试响应。" }, null) + event({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local test server not listening");
  const costs: unknown[] = [];
  const audit = {
    runtime: { manifest: { phase: "PREPARE", usage: { startedAt: new Date().toISOString() }, budget: { maxWallTimeSeconds: 60 } } },
    cached: async () => undefined,
    before: async () => ({ local: { status: "STARTED" }, global: { status: "STARTED" }, requestId: "local-test" }),
    after: async (_ticket: unknown, result: { usage?: { cost?: unknown } } | undefined) => { if (result) costs.push(result.usage?.cost); },
  } as unknown as LiveAudit;
  const models = createConfiguredModels({ provider: "local-test", modelId: "local-model", baseUrl: `http://127.0.0.1:${address.port}/v1` } as RuntimeConfig, audit);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "local-test", modelId: "local-model" }, tools: [] } });
    const submission = await root.submit({ type: "input", content: "读取测试响应" }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    expect(settled, JSON.stringify(settled)).toMatchObject({ status: "done" });
    expect(costs).toHaveLength(1);
    expect(Object.values(costs[0] as Record<string, unknown>).every((value) => typeof value !== "number" || Number.isFinite(value))).toBe(true);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it("retries a gateway that refuses the request, and stops after the budgeted retries", async () => {
  process.env.OPENAI_API_KEY = "local-test-placeholder";
  process.env.PI_REFUSED_RETRY_DELAY_MS = "10";
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    calls += 1;
    if (calls <= 2) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Our servers are currently overloaded. Please try again later." } }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (delta: unknown, finish: string | null, usage?: unknown): string =>
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    response.end(
      event({ role: "assistant", content: "网关恢复后正常回答。" }, null) +
        event({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local test server not listening");
  const outcomes: string[] = [];
  const audit = {
    runtime: { manifest: { phase: "PREPARE", usage: { startedAt: new Date().toISOString() }, budget: { maxWallTimeSeconds: 60 } } },
    cached: async () => undefined,
    before: async () => ({ local: { status: "STARTED" }, global: { status: "STARTED" }, requestId: "local-test" }),
    after: async () => {
      // The first two dispatches are refused by the gateway; the third is served.
      const outcome = outcomes.length < 2 ? "not_served" : "completed";
      outcomes.push(outcome);
      return outcome;
    },
  } as unknown as LiveAudit;
  const models = createConfiguredModels({ provider: "local-test", modelId: "local-model", baseUrl: `http://127.0.0.1:${address.port}/v1` } as RuntimeConfig, audit);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "local-test", modelId: "local-model" }, tools: [] } });
    const settled = await root.submit({ type: "input", content: "say hi" }, BACKGROUND_CONTEXT).then((submission) => submission.wait(BACKGROUND_CONTEXT));
    expect(settled, JSON.stringify(settled)).toMatchObject({ status: "done" });
    expect(calls).toBe(3);
    expect(outcomes).toEqual(["not_served", "not_served", "completed"]);
  } finally {
    delete process.env.PI_REFUSED_RETRY_DELAY_MS;
    await harness.close(BACKGROUND_CONTEXT);
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 30000);
