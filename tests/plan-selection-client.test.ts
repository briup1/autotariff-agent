import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { PROJECT_ROOT } from "../src/closure/paths.js";

const plan={planId:"p",planVersionId:"pv",planUpdatedAt:"now",sourceSignature:"s",sourceSha256:"hash",name:"怡升昌周报",supplier:"怡升昌",docType:"海运",contractVersion:"v1"};
it("lists choices without preselecting and displays all four user-facing selection fields",async()=>{
  const source=await readFile(resolve(PROJECT_ROOT,"web/app.js"),"utf8");
  const nodes=new Map<string,any>();
  const $=(id:string)=>{if(!nodes.has(id)) nodes.set(id,{value:"",hidden:false,textContent:"",replaceChildren(...children:any[]){this.children=children;}});return nodes.get(id);};
  const state:any={};
  const context=createContext({state,$,api:async()=>({plans:[plan]}),el:(_tag:string,_class:string,text:string)=>({textContent:text,value:""})});
  runInContext(source.slice(source.indexOf("async function loadSourcePlans("),source.indexOf("function refreshSources(")),context);
  await runInContext("loadSourcePlans('source')",context);
  expect($("source-plan-select").value).toBe("");
  expect($("source-plan-fields").hidden).toBe(false);
  $("source-plan-select").value=plan.planVersionId;
  runInContext("renderSourcePlan()",context);
  for(const expected of [plan.name,plan.supplier,plan.docType,plan.contractVersion]) expect($("source-plan-detail").textContent).toContain(expected);
});

it("preselects only an explicitly reported unique match and leaves multiple matches for the user", async () => {
  const source = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  const nodes = new Map<string, any>();
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, { value: "", hidden: false, textContent: "", replaceChildren(...children: any[]) { this.children = children; } }); return nodes.get(id); };
  const context = createContext({ state: {}, $, api: async () => ({ plans: [plan], selection: "unique", preselectedPlanVersionId: plan.planVersionId }), el: (_tag: string, _class: string, text: string) => ({ textContent: text, value: "" }) });
  runInContext(source.slice(source.indexOf("async function loadSourcePlans("), source.indexOf("function refreshSources(")), context);
  await runInContext("loadSourcePlans('source')", context);
  expect($("source-plan-select").value).toBe(plan.planVersionId);
  expect($("source-plan-detail").textContent).toContain("唯一精确匹配");

  const multiple = createContext({ state: {}, $, api: async () => ({ plans: [plan, { ...plan, planVersionId: "pv-2", name: "另一方案" }], selection: "multiple" }), el: (_tag: string, _class: string, text: string) => ({ textContent: text, value: "" }) });
  runInContext(source.slice(source.indexOf("async function loadSourcePlans("), source.indexOf("function refreshSources(")), multiple);
  await runInContext("loadSourcePlans('source')", multiple);
  expect($("source-plan-select").value).toBe("");
  expect($("source-plan-detail").textContent).toContain("多个精确匹配");
});

it("carries the same selected identity on a paid-request retry",async()=>{
  const source=await readFile(resolve(PROJECT_ROOT,"web/app.js"),"utf8");
  const send=source.slice(source.indexOf("async function sendMessage("),source.indexOf("async function approveContract("));
  let pending:any;const requests:any[]=[];
  const context=createContext({state:{selection:"c",conversation:{conversation:{planSelection:plan},messages:[]},drafts:new Map()},
    $:(id:string)=>id==="message-input"?{value:"沿用怡升昌规则"}:{disabled:false},crypto:{randomUUID:()=>"request-1"},isActive:()=>false,pendingFor:()=>pending,
    savePending:(_id:string,value:any)=>{pending=value;},renderComposer(){},renderMessages(){},renderSidebar(){},renderConversationHeader(){},markDisconnected(){},markConnected(){},updateConversationSummary(){},loadRun:async()=>{},
    api:async(_path:string,options:{body:string})=>{requests.push(JSON.parse(options.body));throw Object.assign(new Error("lost"),{network:true});}});
  runInContext(send,context);
  await runInContext("sendMessage({preventDefault(){}})",context);
  await runInContext("sendMessage({preventDefault(){}})",context);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({requestId:"request-1",planSelection:plan});
});

it("imports an upload once, waits for an explicit choice and then creates the selected conversation",async()=>{
  const source=await readFile(resolve(PROJECT_ROOT,"web/app.js"),"utf8");
  const nodes=new Map<string,any>();
  const $=(id:string)=>{if(!nodes.has(id))nodes.set(id,{value:"",files:[],disabled:false,hidden:false,textContent:"",close(){},focus(){}});return nodes.get(id);};
  $("original-file").files=[{name:"new.xlsx",size:100}];
  const state:any={sourceMode:"upload",bootstrap:{sources:[]}};
  const requests:any[]=[];
  const context=createContext({state,$,document:{querySelectorAll:()=>[]},readBase64:async()=>"bytes",markConnected(){},markDisconnected(){},refreshSources(){},renderSourceDetail(){},toast(){},updateConversationSummary(){},selectConversation:async()=>{},
    loadSourcePlans:async()=>{state.sourcePlanChoices=[plan];},
    api:async(path:string,options:{body:string})=>{requests.push({path,body:JSON.parse(options.body)});return path==="/api/uploads"?{id:"uploaded",supported:true}:{conversation:{id:"created"}};}});
  runInContext(source.slice(source.indexOf("async function createConversation("),source.indexOf("async function sendMessage(")),context);
  await runInContext("createConversation({preventDefault(){}})",context);
  expect(requests.map(r=>r.path)).toEqual(["/api/uploads"]);
  expect(state.uploadSourceId).toBe("uploaded");
  $("source-plan-select").value=plan.planVersionId;
  await runInContext("createConversation({preventDefault(){}})",context);
  expect(requests.map(r=>r.path)).toEqual(["/api/uploads","/api/conversations"]);
  expect(requests[1].body).toEqual({sourceId:"uploaded",planSelection:plan});
});
