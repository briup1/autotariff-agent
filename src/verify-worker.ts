import { readFile } from "node:fs/promises";
import { ClosureRuntime } from "./closure/runtime.js";
import { PYTHON, PROJECT_ROOT } from "./closure/paths.js";
import { resolve } from "node:path";
const [source, parser, runId] = process.argv.slice(2);
const runtime = new ClosureRuntime({
  provider: "offline",
  modelId: "none",
  sourcePath: source,
  pythonBin: PYTHON,
  runDate: "2026-11-03",
  runYear: 2026,
  maxAgentTurns: 12,
  storagePath: ":memory:",
});
try {
  await runtime.bootstrap(runId);
  console.log(JSON.stringify({ runId: runtime.manifest.runId }));
  if (runtime.manifest.phase === "PREPARE") await runtime.inspect();
  if (runtime.manifest.phase === "INVENTORIED")
    await runtime.prepare(
      await readFile(resolve(PROJECT_ROOT, parser), "utf8"),
      {
        route: "excel_script",
        reason: "Controlled offline process-recovery fixture",
      },
    );
  if (runtime.manifest.phase === "ATTEMPT_READY") await runtime.execute();
  runtime.crash("before-postprocess");
  if (runtime.manifest.phase === "EXTRACTED") await runtime.postprocess();
  if (
    ["POSTPROCESSED", "VALIDATED", "REPAIR_PENDING"].includes(
      runtime.manifest.phase ?? "",
    )
  )
    await runtime.validate();
  console.log(
    JSON.stringify({
      runId: runtime.manifest.runId,
      phase: runtime.manifest.phase,
      decision: runtime.manifest.decision,
      actions: runtime.manifest.actions.length,
    }),
  );
} finally {
  runtime.close();
}
