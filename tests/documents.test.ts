import { it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ClosureRuntime } from "../src/closure/runtime.js";
import { inspectDocument, ocrBinary } from "../src/closure/documents.js";
import { runProcess } from "../src/closure/execute.js";
import { PROJECT_ROOT, PYTHON } from "../src/closure/paths.js";
import { scanExpected } from "../src/closure/oracle.js";
const root = resolve(PROJECT_ROOT, "template_runs/nonexcel-fixtures");
beforeAll(async () => {
  await runProcess(PYTHON, [
    resolve(PROJECT_ROOT, "src/workers/fixtures.py"),
    root,
  ]);
}, 20000);
it("C03 real two-page PDF converts to mapped Excel, sandbox parser runs, original-source validation retains both pages and remarks", async () => {
  const r = new ClosureRuntime({
    provider: "offline",
    modelId: "none",
    sourcePath: resolve(root, "table.pdf"),
    pythonBin: PYTHON,
    runDate: "2026-11-03",
    runYear: 2026,
    maxAgentTurns: 12,
    storagePath: ":memory:",
  });
  try {
    await r.bootstrap();
    await r.inspect(0, 10);
    expect(r.document?.units).toHaveLength(2);
    await r.convert();
    const parser = await readFile(
      resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
      "utf8",
    );
    await r.prepare(parser, {
      route: "converted_excel_script",
      reason: "genuine PDF table conversion",
    });
    await r.execute();
    await r.postprocess();
    expect((await r.validate()).issues).toEqual([]);
    const result = JSON.parse(
      (await r.store.read(r.attempt.rawResult!)).toString(),
    );
    expect(result).toHaveLength(2);
    expect(result.map((x: Record<string, unknown>) => x["运价备注"])).toEqual([
      "source note",
      "source note",
    ]);
  } finally {
    r.close();
  }
}, 20000);
it("C04 source DOCX paragraphs are really read; independent narrow grammar retains both narrative quotes", async () => {
  const e = await inspectDocument(resolve(root, "narrative.docx"), PYTHON);
  expect(e.units[0].text).toContain("SHA-BUSAN");
  expect(scanExpected(e.inventory).records).toHaveLength(2);
});
it("real image file is independently OCR scanned with native Vision coordinates, without network", async () => {
  await ocrBinary();
  const e = await inspectDocument(resolve(root, "quote.png"), PYTHON);
  expect(e.units[0].text).toContain("SHA-BUSAN");
  expect(scanExpected(e.inventory).records).toHaveLength(1);
  expect(e.mapping.length).toBeGreaterThan(0);
}, 120000);
it("C05 physical converted workbook loses a row; actual run detects conversion-stage loss before route switching", async () => {
  const { injectConversionLoss } =
    await import("../src/closure/conversion-fault-fixture.js");
  const r = new ClosureRuntime({
    provider: "offline",
    modelId: "none",
    sourcePath: resolve(root, "table.pdf"),
    pythonBin: PYTHON,
    runDate: "2026-11-03",
    runYear: 2026,
    maxAgentTurns: 12,
    storagePath: ":memory:",
  });
  try {
    await r.bootstrap();
    await r.inspect();
    await r.convert();
    await injectConversionLoss(r);
    await r.prepare(
      await readFile(
        resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
        "utf8",
      ),
      {
        route: "converted_excel_script",
        reason: "controlled real conversion loss",
      },
    );
    await r.execute();
    await r.postprocess();
    const report = await r.validate();
    expect(
      report.issues.some(
        (i) =>
          i.stage === "conversion" &&
          i.code === "MISSING_RECORD" &&
          i.sourceIds.includes("Page2!R2C1"),
      ),
    ).toBe(true);
    // Controlled host oracle is used here only to verify direct-route transport. Real Pi switching is a separate live requirement.
    const source = scanExpected(r.inventory).records;
    await r.prepare(JSON.stringify(source), {
      route: "direct_llm",
      reason: "offline direct-route transport fixture",
    });
    await r.execute();
    await r.postprocess();
    expect((await r.validate()).issues).toEqual([]);
  } finally {
    r.close();
  }
}, 20000);
