import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { PROJECT_ROOT, runsRootFor } from "./closure/paths.js";
const runId = `offline-${Date.now()}`,
  root = resolve(runsRootFor(PROJECT_ROOT), runId);
await mkdir(root, { recursive: true });
const path = resolve(root, "vitest.json");
const exit = await new Promise<number>((yes, no) => {
  const child = spawn(
    "npm",
    [
      "test",
      "--",
      "--reporter=default",
      "--reporter=json",
      "--outputFile=" + path,
    ],
    {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        UV_CACHE_DIR: process.env.UV_CACHE_DIR,
        npm_config_cache: process.env.npm_config_cache,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
        TZ: process.env.TZ,
        OPENAI_API_KEY: "",
        PI_MODEL_ID: "",
      },
      stdio: "inherit",
    },
  );
  child.on("error", no);
  child.on("close", (code) => yes(code ?? 1));
});
const report = JSON.parse(await readFile(path, "utf8")) as {
  numTotalTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    assertionResults: Array<{ fullName: string; status: string }>;
  }>;
};
const passed = new Set(
  report.testResults.flatMap((f) =>
    f.assertionResults
      .filter((t) => t.status === "passed")
      .flatMap((t) => t.fullName.match(/\bC\d{2}\b/g) ?? []),
  ),
);
const required = Array.from(
    { length: 24 },
    (_, i) => `C${String(i + 1).padStart(2, "0")}`,
  ),
  missing = required.filter((c) => !passed.has(c));
const status =
  exit === 0 &&
  !report.numFailedTests &&
  !report.numPendingTests &&
  report.numTotalTests > 0 &&
  !missing.length
    ? "PASS"
    : "FAIL";
const summary = {
  runId,
  status,
  tests: report.numTotalTests,
  failed: report.numFailedTests,
  pending: report.numPendingTests,
  requiredCases: required,
  missingCases: missing,
  report: path,
  source:
    "synthetic fixtures plus process/sandbox fault tests; no model required",
};
await writeFile(
  resolve(root, "summary.json"),
  JSON.stringify(summary, null, 2),
);
await writeFile(
  resolve(runsRootFor(PROJECT_ROOT), "offline-latest.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary));
if (status !== "PASS") process.exitCode = 1;
