import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "./execute.js";
import { PROJECT_ROOT } from "./paths.js";

const worker = resolve(PROJECT_ROOT, "src/workers/xlsx_io.py");

export type SheetPreview = {
  name: string;
  rows: unknown[][];
  truncated: boolean;
  totalRows: number;
  totalColumns: number;
};
export type WorkbookPreview = { sheets: SheetPreview[]; sheetCount: number };

async function scratch<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const root = resolve(PROJECT_ROOT, ".tmp/runtime");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, prefix));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Host-side export of committed records to a real .xlsx file. Deterministic, no model budget. */
export async function exportRecords(python: string, rows: unknown[]): Promise<Buffer> {
  if (!Array.isArray(rows)) throw new Error("Export requires an array of records");
  return scratch("xlsx-export-", async (directory) => {
    const source = join(directory, "records.json"),
      target = join(directory, "result.xlsx");
    await writeFile(source, JSON.stringify(rows));
    await runProcess(python, [worker, "export", source, target], { timeoutMs: 90000 });
    return readFile(target);
  });
}

/** Read-only preview of any xlsx artifact, including the original upload. */
export async function previewWorkbook(python: string, path: string): Promise<WorkbookPreview> {
  const output = await runProcess(python, [worker, "preview", path], {
    timeoutMs: 60000,
    maxBytes: 32 * 1024 * 1024,
  });
  return JSON.parse(output) as WorkbookPreview;
}
