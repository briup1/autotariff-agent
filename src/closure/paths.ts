import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const PYTHON = resolve(PROJECT_ROOT, ".venv/bin/python");

/**
 * Where run evidence, the business ledger and the model budget live.
 *
 * Production and evidence tooling always use `<projectRoot>/template_runs`.
 * Tests set PI_RUN_ROOT to a throwaway directory so they cannot write into the
 * delivered ledger; the override only applies to the real project root, never
 * to the temporary roots that the web workbench tests pass explicitly.
 */
export const runsRootFor = (projectRoot: string): string =>
  projectRoot === PROJECT_ROOT && process.env.PI_RUN_ROOT
    ? resolve(process.env.PI_RUN_ROOT)
    : resolve(projectRoot, "template_runs");
