import type {
  Attempt,
  Issue,
  SourceInventory,
  ValidationReport,
} from "./models.js";
import { scanExpected } from "./oracle.js";
import { scanConfig, type Contract } from "./contract.js";
import { runContractChecks } from "./contract-checks.js";
const problem = (
  code: string,
  stage: Issue["stage"],
  id: string,
  message: string,
  expected?: Record<string, unknown>,
  actual?: Record<string, unknown>,
): Issue => ({
  issueId: `${code}:${id}:${Object.keys(expected ?? {}).join(",")}`,
  code,
  stage,
  sourceIds: id ? [id] : [],
  resultIds: id ? [id] : [],
  message,
  expected,
  actual,
});
export function compareResults(
  attemptId: string,
  actual: Record<string, unknown>[],
  expected: Record<string, unknown>[],
  version: string,
): ValidationReport {
  const issues: Issue[] = [],
    byId = new Map<string, Record<string, unknown>>(),
    want = new Set(expected.map((r) => String(r.recordId)));
  for (const row of actual) {
    const id = String(row.recordId ?? "");
    if (byId.has(id))
      issues.push(
        problem(
          "DUPLICATE_SOURCE",
          "extraction",
          id,
          "Same source identity emitted twice",
        ),
      );
    byId.set(id, row);
    if (!want.has(id))
      issues.push(
        problem(
          "EXTRA_RECORD",
          "extraction",
          id,
          "Record not justified by independent source scan",
        ),
      );
  }
  for (const row of expected) {
    const id = String(row.recordId),
      got = byId.get(id);
    if (!got) {
      issues.push(
        problem(
          "MISSING_RECORD",
          "extraction",
          id,
          "Expected source record missing",
          row,
        ),
      );
      continue;
    }
    for (const [key, value] of Object.entries(row)) {
      if (JSON.stringify(got[key] ?? null) !== JSON.stringify(value ?? null))
        issues.push(
          problem(
            "FIELD_MISMATCH",
            "extraction",
            id,
            `Field ${key} differs`,
            { [key]: value },
            { [key]: got[key] ?? null },
          ),
        );
    }
  }
  return {
    attemptId,
    status: issues.length ? "FAIL" : "REVIEW",
    issues,
    checkedRuleIds: ["independent-source-records"],
    unresolvedRuleIds: ["business-approval"],
    generatedFromInterpretation: version,
  };
}
/** Deliberately separate implementation from production post-processing. */
export function expectedFinal(
  raw: Record<string, unknown>[],
  date: string,
  year: number,
  contract?: Contract,
): Record<string, unknown>[] {
  const numeric = (v: unknown): unknown => {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v;
    const s = String(v)
      .trim()
      .replace(/[,，\s]/g, "")
      .replace(/^(?:USD|CNY|RMB|US\$|\$|¥|￥)/i, "");
    return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : String(v).trim();
  };
  const dated = (v: unknown): string | null => {
    if (v == null || v === "") return null;
    if (typeof v === "number")
      return new Date(Date.UTC(1899, 11, 30) + v * 86400000)
        .toISOString()
        .substring(0, 10);
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
    const full = s.match(/(20\d{2})[年\/.-](\d{1,2})[月\/.-](\d{1,2})/);
    const bits = s.match(
      /(\d{1,2})[月/.](\d{1,2})(?:日)?(?:[^\d]+(\d{1,2})日|\s*[-~至]\s*(\d{1,2}))?/,
    );
    if (!full && !bits) return null;
    const y = Number(full?.[1] ?? year),
      m = Number(full?.[2] ?? bits?.[1]),
      d = Number(full?.[3] ?? bits?.[3] ?? bits?.[4] ?? bits?.[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d
      ? dt.toISOString().substring(0, 10)
      : null;
  };
  if (contract) {
    // Independent re-implementation of the contract normalisation, kept apart from production post-processing.
    const prices = contract.fields.filter((field) => field.role === "price").map((field) => field.name),
      dates = contract.fields.filter((field) => field.role === "date").map((field) => field.name);
    return raw.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const key of Object.keys(out))
        if (typeof out[key] === "string") out[key] = (out[key] as string).trim();
      for (const field of prices) out[field] = numeric(out[field]);
      for (const field of contract.fields)
        if (field.fillFrom && (out[field.name] == null || out[field.name] === "") && out[field.fillFrom] != null)
          out[field.name] = out[field.fillFrom];
      for (const field of dates) out[field] = dated(out[field]);
      return out;
    });
  }
  return raw.map((row) => {
    const out = { ...row };
    for (const k of Object.keys(out))
      if (typeof out[k] === "string") out[k] = (out[k] as string).trim();
    for (const k of ["20GP卖价", "40GP卖价", "40HQ卖价"])
      out[k] = numeric(out[k]);
    out["40GP卖价"] ??= out["40HQ卖价"];
    out["40HQ卖价"] ??= out["40GP卖价"];
    out.ETD = dated(out.ETD);
    out["运价有效开始时间"] = date;
    out["运价有效结束时间"] = out.ETD;
    if (Array.isArray(out["运价备注"]))
      out["运价备注"] = (out["运价备注"] as unknown[])
        .filter((v) => v != null)
        .map((v) => String(v).trim())
        .filter(Boolean)
        .join(" | ");
    return out;
  });
}
export function detectPostProcessMutation(
  attemptId: string,
  raw: Record<string, unknown>[],
  final: Record<string, unknown>[],
  version: string,
  date = "2026-11-03",
  year = 2026,
  contract?: Contract,
): ValidationReport {
  const expected = expectedFinal(raw, date, year, contract),
    report = compareResults(attemptId, final, expected, version);
  report.issues = report.issues.map((i) => ({
    ...i,
    code: "POST_PROCESS_MUTATION",
    stage: "post_process",
  }));
  for (let n = 0; n < raw.length; n++)
    if (raw[n].ETD != null && raw[n].ETD !== "" && expected[n].ETD === null) {
      const id = String(raw[n].recordId);
      report.issues.push(
        problem(
          "UNKNOWN_ETD",
          "post_process",
          id,
          "Source date cannot be normalized under the frozen rules; expected date unknown",
          { ETD: "unknown" },
          { sourceETD: raw[n].ETD },
        ),
      );
    }
  return report;
}
export function validateAttempt(
  attempt: Attempt,
  records: Record<string, unknown>[],
  inventory: SourceInventory,
  version: string,
  year = 2026,
  contract?: Contract,
): ValidationReport {
  const scan = scanExpected(
    inventory,
    contract ? scanConfig(contract) : undefined,
  );
  const canonical = (
    rows: Record<string, unknown>[],
  ): Record<string, unknown>[] =>
    expectedFinal(rows, "", year, contract).map((row) => {
      delete row["运价有效开始时间"];
      delete row["运价有效结束时间"];
      return row;
    });
  const expected = canonical(scan.records),
    report = compareResults(
      attempt.attemptId,
      canonical(records),
      expected,
      version,
    );
  for (let n = 0; n < scan.records.length; n++)
    if (
      scan.records[n].ETD != null &&
      scan.records[n].ETD !== "" &&
      expected[n].ETD === null
    )
      report.issues.push(
        problem(
          "UNKNOWN_SOURCE_ETD",
          "inventory",
          String(scan.records[n].recordId),
          "Original source date cannot be normalized; candidate null does not hide the unknown",
          { ETD: "unknown" },
          { ETD: scan.records[n].ETD },
        ),
      );
  report.issues.push(...scan.issues);
  report.status = report.issues.length ? "FAIL" : "REVIEW";
  if (
    report.issues.some((i) =>
      ["UNSUPPORTED_FORMULA", "AMBIGUOUS_HEADER", "UNDISPOSED_SOURCE"].includes(
        i.code,
      ),
    )
  )
    report.status = "BLOCKED";
  if (
    !scan.records.length &&
    !records.length &&
    inventory.cells.some((c) => c.value != null) &&
    !scan.regions.length
  ) {
    report.issues.push(
      problem(
        "UNSUPPORTED_LAYOUT",
        "inventory",
        "",
        "Nonempty input has no supported tariff region",
      ),
    );
    report.status = "BLOCKED";
  }
  if (contract) {
    const outcome = runContractChecks(contract, canonical(records));
    report.issues.push(...outcome.issues);
    report.checkedRuleIds = ["source-coverage", ...outcome.checkedRuleIds];
    report.uncheckedRules = outcome.unchecked;
    report.unresolvedRuleIds = [
      ...outcome.unchecked.map((entry) => entry.id),
      "business-approval",
    ];
    if (report.issues.length) report.status = "FAIL";
    if (
      report.issues.some((issue) =>
        ["UNSUPPORTED_FORMULA", "AMBIGUOUS_HEADER", "UNDISPOSED_SOURCE"].includes(issue.code),
      )
    )
      report.status = "BLOCKED";
  } else {
    report.checkedRuleIds = [
      "source-coverage",
      "routeSplit",
      "containerFields",
      "lssAndRemarks",
      "etdPriority",
      "transitPort",
      "transitTime",
      "routeCode",
    ];
    report.unresolvedRuleIds = ["business-approval"];
  }
  return report;
}
export function compareReports(
  before: ValidationReport,
  after: ValidationReport,
): unknown {
  const a = new Set(before.issues.map((i) => i.issueId)),
    b = new Set(after.issues.map((i) => i.issueId));
  return {
    fixed: [...a].filter((x) => !b.has(x)),
    introduced: [...b].filter((x) => !a.has(x)),
    unresolved: [...b].filter((x) => a.has(x)),
    beforeAttempt: before.attemptId,
    afterAttempt: after.attemptId,
  };
}
