import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ClosureRuntime } from "../src/closure/runtime.js";
import { approveStoredContract, readStoredContract, scanConfig, validateContract } from "../src/closure/contract.js";
import { scanExpected } from "../src/closure/oracle.js";
import type { SourceInventory } from "../src/closure/models.js";
import { runProcess } from "../src/closure/execute.js";
import { PYTHON } from "../src/closure/paths.js";
import type { ValidationReport } from "../src/closure/models.js";

const CONTRACT = {
  version: "a-company-v001",
  fields: [
    { name: "origin", role: "text", aliases: ["起运港"], required: true },
    { name: "destination", role: "text", aliases: ["目的港"], required: true },
    { name: "45HQ卖价", role: "price", aliases: ["45HQ"], required: true },
    { name: "币种", role: "enum", aliases: ["币种"], enum: ["USD", "CNY"] },
    { name: "ETD", role: "date", aliases: ["开船日期", "ETD"] },
    { name: "备注", role: "text", aliases: ["备注"], emit: false },
  ],
  route: { kind: "columns", separators: ["-"] },
  checks: [
    { id: "port-required", kind: "required_fields", params: { fields: ["origin", "destination"] }, quote: "起运港和目的港必须填写" },
    { id: "price-number", kind: "price_preserved", params: { fields: ["45HQ卖价"] }, quote: "45HQ 价格必须是数字" },
    { id: "currency-enum", kind: "enum", params: { field: "币种", values: ["USD", "CNY"] }, quote: "币种只能是 USD 或 CNY" },
    { id: "etd-format", kind: "date_normalize", params: { field: "ETD" }, quote: "开船日期统一为 YYYY-MM-DD" },
    { id: "unique-source", kind: "unique_source_ids", params: {}, quote: "每条记录对应唯一原文坐标" },
    { id: "remark-meaning", kind: "pattern", params: { field: "备注", pattern: "^$" }, quote: "备注的业务含义", status: "unchecked", reason: "备注口径待业务确认" },
  ],
};

const PARSER = `import json, sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1], data_only=True)
sheet = book[book.sheetnames[0]]
rows = list(sheet.iter_rows(values_only=True))
out = []
for index, row in enumerate(rows[1:], start=2):
    if not any(value not in (None, "") for value in row):
        continue
    row = list(row) + [None] * (6 - len(row))
    out.append({
        "recordId": f"{sheet.title}!R{index}C1",
        "sourceId": f"{sheet.title}!R{index}C1",
        "origin": row[0], "destination": row[1], "45HQ卖价": row[2],
        "币种": row[3], "ETD": row[4], "备注": row[5],
    })
open(sys.argv[2], "w").write(json.dumps(out))
`;

it("normalizes split-route candidates that repeat the route header", () => {
  const raw = {
    version: "yishengchang-v002-trial",
    fields: [
      { name: "origin", role: "text", aliases: ["航线"], required: true, source: { kind: "column" } },
      { name: "destination", role: "text", aliases: ["航线"], required: true, source: { kind: "column" } },
      { name: "20GP卖价", role: "price", aliases: ["20GP"], source: { kind: "column" } },
    ],
    route: { kind: "split", separators: ["-", "="] },
    checks: [{ id: "route", kind: "route_split", params: { fields: ["origin", "destination"] }, quote: "航线拆分" }],
  };
  const { contract, issues } = validateContract(raw);
  expect(issues).toEqual([]);
  expect(contract.fields.find((field) => field.name === "route")).toMatchObject({ emit: false, aliases: ["航线"] });
  expect(contract.fields.filter((field) => ["origin", "destination"].includes(field.name)).map((field) => field.source)).toEqual([
    { kind: "route_split", from: "route", side: "origin" },
    { kind: "route_split", from: "route", side: "destination" },
  ]);
  const cell = (row: number, column: number, value: unknown): SourceInventory["cells"][number] => ({
    sourceId: `上海!R${row}C${column}`,
    sheet: "上海",
    coordinate: `${String.fromCharCode(64 + column)}${row}`,
    row,
    column,
    value,
    formula: null,
    hiddenRow: false,
    hiddenColumn: false,
  });
  const inventory: SourceInventory = {
    sourceSha256: "source",
    sheets: [{ name: "上海", maxRow: 2, maxColumn: 2, hidden: false }],
    cells: [cell(1, 1, "航线"), cell(1, 2, "20GP"), cell(2, 1, "上海-釜山"), cell(2, 2, 80)],
    warnings: [],
  };
  const scan = scanExpected(inventory, scanConfig(contract));
  expect(scan.records).toEqual([{ recordId: "上海!R2C1", sourceId: "上海!R2C1", origin: "上海", destination: "釜山", "20GP卖价": 80 }]);
  expect(scan.issues).toEqual([]);
});

