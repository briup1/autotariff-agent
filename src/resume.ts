import { ClosureRuntime } from "./closure/runtime.js";
import { loadConfig } from "./config.js";
import { runPi } from "./index.js";
const runtime = new ClosureRuntime(loadConfig());
try {
  await runtime.bootstrap(process.argv[2]);
  await runtime.resumeForRepair();
  if (runtime.attempt?.rawResult && !runtime.attempt.finalResult)
    await runtime.postprocess();
  if (runtime.attempt?.finalResult && !runtime.attempt.validation)
    await runtime.validate();
  console.log(
    JSON.stringify(await runPi(runtime, process.argv.slice(3).join(" "))),
  );
} finally {
  runtime.close();
}
