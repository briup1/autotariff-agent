import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createWorkbenchServer } from "../src/web/server.js";
import { WorkbenchService, type RunJobContext } from "../src/web/service.js";
import { writeStoredContract, approveStoredContract } from "../src/closure/contract.js";
import { digest, ArtifactStore } from "../src/closure/artifacts.js";
import { ClosureController } from "../src/closure/controller.js";
import { DEFAULT_BUDGET, ClosureRuntime } from "../src/closure/runtime.js";
import { runProcess } from "../src/closure/execute.js";
import { PYTHON } from "../src/closure/paths.js";
import { VISUAL_TASK_ID } from "../src/closure/live-budget.js";

let root: string, url: string, calls: number;
let app: Awaited<ReturnType<typeof createWorkbenchServer>>;
const key = digest("怡升昌规则");
async function runner({ job }: RunJobContext) {
  calls++;
  const controller = new ClosureController(new ArtifactStore(root), root, DEFAULT_BUDGET);
  const manifest = await controller.readManifest(job.runId!);
  try { await controller.stop(manifest, "ANSWERED", "回答完成"); }
  finally { controller.close(manifest); }
}
async function start() {
  app = await createWorkbenchServer({ projectRoot: root, sources: [], modelConfigured: () => true, runner });
  url = await app.listen(0);
}
async function post(path: string, body: unknown) {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function plan() {
  await writeStoredContract(root, { version: "old", requirementsDigest: key, requirementsSource: "uploaded", fields: [{name:"port",role:"text",aliases:["PORT"],required:true},{name:"price",role:"price",aliases:["PRICE"]}], route:{kind:"columns",separators:[]},checks:[] });
  await approveStoredContract(root, key, "user");
  return app.service.plans.archive({requestId:"archive",requirementsDigest:key,name:"怡升昌周报",supplier:"怡升昌",docType:"海运"});
}
async function signedPlan(requestId: string, name: string) {
  await writeStoredContract(root, { version: "old", requirementsDigest: key, requirementsSource: "uploaded", fields: [{name:"port",role:"text",aliases:["PORT"],required:true},{name:"price",role:"price",aliases:["PRICE"]}], route:{kind:"columns",separators:[]},checks:[] });
  await approveStoredContract(root, key, "user");
  await writeFile(resolve(root, "requirements.txt"), "怡升昌规则");
  app.service.store.putSource({id:"signed-source",label:"怡升昌来源",filename:"source.xlsx",requirementsName:"requirements.txt",sourcePath:resolve(root,"source.xlsx"),requirementsPath:resolve(root,"requirements.txt"),supported:true,kind:"sample",templateName:"fixture",supplier:"怡升昌",docType:"海运"});
  return app.service.archivePlan({requestId,requirementsDigest:key,name,supplier:"怡升昌",docType:"海运"});
}
async function upload() {
  const response = await post("/api/uploads", { name: "new.xlsx", base64: (await readFile(resolve(root, "source.xlsx"))).toString("base64") });
  expect(response.status).toBe(201);
  return response.json();
}
async function choice(sourceId: string) {
  const response = await fetch(url + `/api/sources/${sourceId}/plans`);
  expect(response.status).toBe(200);
  return (await response.json()).plans[0];
}
async function choiceResult(sourceId: string) {
  const response = await fetch(url + `/api/sources/${sourceId}/plans`);
  expect(response.status).toBe(200);
  return response.json();
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(resolve(tmpdir(), "plan-binding-"))); calls = 0;
  await runProcess(PYTHON,["-c",`from openpyxl import Workbook
b=Workbook();s=b.active;s.title='报价';s.append(['PORT','PRICE']);s.append(['上海',200]);b.save(${JSON.stringify(resolve(root,"source.xlsx"))})`]);
  await start();
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await app?.close(); await rm(root,{recursive:true,force:true}); });

it("offers only confirmed compatible plans, with no automatic selection", async () => {
  const p = await plan(), source = await upload();
  expect(await choice(source.id)).toMatchObject({planId:p.planId,planVersionId:p.currentVersionId,name:p.name,supplier:"怡升昌",docType:"海运",contractVersion:"v1"});
  app.service.plans.setInactive(p.planId,true);
  expect(await choice(source.id)).toBeUndefined();
  app.service.plans.setInactive(p.planId,false);
  await runProcess(PYTHON,["-c",`from openpyxl import Workbook
b=Workbook();b.active.append(['UNRELATED']);b.save(${JSON.stringify(resolve(root,"source.xlsx"))})`]);
  const other = await upload();
  expect(await choice(other.id)).toBeUndefined();
});

