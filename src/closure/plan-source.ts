import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { digest } from "./artifacts.js";
import { normalizeAlias, scanConfig, type Contract } from "./contract.js";
import { inspectSource } from "./source.js";
import { inspectDocument } from "./documents.js";
import { scanExpected } from "./oracle.js";
import { normalizePlanKey } from "./plan-normalization.js";
import { PYTHON } from "./paths.js";
import type { SourceInventory } from "./models.js";

export async function inspectPlanSource(path: string) {
  const sourceSha256 = digest(await readFile(path));
  const inventory = extname(path).toLowerCase() === ".xlsx"
    ? await inspectSource(path, PYTHON) : (await inspectDocument(path, PYTHON)).inventory;
  if (digest(await readFile(path)) !== sourceSha256) throw new Error("Source changed during inspection");
  return { inventory, sourceSha256 };
}

/** Structural evidence only: no prices, row values, row counts or timestamps enter the signature. */
export function planSource({inventory,sourceSha256}: {inventory:SourceInventory;sourceSha256:string}, contract: Contract, docType: string) {
  const regions = scanExpected(inventory, scanConfig(contract)).regions as Array<{ sheet: string; row: number; start: number; end: number; fields: Record<string, number> }>;
  const required = contract.fields.filter((field) => (field.required || field.role === "price") && (!field.source || field.source.kind === "column"));
  const applicable = regions.length > 0 && required.every((field) => regions.some((region) => field.name in region.fields));
  const structure = {
    docType: normalizePlanKey(docType),
    sheets: inventory.sheets.map((sheet) => normalizePlanKey(sheet.name)),
    regions: regions.map((region) => ({
      sheet: normalizePlanKey(region.sheet), start: region.start, end: region.end,
      headers: inventory.cells.filter((cell) => cell.sheet === region.sheet && cell.row === region.row && cell.column >= region.start && cell.column <= region.end)
        .sort((a, b) => a.column - b.column).map((cell) => normalizePlanKey(String(cell.value ?? ""))),
      fields: Object.entries(region.fields).sort((a,b) => a[1]-b[1]).map(([name,column]) => [normalizeAlias(name),column]),
    })),
  };
  return { sourceSignature: digest(JSON.stringify(structure)), sourceSha256, applicable };
}
