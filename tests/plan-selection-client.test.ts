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

// 用轻量 DOM 执行真实文件弹窗代码，观察实际文字而不是搜索脚本。
async function sourceDialog(api: (path: string, options?: any) => Promise<any>) {
  const script = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  const nodes = new Map<string, any>();
  const node = (text = "") => ({
    value: "", files: [] as any[], hidden: false, disabled: false, open: false, children: [] as any[], ownText: text,
    get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); },
    set textContent(value: string) { this.ownText = value; this.children = []; },
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren(...children: any[]) { this.ownText = ""; this.children = children; },
    close() { this.open = false; }, showModal() { this.open = true; }, focus() {},
  });
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const sources = [
    { id: "sample-controlled", label: "海运运价表示例", filename: "small.xlsx", requirementsName: "controlled-requirements.txt", kind: "sample", supported: true, hasRequirements: true, contractStatus: "missing" },
    { id: "B", label: "无说明", filename: "B.xlsx", requirementsName: "占位说明.txt", supported: true, hasRequirements: false, contractStatus: "missing" },
    { id: "C", label: "已有规则", filename: "C.xlsx", requirementsName: "占位名称", supported: true, hasRequirements: false, contractStatus: "confirmed" },
    { id: "candidate", label: "候选", filename: "candidate.xlsx", supported: true, hasRequirements: false, contractStatus: "candidate" },
    { id: "missing", label: "缺失原文", filename: "missing.xlsx", supported: false, hasRequirements: false, reason: "原文件未找到" },
    { id: "missing-rules", label: "缺失说明", filename: "small.xlsx", supported: false, hasRequirements: false, reason: "配套抽取说明缺失" },
  ];
  const state: any = { sourceMode: "sample", bootstrap: { sources } };
  const context = createContext({ state, $, api, document: { createTextNode: (text: string) => node(text), querySelectorAll: () => [] },
    el: (_tag: string, _class: string, text = "") => node(text),
    syncSelect: (select: any, options: any[], selected: string) => { select.replaceChildren(...options.map((option) => Object.assign(node(option.label), { value: option.value }))); select.value = selected; },
    closeSidebar() {}, readBase64: async () => "bytes", TextDecoder,
    markConnected() {}, markDisconnected() {}, toast() {}, updateConversationSummary() {}, selectConversation: async () => {},
  });
  runInContext(script.slice(script.indexOf("function openSourceDialog("), script.indexOf("function readBase64(")), context);
  runInContext(script.slice(script.indexOf("async function createConversation("), script.indexOf("async function sendMessage(")), context);
  const run = (code: string) => runInContext(code, context);
  // 真实切换顺序与 change 监听器保持一致，loadSourcePlans 同步清理旧结论。
  const select = async (id: string) => { $("source-select").value = id; run("renderSourceDetail()"); await run(`loadSourcePlans(${JSON.stringify(id)})`); };
  return { $, state, run, select };
}

it("renders business sample names and separates attached explanations from reusable rules", async () => {
  const { $, select, run } = await sourceDialog(async () => ({ plans: [], selection: "none" }));
  run("refreshSources()");
  expect($("source-select").textContent).toContain("海运运价表示例");
  expect($("source-select").textContent).not.toContain("试点");
  await select("sample-controlled");
  for (const text of ["small.xlsx", "合成演示数据", "已附抽取说明", "controlled-requirements.txt"]) expect($("source-detail").textContent).toContain(text);
  expect($("source-plan-select").textContent).toBe("不使用方案");
  expect($("source-plan-detail").textContent).toContain("将按附带抽取说明继续");
  expect($("source-plan-detail").textContent).not.toContain("先观察");
  await select("B");
  expect($("source-detail").textContent).toContain("未附抽取说明");
  expect($("source-detail").textContent).not.toContain("占位说明");
  expect($("source-plan-detail").textContent).toContain("发送抽取要求后，会先观察原文");
  expect($("source-plan-detail").textContent).toContain("供人工确认");
  await select("C");
  expect($("source-detail").textContent).toContain("未附抽取说明");
  expect($("source-plan-detail").textContent).toContain("已有已确认规则可沿用");
  expect($("source-plan-detail").textContent).not.toContain("先观察");
  await select("candidate");
  expect($("source-plan-detail").textContent).toContain("先观察原文");
  expect($("source-plan-detail").textContent).not.toContain("已有已确认规则");
  for (const id of ["missing", "missing-rules"]) {
    await select(id);
    expect($("source-detail").textContent).toContain("暂不可用");
    expect($("source-detail").textContent).toContain(id === "missing" ? "原文件未找到" : "配套抽取说明缺失");
    expect($("create-conversation").disabled).toBe(true);
    expect($("source-plan-detail").textContent).not.toContain("先观察");
  }
  await select("sample-controlled");
  expect($("create-conversation").disabled).toBe(false);
});