it("reports unique and multiple exact matches without choosing a multiple-match plan", async () => {
  const first = await signedPlan("signed-plan", "怡升昌周报"), source = await upload();
  const uploaded = app.service.store.source(source.id);
  app.service.store.putSource({ ...uploaded, supplier: "怡升昌", docType: "海运" });
  await expect(choiceResult(source.id)).resolves.toMatchObject({ selection: "unique", preselectedPlanVersionId: first.currentVersionId, plans: [{ planId: first.planId }] });
  const second = await signedPlan("second-plan", "另一方案");
  const result = await choiceResult(source.id);
  expect(result.selection).toBe("multiple");
  expect(result.preselectedPlanVersionId).toBeUndefined();
  expect(result.plans.map((entry: { planId: string }) => entry.planId)).toEqual(expect.arrayContaining([first.planId, second.planId]));
  await expect(app.service.create(source.id)).rejects.toThrow("请先手动选择方案");
});

it("requires normalized supplier and document type when source identity is known", async () => {
  const p = await plan();
  app.service.store.putSource({ id: "known-source", label: "已知供应商", filename: "source.xlsx", sourcePath: resolve(root, "source.xlsx"), requirementsName: "（未提供）", supported: true, kind: "upload", templateName: "unknown", supplier: "其他供应商", docType: "海运" });
  const result = await choiceResult("known-source");
  expect(result).toMatchObject({ selection: "none", plans: [] });
  expect(p.supplier).toBe("怡升昌");
});

it("does not auto-select a unique plan when source identity is unknown", async () => {
  const p = await plan();
  const source = await upload();
  const result = await choiceResult(source.id);
  expect(result).toMatchObject({ selection: "none", plans: [{ planId: p.planId }] });
  expect(result.preselectedPlanVersionId).toBeUndefined();
});

it("does not auto-select a legacy plan without a persisted source signature", async () => {
  const p = await plan();
  const source = await upload();
  const result = await choiceResult(source.id);
  expect(app.service.plans.version(p.currentVersionId).sourceSignatureRef).toBeNull();
  expect(result).toMatchObject({ selection: "none", plans: [{ planId: p.planId }] });
  expect(result.preselectedPlanVersionId).toBeUndefined();
});

it("excludes a confirmed plan whose persisted source signature does not match", async () => {
  await writeStoredContract(root, { version: "old", requirementsDigest: key, requirementsSource: "uploaded", fields: [{name:"port",role:"text",aliases:["PORT"],required:true},{name:"price",role:"price",aliases:["PRICE"]}], route:{kind:"columns",separators:[]}, checks:[] });
  await approveStoredContract(root, key, "user");
  await app.service.plans.archive({ requestId: "signature-plan", requirementsDigest: key, name: "带签名方案", supplier: "怡升昌", docType: "海运", sourceSignature: "a".repeat(64) });
  const source = await upload();
  expect(await choiceResult(source.id)).toMatchObject({ selection: "none", plans: [] });
});

it("keeps row values and prices outside the structural signature",async()=>{
  await plan();const first=await upload(),before=await choice(first.id);
  await runProcess(PYTHON,["-c",`from openpyxl import load_workbook
b=load_workbook(${JSON.stringify(resolve(root,"source.xlsx"))});b.active['B2']=999;b.save(${JSON.stringify(resolve(root,"source.xlsx"))})`]);
  const second=await upload(),after=await choice(second.id);
  expect(before.sourceSignature).toBe(after.sourceSignature);
  expect(before.sourceSha256).not.toBe(after.sourceSha256);
});

it("rejects candidate plans and corrupt version artifacts without falling back to digest lookup",async()=>{
  const p=await plan(),source=await upload(),selected=await choice(source.id);
  const conversation=app.service.store.create(source.id,undefined,selected);
  const stored=app.service.plans.readContract(p.currentVersionId);
  await writeFile(resolve(stored.directory,"contract.json"),"corrupt");
  expect(await choice(source.id)).toBeUndefined();
  await expect(app.service.send(conversation.id,"corrupt","提取",selected)).rejects.toMatchObject({code:"PLAN_VERSION_STALE"});
  const candidate={...app.service.plans.get(p.planId),status:"candidate"};
  app.service.plans.ledger.db.prepare("UPDATE plans SET status='candidate',data=? WHERE id=?").run(JSON.stringify(candidate),p.planId);
  expect(await choice(source.id)).toBeUndefined();
  expect(app.service.store.jobs()).toHaveLength(0);
});

