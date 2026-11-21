import {afterEach,beforeEach,expect,it} from "vitest";
import {mkdtemp,readFile,realpath,rm,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {tmpdir} from "node:os";
import {createWorkbenchServer} from "../src/web/server.js";
import {ClosureRuntime} from "../src/closure/runtime.js";
import {DEFAULT_BUDGET} from "../src/closure/runtime.js";
import {ClosureController} from "../src/closure/controller.js";
import {ArtifactStore} from "../src/closure/artifacts.js";
import {approveStoredContract,writeStoredContract} from "../src/closure/contract.js";
import {digest} from "../src/closure/artifacts.js";
import {runProcess} from "../src/closure/execute.js";
import {PYTHON} from "../src/closure/paths.js";

let root:string,p:any,conversationId:string,requestId:number;
let app:Awaited<ReturnType<typeof createWorkbenchServer>>;
let runtime:ClosureRuntime|undefined;
beforeEach(async()=>{
 root=await realpath(await mkdtemp(resolve(tmpdir(),"plan-review-")));requestId=0;
 await runProcess(PYTHON,["-c",`from openpyxl import Workbook
b=Workbook();s=b.active;s.title='报价';s.append(['PORT','PRICE']);s.append(['上海',200]);b.save(${JSON.stringify(resolve(root,"source.xlsx"))})`]);
 app=await createWorkbenchServer({projectRoot:root,sources:[{id:"source",label:"怡升昌新表",filename:"source.xlsx",requirementsName:"无说明",sourcePath:resolve(root,"source.xlsx"),supported:true,kind:"sample",templateName:"fixture"}],modelConfigured:()=>true,runner:async()=>{}});
 const key=digest("怡升昌规则");
 await writeStoredContract(root,{version:"legacy",requirementsDigest:key,requirementsSource:"uploaded",fields:[{name:"port",role:"text",aliases:["PORT"],required:true},{name:"price",role:"price",aliases:["PRICE"]}],route:{kind:"columns",separators:[]},checks:[]});
 await approveStoredContract(root,key,"local-user");
 p=app.service.plans.archive({requestId:"archive",requirementsDigest:key,name:"怡升昌周报",supplier:"怡升昌",docType:"海运"});
});
afterEach(async()=>{runtime?.close();runtime=undefined;await app?.close();await rm(root,{recursive:true,force:true});});
async function extraction(price=200){
 const selected=(await app.service.availablePlans("source"))[0];
 const conversation=app.service.store.create("source",undefined,selected);conversationId=conversation.id;
 const {job}=app.service.store.admit(conversationId,`request-${++requestId}`,"沿用周报方案",selected);
 const manifest=await app.service.preparePlanRun(job);
 app.service.store.bind(job,manifest.runId,app.service.plans.ledger.runBinding(manifest.runId));
 runtime=new ClosureRuntime({provider:"offline",modelId:"none",storagePath:":memory:",projectRoot:root,sourcePath:resolve(root,"source.xlsx"),pythonBin:PYTHON,runDate:"2026-11-14",runYear:2026,contractFirst:true});
 await runtime.bootstrap(manifest.runId);await runtime.inspect();
 await runtime.prepare(JSON.stringify([{recordId:"报价!R2C1",sourceId:"报价!R2C1",port:"上海",price}]),{route:"direct_llm",reason:"controlled candidate result, no model call"});
 await runtime.execute();await runtime.postprocess();
 return runtime;
}

it.each(["confirmed","inactive"])("moves independent reuse findings to REVIEW and preserves %s plan metadata",async(status)=>{
 const r=await extraction(201);
 if(status==="inactive")app.service.plans.setInactive(p.planId,true);
 const before=app.service.plans.get(p.planId),versions=app.service.plans.versions(p.planId);
 const report=await r.validate();
 expect(report.status).toBe("FAIL");
 expect(report.issues).toContainEqual(expect.objectContaining({code:"FIELD_MISMATCH",sourceIds:["报价!R2C1"],expected:{price:200},actual:{price:201}}));
 expect(r.manifest).toMatchObject({phase:"TERMINAL",decision:"REVIEW"});
 const detail=await app.service.projection.detail(r.manifest.runId);
 expect(detail.run).toMatchObject({decision:"REVIEW",reuseCheckStatus:"findings",businessApproval:false});
 expect(detail.issues).toEqual(report.issues);
 expect(JSON.parse((await r.store.read(r.manifest.refs!.review)).toString())).toMatchObject({businessApproval:false});
 expect(app.service.plans.get(p.planId)).toMatchObject({status:before.status,currentVersionId:before.currentVersionId,lastResult:"REVIEW"});
 expect(app.service.plans.versions(p.planId)).toEqual(versions);
 const runId=r.manifest.runId;r.close();runtime=undefined;
 await app.close();app=await createWorkbenchServer({projectRoot:root,sources:[],modelConfigured:()=>true,runner:async()=>{}});
 const reloaded=await app.service.projection.detail(runId);
 expect(reloaded.run).toMatchObject({decision:"REVIEW",reuseCheckStatus:"findings",businessApproval:false});
 expect(reloaded.issues).toEqual(report.issues);
});

it("keeps a clean reuse check at REVIEW with an explicit human business gate",async()=>{
 const r=await extraction();const report=await r.validate();
 expect(report.issues).toEqual([]);
 expect(r.manifest.decision).toBe("REVIEW");
 expect((await app.service.projection.detail(r.manifest.runId)).run).toMatchObject({reuseCheckStatus:"clean",businessApproval:false,issueCount:0});
 expect(JSON.parse((await r.store.read(r.manifest.refs!.review)).toString()).businessApproval).toBe(false);
});

it.each(["missing","corrupt","unregistered"])("shows %s reports as unavailable instead of claiming zero findings",async(failure)=>{
 const r=await extraction();await r.validate();
 const ref=r.attempt.validation!;
 if(failure==="missing")await rm(r.store.path(r.manifest.runId,ref.relativePath));
 if(failure==="corrupt")await writeFile(r.store.path(r.manifest.runId,ref.relativePath),"corrupt");
 if(failure==="unregistered"){delete r.attempt.validation;r.controller.persist(r.manifest);}
 const detail=await app.service.projection.detail(r.manifest.runId);
 expect(detail.run).toMatchObject({reuseCheckStatus:"unavailable",businessApproval:false});
 expect(detail.run.issueCount).toBeUndefined();
 expect(detail.attempts[0].reportStatus).toBe("error");
 expect(detail.run.error).toContain("检查报告");
});

it("keeps checker failure BLOCKED and retains diagnostic evidence",async()=>{
 const r=await extraction();(r as unknown as {pythonBin:string}).pythonBin=resolve(root,"missing-python");
 const report=await r.validate();
 expect(report.status).toBe("BLOCKED");expect(r.manifest.decision).toBe("BLOCKED");
 expect(report.issues[0]).toMatchObject({code:"CHECKER_FAILED",expected:{value:"unknown; checker unavailable"},actual:expect.any(Object)});
 expect((await app.service.projection.detail(r.manifest.runId)).run).toMatchObject({reuseCheckStatus:"unavailable",businessApproval:false});
 expect(app.service.plans.get(p.planId)).toMatchObject({status:"confirmed",currentVersionId:p.currentVersionId});
});

it("sends completed structural coverage findings to REVIEW while preserving the BLOCKED check report",async()=>{
 await runProcess(PYTHON,["-c",`from openpyxl import load_workbook
b=load_workbook(${JSON.stringify(resolve(root,"source.xlsx"))});b.active['E8']=777;b.save(${JSON.stringify(resolve(root,"source.xlsx"))})`]);
 const r=await extraction();const report=await r.validate();
 expect(report.status).toBe("BLOCKED");
 expect(report.issues).toContainEqual(expect.objectContaining({code:"UNDISPOSED_SOURCE",sourceIds:["报价!E8"]}));
 expect(r.manifest.decision).toBe("REVIEW");
 expect((await app.service.projection.detail(r.manifest.runId)).run).toMatchObject({reuseCheckStatus:"findings",businessApproval:false});
});

it("keeps results pending until an independent check has actually produced a report",async()=>{
 const r=await extraction();
 expect((await app.service.projection.detail(r.manifest.runId)).run).toMatchObject({reuseCheckStatus:"pending",businessApproval:false});
});

it("marks a terminal run with no check report unavailable while retaining its BLOCKED decision",async()=>{
 const r=await extraction();await r.controller.stop(r.manifest,"BLOCKED","execution stopped before independent checking");
 const detail=await app.service.projection.detail(r.manifest.runId);
 expect(detail.run).toMatchObject({decision:"BLOCKED",reuseCheckStatus:"unavailable",businessApproval:false});
 expect(detail.attempts[0].reportStatus).toBe("error");expect(detail.records.status).toBe("available");
});

it("keeps a terminal no-attempt check unavailable after restart", async () => {
  const selected = (await app.service.availablePlans("source"))[0];
  const conversation = app.service.store.create("source", undefined, selected);
  const { job } = app.service.store.admit(conversation.id, "terminal-before-check", "沿用周报方案", selected);
  const manifest = await app.service.preparePlanRun(job);
  const controller = new ClosureController(new ArtifactStore(root), root, DEFAULT_BUDGET);
  const acquired = await controller.readManifest(manifest.runId);
  await controller.stop(acquired, "BLOCKED", "execution stopped before independent checking");
  controller.close(acquired);
  app.service.store.bind(job, manifest.runId, app.service.plans.ledger.runBinding(manifest.runId));
  await app.close();
  app = await createWorkbenchServer({ projectRoot: root, sources: [], modelConfigured: () => true, runner: async () => {} });
  const detail = await app.service.projection.detail(manifest.runId);
  expect(detail.run).toMatchObject({ decision: "BLOCKED", reuseCheckStatus: "unavailable", businessApproval: false, stopReason: "execution stopped before independent checking" });
});
