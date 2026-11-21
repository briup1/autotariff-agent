import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectPlanSource, planSource } from "../src/closure/plan-source.js";
import type { Contract } from "../src/closure/contract.js";
import { runProcess } from "../src/closure/execute.js";
import { PYTHON } from "../src/closure/paths.js";

let root: string;
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("normalizes fullwidth headers before structural region detection", async () => {
  root = await realpath(await mkdtemp(resolve(tmpdir(), "plan-source-")));
  const normal = resolve(root, "normal.xlsx"), fullwidth = resolve(root, "fullwidth.xlsx");
  await runProcess(PYTHON, ["-c", `from openpyxl import Workbook
for path, header in [(${JSON.stringify(normal)}, 'PORT'), (${JSON.stringify(fullwidth)}, 'ＰＯＲＴ')]:
 b=Workbook(); s=b.active; s.title='报价'; s.append([header, 'PRICE']); s.append(['上海', 200]); b.save(path)`]);
  const contract: Contract = { version: "v1", requirementsDigest: "a".repeat(64), requirementsSource: "uploaded", fields: [
    { name: "port", role: "text", aliases: ["PORT"], required: true },
    { name: "price", role: "price", aliases: ["PRICE"] },
  ], route: { kind: "columns", separators: [] }, checks: [] };
  const normalShape = planSource(await inspectPlanSource(normal), contract, "海运");
  const fullwidthShape = planSource(await inspectPlanSource(fullwidth), contract, "海运");
  expect(normalShape.applicable).toBe(true);
  expect(fullwidthShape.applicable).toBe(true);
  expect(fullwidthShape.sourceSignature).toBe(normalShape.sourceSignature);
});