it("binds one identity through selection, ledger, receipt, projection, retry and restart", async () => {
  const p = await plan(), source = await upload(), selected = await choice(source.id);
  const current = await (await post("/api/conversations",{sourceId:source.id,planSelection:selected})).json();
  const id = current.conversation.id, path = `/api/conversations/${id}/messages`;
  const response = await post(path,{requestId:"run-1",content:"沿用怡升昌规则",planSelection:selected});
  expect(response.status).toBe(202);
  await app.service.idle();
  const job = app.service.store.job(id,"run-1")!;
  const binding = {planId:p.planId,planVersionId:p.currentVersionId,contractVersion:"v1",requirementsDigest:key,planNameSnapshot:p.name};
  expect(job.bindingReceipt).toEqual(binding);
  expect(app.service.plans.ledger.runBinding(job.runId!)).toEqual(binding);
  expect((await app.service.projection.detail(job.runId!)).run).toMatchObject(binding);
  expect(app.service.plans.get(p.planId)).toMatchObject({lastUsedAt:expect.any(String),lastResult:"ANSWERED"});
  app.service.plans.rename(p.planId,"现名");
  app.service.plans.setInactive(p.planId,true);
  expect((await post(path,{requestId:"run-1",content:"沿用怡升昌规则",planSelection:selected})).status).toBe(202);
  expect(calls).toBe(1);
  await app.close(); await start();
  expect((await app.service.projection.detail(job.runId!)).run).toMatchObject(binding);
  expect(app.service.store.job(id,"run-1")!.bindingReceipt).toEqual(binding);
});

it.each(["inactive","version","source","signature"])("rejects stale %s before making a phantom run", async (change) => {
  const p = await plan(), source = await upload(), selected = await choice(source.id);
  const current = await (await post("/api/conversations",{sourceId:source.id,planSelection:selected})).json();
  if(change==="inactive") app.service.plans.setInactive(p.planId,true);
  if(change==="version") selected.planVersionId="unknown";
  if(change==="source") await writeFile(app.service.store.source(source.id).sourcePath,Buffer.from("changed"));
  if(change==="signature") selected.sourceSignature="a".repeat(64);
  const response = await post(`/api/conversations/${current.conversation.id}/messages`,{requestId:"stale",content:"提取",planSelection:selected});
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("PLAN_VERSION_STALE");
  expect(app.service.store.jobs()).toEqual([]);
  expect(app.service.plans.ledger.db.prepare("SELECT * FROM run_bindings").all()).toHaveLength(0);
  expect(app.service.plans.get(p.planId)).toMatchObject({lastUsedAt:null,lastResult:null});
});

it("executes the bound contract in the actual runtime without a legacy contract fallback", async () => {
  await plan(); const source=await upload(), selected=await choice(source.id);
  const conversation=app.service.store.create(source.id,undefined,selected);
  const {job}=app.service.store.admit(conversation.id,"runtime","提取",selected);
  const manifest=await app.service.preparePlanRun(job);
  await rm(resolve(root,"template_runs/contracts"),{recursive:true,force:true});
  const runtime=new ClosureRuntime({provider:"offline",modelId:"none",storagePath:":memory:",projectRoot:root,sourcePath:app.service.store.source(source.id).sourcePath,pythonBin:PYTHON,runDate:"2026-11-14",runYear:2026,contractFirst:true});
  try {
    await runtime.bootstrap(manifest.runId);
    expect(runtime.contract?.version).toBe("v1");
    expect(runtime.contractStored?.approved).toBe(true);
    expect(()=>runtime.controller.ledger.save(manifest.runId,{...runtime.manifest,binding:{...runtime.manifest.binding,planNameSnapshot:"changed"}})).toThrow("immutable");
    await runtime.inspect();
    expect(runtime.inventory.sheets[0].name).toBe("报价");
    await expect(runtime.draftContract({contract:"{}"})).rejects.toThrow("人工创建新版本");
    await runtime.prepare(`import json,sys
from openpyxl import load_workbook
b=load_workbook(sys.argv[1],data_only=True);s=b.active
out=[{'recordId':f'{s.title}!R2C1','sourceId':f'{s.title}!R2C1','port':s['A2'].value,'price':s['B2'].value}]
open(sys.argv[2],'w').write(json.dumps(out))`,{route:"excel_script",reason:"explicit plan"});
    await runtime.execute(); await runtime.postprocess();
    const result=JSON.parse((await runtime.store.read(runtime.attempt.finalResult!)).toString());
    expect(result[0]).toMatchObject({port:"上海",price:200});
    const checked=await runtime.validate();
    expect(checked.generatedFromInterpretation).toBe("v1");
    expect(checked.issues).toEqual([]);
    expect(runtime.manifest.binding).toMatchObject({planId:selected.planId,planVersionId:selected.planVersionId,contractVersion:"v1",requirementsDigest:key,planNameSnapshot:selected.name});
    expect(runtime.manifest.decision).toBe("REVIEW");
  } finally { runtime.close(); }
  expect(app.service.plans.list()[0].lastResult).toBe("REVIEW");
});

