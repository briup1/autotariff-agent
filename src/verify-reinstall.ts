import { cp, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PROJECT_ROOT, PYTHON, runsRootFor } from "./closure/paths.js";
import { runProcess } from "./closure/execute.js";
import { ArtifactStore } from "./closure/artifacts.js";
const parent = resolve(PROJECT_ROOT, ".tmp");
await mkdir(parent, { recursive: true });
const stage = await mkdtemp(join(parent, "reinstall-")),
  runId = `reinstall-${Date.now()}`,
  store = new ArtifactStore(PROJECT_ROOT);
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  UV_CACHE_DIR: process.env.UV_CACHE_DIR,
  npm_config_cache: process.env.npm_config_cache,
  HOME: stage,
  NPM_CONFIG_USERCONFIG: "/dev/null",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONNOUSERSITE: "1",
};
try {
  for (const file of [
    "package.json",
    "package-lock.json",
    "pyproject.toml",
    "uv.lock",
    "tsconfig.json",
  ])
    await cp(resolve(PROJECT_ROOT, file), join(stage, file));
  await cp(resolve(PROJECT_ROOT, "src"), join(stage, "src"), {
    recursive: true,
  });
  await cp(resolve(PROJECT_ROOT, "config"), join(stage, "config"), {
    recursive: true,
  });
  const npm = await runProcess(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: stage, env, timeoutMs: 180000 },
  );
  const uv = await runProcess(
    "uv",
    ["sync", "--project", stage, "--locked", "--python", PYTHON],
    { cwd: stage, env, timeoutMs: 180000 },
  );
  const python = join(stage, ".venv/bin/python");
  await writeFile(
    join(stage, "src/closure/paths.ts"),
    `export const PROJECT_ROOT=${JSON.stringify(PROJECT_ROOT)};export const PYTHON=${JSON.stringify(python)};\n`,
  );
  const prefix = (
    await runProcess(
      python,
      ["-c", "import sys,openpyxl,pymupdf,docx;print(sys.prefix)"],
      { cwd: stage, env },
    )
  ).trim();
  if (prefix !== join(stage, ".venv"))
    throw new Error("Reinstall used a different Python environment");
  const output = await runProcess(
    process.execPath,
    [
      "--import",
      join(stage, "node_modules/tsx/dist/loader.mjs"),
      join(stage, "src/verify-worker.ts"),
      resolve(runsRootFor(PROJECT_ROOT), "live-fixtures/small.xlsx"),
      "fixtures/reference_parser.py",
    ],
    { cwd: stage, env, timeoutMs: 120000 },
  );
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  if (result.decision !== "REVIEW")
    throw new Error("Fresh environment did not complete controlled extraction");
  await store.put(
    runId,
    "summary.json",
    JSON.stringify(
      {
        runId,
        status: "PASS",
        freshNodeDependencies: true,
        freshPythonEnvironment: true,
        prefix,
        applicationSource:
          "fresh local copy, evidence root pinned to original project",
        modelCalls: 0,
        result,
        npm,
        uv,
      },
      null,
      2,
    ),
    "reinstall-verification",
  );
  await store.snapshot("reinstall-latest", "summary.json", {
    runId,
    status: "PASS",
    evidence: `${runId}/summary.json`,
  });
  console.log(JSON.stringify({ status: "PASS", runId, result }));
} finally {
  await rm(stage, { recursive: true, force: true });
}
