import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { PROJECT_ROOT } from "../src/closure/paths.js";

async function client(confirm = true) {
  const source = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  const nodes = new Map<string, any>();
  const document = { activeElement: null as any };
  function node() {
    return { id: "", value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {} as Record<string, string>, children: [] as any[], handlers: {} as Record<string, (event?: any) => void>, attributes: {} as Record<string, string>,
      append(...children: any[]) { this.children.push(...children); }, replaceChildren(...children: any[]) { this.children = children; },
      addEventListener(event: string, fn: (event?: any) => void) { this.handlers[event] = fn; },
      setAttribute(name: string, value: string) { this.attributes[name] = value; }, removeAttribute(name: string) { delete this.attributes[name]; },
      focus() { document.activeElement = this; },
      showModal() { this.open = true; }, close() { this.open = false; this.handlers.close?.(); },
      querySelector(selector: string): any { return this.children.map((child) => child.id === selector.slice(1) ? child : child.querySelector?.(selector)).find(Boolean); },
    };
  }
  const $ = (id: string) => { if (!nodes.has(id)) { const value = node(); value.id = id; nodes.set(id, value); } return nodes.get(id)!; };
  const requests: { path: string; body?: any }[] = [];
  const state = { bootstrap: { plans: [] as any[] } };
  let failure: string | number | undefined;
  let pendingRead: Promise<any> | undefined;
  let pendingWrite: Promise<any> | undefined;
  let sequence = 0;
  const context = createContext({
    $, state, document, crypto: { randomUUID: () => `archive-request-${++sequence}` }, window: { confirm: () => confirm },
    el: (_tag: string, _class: string, text: string) => Object.assign(node(), { textContent: text || "", className: _class }),
    toast: () => {}, readableDate: (value: string) => value,
    api: async (path: string, options?: { body: string }) => {
      requests.push({ path, ...(options ? { body: JSON.parse(options.body) } : {}) });
      if (!options && pendingRead) return pendingRead;
      if (options && pendingWrite) return pendingWrite;
      if (failure === "read" && !options) { failure = undefined; throw new Error("读取失败"); }
      if (path.endsWith("archive-options")) return { contracts: [{ requirementsDigest: "digest", contractVersion: "v1", name: "本周表", supplier: "怡升昌", docType: "海运" }] };
      if (path.endsWith("version-options")) return {contracts:[{requirementsDigest:"new-digest",contractSha256:"preview-sha",sourceId:"new-source",sourceName:"新表.xlsx",contractVersion:"candidate",contract:{fields:[{name:"price",role:"price"}]}}]};
      if (path === "/api/plans" && !options) return { plans: state.bootstrap.plans };
      if (failure === "malformed") { failure = undefined; return {}; }
      if (failure) { const error = Object.assign(new Error("save failed"), { status: typeof failure === "number" ? failure : undefined }); failure = undefined; throw error; }
      if (path.endsWith("/versions")) return {plan:{planId:"plan-1",currentVersionId:"version-2",name:"本周表",status:"confirmed"},version:{planVersionId:"version-2",contractVersion:"v2"}};
      return { planId: "plan-1", currentVersionId: "version-1", name: "本周表", supplier: "怡升昌", docType: "海运", status: path.endsWith("deactivate") ? "inactive" : "confirmed", lastUsedAt: null, lastResult: null };
    },
  });
  runInContext(source.slice(source.indexOf("function renderPlanLibrary("), source.indexOf("async function openArtifact(")), context);
  for (const line of source.split("\n").filter((line) => /^\$\('(cancel-plan|plan-form-dialog|plan-library-dialog)'\).addEventListener/.test(line))) runInContext(line, context);
  return { $, requests, context, state, document, failNext: (mode: string | number) => { failure = mode; }, deferRead: (promise: Promise<any> | undefined) => { pendingRead = promise; }, deferWrite: (promise: Promise<any>) => { pendingWrite = promise; } };
}
function text(node: any): string { return node.textContent + node.children.map(text).join(" "); }

