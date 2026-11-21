import { it, expect } from "vitest";
import { postProcess } from "../src/closure/postprocess.js";
it("literal contract examples independently constrain dates, money normalization, negative preservation and container relations", () => {
  const raws = [
    {
      ETD: "8月7日",
      "20GP卖价": "USD 1,200",
      "40GP卖价": null,
      "40HQ卖价": -10,
    },
    {
      ETD: "8月4日晚开14日",
      "20GP卖价": "-5",
      "40GP卖价": "200",
      "40HQ卖价": null,
    },
    { ETD: "8.1-30", "20GP卖价": 0, "40GP卖价": 0, "40HQ卖价": 0 },
  ];
  const result = postProcess(raws, "2026-11-03", 2026);
  expect(result.map((r) => r.ETD)).toEqual([
    "2026-08-07",
    "2026-08-14",
    "2026-08-30",
  ]);
  expect(result.map((r) => r["20GP卖价"])).toEqual([1200, -5, 0]);
  expect(result.map((r) => r["40GP卖价"])).toEqual([-10, 200, 0]);
  expect(result.map((r) => r["40HQ卖价"])).toEqual([-10, 200, 0]);
  expect(
    result.every(
      (r) =>
        r["运价有效结束时间"] === r.ETD &&
        r["运价有效开始时间"] === "2026-11-03",
    ),
  ).toBe(true);
});
it("unknown nonempty ETD is explicitly reported instead of treating null normalization as checked success", async () => {
  const { detectPostProcessMutation } =
    await import("../src/closure/validation.js");
  const raw = [
    {
      recordId: "unknown-date",
      sourceId: "unknown-date",
      ETD: "date to be confirmed",
    },
  ];
  const report = detectPostProcessMutation(
    "attempt-001",
    raw,
    postProcess(raw, "2026-11-03", 2026),
    "v002",
  );
  expect(
    report.issues.some(
      (i) => i.code === "UNKNOWN_ETD" && i.expected?.ETD === "unknown",
    ),
  ).toBe(true);
});
