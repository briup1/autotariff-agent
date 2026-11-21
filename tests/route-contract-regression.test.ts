import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { scanConfig, validateContract } from "../src/closure/contract.js";
import { scanExpected } from "../src/closure/oracle.js";
import { ClosureRuntime } from "../src/closure/runtime.js";
import { runProcess } from "../src/closure/execute.js";
import { PYTHON } from "../src/closure/paths.js";
import type { SourceInventory } from "../src/closure/models.js";

function inventory(rows: unknown[][]): SourceInventory {
  return {
    sourceSha256: "regression-source",
    sheets: [{ name: "报价", maxRow: rows.length, maxColumn: rows[0].length, hidden: false }],
    cells: rows.flatMap((values, r) => values.map((value, c) => ({
      sourceId: `报价!R${r + 1}C${c + 1}`, sheet: "报价",
      coordinate: `${String.fromCharCode(65 + c)}${r + 1}`, row: r + 1, column: c + 1,
      value, formula: null, hiddenRow: false, hiddenColumn: false,
    }))),
    warnings: [],
  };
}

function candidate(originAliases: string[], destinationAliases: string[]) {
  return {
    fields: [
      { name: "origin", role: "text", aliases: originAliases, source: { kind: "column" } },
      { name: "destination", role: "text", aliases: destinationAliases, source: { kind: "column" } },
      { name: "20GP卖价", role: "price", aliases: ["20GP"], source: { kind: "column" } },
    ],
    route: { kind: "split", separators: ["-"] },
    checks: [{ id: "route", kind: "route_split", params: { fields: ["origin", "destination"] }, quote: "航线拆分" }],
  };
}

it.each([["起运港", "目的港"], ["ORIGIN", "DESTINATION"]])(
  "preserves legacy independent columns %s / %s",
  (origin, destination) => {
    const scan = scanExpected(inventory([[origin, destination, "20GP"], ["上海", "釜山", 80]]));
    expect(scan.records[0]).toMatchObject({ origin: "上海", destination: "釜山", "20GP卖价": 80 });
    expect(scan.issues).toEqual([]);
  },
);

it("still splits a legacy route column", () => {
  const scan = scanExpected(inventory([["航线", "20GP"], ["上海-釜山", 80]]));
  expect(scan.records[0]).toMatchObject({ origin: "上海", destination: "釜山", "20GP卖价": 80 });
  expect(scan.issues).toEqual([]);
});

it.each(["航线", "ROUTE"])("derives a candidate from a single %s column", (header) => {
  const { contract, issues } = validateContract(candidate([header], [header]));
  expect(issues).toEqual([]);
  expect(contract.fields.find((field) => field.name === "route")).toMatchObject({ aliases: [header], emit: false });
  const scan = scanExpected(inventory([[header, "20GP"], ["上海-釜山", 80]]), scanConfig(contract));
  expect(scan.records).toEqual([{ recordId: "报价!R2C1", sourceId: "报价!R2C1", origin: "上海", destination: "釜山", "20GP卖价": 80 }]);
  expect(scan.issues).toEqual([]);
});

it.each(["备注", "起运港"])("rejects unrelated shared alias %s without inventing a route", (alias) => {
  const raw = candidate([alias], [alias]);
  const { contract, issues } = validateContract(raw);
  expect(issues.filter((issue) => issue.code === "ROUTE_SOURCE")).toHaveLength(2);
  expect(contract.fields).toEqual(raw.fields);
});

it("preserves independent column sources in a columns contract", () => {
  const raw = { ...candidate(["起运港"], ["目的港"]), route: { kind: "columns", separators: ["-"] }, checks: [] };
  const { contract, issues } = validateContract(raw);
  expect(issues).toEqual([]);
  expect(contract.fields).toEqual(raw.fields);
  const scan = scanExpected(inventory([["起运港", "目的港", "20GP"], ["上海", "釜山", 80]]), scanConfig(contract));
  expect(scan.records[0]).toMatchObject({ origin: "上海", destination: "釜山", "20GP卖价": 80 });
  expect(scan.issues).toEqual([]);
});

it("does not replace independent aliases just because a route field exists", () => {
  const raw = candidate(["起运港", "航线"], ["目的港", "航线"]);
  raw.fields.unshift({ name: "route", role: "text", aliases: ["航线"], source: { kind: "column" } });
  const { contract, issues } = validateContract(raw);
  expect(issues.filter((issue) => issue.code === "ROUTE_SOURCE")).toHaveLength(2);
  expect(contract.fields).toEqual(raw.fields);
});

it("rejects an ambiguous pair of route source fields", () => {
  const raw = candidate(["航线"], ["航线"]);
  raw.fields.unshift(
    { name: "route", role: "text", aliases: ["航线"], source: { kind: "column" } },
    { name: "otherRoute", role: "text", aliases: ["航线"], source: { kind: "column" } },
  );
  const { contract, issues } = validateContract(raw);
  expect(issues.filter((issue) => issue.code === "ROUTE_SOURCE")).toHaveLength(2);
  expect(contract.fields).toEqual(raw.fields);
});

