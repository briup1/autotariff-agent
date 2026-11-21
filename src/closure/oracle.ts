import type { SourceInventory, SourceCell, Issue } from "./models.js";
import type { ScanConfig } from "./contract.js";
import { normalizeAlias } from "./contract.js";

export type Scan = {
  records: Record<string, unknown>[];
  issues: Issue[];
  dispositions: Record<string, string>;
  regions: unknown[];
};
const text = (x: unknown): string => (x == null ? "" : String(x).trim());

/** Legacy freight header vocabulary. Kept as the default when no contract is attached. */
const alias = (value: unknown): string => {
  const s = text(value)
    .replace(/[\s'’′]/g, "")
    .toUpperCase();
  if (["航线", "ROUTE"].includes(s)) return "route";
  if (["起运港", "ORIGIN"].includes(s)) return "origin";
  if (["目的港", "DESTINATION"].includes(s)) return "destination";
  if (["20GP", "40GP", "40HQ", "40HC"].includes(s))
    return s === "40HC" ? "40HQ卖价" : `${s}卖价`;
  if (/^(预计开船日期|开船日期|有效日期|开船时间|ETD)$/.test(s)) return "ETD";
  if (s.startsWith("LSS")) return "LSS";
  if (s === "REMARKS") return "备注";
  return [
    "备注",
    "中转港",
    "航程",
    "航线代码",
    "币种",
    "单位",
    "有效期",
  ].includes(s)
    ? s
    : "";
};
export const legacyAlias = alias;

/** Default scan shape: the freight interpretation the host already validates. */
export const LEGACY_SCAN: ScanConfig = {
  fields: [
    { name: "route", role: "text", aliases: ["航线", "ROUTE"], emit: false },
    { name: "origin", role: "text", aliases: ["起运港", "ORIGIN"], source: { kind: "route_split", from: "route", side: "origin" } },
    { name: "destination", role: "text", aliases: ["目的港", "DESTINATION"], source: { kind: "route_split", from: "route", side: "destination" } },
    { name: "20GP卖价", role: "price", aliases: ["20GP", "20'GP"] },
    { name: "40GP卖价", role: "price", aliases: ["40GP"] },
    { name: "40HQ卖价", role: "price", aliases: ["40HQ", "40HC"] },
    { name: "运价备注", role: "text", source: { kind: "join", from: ["LSS", "备注"], separator: " | " } },
    { name: "中转港", role: "text", aliases: ["中转港"] },
    { name: "航程", role: "text", aliases: ["航程"] },
    { name: "航线代码", role: "text", aliases: ["航线代码"] },
    { name: "ETD", role: "date", aliases: ["预计开船日期", "开船日期", "有效日期", "开船时间", "ETD"] },
    { name: "LSS", role: "text", aliases: ["LSS"], emit: false },
    { name: "备注", role: "text", aliases: ["备注", "REMARKS"], emit: false },
  ],
  route: { kind: "split", separators: ["-", "=", "＝"] },
  priceFields: ["20GP卖价", "40GP卖价", "40HQ卖价"],
  regionStartFields: ["route", "origin"],
  aliasToField: new Map(),
  remarkJoins: [{ target: "运价备注", from: ["LSS", "备注"], separator: " | " }],
  routeSplits: [
    { target: "origin", from: "route", side: "origin" },
    { target: "destination", from: "route", side: "destination" },
  ],
  resolveAlias: alias,
  contextRemarks: true,
};
const problem = (
  code: string,
  cells: SourceCell[],
  message: string,
): Issue => ({
  issueId: `${code}:${cells.map((c) => c.sourceId).join(",")}`,
  code,
  stage: "inventory",
  sourceIds: cells.map((c) => c.sourceId),
  resultIds: [],
  message,
});
/** Earliest separator wins; the character class is what the freight interpretation has always used. */
const splitRoute = (value: string, separators: string[]): [string, string] => {
  let index = -1,
    width = 0;
  for (const separator of separators) {
    const at = value.indexOf(separator);
    if (at >= 0 && (index < 0 || at < index)) {
      index = at;
      width = separator.length;
    }
  }
  return index < 0
    ? [value, ""]
    : [value.slice(0, index), value.slice(index + width)];
};
/**
 * Contract mode: a header is one or more runs of recognised columns. Each run is one table,
 * so side-by-side tables and arbitrary column orders stay separable without naming a first column.
 */
const headerRuns = (
  row: SourceCell[],
  field: (value: unknown) => string,
): SourceCell[] => {
  const matched = row
    .filter((cell) => field(cell.value))
    .sort((a, b) => a.column - b.column);
  const starts: SourceCell[] = [];
  let previous = -Infinity;
  for (const cell of matched) {
    if (!starts.length || cell.column - previous > 1) starts.push(cell);
    previous = cell.column;
  }
  return starts;
};
/** Independent source interpretation; candidate scripts never receive or edit these expectations. */
export function scanExpected(
  inventory: SourceInventory,
  config: ScanConfig = LEGACY_SCAN,
): Scan {
  const records: Record<string, unknown>[] = [],
    issues: Issue[] = [],
    dispositions: Record<string, string> = {},
    regions: unknown[] = [];
  const field = (value: unknown): string =>
    config.resolveAlias
      ? config.resolveAlias(value)
      : config.aliasToField.get(normalizeAlias(value)) ?? "";
  const priceSet = new Set(config.priceFields),
    emitted = config.fields.filter(
      (entry) => entry.emit !== false && entry.source?.kind !== "constant",
    );
  for (const sheet of inventory.sheets) {
    const cells = inventory.cells.filter((c) => c.sheet === sheet.name),
      byRow = new Map<number, SourceCell[]>();
    const shared = cells
      .filter((c) => /^共享说明[:：]/.test(text(c.value)))
      .map((c) => ({
        id: c.sourceId,
        text: text(c.value)
          .replace(/^共享说明[:：]/, "")
          .trim(),
      }));
    for (const cell of cells) {
      const row = byRow.get(cell.row) ?? [];
      row.push(cell);
      byRow.set(cell.row, row);
      dispositions[cell.sourceId] = "context";
      if (cell.unsupported?.length && cell.formula)
        issues.push(
          problem(
            "UNSUPPORTED_FORMULA",
            [cell],
            "Formula has no cached value; calculation required",
          ),
        );
    }
    const active = new Map<
      number,
      {
        fields: Map<string, number>;
        end: number;
        lastRoute: string;
        context: Record<string, string>;
        startRow: number;
      }
    >();
    let pending: Record<string, string> = {};
    for (const [rowNumber, row] of [...byRow].sort((a, b) => a[0] - b[0])) {
      row.sort((a, b) => a.column - b.column);
      const starts = config.detectRegions
        ? headerRuns(row, field)
        : row.filter((c) => config.regionStartFields.includes(field(c.value)));
      if (starts.length) {
        for (let i = 0; i < starts.length; i++) {
          const start = starts[i].column,
            end = starts[i + 1]?.column ?? sheet.maxColumn + 1,
            fields = new Map<string, number>();
          for (const c of row.filter(
            (c) => c.column >= start && c.column < end,
          )) {
            const a = field(c.value);
            if (a) {
              if (priceSet.has(a) && c.mergedRange) {
                const ends = c.mergedRange.match(/([A-Z]+)\d+:([A-Z]+)\d+/);
                if (ends && ends[1] !== ends[2])
                  issues.push(
                    problem(
                      "AMBIGUOUS_HEADER",
                      [c],
                      "Merged container header spans multiple value columns; field role unknown",
                    ),
                  );
              }
              fields.set(a, c.column);
              dispositions[c.sourceId] = "header";
            }
          }
          // A second header tier is read before classifying any data row.
          for (const c of byRow.get(rowNumber + 1) ?? []) {
            if (c.column >= start && c.column < end) {
              const a = field(c.value);
              if (a && !fields.has(a)) {
                fields.set(a, c.column);
                dispositions[c.sourceId] = "header";
              }
            }
          }
          if (
            ![...fields.keys()].some((k) => priceSet.has(k)) &&
            (!config.detectRegions || fields.size >= 2)
          ) {
            issues.push(
              problem(
                "AMBIGUOUS_HEADER",
                [starts[i]],
                "No container price mapping in this region",
              ),
            );
            continue;
          }
          const previous = active.get(start);
          const title = cells
            .filter(
              (c) =>
                c.row < rowNumber &&
                c.row >= rowNumber - 3 &&
                c.column >= start &&
                c.column < end &&
                /^(主运价|附加费)$/.test(text(c.value)),
            )
            .at(-1);
          const context = { ...pending };
          context.sharedRemark = shared.map((c) => c.text).join(" | ");
          context.sharedSources = shared.map((c) => c.id).join(",");
          if (
            previous &&
            JSON.stringify([...previous.fields]) ===
              JSON.stringify([...fields]) &&
            !Object.keys(pending).length &&
            !(title && title.row > previous.startRow)
          ) {
            context.currency = previous.context.currency ?? "";
            context.unit = previous.context.unit ?? "";
            context.remark = previous.context.remark ?? "";
            context.intent = previous.context.intent ?? "";
            context.intentSource = previous.context.intentSource ?? "";
          }
          if (title) {
            context.intent =
              text(title.value) === "附加费" ? "surcharge" : "main_fare";
            context.intentSource = title.sourceId;
          }
          active.set(start, {
            fields,
            end,
            lastRoute: "",
            context,
            startRow: rowNumber,
          });
          regions.push({
            sheet: sheet.name,
            row: rowNumber,
            start,
            end,
            fields: Object.fromEntries(fields),
            context,
          });
        }
        pending = {};
        continue;
      }
      const nonempty = row.filter((c) => text(c.value));
      if (
        nonempty.some((c) =>
          /^(币种|单位|有效期|备注|共享说明|归属不明)[:：]/.test(text(c.value)),
        )
      ) {
        for (const c of nonempty) {
          const s = text(c.value);
          if (s.startsWith("归属不明"))
            issues.push(
              problem("AMBIGUOUS_CONTEXT", [c], "Context scope needs review"),
            );
          else {
            if (s.startsWith("共享说明")) continue;
            const key = s.startsWith("币种")
              ? "currency"
              : s.startsWith("单位")
                ? "unit"
                : "remark";
            pending[key] = s.replace(/^[^:：]+[:：]/, "").trim();
          }
        }
        continue;
      }
      for (const [start, region] of active) {
        const get = (name: string): unknown =>
          row.find((c) => c.column === region.fields.get(name))?.value ?? null;
        const priceValues = config.priceFields.map(get);
        if (
          priceValues.every((v) => v === null || v === "") ||
          priceValues.some((v) => priceSet.has(field(v)))
        )
          continue;
        for (const c of row.filter(
          (c) => c.column >= start && c.column < region.end,
        )) {
          if (text(c.value)) dispositions[c.sourceId] = "record";
        }
        const routeField = config.routeSplits[0]?.from,
          seam = routeField ? text(get(routeField)) : "";
        if (seam) region.lastRoute = seam;
        const routeValue = seam || region.lastRoute,
          parts = splitRoute(routeValue, config.route.separators);
        const id = `${sheet.name}!R${rowNumber}C${start}`;
        const record: Record<string, unknown> = { recordId: id, sourceId: id };
        for (const entry of emitted) {
          const kind = entry.source?.kind ?? "column";
          if (kind === "join") {
            const join = config.remarkJoins.find((item) => item.target === entry.name);
            record[entry.name] = join
              ? [
                  ...join.from.map((name) => text(get(name))),
                  ...(config.contextRemarks === false
                    ? []
                    : [region.context.remark ?? "", region.context.sharedRemark ?? ""]),
                ]
                  .filter(Boolean)
                  .join(join.separator)
              : null;
            continue;
          }
          if (kind === "route_split") {
            // Legacy vocabulary accepts separate port columns; explicit contracts keep their declared derivation.
            record[entry.name] = config === LEGACY_SCAN && region.fields.has(entry.name)
              ? text(get(entry.name))
              : (entry.source?.kind === "route_split" && entry.source.side === "origin"
                  ? parts[0]
                  : parts[1]
                ).trim();
            continue;
          }
          record[entry.name] = get(entry.name);
        }
        const unresolved = config.routeSplits.filter(
          (item) => !text(record[item.target]),
        );
        if (unresolved.length)
          issues.push(
            problem(
              "ROUTE_UNRESOLVED",
              row.filter((c) => c.column === start),
              "Cannot determine route fields",
            ),
          );
        if (region.context.currency) record["币种"] = region.context.currency;
        if (region.context.unit) record["单位"] = region.context.unit;
        if (region.context.intent) record.tariffType = region.context.intent;
        records.push(record);
      }
    }
    for (const cell of cells)
      if (
        dispositions[cell.sourceId] === "context" &&
        typeof cell.value === "number"
      ) {
        dispositions[cell.sourceId] = "pending";
        issues.push(
          problem(
            "UNDISPOSED_SOURCE",
            [cell],
            "Numeric source cell is outside a classified header, quote or explicit context; coverage unknown",
          ),
        );
      }
  }
  return { records, issues, dispositions, regions };
}
