import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Tests must never write into the delivered ledger (`template_runs/closure.sqlite`).
 * Every run writes evidence under PI_RUN_ROOT; the default is a throwaway directory.
 * `scripts/run_with_temp_runtime.sh npm test` keeps working: the override is per-test-run.
 */
const runRoot =
  process.env.PI_RUN_ROOT ??
  mkdtempSync(resolve(tmpdir(), "autotariff-test-runs-"));
process.env.PI_RUN_ROOT = runRoot;

export default defineConfig({
  test: {
    env: { PI_RUN_ROOT: runRoot, PI_RUN_ORIGIN: "test" },
  },
});
