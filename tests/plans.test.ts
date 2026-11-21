import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkbenchServer } from "../src/web/server.js";
import { approveStoredContract, readStoredContract, writeStoredContract, type Contract } from "../src/closure/contract.js";
import { digest } from "../src/closure/artifacts.js";
import { Ledger } from "../src/closure/ledger.js";
import { PlanLibrary } from "../src/closure/plans.js";

let root: string, url: string;
let app: Awaited<ReturnType<typeof createWorkbenchServer>>;
const requirementsDigest = digest("怡升昌本周说明");
const contract: Contract = {
  version: "legacy-rules-17", requirementsDigest, requirementsSource: "uploaded",
  fields: [{ name: "port", role: "text", aliases: ["PORT"], required: true }],
  route: { kind: "columns", separators: [] }, checks: [],
};
const archive = { requestId: "archive-1", requirementsDigest, name: "  怡升昌周报  ", supplier: " 怡升昌 ", docType: " 海运报价 " };
async function start() {
  app = await createWorkbenchServer({ projectRoot: root, sources: [], modelConfigured: () => false });
  url = await app.listen(0);
}
async function post(path: string, body: unknown) {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function create(body = archive) {
  const response = await post("/api/plans", body);
  expect(response.status).toBe(201);
  return response.json();
}
beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), "plans-"));
  await writeStoredContract(root, contract);
  await start();
});
afterEach(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });

it("starts with a real empty library and excludes unconfirmed contracts", async () => {
  expect((await (await fetch(url + "/api/plans")).json()).plans).toEqual([]);
  expect((await (await fetch(url + "/api/plans/archive-options")).json()).contracts).toEqual([]);
  expect((await (await fetch(url + "/api/bootstrap")).json()).plans).toEqual([]);
  expect((await post("/api/plans", archive)).status).toBe(422);
  expect((await (await fetch(url + "/api/plans")).json()).plans).toEqual([]);
});

it.each([false, true])("concurrent confirmations return the same durable approval (stale approval: %s)", async (stale) => {
  const expected = digest(await readFile(resolve(root, "template_runs/contracts", requirementsDigest, "contract.json")));
  // A replacement candidate can retain the preceding version's invalid approval file.
  if (stale) await writeFile(resolve(root, "template_runs/contracts", requirementsDigest, "approval.json"), JSON.stringify({ contractSha256: "old" }));
  const approvals = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    approveStoredContract(root, requirementsDigest, `user-${i}`, expected, contract.version)));
  expect(approvals.every(approval => JSON.stringify(approval) === JSON.stringify(approvals[0]))).toBe(true);
  expect((await readStoredContract(root, requirementsDigest))!.approval).toEqual(approvals[0]);
});

it("offers known source archive fields without inventing unknown supplier labels", async () => {
  await writeFile(resolve(root, "rules.txt"), "怡升昌本周说明");
  app.service.store.putSource({ id: "source", label: "本周表", filename: "本周表.xlsx", requirementsName: "rules.txt", sourcePath: resolve(root, "table.xlsx"), requirementsPath: resolve(root, "rules.txt"), supported: true, kind: "upload", templateName: "unknown", supplier: "怡升昌", docType: "海运" });
  await approveStoredContract(root, requirementsDigest, "local-user");
  const options = await (await fetch(url + "/api/plans/archive-options")).json();
  expect(options.contracts).toEqual([{ requirementsDigest, contractVersion: "legacy-rules-17", name: "本周表", supplier: "怡升昌", docType: "海运" }]);
});

it("archives a confirmed contract once, preserves the legacy contract and survives restart", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  const legacy = await readStoredContract(root, requirementsDigest);
  const original = await readFile(resolve(legacy!.directory, "contract.json"), "utf8");
  const plan = await create();
  expect(plan).toMatchObject({ name: "怡升昌周报", supplier: "怡升昌", docType: "海运报价", status: "confirmed", lastUsedAt: null, lastResult: null });
  expect(plan.planId).toBeTruthy();
  const version = await (await fetch(url + `/api/plans/${plan.planId}`)).json();
  expect(version.plan.currentVersionId).toBe(version.version.planVersionId);
  expect(version.version).toMatchObject({ planId: plan.planId, contractVersion: "v1", requirementsDigest });
  expect(version.version.contractSha256).toMatch(/^[a-f0-9]{64}$/);
  const snapshot = await app.service.plans.readContract(version.version.planVersionId);
  expect(snapshot).toMatchObject({ approved: true, contract: { version: "v1", requirementsDigest } });
  expect(await readFile(resolve(legacy!.directory, "contract.json"), "utf8")).toBe(original);
  await writeStoredContract(root, { ...contract, version: "replacement" });
  expect((await app.service.plans.readContract(version.version.planVersionId)).contract.version).toBe("v1");
  await app.close(); await start();
  expect(await create({ ...archive, name: "重复请求仍返回原对象" })).toEqual(plan);
  expect((await (await fetch(url + "/api/plans")).json()).plans).toEqual([plan]);
});