it("preserves the configured run budget, business date and scoped model accounting before dispatch",async()=>{
  await plan();const source=await upload(),selected=await choice(source.id);
  const conversation=app.service.store.create(source.id,undefined,selected);
  const {job}=app.service.store.admit(conversation.id,"budget-config","提取",selected);
  app.service.options.runner=undefined;
  vi.stubEnv("OPENAI_API_KEY","offline-placeholder");vi.stubEnv("PI_MODEL_ID","offline");vi.stubEnv("PI_MAX_AGENT_TURNS","7");vi.stubEnv("PI_RUN_DATE","2026-11-14");vi.stubEnv("PI_RUN_YEAR","2026");
  const manifest=await app.service.preparePlanRun(job);
  expect(manifest.budget.maxAgentTurns).toBe(7);
  expect(manifest.binding).toMatchObject({liveBudgetTask:VISUAL_TASK_ID,runDate:"2026-11-14",runYear:2026});
});

it("rolls back run and binding together on a ledger failure and retains an actionable request", async () => {
  const p=await plan(),source=await upload(),selected=await choice(source.id);
  const current=await (await post("/api/conversations",{sourceId:source.id,planSelection:selected})).json();
  app.service.plans.ledger.db.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON run_bindings BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END");
  const result=await post(`/api/conversations/${current.conversation.id}/messages`,{requestId:"ledger-fail",content:"提取",planSelection:selected});
  expect(result.status).toBe(500);
  expect(app.service.plans.ledger.db.prepare("SELECT * FROM runs").all()).toHaveLength(0);
  expect(app.service.plans.ledger.db.prepare("SELECT * FROM run_bindings").all()).toHaveLength(0);
  expect(app.service.plans.get(p.planId)).toMatchObject({lastUsedAt:null,lastResult:null});
  expect(app.service.store.job(current.conversation.id,"ledger-fail")?.state).toBe("FAILED");
});

it("does not share a request identity across conversations or drift a duplicate to another plan", async () => {
  await plan();const source=await upload(),selected=await choice(source.id);
  const first=await app.service.create(source.id,undefined,selected);
  await app.service.send(first.conversation.id,"global-request","提取",selected);await app.service.idle();
  const second=await app.service.create(source.id,undefined,selected);
  await expect(app.service.send(second.conversation.id,"global-request","提取",selected)).rejects.toThrow("另一会话");
  await expect(app.service.send(first.conversation.id,"global-request","提取",{...selected,planVersionId:"another"})).rejects.toThrow("另一条消息或方案");
  expect(calls).toBe(1);
});

