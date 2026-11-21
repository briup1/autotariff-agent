import { beforeAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ClosureRuntime } from "../src/closure/runtime.js";
import { PROJECT_ROOT, PYTHON } from "../src/closure/paths.js";
import { runProcess } from "../src/closure/execute.js";
import { inventoryPage } from "../src/closure/source.js";
import { scanExpected } from "../src/closure/oracle.js";
const root = resolve(PROJECT_ROOT, "template_runs/scenario-fixtures");
let parser: string;
beforeAll(async () => {
  await runProcess(PYTHON, [
    resolve(PROJECT_ROOT, "src/workers/fixtures.py"),
    root,
  ]);
  parser = await readFile(
    resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
    "utf8",
  );
}, 20000);
async function setup(name: string): Promise<ClosureRuntime> {
  const r = new ClosureRuntime({
    provider: "offline",
    modelId: "none",
    sourcePath: resolve(root, name),
    pythonBin: PYTHON,
    runDate: "2026-11-03",
    runYear: 2026,
    maxAgentTurns: 12,
    storagePath: ":memory:",
  });
  await r.bootstrap();
  await r.inspect(0, 7);
  return r;
}
it("C01 feedback locates missing quote; new parser snapshot actually reruns and repairs without regression", async () => {
  const r = await setup("small.xlsx");
  try {
    const broken = parser.replace(
      "json.dump(result,",
      "json.dump(result[:-1],",
    );
    await r.prepare(broken, {
      route: "excel_script",
      reason: "controlled omission",
    });
    await r.execute();
    await r.postprocess();
    const first = await r.validate();
    expect(
      first.issues.some(
        (i) =>
          i.code === "MISSING_RECORD" && i.sourceIds.includes("Rates!R4C1"),
      ),
    ).toBe(true);
    const ref = r.attempt.parser;
    await r.prepare(
      parser,
      { route: "excel_script", reason: "repair the omitted final row" },
      ref,
    );
    await r.execute();
    await r.postprocess();
    const second = await r.validate();
    expect(second.issues).toEqual([]);
    expect(r.manifest.attempts).toHaveLength(2);
    expect(r.attempt.feedbackRefs).toHaveLength(1);
    expect(
      await readFile(r.store.path(r.manifest.runId, ref.relativePath), "utf8"),
    ).toBe(broken);
  } finally {
    r.close();
  }
}, 15000);
it("C06 C07 hidden rows/columns/sheets, full and partial strike, invisible displays retain quotes and evidence", async () => {
  const r = await setup("styles.xlsx");
  try {
    expect(r.inventory.cells.some((c) => c.hiddenRow)).toBe(true);
    expect(r.inventory.cells.some((c) => c.hiddenColumn)).toBe(true);
    expect(r.inventory.sheets.some((s) => s.hidden)).toBe(true);
    expect(r.inventory.cells.some((c) => c.style?.strike)).toBe(true);
    expect(
      r.inventory.cells.some((c) => c.style?.richText.some((t) => t.strike)),
    ).toBe(true);
    expect(
      r.inventory.cells.some((c) => c.displayedValue === "" && c.value != null),
    ).toBe(true);
    await r.prepare(parser, {
      route: "excel_script",
      reason: "style evidence retained",
    });
    await r.execute();
    await r.postprocess();
    expect((await r.validate()).issues).toEqual([]);
    const final = JSON.parse(
      (await r.store.read(r.attempt.finalResult!)).toString(),
    );
    expect(final).toHaveLength(4);
    expect(final[3]["20GP卖价"]).toBe(-20);
  } finally {
    r.close();
  }
}, 15000);
it("C08 C09 full 5005 rows scanned with cross-page merges; pagination invariant", async () => {
  const r = await setup("large.xlsx");
  try {
    await r.prepare(parser, {
      route: "excel_script",
      reason: "full scale scan",
    });
    await r.execute();
    await r.postprocess();
    expect((await r.validate()).issues).toEqual([]);
    const raw = JSON.parse(
      (await r.store.read(r.attempt.rawResult!)).toString(),
    );
    expect(raw).toHaveLength(5005);
    for (const size of [7, 128, 500]) {
      const seen: string[] = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page = inventoryPage(r.inventory, cursor, size) as {
          cells: Array<{ sourceId: string }>;
          nextCursor: number | null;
        };
        seen.push(...page.cells.map((c) => c.sourceId));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(r.inventory.cells.map((c) => c.sourceId));
    }
  } finally {
    r.close();
  }
}, 40000);
it("C10 C11 C12 C13 side tables/reordered columns, multi-tier headers, repeated headers, legal duplicates and scoped currencies", async () => {
  for (const file of ["side-by-side.xlsx", "contexts.xlsx"]) {
    const r = await setup(file);
    try {
      await r.prepare(parser, {
        route: "excel_script",
        reason: "region-specific mappings",
      });
      await r.execute();
      await r.postprocess();
      expect((await r.validate()).issues).toEqual([]);
      const rows = JSON.parse(
        (await r.store.read(r.attempt.rawResult!)).toString(),
      );
      if (file === "contexts.xlsx") {
        expect(rows).toHaveLength(3);
        expect(rows.map((x: Record<string, unknown>) => x["币种"])).toEqual([
          "USD",
          "USD",
          "CNY",
        ]);
        expect(rows[0].origin).toBe(rows[1].origin);
        expect(rows.map((row: Record<string, unknown>) => row["单位"])).toEqual(
          ["box", "box", "container"],
        );
        expect(
          rows.map((row: Record<string, unknown>) => row["运价备注"]),
        ).toEqual([
          "first | sheet-shared",
          "first | sheet-shared",
          "second | sheet-shared",
        ]);
      } else {
        expect(rows).toHaveLength(2);
        expect(rows[1]["20GP卖价"]).toBe(100);
      }
    } finally {
      r.close();
    }
  }
  const r = await setup("ambiguous.xlsx");
  try {
    expect(scanExpected(r.inventory).regions).toHaveLength(1);
  } finally {
    r.close();
  }
}, 15000);
it("C14 ambiguous context is located and prevents passing", async () => {
  const r = await setup("ambiguous.xlsx");
  try {
    await r.prepare(parser, {
      route: "excel_script",
      reason: "retain ambiguous source",
    });
    await r.execute();
    await r.postprocess();
    const report = await r.validate();
    expect(
      report.issues.find((i) => i.code === "AMBIGUOUS_CONTEXT")?.sourceIds,
    ).toEqual(["Rates!A4"]);
    expect(r.manifest.decision).not.toBe("PASS");
  } finally {
    r.close();
  }
});
it("C15 actual validation detects extra/wrong price and post-processing mutation while legal normalization passes", async () => {
  const r = await setup("small.xlsx");
  try {
    await r.prepare(
      parser
        .replace(
          "result.append(record)",
          'record["20GP卖价"] = 999\n            result.append(record)',
        )
        .replace(
          "json.dump(result,",
          'result.append(dict(result[0],recordId="fabricated",sourceId="fabricated"))\njson.dump(result,',
        ),
      { route: "excel_script", reason: "controlled price corruption" },
    );
    await r.execute();
    await r.postprocess();
    const report = await r.validate();
    expect(
      report.issues.some(
        (i) => i.code === "FIELD_MISMATCH" && i.expected?.["20GP卖价"] === -10,
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (i) => i.code === "EXTRA_RECORD" && i.resultIds.includes("fabricated"),
      ),
    ).toBe(true);
  } finally {
    r.close();
  }
});
it("C17 empty supported tariff is legal; nonempty unknown layout is explicitly blocked", async () => {
  for (const file of ["empty.xlsx", "unsupported.xlsx"]) {
    const r = await setup(file);
    try {
      await r.prepare(parser, {
        route: "excel_script",
        reason: "empty semantics",
      });
      await r.execute();
      await r.postprocess();
      const result = await r.validate();
      expect(result.status).toBe(file === "empty.xlsx" ? "REVIEW" : "BLOCKED");
    } finally {
      r.close();
    }
  }
});
it("C15 full run detects injected post-processing corruption and blocks unavailable checking dependency", async () => {
  const r = await setup("small.xlsx");
  let id: string;
  try {
    await r.prepare(parser, {
      route: "excel_script",
      reason: "post-process fault",
    });
    await r.execute();
    await r.postprocess();
    const final = JSON.parse(
      (await r.store.read(r.attempt.finalResult!)).toString(),
    );
    final[0]["20GP卖价"] = 999;
    r.attempt.finalResult = await r.save(
      "outputs/attempt-001/controlled-corrupt-final.json",
      final,
      "controlled-postprocess-fault",
    );
    const report = await r.validate();
    expect(
      report.issues.some(
        (i) => i.code === "POST_PROCESS_MUTATION" && i.stage === "post_process",
      ),
    ).toBe(true);
    id = r.manifest.runId;
  } finally {
    r.close();
  }
  const broken = new ClosureRuntime({
    provider: "offline",
    modelId: "none",
    sourcePath: resolve(root, "small.xlsx"),
    pythonBin: resolve(PROJECT_ROOT, ".tmp/missing-python"),
    runDate: "2026-11-03",
    runYear: 2026,
    maxAgentTurns: 12,
    storagePath: ":memory:",
  });
  try {
    await broken.bootstrap(id!);
    broken.attempt.finalResult = await broken.save(
      "outputs/attempt-001/new-check-input.json",
      [],
      "fault-check-input",
    );
    const result = await broken.validate();
    expect(result.status).toBe("BLOCKED");
    expect(result.issues[0].code).toBe("CHECKER_FAILED");
    expect(broken.manifest.decision).toBe("BLOCKED");
  } finally {
    broken.close();
  }
});
it("C17 two consecutive non-progress repairs stop and retain distinct complete attempt snapshots", async () => {
  const r = await setup("small.xlsx");
  try {
    const broken = parser.replace(
      "json.dump(result,",
      "json.dump(result[:-1],",
    );
    for (let n = 0; n < 3; n++) {
      await r.prepare(broken, {
        route: "excel_script",
        reason: "same unresolved controlled omission",
      });
      await r.execute();
      await r.postprocess();
      await r.validate();
    }
    expect(r.manifest.noProgress).toBe(2);
    expect(r.manifest.decision).toBe("REVIEW");
    expect(r.manifest.attempts).toHaveLength(3);
  } finally {
    r.close();
  }
}, 15000);
it("C10 explicit main/surcharge intents stay with their source regions when tables swap positions", async () => {
  const views: unknown[][] = [];
  for (const file of ["side-by-side.xlsx", "swapped.xlsx"]) {
    const r = await setup(file);
    try {
      await r.prepare(parser, {
        route: "excel_script",
        reason: "explicit title plus header intent evidence",
      });
      await r.execute();
      await r.postprocess();
      expect((await r.validate()).issues).toEqual([]);
      const rows = JSON.parse(
        (await r.store.read(r.attempt.rawResult!)).toString(),
      ) as Record<string, unknown>[];
      views.push(
        rows
          .map((row) => ({
            origin: row.origin,
            price: row["20GP卖价"],
            type: row.tariffType,
          }))
          .sort((a, b) => String(a.origin).localeCompare(String(b.origin))),
      );
    } finally {
      r.close();
    }
  }
  expect(views[0]).toEqual(views[1]);
}, 15000);
it("C11 actual merged multi-tier header parses; ambiguous buy/sell under a merged price header prevents success", async () => {
  const r = await setup("tiered.xlsx");
  try {
    await r.prepare(parser, {
      route: "excel_script",
      reason: "merged header tiers",
    });
    await r.execute();
    await r.postprocess();
    expect((await r.validate()).issues).toEqual([]);
    expect(r.records).toHaveLength(1);
  } finally {
    r.close();
  }
  const a = await setup("ambiguous-header.xlsx");
  try {
    expect(
      scanExpected(a.inventory).issues.some(
        (i) => i.code === "AMBIGUOUS_HEADER",
      ),
    ).toBe(true);
  } finally {
    a.close();
  }
}, 15000);
it("C07 C15 cached formula has raw/display evidence and extracts; absent formula cache blocks checking explicitly", async () => {
  for (const file of ["formula-cached.xlsx", "formula-uncached.xlsx"]) {
    const r = await setup(file);
    try {
      expect(
        r.inventory.cells.find((c) => c.coordinate === "B2")?.formula,
      ).toBe("=10+5");
      await r.prepare(parser, {
        route: "excel_script",
        reason: "formula cache evidence",
      });
      await r.execute();
      await r.postprocess();
      const report = await r.validate();
      if (file === "formula-cached.xlsx") {
        expect(r.records[0]["20GP卖价"]).toBe(15);
        expect(report.issues).toEqual([]);
      } else {
        expect(report.status).toBe("BLOCKED");
        expect(
          report.issues.some((i) => i.code === "UNSUPPORTED_FORMULA"),
        ).toBe(true);
      }
    } finally {
      r.close();
    }
  }
}, 15000);
it("C08 actual sandbox parser omits middle, batch-boundary and final records; full runtime validation locates all three", async () => {
  const r = await setup("large.xlsx");
  try {
    const omitted = ["Rates!R129C1", "Rates!R2502C1", "Rates!R5006C1"];
    const faulty = parser.replace(
      "result.append(record)",
      `if record_id not in ${JSON.stringify(omitted)}: result.append(record)`,
    );
    await r.prepare(faulty, {
      route: "excel_script",
      reason: "controlled large omissions at boundary, middle and last row",
    });
    await r.execute();
    expect(r.records).toHaveLength(5002);
    await r.postprocess();
    const report = await r.validate();
    expect(report.status).toBe("FAIL");
    expect(
      report.issues
        .filter((i) => i.code === "MISSING_RECORD")
        .map((i) => i.resultIds[0])
        .sort(),
    ).toEqual(omitted.sort());
  } finally {
    r.close();
  }
}, 20000);
it("C17 abnormal empty extraction from a source with quotes is rejected by the actual runtime", async () => {
  const r = await setup("small.xlsx");
  try {
    await r.prepare('import json,sys\njson.dump([],open(sys.argv[2],"w"))', {
      route: "excel_script",
      reason: "controlled abnormal empty extraction",
    });
    await r.execute();
    await r.postprocess();
    const report = await r.validate();
    expect(report.status).toBe("FAIL");
    expect(
      report.issues.filter((i) => i.code === "MISSING_RECORD"),
    ).toHaveLength(3);
    expect(r.manifest.decision).not.toBe("PASS");
  } finally {
    r.close();
  }
});
it("C09 C23 source and normalized expectations freeze before parser creation; changed basis blocks actual validation", async () => {
  const r = await setup("small.xlsx");
  try {
    expect(r.manifest.binding?.sourceExpectationDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(r.manifest.attempts).toHaveLength(0);
    await r.prepare(parser, {
      route: "excel_script",
      reason: "frozen-basis drift injection",
    });
    await r.execute();
    await r.postprocess();
    r.manifest.binding!.sourceExpectationDigest = "controlled-drift";
    const result = await r.validate();
    expect(result.status).toBe("BLOCKED");
    expect(result.issues[0].code).toBe("SOURCE_EXPECTATION_DRIFT");
  } finally {
    r.close();
  }
});
it("C15 legal early money/date/container/remark normalization passes the full source and postprocess checks", async () => {
  const r = await setup("normalization.xlsx");
  try {
    const early = parser.replace(
      "result.append(record)",
      'record["20GP卖价"] = 1200\n            record["40GP卖价"] = 200\n            record["ETD"] = record["ETD"].date().isoformat()\n            record["运价备注"] = [" prepaid ", " note "]\n            result.append(record)',
    );
    await r.prepare(early, {
      route: "excel_script",
      reason: "legal early equivalent normalization",
    });
    await r.execute();
    await r.postprocess();
    const checked = await r.validate();
    expect(checked.issues).toEqual([]);
    const final = JSON.parse(
      (await r.store.read(r.attempt.finalResult!)).toString(),
    );
    expect(final[0]).toMatchObject({
      "20GP卖价": 1200,
      "40GP卖价": 200,
      "40HQ卖价": 200,
      ETD: "2026-08-07",
      运价备注: "prepaid | note",
    });
  } finally {
    r.close();
  }
});