it("rejects split routes whose origin and destination are unrelated columns", () => {
  const { issues } = validateContract({
    fields: [
      { name: "origin", role: "text", aliases: ["起运港"], source: { kind: "column" } },
      { name: "destination", role: "text", aliases: ["目的港"], source: { kind: "column" } },
      { name: "price", role: "price", aliases: ["价格"] },
    ],
    route: { kind: "split", separators: ["-"] },
    checks: [{ id: "route", kind: "route_split", params: { fields: ["origin", "destination"] }, quote: "航线拆分" }],
  });
  expect(issues.some((issue) => issue.code === "ROUTE_SOURCE")).toBe(true);
});

it("keeps normalized split-route semantics in the draft self-check", async () => {
  const localRoot = await mkdtemp(resolve(tmpdir(), "contract-route-self-check-"));
  const sourcePath = resolve(localRoot, "route.xlsx"), requirementsPath = resolve(localRoot, "requirements.txt");
  await runProcess(PYTHON, ["-c", `import openpyxl
b=openpyxl.Workbook();s=b.active;s.title="上海";s.append(["航线","20GP"]);s.append(["上海-釜山",80]);b.save(${JSON.stringify(sourcePath)})`]);
  await writeFile(requirementsPath, "航线拆分为起运港和目的港，价格保留");
  const r = new ClosureRuntime({
    projectRoot: localRoot,
    provider: "offline",
    modelId: "none",
    sourcePath,
    requirementsPath,
    pythonBin: PYTHON,
    runDate: "2026-11-15",
    runYear: 2026,
    storagePath: ":memory:",
  });
  try {
    await r.bootstrap();
    await r.inspect();
    const drafted = (await r.draftContract({
      source: "uploaded",
      contract: JSON.stringify({
        version: "route-v1",
        fields: [
          { name: "origin", role: "text", aliases: ["航线"], required: true, source: { kind: "column" } },
          { name: "destination", role: "text", aliases: ["航线"], required: true, source: { kind: "column" } },
          { name: "20GP卖价", role: "price", aliases: ["20GP"], source: { kind: "column" } },
        ],
        route: { kind: "split", separators: ["-"] },
        checks: [{ id: "route", kind: "route_split", params: { fields: ["origin", "destination"] }, quote: "航线拆分" }],
      }),
    })) as { selfCheck: { scanIssuesTotal: number; expectedSample: Record<string, unknown>[] } };
    expect(drafted.selfCheck.scanIssuesTotal).toBe(0);
    expect(drafted.selfCheck.expectedSample[0]).toMatchObject({ origin: "上海", destination: "釜山", "20GP卖价": 80 });
  } finally {
    r.close();
    await rm(localRoot, { recursive: true, force: true });
  }
});

