import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { terminalOutcome } from "../src/web/service.js";
import { PROJECT_ROOT } from "../src/closure/paths.js";

describe("layer 1: the workspace is a conversation first", () => {
  it("treats a turn without an extraction attempt as an answer, not a review", () => {
    expect(terminalOutcome(0)).toBe("answer");
    expect(terminalOutcome(1)).toBe("review");
    expect(terminalOutcome(3)).toBe("review");
  });

  it("tells the Agent to answer first and only extract on an explicit request", async () => {
    const prompt = await readFile(resolve(PROJECT_ROOT, "config/llm/system-prompt.md"), "utf8");
    expect(prompt).toContain("Layer 1, conversation");
    expect(prompt).toContain("Layer 2, extraction");
    expect(prompt).toMatch(/A file was attached to this conversation; that alone is not a request to extract/);
    expect(prompt).toMatch(/Never start an extraction because a file exists/);
    expect(prompt).toMatch(/Never reply with only a status line/);
  });

  it("keeps the answer-first instruction in a configurable template, not in code", async () => {
    const template = await readFile(resolve(PROJECT_ROOT, "config/llm/runtime-context.md"), "utf8");
    expect(template).toMatch(/Answer the person's actual message first/);
    expect(template).toMatch(/is not an instruction to extract/);
    const service = await readFile(resolve(PROJECT_ROOT, "src/web/service.ts"), "utf8");
    // The runner renders the template instead of pasting instruction text into code.
    expect(service).toMatch(/renderTemplate\(await readPrompt\("runtime-context\.md"\)/);
    expect(service).not.toMatch(/Answer the person's actual message first, in Chinese\. Having a file/);
  });

  it("renders every placeholder the template declares", async () => {
    const { renderTemplate } = await import("../src/web/service.js");
    const template = await readFile(resolve(PROJECT_ROOT, "config/llm/runtime-context.md"), "utf8");
    const rendered = renderTemplate(template, {
      facts: "今天：2026-11-04（星期三）",
      conversationId: "c1",
      parentRunId: "none",
      messages: "[]",
      previous: "[]",
      contractHint: "confirmed-hint",
      request: "今天周几了",
    });
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    expect(rendered).toContain("今天周几了");
    expect(rendered).toContain("confirmed-hint");
  });
});
