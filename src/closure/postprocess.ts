export const POSTPROCESS_VERSION = "fields-v002";
export const priceFields = ["20GP卖价", "40GP卖价", "40HQ卖价"];
export function money(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value)
    .trim()
    .replace(/[,，\s]/g, "")
    .replace(/^(USD|CNY|RMB|US\$|\$|¥|￥)/i, "");
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : String(value).trim();
}
export function normalizeDate(value: unknown, year: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number")
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000)
      .toISOString()
      .slice(0, 10);
  const s = String(value).trim();
  if (/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
  const full = s.match(/(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})/);
  const md = s.match(
    /(\d{1,2})[月\/.](\d{1,2})(?:日)?(?:[^\d]+(\d{1,2})日|\s*[-~至]\s*(\d{1,2}))?/,
  );
  const y = full ? Number(full[1]) : year,
    m = Number(full?.[2] ?? md?.[1]),
    d = Number(full?.[3] ?? md?.[3] ?? md?.[4] ?? md?.[2]);
  if (!m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? dt.toISOString().slice(0, 10)
    : null;
}
/** Complete frozen fields-v002 chain; legacy global PROCESS_RULES are not runtime dependencies. */
export function postProcess(
  raw: Record<string, unknown>[],
  runDate: string,
  year: number,
): Record<string, unknown>[] {
  return raw.map((row) => {
    const out = { ...row };
    for (const [k, v] of Object.entries(out))
      if (typeof v === "string") out[k] = v.trim();
    for (const field of priceFields) out[field] = money(out[field]);
    if (out["40GP卖价"] === null && out["40HQ卖价"] !== null)
      out["40GP卖价"] = out["40HQ卖价"];
    if (out["40HQ卖价"] === null && out["40GP卖价"] !== null)
      out["40HQ卖价"] = out["40GP卖价"];
    out.ETD = normalizeDate(out.ETD, year);
    out["运价有效开始时间"] = runDate;
    out["运价有效结束时间"] = out.ETD;
    if (Array.isArray(out["运价备注"]))
      out["运价备注"] = (out["运价备注"] as unknown[])
        .map((v) => String(v).trim())
        .join(" | ");
    return out;
  });
}

/**
 * Contract-driven finalization. Only the declared field roles are normalized; nothing outside
 * the contract is invented, and missing values stay missing.
 */
export function postProcessContract(
  raw: Record<string, unknown>[],
  contract: import("./contract.js").Contract,
  runDate: string,
  year: number,
): Record<string, unknown>[] {
  const prices = contract.fields.filter((field) => field.role === "price").map((field) => field.name);
  const dates = contract.fields.filter((field) => field.role === "date").map((field) => field.name);
  return raw.map((row) => {
    const out = { ...row };
    for (const [key, value] of Object.entries(out))
      if (typeof value === "string") out[key] = value.trim();
    for (const field of prices) out[field] = money(out[field]);
    for (const field of contract.fields)
      if (field.fillFrom && (out[field.name] == null || out[field.name] === "") && out[field.fillFrom] != null)
        out[field.name] = out[field.fillFrom];
    for (const field of dates) out[field] = normalizeDate(out[field], year);
    void runDate;
    return out;
  });
}