it("normalizes targets of an existing single route source column", () => {
  const raw = candidate(["航线"], ["航线"]);
  raw.fields.unshift({ name: "rawRoute", role: "text", aliases: ["航线"], source: { kind: "column" } });
  const { contract, issues } = validateContract(raw);
  expect(issues).toEqual([]);
  expect(contract.fields.filter((field) => ["origin", "destination"].includes(field.name)).map((field) => field.source)).toEqual([
    { kind: "route_split", from: "rawRoute", side: "origin" },
    { kind: "route_split", from: "rawRoute", side: "destination" },
  ]);
  const scan = scanExpected(inventory([["航线", "20GP"], ["上海-釜山", 80]]), scanConfig(contract));
  expect(scan.records[0]).toMatchObject({ origin: "上海", destination: "釜山", "20GP卖价": 80 });
  expect(scan.issues).toEqual([]);
});

it("does not treat a constant route field as a source column", () => {
  const raw = candidate(["航线"], ["航线"]);
  const fields = [{ name: "rawRoute", role: "text", aliases: ["航线"], source: { kind: "constant", value: "上海-釜山" } }, ...raw.fields];
  const { contract, issues } = validateContract({ ...raw, fields });
  expect(issues.filter((issue) => issue.code === "ROUTE_SOURCE")).toHaveLength(2);
  expect(contract.fields).toEqual(fields);
});

it("does not split unrelated aliases of a field also named route", () => {
  const raw = candidate(["备注"], ["备注"]);
  raw.fields.unshift({ name: "route", role: "text", aliases: ["航线", "备注"], source: { kind: "column" } });
  const { contract, issues } = validateContract(raw);
  expect(issues.filter((issue) => issue.code === "ROUTE_SOURCE")).toHaveLength(2);
  expect(contract.fields).toEqual(raw.fields);
});

it("keeps explicitly derived split fields when independent header words are present", () => {
  const { contract, issues } = validateContract({
    ...candidate([], []),
    fields: [
      { name: "route", role: "text", aliases: ["航线"], emit: false },
      { name: "origin", role: "text", aliases: ["起运港"], source: { kind: "route_split", from: "route", side: "origin" } },
      { name: "destination", role: "text", aliases: ["目的港"], source: { kind: "route_split", from: "route", side: "destination" } },
      { name: "20GP卖价", role: "price", aliases: ["20GP"] },
    ],
  });
  expect(issues).toEqual([]);
  const scan = scanExpected(inventory([["航线", "起运港", "目的港", "20GP"], ["上海-釜山", "错误起点", "错误终点", 80]]), scanConfig(contract));
  expect(scan.records[0]).toMatchObject({ origin: "上海", destination: "釜山", "20GP卖价": 80 });
  expect(scan.issues).toEqual([]);
});

it.each([
  { name: undefined, index: 0 }, { name: 123, index: 0 },
  { name: undefined, index: 2 }, { name: 123, index: 2 },
])("rejects invalid field name $name at index $index and archives the exact draft", async ({ name, index }) => {
  const root = await mkdtemp(resolve(tmpdir(), "route-contract-rejection-"));
  const sourcePath = resolve(root, "source.xlsx");
  await runProcess(PYTHON, ["-c", `import openpyxl
b=openpyxl.Workbook();s=b.active;s.append(["航线","20GP"]);s.append(["上海-釜山",80]);b.save(${JSON.stringify(sourcePath)})`]);
  const runtime = new ClosureRuntime({ projectRoot: root, provider: "offline", modelId: "none", sourcePath, pythonBin: PYTHON, runDate: "2026-11-15", runYear: 2026, storagePath: ":memory:" });
  try {
    await runtime.bootstrap();
    await runtime.inspect();
    const raw = candidate(["航线"], ["航线"]);
    const fields: unknown[] = [...raw.fields];
    fields[index] = { name, role: "price", aliases: ["20GP"] };
    const input = { ...raw, fields };
    const draft = JSON.parse(JSON.stringify(input));
    const result = await runtime.draftContract({ contract: JSON.stringify(draft) }) as { accepted: boolean; issues: unknown[]; rejectedAt: string };
    expect(result.accepted).toBe(false);
    expect(result.issues).toContainEqual({ code: "FIELD_NAME", message: "Field name is required", path: `fields[${index}]` });
    const ref = runtime.manifest.refs!["rejected-1"];
    expect(result.rejectedAt).toBe(ref.relativePath);
    expect(JSON.parse((await runtime.store.read(ref)).toString())).toEqual({ issues: result.issues, draft });
    const savedManifest = await runtime.controller.readManifest(runtime.manifest.runId);
    expect(savedManifest.refs!["rejected-1"]).toEqual(ref);
    expect(runtime.contract).toBeUndefined();
    expect(runtime.manifest.refs!.contract).toBeUndefined();
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