it("ignores old plan responses and never announces observation while loading or failed", async () => {
  let release!: (value: any) => void;
  const late = new Promise((done) => { release = done; });
  const { $, run, select, state } = await sourceDialog(async (path) => {
    if (path.includes("sample-controlled")) return late;
    if (path.includes("candidate")) throw new Error("offline");
    return { plans: [], selection: "none" };
  });
  await select("B");
  $("source-select").value = "sample-controlled";
  run("renderSourceDetail()");
  const pending = run("loadSourcePlans('sample-controlled')");
  expect($("source-plan-detail").textContent).toContain("正在读取");
  expect($("source-plan-select").value).toBe("");
  expect($("source-plan-detail").textContent).not.toContain("先观察");
  await select("B");
  release({ plans: [plan], selection: "unique", preselectedPlanVersionId: plan.planVersionId });
  await pending;
  expect(state.sourcePlanChoices).toEqual([]);
  expect($("source-plan-select").value).toBe("");
  expect($("source-detail").textContent).toContain("B.xlsx");
  expect($("source-plan-detail").textContent).toContain("先观察原文");
  await select("C");
  expect($("source-plan-detail").textContent).toContain("已确认规则");
  await select("candidate");
  expect($("source-plan-detail").textContent).toContain("尚未确定");
  expect($("source-plan-detail").textContent).not.toContain("先观察");
  expect($("source-error").hidden).toBe(false);
});

it("keeps manual selection tokens, cancellation guidance, unique preselection and multiple-match limits", async () => {
  let match = "none";
  const requests: any[] = [];
  const { $, run, select } = await sourceDialog(async (path, options) => {
    requests.push({ path, body: options?.body && JSON.parse(options.body) });
    if (path === "/api/conversations") return { conversation: { id: "created" } };
    return { plans: [plan], selection: match, ...(match === "unique" ? { preselectedPlanVersionId: plan.planVersionId } : {}) };
  });
  await select("B");
  $("source-plan-select").value = plan.planVersionId;
  run("renderSourcePlan()");
  for (const text of [plan.name, plan.supplier, plan.docType, plan.contractVersion]) expect($("source-plan-detail").textContent).toContain(text);
  expect($("source-plan-detail").textContent).not.toContain("先观察");
  await run("createConversation({preventDefault(){}})");
  expect(requests.at(-1).body.planSelection).toEqual(plan);
  $("source-plan-select").value = "";
  run("renderSourcePlan()");
  expect($("source-plan-detail").textContent).toContain("先观察");
  match = "unique";
  await select("B");
  expect($("source-plan-select").value).toBe(plan.planVersionId);
  expect($("source-plan-detail").textContent).toContain("唯一精确匹配");
  match = "multiple";
  await select("B");
  expect($("source-plan-select").value).toBe("");
  expect($("source-plan-detail").textContent).toContain("请先手动选择");
  expect($("source-plan-detail").textContent).not.toContain("先观察");
  const count = requests.length;
  await run("createConversation({preventDefault(){}})");
  expect(requests).toHaveLength(count);
  expect($("source-error").textContent).toContain("请先手动选择");
});

it.each([true, false])("shows just-imported explanation state (%s) and creates without sending", async (attached) => {
  const requests: string[] = [];
  const { $, run, select } = await sourceDialog(async (path) => {
    requests.push(path);
    if (path === "/api/uploads") return { id: "new-upload", filename: "new.xlsx", label: "new.xlsx", kind: "upload", supported: true, hasRequirements: attached, requirementsName: "new.txt", contractStatus: "missing" };
    if (path === "/api/conversations") return { conversation: { id: "created" } };
    return { plans: [], selection: "none" };
  });
  await select("sample-controlled");
  run("setSourceMode('upload')");
  expect($("source-detail").hidden).toBe(true);
  expect($("source-plan-detail").textContent).toBe("");
  $("original-file").files = [{ name: "new.xlsx", size: 100 }];
  if (attached) $("requirements-file").files = [{ name: "new.txt", arrayBuffer: async () => new TextEncoder().encode("新说明").buffer }];
  await run("createConversation({preventDefault(){}})");
  expect(requests.filter((path) => path === "/api/uploads")).toHaveLength(1);
  expect(requests).not.toContain("/api/conversations");
  expect($("source-detail").hidden).toBe(false);
  expect($("source-detail").textContent).toContain("new.xlsx");
  expect($("source-detail").textContent).not.toContain("small.xlsx");
  expect($("source-detail").textContent).toContain(attached ? "已附抽取说明" : "未附抽取说明");
  expect($("source-plan-detail").textContent).toContain(attached ? "将按附带抽取说明继续" : "先观察原文");
  await run("createConversation({preventDefault(){}})");
  expect(requests.filter((path) => path === "/api/uploads")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/conversations")).toHaveLength(1);
  expect(requests.some((path) => /\/messages$/.test(path))).toBe(false);
  run("resetUploadSource()");
  expect($("source-detail").hidden).toBe(true);
  expect($("source-plan-detail").textContent).toBe("");
  run("setSourceMode('upload')");
  expect($("source-plan-detail").textContent).toBe("");
  expect($("source-detail").hidden).toBe(true);
  $("source-select").value = "sample-controlled";
  run("openSourceDialog()");
  await Promise.resolve(); await Promise.resolve();
  expect($("source-detail").textContent).toContain("small.xlsx");
  expect($("source-plan-select").value).toBe("");
  expect($("source-plan-detail").textContent).not.toContain("先观察");
});
