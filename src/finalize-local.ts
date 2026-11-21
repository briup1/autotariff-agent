import { ClosureRuntime } from "./closure/runtime.js";
import { loadConfig } from "./config.js";
const runtime = new ClosureRuntime(loadConfig());
try {
  await runtime.bootstrap(process.argv[2]);
  await runtime.resumeForRepair();
  if (!runtime.attempt.rawResult)
    throw new Error("No committed extraction available");
  if (!runtime.attempt.finalResult) await runtime.postprocess();
  const report = await runtime.validate();
  if (runtime.manifest.phase !== "TERMINAL")
    await runtime.finish(
      `Model budget stopped automatic repair; ${report.issues.length} independently located issues retained for business review`,
    );
  console.log(
    JSON.stringify({
      runId: runtime.manifest.runId,
      attempt: runtime.attempt.attemptId,
      status: report.status,
      issues: report.issues.length,
      usage: runtime.manifest.usage,
    }),
  );
} finally {
  runtime.close();
}
