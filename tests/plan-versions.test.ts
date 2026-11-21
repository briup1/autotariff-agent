import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createWorkbenchServer } from "../src/web/server.js";
import { writeStoredContract, approveStoredContract, readStoredContract, type Contract } from "../src/closure/contract.js";
import { digest, ArtifactStore } from "../src/closure/artifacts.js";
import { ClosureController } from "../src/closure/controller.js";
import { ClosureRuntime, DEFAULT_BUDGET } from "../src/closure/runtime.js";
import { runProcess } from "../src/closure/execute.js";
import { PYTHON } from "../src/closure/paths.js";

let root:string,url:string,p:any,sourceId:string;
let app:Awaited<ReturnType<typeof createWorkbenchServer>>;
const originalKey=digest("旧说明"),newKey=digest("新说明");
const oldContract:Contract={version:"legacy-v7",requirementsDigest:originalKey,requirementsSource:"uploaded",fields:[{name:"port",role:"text",aliases:["PORT"],required:true}],route:{kind:"columns",separators:[]},checks:[]};
const newContract:Contract={...oldContract,version:"candidate-v2",requirementsDigest:newKey,fields:[...oldContract.fields,{name:"price",role:"price",aliases:["PRICE"],keepNegative:true}]};
async function start(){app=await createWorkbenchServer({projectRoot:root,sources:[],modelConfigured:()=>true,runner:async()=>{}});url=await app.listen(0);}
async function post(path:string,body:unknown){return fetch(url+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
async function detail(){return (await fetch(url+`/api/plans/${p.planId}`)).json();}
async function options(){const response=await fetch(url+`/api/plans/${p.planId}/version-options`);expect(response.status).toBe(200);return (await response.json()).contracts;}
async function body(requestId="new-version"){
  const option=(await options()).find((entry:any)=>entry.requirementsDigest===newKey);
  expect(option).toBeTruthy();
  return {requestId,requirementsDigest:newKey,contractSha256:option.contractSha256,sourceId:option.sourceId,expectedCurrentVersionId:p.currentVersionId,confirmContract:true};
}
async function append(payload?:unknown){return post(`/api/plans/${p.planId}/versions`,payload??await body());}
async function oldRun(){
  const selected=(await (await fetch(url+`/api/sources/${sourceId}/plans`)).json()).plans[0];
  const conversation=app.service.store.create(sourceId,undefined,selected);
  const {job}=app.service.store.admit(conversation.id,"old-run","沿用旧规则",selected);
  const manifest=await app.service.preparePlanRun(job);
  app.service.store.bind(job,manifest.runId,app.service.plans.ledger.runBinding(manifest.runId));
  const c=new ClosureController(new ArtifactStore(root),root,DEFAULT_BUDGET);const acquired=await c.readManifest(manifest.runId);
  try{await c.stop(acquired,"REVIEW","人工复核");}finally{c.close(acquired);}
  app.service.store.complete(job);
  return manifest.runId;
}
beforeEach(async()=>{
  root=await realpath(await mkdtemp(resolve(tmpdir(),"plan-version-")));
  await runProcess(PYTHON,["-c",`from openpyxl import Workbook
b=Workbook();s=b.active;s.title='报价';s.append(['PORT','PRICE']);s.append(['上海',200]);b.save(${JSON.stringify(resolve(root,"source.xlsx"))})`]);
  await writeFile(resolve(root,"new-rules.txt"),"新说明");
  await start();
  await writeStoredContract(root,oldContract);await approveStoredContract(root,originalKey,"user");
  p=app.service.plans.archive({requestId:"archive",requirementsDigest:originalKey,name:"怡升昌周报",supplier:"怡升昌",docType:"海运"});
  await writeStoredContract(root,newContract);
  sourceId="new-source";
  app.service.store.putSource({id:sourceId,label:"新表",filename:"source.xlsx",requirementsName:"新说明",requirementsPath:resolve(root,"new-rules.txt"),sourcePath:resolve(root,"source.xlsx"),kind:"upload",supported:true,templateName:"fixture"});
});
afterEach(async()=>{await app?.close();await rm(root,{recursive:true,force:true});});

it("previews the exact candidate and requires explicit confirmation before appending",async()=>{
  const candidates=await options();
  expect(candidates).toContainEqual(expect.objectContaining({requirementsDigest:newKey,sourceId,contract:newContract,contractSha256:expect.any(String)}));
  const payload=await body();
  expect((await append({...payload,confirmContract:false})).status).toBe(400);
  expect((await append({...payload,confirmContract:undefined})).status).toBe(400);
  expect((await detail()).plan.currentVersionId).toBe(p.currentVersionId);
  expect((await detail()).versions).toHaveLength(1);
});

it("appends immutable v2 and source evidence without changing v1, legacy contracts or old bindings",async()=>{
  const runId=await oldRun(),before=await detail();
  const first=app.service.plans.readContract(p.currentVersionId);
  const bytes=await readFile(resolve(first.directory,"contract.json"));
  const legacy=(await readStoredContract(root,newKey))!;
  const legacyBytes=await readFile(resolve(legacy.directory,"contract.json"));
  const response=await append();expect(response.status).toBe(201);
  const result=await response.json();
  expect(result.plan.planId).toBe(p.planId);
  expect(result.version).toMatchObject({planId:p.planId,contractVersion:"v2",requirementsDigest:newKey,contractSha256:expect.any(String),sourceSignatureRef:expect.objectContaining({kind:"source-signature"})});
  expect(result.version.planVersionId).not.toBe(p.currentVersionId);
  expect(await readFile(resolve(first.directory,"contract.json"))).toEqual(bytes);
  expect(await readFile(resolve(legacy.directory,"contract.json"))).toEqual(legacyBytes);
  expect((await readStoredContract(root,newKey))!.approved).toBe(false);
  const signature=JSON.parse((await app.service.projection.artifacts.read(result.version.sourceSignatureRef)).toString());
  expect(signature).toMatchObject({version:"sourceSignature-v1",sourceSignature:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect((await app.service.projection.detail(runId)).run).toMatchObject({planVersionId:p.currentVersionId,contractVersion:"v1",planNameSnapshot:p.name});
  await rm(resolve(first.directory,"contract.json"));
  expect((await app.service.projection.detail(runId)).run).toMatchObject({contractVersion:"v1",planNameSnapshot:p.name});
  expect((await detail()).plan).toMatchObject({status:"confirmed",lastResult:before.plan.lastResult,lastUsedAt:before.plan.lastUsedAt});
  const selectable=(await (await fetch(url+`/api/sources/${sourceId}/plans`)).json()).plans;
  expect(selectable[0].planVersionId).toBe(result.version.planVersionId);
  await app.close();await start();
  expect((await detail()).versions.map((v:any)=>v.contractVersion)).toEqual(["v2","v1"]);
});

it("rolls back an append failure and never overwrites a previously issued version number",async()=>{
  const payload=await body();
  app.service.plans.ledger.db.exec("CREATE TRIGGER fail_version_request BEFORE INSERT ON plan_version_requests BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  expect((await append(payload)).status).toBe(500);
  expect((await detail()).versions).toHaveLength(1);
  expect((await detail()).plan.currentVersionId).toBe(p.currentVersionId);
  expect(await readdir(resolve(root,"template_runs/plans",p.planId))).toEqual([p.currentVersionId]);
  app.service.plans.ledger.db.exec("DROP TRIGGER fail_version_request");
  expect((await (await append(payload)).json()).version.contractVersion).toBe("v2");
});

it("serializes simultaneous confirmations against the same current version",async()=>{
  const payload=await body();
  const responses=await Promise.all([append(payload),append({...payload,requestId:"parallel-version"})]);
  expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
  expect((await detail()).versions.map((v:any)=>v.contractVersion)).toEqual(["v2","v1"]);
});

it("deduplicates confirmation retries and keeps v1/v2/v3 monotonic after restart",async()=>{
  const payload=await body(),response=await append(payload),v2=(await response.json()).version;
  expect(response.status).toBe(201);
  await app.close();await start();
  expect((await (await append(payload)).json()).version).toEqual(v2);
  p=(await detail()).plan;
  await writeStoredContract(root,{...newContract,notes:["必须保留负价"]});
  const v3=await (await append(await body("third"))).json();
  expect(v3.version.contractVersion).toBe("v3");
  expect((await (await append(payload)).json()).version).toEqual(v2);
  expect((await detail()).plan.currentVersionId).toBe(v3.version.planVersionId);
  expect((await detail()).versions).toHaveLength(3);
  expect(()=>app.service.plans.ledger.db.prepare("DELETE FROM plan_versions WHERE id=?").run(v2.planVersionId)).toThrow("immutable");
});

it("keeps a previously bound running request on v1 while new requests must select v2",async()=>{
  const selected=(await (await fetch(url+`/api/sources/${sourceId}/plans`)).json()).plans[0];
  const conversation=app.service.store.create(sourceId,undefined,selected);
  const {job}=app.service.store.admit(conversation.id,"still-v1","提取",selected);
  const manifest=await app.service.preparePlanRun(job);
  app.service.store.bind(job,manifest.runId,app.service.plans.ledger.runBinding(manifest.runId));
  expect((await append()).status).toBe(201);
  expect((await post("/api/conversations",{sourceId,planSelection:selected})).status).toBe(409);
  const runtime=new ClosureRuntime({provider:"offline",modelId:"none",storagePath:":memory:",projectRoot:root,sourcePath:resolve(root,"source.xlsx"),pythonBin:PYTHON,runDate:"2026-11-14",runYear:2026,contractFirst:true});
  try{await runtime.bootstrap(manifest.runId);expect(runtime.contract?.version).toBe("v1");expect(runtime.contract?.fields).toHaveLength(1);}
  finally{runtime.close();}
});

it("rejects changed previews, stale current versions, mismatched source and metadata-only rule copies",async()=>{
  const payload=await body();
  expect((await append({...payload,expectedCurrentVersionId:"wrong"})).status).toBe(409);
  expect((await append({...payload,contractSha256:"a".repeat(64)})).status).toBe(409);
  expect((await append({...payload,sourceId:"unknown"})).status).toBe(404);
  await writeStoredContract(root,{...oldContract,requirementsDigest:newKey,version:"renamed-only"});
  const unchanged=await append(await body());expect(unchanged.status).toBe(422);expect((await unchanged.json()).code).toBe("PLAN_RULES_UNCHANGED");
  expect((await detail()).versions).toHaveLength(1);
});

it("keeps the original name snapshot and projects the current name without mutating stored history",async()=>{
  const runId=await oldRun(),binding=app.service.plans.ledger.runBinding(runId);
  app.service.plans.rename(p.planId,"怡升昌海运新名");
  const run=(await app.service.projection.detail(runId)).run;
  expect(run).toMatchObject({planNameSnapshot:"怡升昌周报",planCurrentName:"怡升昌海运新名",contractVersion:"v1"});
  expect(app.service.plans.ledger.runBinding(runId)).toEqual(binding);
});

it.each(["missing","corrupt","signature"])("blocks new use of %s artifacts while old run evidence stays readable",async(failure)=>{
  const runId=await oldRun(),response=await append(),version=(await response.json()).version;
  const current=app.service.plans.readContract(version.planVersionId);
  const selected=(await (await fetch(url+`/api/sources/${sourceId}/plans`)).json()).plans[0];
  const conversation=app.service.store.create(sourceId,undefined,selected);
  if(failure==="missing")await rm(resolve(current.directory,"contract.json"));
  if(failure==="corrupt")await writeFile(resolve(current.directory,"contract.json"),"corrupt");
  if(failure==="signature")await writeFile(app.service.projection.artifacts.path("plans",version.sourceSignatureRef.relativePath),"corrupt");
  expect((await post(`/api/conversations/${conversation.id}/messages`,{requestId:"must-block",content:"提取",planSelection:selected})).status).toBe(409);
  expect((await app.service.projection.detail(runId)).run).toMatchObject({contractVersion:"v1",planNameSnapshot:p.name,decision:"REVIEW"});
  expect((await detail()).versions).toHaveLength(2);
});

it("does not create a version or change plan status on REVIEW",async()=>{
  const pointer=p.currentVersionId;await oldRun();
  const current=await detail();expect(current.versions).toHaveLength(1);
  expect(current.plan).toMatchObject({currentVersionId:pointer,status:"confirmed",lastResult:"REVIEW"});
});
