import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ClosureRuntime } from "./runtime.js";
import { runProcess } from "./execute.js";
import { PROJECT_ROOT } from "./paths.js";
/** Physical test fault, never exposed as an Agent tool or used in normal conversion. */
export async function injectConversionLoss(
  runtime: ClosureRuntime,
): Promise<void> {
  const root = resolve(PROJECT_ROOT, ".tmp/runtime");
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(join(root, "conversion-fault-"));
  try {
    const original = runtime.manifest.refs!.converted,
      target = join(scratch, "lossy.xlsx");
    await runProcess(runtime.pythonBin, [
      resolve(PROJECT_ROOT, "tests/fixtures/drop-converted-row.py"),
      runtime.store.path(runtime.manifest.runId, original.relativePath),
      target,
    ]);
    await runtime.controller.action(
      runtime.manifest,
      "controlled_conversion_loss",
      { original: original.sha256 },
      {},
      async () => {
        const ref = await runtime.store.put(
          runtime.manifest.runId,
          "outputs/controlled-lossy-converted.xlsx",
          await readFile(target),
          "synthetic-conversion-fault",
        );
        runtime.manifest.refs!.converted = ref;
        await runtime.save(
          "outputs/conversion-fault-provenance.json",
          {
            origin: "synthetic deliberate loss in actual converted file",
            original,
            lossy: ref,
            operation: "delete final worksheet row 2; preserve original PDF",
          },
          "fault-provenance",
        );
        return ref;
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
