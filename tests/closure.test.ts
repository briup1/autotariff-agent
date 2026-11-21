import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/closure/artifacts.js";
import { transition } from "../src/closure/state.js";
import {
  compareResults,
  detectPostProcessMutation,
} from "../src/closure/validation.js";
describe("closure boundary behavior", () => {
  it("rejects an artifact path outside the current run", async () => {
    const store = new ArtifactStore(process.cwd());
    await expect(
      store.put("run", "../escape.txt", "x", "test"),
    ).rejects.toThrow("escapes");
  });

  it("keeps the state machine explicit", () => {
    expect(transition("PREPARE", "INVENTORIED")).toBe("INVENTORIED");
    expect(() => transition("PASS", "RUNNING")).toThrow(
      "Invalid run transition",
    );
  });

  it("preserves a matching negative price without a blocking issue", () => {
    const rows = [
      {
        recordId: "negative-source",
        sourceId: "negative-source",
        "20GP卖价": -10,
      },
    ];
    expect(compareResults("attempt-001", rows, rows, "v002").issues).toEqual(
      [],
    );
  });

  it("locates a missing record and field mismatch", () => {
    const report = compareResults(
      "attempt-001",
      [{ recordId: "上海!R5", sourceId: "上海!R5", "20GP卖价": 20 }],
      [
        { recordId: "上海!R5", sourceId: "上海!R5", "20GP卖价": 10 },
        { recordId: "上海!R6", sourceId: "上海!R6", "20GP卖价": 30 },
      ],
      "yishengchang-v001",
    );
    expect(report.issues.map((item) => item.code)).toEqual([
      "FIELD_MISMATCH",
      "MISSING_RECORD",
    ]);
    expect(report.issues[0]).toMatchObject({
      sourceIds: ["上海!R5"],
      resultIds: ["上海!R5"],
    });
    expect(report.issues[1]).toMatchObject({
      sourceIds: ["上海!R6"],
      resultIds: ["上海!R6"],
    });
  });

  it("locates a post-process mutation", () => {
    const report = detectPostProcessMutation(
      "attempt-001",
      [{ recordId: "上海!R5", sourceId: "上海!R5", amount: 10 }],
      [{ recordId: "上海!R5", sourceId: "上海!R5", amount: 999 }],
      "yishengchang-v001",
    );
    expect(report.issues[0]).toMatchObject({
      code: "POST_PROCESS_MUTATION",
      stage: "post_process",
      sourceIds: ["上海!R5"],
    });
  });
});
it("script diff preserves deletion of one repeated line", async () => {
  const { textDiff } = await import("../src/closure/artifacts.js");
  expect(textDiff("head\nrepeat\nrepeat\ntail", "head\nrepeat\ntail")).toEqual({
    startLine: 3,
    removed: ["repeat"],
    added: [],
  });
});
