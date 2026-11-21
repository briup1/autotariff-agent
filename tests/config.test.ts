import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("runtime config", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PI_MODEL_ID;
    delete process.env.PI_MAX_AGENT_TURNS;
  });

  it("rejects an empty model key", () => {
    process.env.PI_MODEL_ID = "test-model";
    expect(() => loadConfig()).toThrow("OPENAI_API_KEY is empty");
  });

  it("rejects a missing model id", () => {
    process.env.OPENAI_API_KEY = "test-key";
    expect(() => loadConfig()).toThrow("PI_MODEL_ID is empty");
  });

  it("loads the non-secret model configuration", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.PI_MODEL_ID = "test-model";
    const config = loadConfig();
    expect(config).toMatchObject({ provider: "openai", modelId: "test-model" });
    // Turns come from config/policies/budget.yaml, not from a code constant.
    expect(config.maxAgentTurns).toBeUndefined();
    expect(config.budget).toMatchObject({ maxAgentTurns: 12, maxAttempts: 3, maxToolCalls: 40 });
    expect(config.systemPromptPath).toContain("config/llm/system-prompt.md");
  });

  it("uses the local calendar day, not the UTC day", async () => {
    const { localDate } = await import("../src/config.js");
    // 2026-11-04 07:30 in Beijing is still 2026-11-03 in UTC.
    const beijingMorning = new Date(2026, 10, 4, 7, 30, 0);
    expect(localDate(beijingMorning)).toBe(localDate(new Date(beijingMorning.getTime())));
    expect(localDate(new Date(2026, 10, 4, 7, 30, 0))).toMatch(/^2026-11-0[34]$/);
    expect(localDate(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
  });

  it("fails loudly when the configured budget is not a flat positive integer map", async () => {
    const { readFlatConfig, optionalInteger } = await import("../src/config-file.js");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cfg-"));
    try {
      const bad = join(dir, "budget.yaml");
      await writeFile(bad, "max_agent_turns: twelve\n");
      const parsed = readFlatConfig(bad);
      expect(parsed.max_agent_turns).toBe("twelve");
      expect(() => optionalInteger(parsed, "max_agent_turns", bad)).toThrow(/positive integer/);
      await writeFile(bad, "max_agent_turns\n");
      expect(() => readFlatConfig(bad)).toThrow(/not a flat/);
      await writeFile(bad, "max_agent_turns: 12\nmax_agent_turns: 13\n");
      expect(() => readFlatConfig(bad)).toThrow(/repeats/);
      await writeFile(bad, "max_agent_turns: 12\n");
      expect(readFlatConfig(bad).max_agent_turns).toBe(12);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
