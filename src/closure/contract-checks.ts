import type { Contract, ContractCheck } from "./contract.js";

export type CheckIssue = {
  issueId: string;
  code: string;
  stage: "validation";
  sourceIds: string[];
  resultIds: string[];
  message: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
};
export type CheckOutcome = {
  checkedRuleIds: string[];
  unchecked: Array<{ id: string; reason: string }>;
  issues: CheckIssue[];
};

const text = (value: unknown): string => (value == null ? "" : String(value).trim());
/** Accept either {"field": "x"} or {"fields": ["x"]} so a natural draft is not rejected for shape. */
const fieldParam = (params: Record<string, unknown>): string =>
  typeof params.field === "string"
    ? params.field
    : Array.isArray(params.fields) && typeof params.fields[0] === "string"
      ? (params.fields[0] as string)
      : "";

/**
 * Declarative rule checks. They only look at the post-processed candidate; the independent
 * expectation comes from the host re-scan, so these operators never define truth by themselves.
 */
export function runContractChecks(
  contract: Contract,
  candidate: Record<string, unknown>[],
): CheckOutcome {
  const outcome: CheckOutcome = { checkedRuleIds: [], unchecked: [], issues: [] };
  const fail = (
    check: ContractCheck,
    row: Record<string, unknown> | undefined,
    field: string,
    message: string,
    expected?: Record<string, unknown>,
    actual?: Record<string, unknown>,
  ): void => {
    const id = row ? String(row.recordId ?? row.sourceId ?? "") : "";
    const issueId = `${check.id}:${field}:${id || "run"}`;
    if (outcome.issues.some((issue) => issue.issueId === issueId)) return;
    outcome.issues.push({
      issueId,
      code: `CONTRACT_${check.kind.toUpperCase()}`,
      stage: "validation",
      sourceIds: id ? [id] : [],
      resultIds: id ? [id] : [],
      message,
      ...(expected ? { expected } : {}),
      ...(actual ? { actual } : {}),
    });
  };
  for (const check of contract.checks) {
    if (check.status === "unchecked") {
      outcome.unchecked.push({ id: check.id, reason: check.reason ?? "未说明原因" });
      continue;
    }
    try {
      switch (check.kind) {
        case "required_fields": {
          const fields = (check.params.fields as string[]) ?? [];
          for (const row of candidate)
            for (const field of fields)
              if (!text(row[field]))
                fail(check, row, field, `必填字段 ${field} 为空`, { [field]: "non-empty" }, { [field]: row[field] ?? null });
          break;
        }
        case "price_preserved": {
          const fields = (check.params.fields as string[]) ?? [];
          for (const row of candidate)
            for (const field of fields) {
              const value = row[field];
              if (value == null || value === "") continue;
              if (typeof value !== "number")
                fail(check, row, field, `价格 ${field} 必须是数值`, { [field]: "number" }, { [field]: value });
            }
          break;
        }
        case "enum": {
          const field = fieldParam(check.params),
            values = ((check.params.values ?? check.params.enum ?? []) as string[]) ?? [];
          for (const row of candidate) {
            const value = text(row[field]);
            if (value && !values.includes(value))
              fail(check, row, field, `字段 ${field} 的取值不在允许范围内`, { [field]: values }, { [field]: value });
          }
          break;
        }
        case "pattern": {
          const field = fieldParam(check.params),
            pattern = new RegExp(String(check.params.pattern ?? ""));
          for (const row of candidate) {
            const value = text(row[field]);
            if (value && !pattern.test(value))
              fail(check, row, field, `字段 ${field} 不匹配要求格式`, { [field]: String(check.params.pattern) }, { [field]: value });
          }
          break;
        }
        case "route_split": {
          const fields =
            (check.params.fields as string[]) ??
            contract.fields
              .filter((field) => field.source?.kind === "route_split")
              .map((field) => field.name);
          for (const row of candidate)
            for (const field of fields)
              if (!text(row[field]))
                fail(check, row, field, `航线无法拆分出 ${field}`, { [field]: "non-empty" }, { [field]: row[field] ?? null });
          break;
        }
        case "join_order": {
          const target = String(check.params.target ?? ""),
            from = (check.params.from as string[]) ?? [];
          for (const row of candidate) {
            const sources = from.map((field) => text(row[field])).filter(Boolean);
            if (sources.length && !text(row[target]))
              fail(check, row, target, `合并字段 ${target} 为空，但来源字段有值`, { [target]: sources.join(" | ") }, { [target]: null });
          }
          break;
        }
        case "unique_source_ids": {
          const seen = new Map<string, number>();
          for (const row of candidate) {
            const id = text(row.sourceId);
            if (!id) continue;
            const count = (seen.get(id) ?? 0) + 1;
            seen.set(id, count);
            if (count === 2) fail(check, row, "sourceId", `原文坐标 ${id} 被多条记录重复使用`);
          }
          break;
        }
        case "date_normalize": {
          const field = fieldParam(check.params) || "ETD";
          for (const row of candidate) {
            const value = row[field];
            if (value == null || value === "") continue;
            if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
              fail(check, row, field, `日期 ${field} 未归一化为 YYYY-MM-DD`, { [field]: "YYYY-MM-DD" }, { [field]: value });
          }
          break;
        }
        case "source_coverage":
          // Enforced by host dispositions during the independent re-scan; recorded as acknowledged.
          break;
        default:
          outcome.unchecked.push({ id: check.id, reason: `未实现的检查类型 ${String(check.kind)}` });
          continue;
      }
      outcome.checkedRuleIds.push(check.id);
    } catch (error) {
      outcome.unchecked.push({ id: check.id, reason: `检查执行失败：${String(error)}` });
    }
  }
  return outcome;
}