let root: string;
let source: string;
let requirements: string;

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "contract-test-"));
  source = resolve(root, "a-company.xlsx");
  requirements = resolve(root, "a-company-requirements.txt");
  await runProcess(PYTHON, ["-c", `import openpyxl
book = openpyxl.Workbook(); sheet = book.active; sheet.title = "报价"
sheet.append(["起运港", "目的港", "45HQ", "币种", "开船日期", "备注"])
sheet.append(["上海", "釜山", 1800, "USD", "2026-11-20", "含附加费"])
sheet.append(["宁波", "新加坡", 2100, "CNY", "11/25", "预付"])
sheet.append(["深圳", "曼谷", 1650, "USD", "2026-12-01", ""])
book.save(${JSON.stringify(source)})`]);
  await writeFile(requirements, [
    "A 公司运价说明：",
    "1. 起运港和目的港必须填写。",
    "2. 45HQ 价格必须是数字。",
    "3. 币种只能是 USD 或 CNY。",
    "4. 开船日期统一为 YYYY-MM-DD。",
    "5. 每条记录对应唯一原文坐标。",
  ].join("\n"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function runtime(templateName: string): ClosureRuntime {
  return new ClosureRuntime({
    provider: "offline",
    modelId: "none",
    sourcePath: source,
    requirementsPath: requirements,
    templateName,
    pythonBin: PYTHON,
    runDate: "2026-11-03",
    runYear: 2026,
    maxAgentTurns: 12,
    storagePath: ":memory:",
  });
}

it("admits an undocumented template, declares a contract, and extracts under it", async () => {
  const r = runtime(`a-company-${Date.now()}`);
  try {
    await r.bootstrap();
    expect(r.manifest.binding?.contractRequired).toBe(true);
    expect(r.manifest.binding?.contractStatus).toBe("missing");
    await r.inspect(0, 60);
    // No contract yet: extraction cannot start.
    await expect(
      r.prepare(PARSER, { route: "excel_script", reason: "premature" }),
    ).rejects.toThrow("draft_contract");
    const drafted = (await r.draftContract({
      contract: JSON.stringify(CONTRACT),
      source: "uploaded",
    })) as { accepted: boolean; selfCheck: Record<string, unknown> };
    expect(drafted.accepted).toBe(true);
    expect(drafted.selfCheck).toMatchObject({ regions: 1, expectedRecords: 3, unmatchedAliases: [], blindChecks: [] });
    expect((drafted.selfCheck.uncheckedRules as unknown[]).length).toBe(1);
    await r.prepare(PARSER, { route: "excel_script", reason: "contract driven" });
    await r.execute();
    await r.postprocess();
    const report: ValidationReport = await r.validate();
    expect(report.issues).toEqual([]);
    expect(report.status).toBe("REVIEW");
    expect(report.checkedRuleIds).toContain("currency-enum");
    expect(report.checkedRuleIds).toContain("price-number");
    expect(report.uncheckedRules).toEqual([{ id: "remark-meaning", reason: "备注口径待业务确认" }]);
    expect(r.manifest.binding?.contractStatus).toBe("candidate");
    const final = JSON.parse((await r.store.read(r.attempt.finalResult!)).toString());
    expect(final[0]).toMatchObject({ origin: "上海", destination: "釜山", "45HQ卖价": 1800, 币种: "USD", ETD: "2026-11-20" });
    expect(final[1].ETD).toBe("2026-11-25");
  } finally {
    r.close();
  }
}, 120000);

it("catches a value the contract forbids and a row the contract cannot derive", async () => {
  const templateName = `a-company-bad-${Date.now()}`;
  const r = runtime(templateName);
  try {
    await r.bootstrap();
    await r.inspect(0, 60);
    await r.draftContract({ contract: JSON.stringify(CONTRACT), source: "uploaded" });
    await r.prepare(
      `import json, sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1], data_only=True)
sheet = book[book.sheetnames[0]]
rows = list(sheet.iter_rows(values_only=True))
out = []
for index, row in enumerate(rows[1:], start=2):
    row = list(row) + [None] * (6 - len(row))
    out.append({"recordId": f"{sheet.title}!R{index}C1", "sourceId": f"{sheet.title}!R{index}C1",
                "origin": row[0], "destination": row[1], "45HQ卖价": (row[2] or 0) + 1,
                "币种": "EUR", "ETD": row[4], "备注": row[5]})
open(sys.argv[2], "w").write(json.dumps(out))
`,
      { route: "excel_script", reason: "wrong values" },
    );
    await r.execute();
    await r.postprocess();
    const report: ValidationReport = await r.validate();
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain("CONTRACT_ENUM");
    expect(report.status).toBe("FAIL");
    expect(r.manifest.phase).toBe("REPAIR_PENDING");
    expect(report.issues.some((issue) => issue.code === "CONTRACT_ENUM")).toBe(true);
    // The independent re-scan compares every declared field, so price drift is located too.
    expect(report.issues.length).toBeGreaterThan(2);
  } finally {
    r.close();
  }
}, 120000);

it("reuses and applies a confirmed contract without drafting again", async () => {
  const digest = (await readFile(requirements)).toString();
  const templateName = `a-company-approved-${Date.now()}`;
  const first = runtime(templateName);
  let contractVersion = "";
  let requirementsDigest = "";
  try {
    await first.bootstrap();
    await first.inspect(0, 60);
    const drafted = (await first.draftContract({
      contract: JSON.stringify(CONTRACT),
      source: "uploaded",
    })) as { contract: { version: string; requirementsDigest: string } };
    contractVersion = drafted.contract.version;
    requirementsDigest = drafted.contract.requirementsDigest;
    expect(requirementsDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    first.close();
  }
  void digest;
  const approval = await approveStoredContract(
    resolve(import.meta.dirname, ".."),
    requirementsDigest,
    "local-user",
  );
  expect(approval.contractVersion).toBe(contractVersion);
  const stored = await readStoredContract(resolve(import.meta.dirname, ".."), requirementsDigest);
  expect(stored?.approved).toBe(true);
  const next = runtime(templateName);
  try {
    await next.bootstrap();
    expect(next.contractConfirmed).toBe(true);
    expect(next.manifest.binding?.contractStatus).toBe("confirmed");
    expect(next.contract?.version).toBe(contractVersion);
    await next.inspect(0, 60);
    await next.prepare(PARSER, { route: "excel_script", reason: "confirmed contract" });
    await next.execute();
    await next.postprocess();
    const report = await next.validate();
    expect(report.issues).toEqual([]);
  } finally {
    next.close();
    await rm(resolve(import.meta.dirname, "..", "template_runs/contracts", requirementsDigest), { recursive: true, force: true });
  }
}, 120000);

it("accepts a revised draft without overwriting the earlier contract evidence", async () => {
  const r = runtime(`a-company-twice-${Date.now()}`);
  try {
    await r.bootstrap();
    await r.inspect(0, 60);
    const first = (await r.draftContract({ contract: JSON.stringify(CONTRACT), source: "uploaded" })) as { accepted: boolean };
    expect(first.accepted).toBe(true);
    const revised = {
      ...CONTRACT,
      version: "a-company-v002",
      fields: [...CONTRACT.fields, { name: "中转港", role: "text" as const, aliases: ["中转港"] }],
    };
    const second = (await r.draftContract({ contract: JSON.stringify(revised), source: "uploaded" })) as { accepted: boolean };
    expect(second.accepted).toBe(true);
    const drafts = Object.keys(r.manifest.refs ?? {}).filter((key) => key.startsWith("contract-draft-"));
    expect(drafts).toHaveLength(2);
    expect(r.manifest.refs!.contract.relativePath).toContain("contract-2.json");
    // The uploaded requirements file is frozen: a second draft may not replace it.
    expect(r.manifest.refs!.requirements.relativePath).toBe("contract/source-requirements.txt");
  } finally {
    r.close();
  }
}, 120000);

it("clamps page bounds instead of failing the tool call", async () => {
  const r = runtime(`a-company-pages-${Date.now()}`);
  try {
    await r.bootstrap();
    const page = (await r.inspect(0, 5000)) as { limit?: number; offset?: number };
    expect(page.limit).toBe(500);
    expect(page.offset).toBe(0);
  } finally {
    r.close();
  }
}, 120000);