it("persists an optional sourceSignature-v1 artifact without changing the immutable plan contract", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  const sourceSignature = "a".repeat(64);
  const plan = await create({ ...archive, requestId: "archive-with-signature", sourceSignature } as typeof archive & { sourceSignature: string });
  const detail = await (await fetch(url + `/api/plans/${plan.planId}`)).json();
  expect(detail.version.sourceSignatureRef).toMatchObject({ kind: "source-signature", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.parse(await readFile(resolve(root, "template_runs", detail.version.planVersionId, "source-signature.json"), "utf8"))).toEqual({ version: "sourceSignature-v1", sourceSignature });
});

it.each(["", " \t\n ", 42, {}, null])("rejects invalid archive names %j without persisting a plan", async (name) => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  expect((await post("/api/plans", { ...archive, name })).status).toBe(400);
  expect((await (await fetch(url + "/api/plans")).json()).plans).toEqual([]);
});

it.each([
  [" ＡＣＭＥ　 Weekly ", "acme\tweekly"], ["Straße", "STRASSE"], ["Σς", "σσ"], ["Ꭰ", "ꭰ"], ["Acme\u0085weekly", "acme weekly"],
])("enforces workspace uniqueness using norm-v1: %s = %s", async (first, duplicate) => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  await create({ ...archive, name: first });
  const response = await post("/api/plans", { ...archive, requestId: "archive-2", name: duplicate });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("PLAN_NAME_DUPLICATE");
  expect((await (await fetch(url + "/api/plans")).json()).plans).toHaveLength(1);
});

it("preserves punctuation and the distinct dotless i in normalized names", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  for (const [i, name] of ["I", "ı", "A-B", "AB"].entries()) await create({ ...archive, requestId: `archive-${i}`, name });
  expect((await (await fetch(url + "/api/plans")).json()).plans).toHaveLength(4);
});

it("renames, deactivates and explicitly restores without changing identity or version", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  const plan = await create();
  const renamed = await (await post(`/api/plans/${plan.planId}/rename`, { name: " 下周海运 " })).json();
  expect(renamed).toMatchObject({ planId: plan.planId, currentVersionId: plan.currentVersionId, name: "下周海运" });
  const inactive = await (await post(`/api/plans/${plan.planId}/deactivate`, {})).json();
  expect(inactive.status).toBe("inactive");
  expect((await post("/api/plans", { ...archive, requestId: "another", name: "下周海运" })).status).toBe(409);
  expect((await post(`/api/plans/${plan.planId}/rename`, { name: " " })).status).toBe(400);
  expect((await post(`/api/plans/${plan.planId}/restore`, {})).status).toBe(200);
  await app.close(); await start();
  const detail = await (await fetch(url + `/api/plans/${plan.planId}`)).json();
  expect(detail.plan).toMatchObject({ planId: plan.planId, currentVersionId: plan.currentVersionId, status: "confirmed", name: "下周海运", lastUsedAt: null, lastResult: null });
  expect(detail.version.contractVersion).toBe("v1");
});

it("rejects rename collisions and missing plans without changing existing metadata", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  const first = await create();
  const second = await create({ ...archive, requestId: "other", name: "Other" });
  expect((await post(`/api/plans/${first.planId}/rename`, { name: "OTHER" })).status).toBe(409);
  expect((await post("/api/plans/missing/deactivate", {})).status).toBe(404);
  const plans = (await (await fetch(url + "/api/plans")).json()).plans;
  expect(plans).toEqual([second, first]);
});

it("rejects missing, corrupt or mismatched approvals without phantom plans", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  const directory = (await readStoredContract(root, requirementsDigest))!.directory;
  await writeFile(resolve(directory, "approval.json"), JSON.stringify({ ...await approveStoredContract(root, requirementsDigest, "local-user"), contractVersion: "wrong" }));
  expect((await post("/api/plans", archive)).status).toBe(422);
  expect((await (await fetch(url + "/api/plans/archive-options")).json()).contracts).toEqual([]);
  await writeFile(resolve(directory, "contract.json"), "corrupt");
  expect((await post("/api/plans", archive)).status).toBe(422);
  await rm(resolve(directory, "contract.json"));
  expect((await post("/api/plans", archive)).status).toBe(422);
  expect((await (await fetch(url + "/api/plans")).json()).plans).toEqual([]);
});

