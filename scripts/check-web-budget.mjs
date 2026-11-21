import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import assert from "node:assert/strict";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(project, "template_runs/visual-center-acceptance");
const db = new DatabaseSync(resolve(project, "template_runs/live-budget.sqlite"), { readOnly: true });
try {
  const taskId = "all-batches-2026-11-03";
  const oldTask = db.prepare("SELECT id,state FROM runs WHERE id=?").get(taskId);
  const actions = db.prepare("SELECT key,data FROM actions WHERE run=? ORDER BY key").all(taskId);
  assert(oldTask, "original task budget must exist");
  const originalDigest = createHash("sha256").update(JSON.stringify({ oldTask, actions })).digest("hex");
  const rows = db.prepare("SELECT data FROM actions WHERE run=?").all("visual-center-2026-11-03");
  const calls = rows.map((row) => JSON.parse(row.data)).filter((action) => action.operation === "model_request" && action.status !== "REJECTED");
  const report = {
    capturedAt: new Date().toISOString(),
    originalTaskId: taskId,
    originalActionCount: actions.length,
    originalDigest,
    newTaskId: "visual-center-2026-11-03",
    actualOrReservedCalls: calls.length,
    completedCalls: calls.filter((action) => action.status === "COMPLETED").length,
    uncertainCalls: calls.filter((action) => action.status === "UNCERTAIN").length,
    limit: 1000,
  };
  await mkdir(destination, { recursive: true });
  const baseline = resolve(destination, "budget-before.json");
  if (process.argv.includes("--capture")) {
    await writeFile(baseline, JSON.stringify(report, null, 2), { flag: "wx" });
  } else {
    const before = JSON.parse(await readFile(baseline, "utf8"));
    assert.equal(originalDigest, before.originalDigest, "original task and actions must remain unchanged");
    assert(calls.length <= 1000, "new task cannot exceed its authorization");
    await writeFile(resolve(destination, "budget-after.json"), JSON.stringify({ ...report, preserved: true }, null, 2));
  }
  console.log(JSON.stringify(report));
} finally {
  db.close();
}