it("shows a meaningful empty library and prefills archive fields from the confirmed source", async () => {
  const { $, context } = await client();
  runInContext("renderPlanLibrary()", context);
  expect(text($("plan-library-content"))).toContain("尚无方案");
  await runInContext("openArchivePlan('digest')", context);
  expect($("plan-name").value).toBe("本周表");
  expect($("plan-supplier").value).toBe("怡升昌");
  expect($("plan-doc-type").value).toBe("海运");
});

it("previews a new contract, requires human confirmation, and cancels without creating a version",async()=>{
  const {$,context,requests}=await client();
  await runInContext("openPlanVersion({planId:'plan-1',currentVersionId:'version-1',name:'本周表'})",context);
  expect($("plan-form-title").textContent).toBe("创建新版本");
  expect($("plan-metadata-fields").hidden).toBe(true);
  expect($("plan-contract-preview").textContent).toContain('"price"');
  await runInContext("savePlan({preventDefault(){}})",context);
  expect(requests.filter(r=>r.body)).toHaveLength(0);
  $("cancel-plan").handlers.click();
  expect($("plan-form-dialog").open).toBe(false);
  expect(requests.filter(r=>r.body)).toHaveLength(0);
});

it("retries a confirmed new-version submission after a lost response without a second version identity",async()=>{
  const {$,context,requests,failNext}=await client();
  await runInContext("openPlanVersion({planId:'plan-1',currentVersionId:'version-1',name:'本周表'})",context);
  $("confirm-plan-version").checked=true;
  failNext("lost");
  await runInContext("savePlan({preventDefault(){}})",context);
  expect($("plan-fields").disabled).toBe(true);
  $("cancel-plan").handlers.click();
  await runInContext("openArchivePlan()",context);
  expect($("plan-form-title").textContent).toBe("创建新版本");
  await runInContext("savePlan({preventDefault(){}})",context);
  const writes=requests.filter(r=>r.body);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].body).toMatchObject({confirmContract:true,sourceId:"new-source",expectedCurrentVersionId:"version-1",contractSha256:"preview-sha"});
  expect($("plan-library-status").textContent).toContain("v2");
});

it("cancels archive, rename and deactivation without a write", async () => {
  const { $, context, requests } = await client(false);
  await runInContext("openArchivePlan('digest')", context);
  $("cancel-plan").handlers.click();
  expect($("plan-form-dialog").open).toBe(false);
  runInContext("openRenamePlan({planId:'p', name:'原名称'})", context);
  expect($("plan-name").value).toBe("原名称");
  $("cancel-plan").handlers.click();
  await runInContext("changePlanStatus({planId:'p',name:'原名称',status:'confirmed'})", context);
  expect(requests.map((entry) => entry.path)).toEqual(["/api/plans/archive-options"]);
});

it.each(["lost", "malformed", 500])("retries the original payload after %s, even after field edits and reopening", async (mode) => {
  const { $, context, requests, state, failNext } = await client();
  await runInContext("openArchivePlan('digest')", context);
  failNext(mode);
  await runInContext("savePlan({preventDefault(){}})", context);
  expect($("plan-form-dialog").open).toBe(true);
  expect($("plan-error").hidden).toBe(false);
  expect($("plan-fields").disabled).toBe(true);
  $("cancel-plan").handlers.click();
  await runInContext("openArchivePlan('other-digest')", context);
  expect($("plan-contract").value).toBe("digest");
  $("plan-name").value = "另一份规则";
  $("plan-contract").value = "other-digest";
  await runInContext("savePlan({preventDefault(){}})", context);
  const writes = requests.filter((entry) => entry.body);
  expect(writes[1].body).toEqual(writes[0].body);
  expect(state.bootstrap.plans).toHaveLength(1);
  expect(text($("plan-library-content"))).toContain("尚未使用");
  expect(text($("plan-library-content"))).toContain("暂无");
});

it("allows correcting a definitively rejected name with a new request identity", async () => {
  const { $, context, requests, failNext } = await client();
  await runInContext("openArchivePlan('digest')", context);
  failNext(409);
  await runInContext("savePlan({preventDefault(){}})", context);
  expect($("plan-fields").disabled).toBe(false);
  $("plan-name").value = "修正后的名称";
  await runInContext("savePlan({preventDefault(){}})", context);
  const writes = requests.filter((entry) => entry.body);
  expect(writes[1].body.name).toBe("修正后的名称");
  expect(writes[1].body.requestId).not.toBe(writes[0].body.requestId);
  expect($("plan-error").hidden).toBe(true);
});