it("keeps version identity immutable and detects missing or corrupt version artifacts", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  const plan = await create();
  const stored = app.service.plans.readContract(plan.currentVersionId);
  expect(() => app.service.plans.ledger.db.prepare("UPDATE plan_versions SET contract_version='v2' WHERE id=?").run(plan.currentVersionId)).toThrow("immutable");
  await writeFile(resolve(stored.directory, "contract.json"), "tampered");
  expect(() => app.service.plans.readContract(plan.currentVersionId)).toThrow("不能归档");
  await post(`/api/plans/${plan.planId}/deactivate`, {});
  expect((await post(`/api/plans/${plan.planId}/restore`, {})).status).toBe(422);
  expect(app.service.plans.get(plan.planId).status).toBe("inactive");
});

it("rolls back metadata and its new artifacts when archiving cannot commit", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  app.service.plans.ledger.db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON plan_archive_requests BEGIN SELECT RAISE(ABORT,'test failure'); END");
  expect((await post("/api/plans", archive)).status).toBe(500);
  expect(app.service.plans.list()).toEqual([]);
  const directories = await readdir(resolve(root, "template_runs/plans"));
  for (const directory of directories) expect(await readdir(resolve(root, "template_runs/plans", directory))).toEqual([]);
  app.service.plans.ledger.db.exec("DROP TRIGGER fail_archive");
  expect((await create()).name).toBe("怡升昌周报");
});

it("scopes normalized names to a workspace", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  await create();
  const otherRoot = resolve(root, "another-workspace");
  await writeStoredContract(otherRoot, contract);
  await approveStoredContract(otherRoot, requirementsDigest, "local-user");
  const other = new PlanLibrary(otherRoot);
  try { expect(other.archive(archive).name).toBe("怡升昌周报"); }
  finally { other.close(); }
});

it("adds the binding storage contract while leaving legacy runs unbound and readable", () => {
  const path = resolve(root, "legacy.sqlite"), legacy = { runId: "legacy-run", binding: { contractVersion: "old" } };
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,state TEXT NOT NULL,owner TEXT,pid INTEGER); CREATE TABLE actions(run TEXT,key TEXT,data TEXT NOT NULL,PRIMARY KEY(run,key))");
  old.prepare("INSERT INTO runs VALUES(?,?,NULL,NULL)").run("legacy-run", JSON.stringify(legacy));
  old.close();
  const ledger = new Ledger(path);
  try {
    expect(ledger.runBinding("legacy-run")).toBeUndefined();
    expect(ledger.acquire("legacy-run")).toEqual(legacy);
  } finally { ledger.close(); }
});

it("persists one binding per run and request and rejects a mismatched plan/version pair", async () => {
  await approveStoredContract(root, requirementsDigest, "local-user");
  const plan = await create();
  const other = await create({ ...archive, requestId: "second-plan", name: "另一方案" });
  const ledger = app.service.plans.ledger;
  const binding = { planId: plan.planId, planVersionId: plan.currentVersionId, contractVersion: "v1", requirementsDigest, planNameSnapshot: plan.name };
  for (const id of ["bound-run", "second-run", "mismatch-run"]) ledger.create(id, { runId: id });
  const insert = ledger.db.prepare("INSERT INTO run_bindings VALUES(?,?,?,?,?,?)");
  insert.run("bound-run", root, "run-request", plan.planId, plan.currentVersionId, JSON.stringify(binding));
  expect(ledger.runBinding("bound-run")).toEqual(binding);
  expect(() => insert.run("bound-run", root, "other-request", plan.planId, plan.currentVersionId, JSON.stringify(binding))).toThrow("UNIQUE");
  expect(() => insert.run("second-run", root, "run-request", plan.planId, plan.currentVersionId, JSON.stringify(binding))).toThrow("UNIQUE");
  expect(() => insert.run("mismatch-run", root, "mismatch-request", other.planId, plan.currentVersionId, JSON.stringify(binding))).toThrow("FOREIGN KEY");
  await app.close(); await start();
  expect(app.service.plans.ledger.runBinding("bound-run")).toEqual(binding);
});
