import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { runProcess } from "./execute.js";
import { PROJECT_ROOT } from "./paths.js";
import type { SourceInventory } from "./models.js";
export type DocumentEvidence = {
  kind: string;
  units: Array<{ id: string; text: string; [key: string]: unknown }>;
  mapping: unknown[];
  warnings: Array<{ code: string; unit: string }>;
  inventory: SourceInventory;
};
export async function ocrBinary(): Promise<string> {
  const directory = resolve(PROJECT_ROOT, ".tmp/tools");
  await mkdir(directory, { recursive: true });
  const binary = join(directory, "ocr");
  try {
    await stat(binary);
    return binary;
  } catch {}
  await runProcess(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-module-cache-path",
      resolve(process.env.TMPDIR ?? directory, "swift-modules"),
      resolve(PROJECT_ROOT, "src/workers/ocr.swift"),
      "-o",
      binary,
    ],
    { timeoutMs: 120000 },
  );
  return binary;
}
export async function inspectDocument(
  source: string,
  python: string,
): Promise<DocumentEvidence> {
  const ocr = [".png", ".jpg", ".jpeg"].includes(extname(source).toLowerCase())
    ? await ocrBinary()
    : "";
  return JSON.parse(
    await runProcess(python, [
      resolve(PROJECT_ROOT, "src/workers/documents.py"),
      source,
      "-",
      ocr,
    ]),
  );
}
export async function convertDocument(
  source: string,
  python: string,
): Promise<{ bytes: Buffer; evidence: DocumentEvidence }> {
  const root = resolve(PROJECT_ROOT, ".tmp/runtime");
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(join(root, "conversion-"));
  try {
    const out = join(scratch, "converted.xlsx"),
      ocr = [".png", ".jpg", ".jpeg"].includes(extname(source))
        ? await ocrBinary()
        : "";
    const evidence = JSON.parse(
      await runProcess(python, [
        resolve(PROJECT_ROOT, "src/workers/documents.py"),
        source,
        out,
        ocr,
      ]),
    ) as DocumentEvidence;
    return { bytes: await readFile(out), evidence };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
