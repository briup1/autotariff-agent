import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { runProcess } from "./execute.js";
import { digest } from "./artifacts.js";
import { PROJECT_ROOT } from "./paths.js";
import type { SourceInventory } from "./models.js";
export async function inspectSource(
  sourcePath: string,
  pythonBin: string,
): Promise<SourceInventory> {
  const output = await runProcess(pythonBin, [
    resolve(PROJECT_ROOT, "src/workers/inventory.py"),
    resolve(sourcePath),
  ]);
  return JSON.parse(output) as SourceInventory;
}
export async function readText(
  path: string,
): Promise<{ text: string; sha256: string }> {
  const bytes = await readFile(path);
  return { text: bytes.toString(), sha256: digest(bytes) };
}
export function inventoryPage(
  inventory: SourceInventory,
  offset = 0,
  limit = 100,
  sheet = "",
): unknown {
  if (!Number.isFinite(offset) || !Number.isFinite(limit))
    throw new Error(
      "Page bounds must be numbers: offset >= 0 and limit between 1 and 500",
    );
  // Clamp instead of failing: the response reports the bounds actually used, so the caller can page on.
  offset = Math.max(0, Math.trunc(offset));
  limit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const cells = sheet
    ? inventory.cells.filter((c) => c.sheet === sheet)
    : inventory.cells;
  const page: typeof cells = [];
  let bytes = 0;
  for (const cell of cells.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(cell));
    if (page.length && bytes + size > 8000) break;
    page.push(cell);
    bytes += size;
  }
  const end = offset + page.length;
  return {
    sheets: inventory.sheets,
    total: cells.length,
    offset,
    limit,
    cells: page,
    nextCursor: end < cells.length ? end : null,
    truncated: end < cells.length,
    warnings: inventory.warnings,
  };
}