it("keeps the most recent terminal decision and does not replace it with interrupted or running attempts", async () => {
  const p=await plan(),source=await upload(),selected=await choice(source.id);
  const conversation=app.service.store.create(source.id,undefined,selected);
  for(const [index,decision] of ["REVIEW","BLOCKED","ANSWERED"].entries()) {
    const {job}=app.service.store.admit(conversation.id,`terminal-${index}`,"提取",selected);
    const manifest=await app.service.preparePlanRun(job);
    const controller=new ClosureController(new ArtifactStore(root),root,DEFAULT_BUDGET);
    const acquired=await controller.readManifest(manifest.runId);
    try {await controller.stop(acquired,decision,"terminal evidence");} finally {controller.close(acquired);}
    app.service.store.bind(job,manifest.runId,app.service.plans.ledger.runBinding(manifest.runId));app.service.store.complete(job);
    expect(app.service.plans.get(p.planId).lastResult).toBe(decision);
  }
  const {job}=app.service.store.admit(conversation.id,"interrupted","提取",selected);
  const manifest=await app.service.preparePlanRun(job);
  app.service.store.bind(job,manifest.runId,app.service.plans.ledger.runBinding(manifest.runId));
  expect(app.service.plans.get(p.planId).lastResult).toBe("ANSWERED");
  await app.close();await start();
  expect(app.service.plans.get(p.planId).lastResult).toBe("ANSWERED");
});

it.each(["reserved","committed","receipt"])("reconciles a restart after %s without a second run or model dispatch", async (boundary) => {
  const p = await plan(), source = await upload(), selected = await choice(source.id);
  const conversation = app.service.store.create(source.id,undefined,selected);
  const {job} = app.service.store.admit(conversation.id,"recover","提取",selected);
  if(boundary!=="reserved") {
    const manifest = await app.service.preparePlanRun(job);
    if(boundary==="receipt") app.service.store.bind(job,manifest.runId,app.service.plans.ledger.runBinding(manifest.runId));
  }
  await app.close(); await start(); await app.service.idle();
  const recovered = app.service.store.job(conversation.id,"recover")!;
  expect(recovered.runId).toBeTruthy();
  expect(recovered.bindingReceipt).toMatchObject({planId:p.planId,planVersionId:p.currentVersionId});
  expect(app.service.plans.ledger.db.prepare("SELECT * FROM run_bindings").all()).toHaveLength(1);
  expect(calls).toBe(boundary==="reserved" ? 1 : 0);
  if(boundary!=="reserved") expect(app.service.plans.get(p.planId).lastResult).toBeNull();
  await app.close(); await start();
  expect(app.service.store.conversation(conversation.id).runIds).toHaveLength(1);
});

it("recovers a ledger commit when writing its web receipt fails", async () => {
  const p = await plan(), source = await upload(), selected = await choice(source.id);
  const current = await (await post("/api/conversations",{sourceId:source.id,planSelection:selected})).json();
  vi.spyOn(app.service.store,"bind").mockImplementationOnce(()=>{throw new Error("receipt unavailable");});
  expect((await post(`/api/conversations/${current.conversation.id}/messages`,{requestId:"receipt-fault",content:"提取",planSelection:selected})).status).toBe(500);
  expect(calls).toBe(0);
  await app.close(); await start();
  const recovered = app.service.store.job(current.conversation.id,"receipt-fault")!;
  expect(recovered.bindingReceipt?.planId).toBe(p.planId);
  expect(app.service.plans.ledger.db.prepare("SELECT * FROM run_bindings").all()).toHaveLength(1);
});

it("returns the same run for concurrent duplicate submissions",async()=>{
  await plan();const source=await upload(),selected=await choice(source.id);
  const current=await app.service.create(source.id,undefined,selected);
  const responses=await Promise.all([1,2].map(()=>app.service.send(current.conversation.id,"parallel","提取",selected)));
  await app.service.idle();
  expect(responses.map(r=>r.conversation.runIds[0])).toEqual([responses[0].conversation.runIds[0],responses[0].conversation.runIds[0]]);
  expect(responses[0].conversation.runIds[0]).toBeTruthy();
  expect(calls).toBe(1);
});

it("repairs a lost web receipt on an idempotent retry without waiting for a restart",async()=>{
  await plan();const source=await upload(),selected=await choice(source.id);
  const current=await app.service.create(source.id,undefined,selected);
  vi.spyOn(app.service.store,"bind").mockImplementationOnce(()=>{throw new Error("receipt unavailable");});
  await expect(app.service.send(current.conversation.id,"retry-receipt","提取",selected)).rejects.toThrow();
  const result=await app.service.send(current.conversation.id,"retry-receipt","提取",selected);
  expect(result.conversation.runIds).toHaveLength(1);
  expect(app.service.store.job(current.conversation.id,"retry-receipt")?.bindingReceipt).toBeTruthy();
  expect(calls).toBe(0);
});