it("shows library read errors and supports retry without pretending the library is empty", async () => {
  const { $, context, failNext } = await client();
  failNext("read");
  await runInContext("openPlanLibrary()", context);
  expect($("plan-library-dialog").open).toBe(true);
  expect($("plan-library-error").hidden).toBe(false);
  expect($("retry-plan-library").hidden).toBe(false);
  await runInContext("loadPlanLibrary()", context);
  expect($("plan-library-error").hidden).toBe(true);
  expect(text($("plan-library-content"))).toContain("尚无方案");
});

it.each(["library", "archive"])("ignores late %s responses after close and a new opening", async (kind) => {
  const { $, context, deferRead } = await client();
  let resolveRead!: (value: any) => void;
  deferRead(new Promise((resolve) => { resolveRead = resolve; }));
  const first = runInContext(kind === "library" ? "openPlanLibrary()" : "openArchivePlan()", context);
  expect($(kind === "library" ? "plan-library-dialog" : "plan-form-dialog").open).toBe(true);
  runInContext(kind === "library" ? "closePlanLibrary()" : "closePlanForm()", context);
  deferRead(undefined);
  await runInContext(kind === "library" ? "openPlanLibrary()" : "openArchivePlan()", context);
  resolveRead(kind === "library" ? { plans: [{ name: "过期响应" }] } : { contracts: [] });
  await first;
  expect($(kind === "library" ? "plan-library-dialog" : "plan-form-dialog").open).toBe(true);
  expect(text($("plan-library-content"))).not.toContain("过期响应");
  if (kind === "archive") expect($("plan-name").value).toBe("本周表");
});

it("announces lifecycle success and restores focus to the replacement row action", async () => {
  const { $, context, state, document } = await client();
  $("plan-library-dialog").showModal();
  state.bootstrap.plans = [{ planId: "plan-1", name: "本周表", status: "confirmed" }];
  await runInContext("changePlanStatus(state.bootstrap.plans[0])", context);
  expect(state.bootstrap.plans[0].status).toBe("inactive");
  expect($("plan-library-status").textContent).toContain("已停用");
  expect(document.activeElement?.textContent).toBe("恢复");
});


it("prevents closing and duplicate writes only while saving, and exposes busy feedback inside the form", async () => {
  const { $, context, requests, deferWrite } = await client();
  await runInContext("openArchivePlan()", context);
  let finish!: (value: any) => void;
  deferWrite(new Promise((resolve) => { finish = resolve; }));
  const saving = runInContext("savePlan({preventDefault(){}})", context);
  expect($("save-plan").disabled).toBe(true);
  expect($("cancel-plan").disabled).toBe(true);
  expect($("plan-form-status").textContent).toContain("正在保存");
  let prevented = false;
  $("plan-form-dialog").handlers.cancel({ preventDefault() { prevented = true; } });
  expect(prevented).toBe(true);
  $("cancel-plan").handlers.click();
  expect($("plan-form-dialog").open).toBe(true);
  await runInContext("savePlan({preventDefault(){}})", context);
  expect(requests.filter((entry) => entry.body)).toHaveLength(1);
  finish({ planId: "p", currentVersionId: "v1", name: "本周表" });
  await saving;
  expect($("cancel-plan").disabled).toBe(false);
  prevented = false;
  $("plan-form-dialog").handlers.cancel({ preventDefault() { prevented = true; } });
  expect(prevented).toBe(false);
});

it("shows archive read errors inside the active dialog and allows retry", async () => {
  const { $, context, failNext } = await client();
  failNext("read");
  await runInContext("openArchivePlan()", context);
  expect($("plan-form-dialog").open).toBe(true);
  expect($("plan-fields").hidden).toBe(true);
  expect($("plan-error").textContent).toContain("读取归档字段失败");
  expect($("retry-plan-archive").hidden).toBe(false);
  await runInContext("loadPlanArchive()", context);
  expect($("plan-fields").hidden).toBe(false);
  expect($("plan-error").hidden).toBe(true);
});
