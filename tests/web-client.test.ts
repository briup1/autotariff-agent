import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { PROJECT_ROOT } from "../src/closure/paths.js";

it.each(["truncated", "malformed"])("keeps the same paid request identity after a %s success response", async (failure) => {
  const source = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  const api = source.slice(source.indexOf("async function api("), source.indexOf("function markConnected("));
  const send = source.slice(source.indexOf("async function sendMessage("), source.indexOf("async function openArtifact("));
  const requests: Array<{ requestId: string; content: string }> = [];
  let pending: unknown = null;
  let sequence = 0;
  const input = { value: "同一条抽取要求" };
  const context = createContext({
    state: { selection: "c1", sending: false, notice: "", drafts: new Map(), conversation: { messages: [] } },
    crypto: { randomUUID: () => `request-${++sequence}` },
    $: (id: string) => id === "message-input" ? input : { disabled: false },
    isActive: () => false,
    pendingFor: () => pending,
    savePending: (_id: string, value: unknown) => { pending = value; },
    markConnected: () => {}, markDisconnected: () => {}, renderComposer: () => {}, renderMessages: () => {}, renderSidebar: () => {}, renderConversationHeader: () => {}, updateConversationSummary: () => {}, loadRun: async () => {},
    fetch: async (_path: string, options: { body: string }) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 202, json: async () => {
        if (requests.length === 1) {
          if (failure === "truncated") throw new TypeError("terminated after 202 headers");
          return {};
        }
        return { conversation: { id: "c1" }, runs: [], messages: [] };
      } };
    },
  });
  runInContext(api + send, context);
  await runInContext("sendMessage({preventDefault(){}})", context);
  expect(pending).toMatchObject({ requestId: "request-1", content: input.value });
  await runInContext("sendMessage({preventDefault(){}})", context);
  expect(requests.map((request) => request.requestId)).toEqual(["request-1", "request-1"]);
  expect(pending).toBeNull();
});

// 复用轻量 DOM 替身，直接执行真实渲染函数，不以替身验证像素布局。
function resultNode(tag = "", className = "", text: unknown = ""): any {
  return { tag, className, textContent: String(text), children: [] as any[], handlers: {} as Record<string, () => unknown>,
    append(...children: any[]) { this.children.push(...children); },
    setAttribute() {}, addEventListener(event: string, handler: () => unknown) { this.handlers[event] = handler; } };
}

// 返回指定标签的所有后代，核对表头与逐行值的一一对应。
function descendants(node: any, tag: string): any[] {
  return [...(node.tag === tag ? [node] : []), ...node.children.flatMap((child: any) => descendants(child, tag))];
}

// 装载合成基准和结果区函数，同时保留用于模式切换断言的状态。
async function resultClient(items?: Record<string, unknown>[]) {
  const source = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  const records = items || JSON.parse(await readFile(resolve(PROJECT_ROOT, "tests/fixtures/history-result-review.json"), "utf8"));
  const state: any = { selection: null, evidenceTab: "results", run: { run: { origin: "history", sourceName: "合成 UI" }, attempts: [{ id: "a2", reportStatus: "available" }], selectedAttemptId: "a2", records: { status: "available", items: records, offset: 0, limit: 2, total: 2 }, issues: [] } };
  const nodes = new Map<string, any>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, { dataset: {}, classList: { toggle(_name: string, active: boolean) { nodes.get(id).active = active; } } }); return nodes.get(id); };
  const viewport = { narrow: false };
  const context = createContext({ state, $: get, matchMedia: () => ({ matches: viewport.narrow }), document: { querySelector: get, querySelectorAll: () => [], createDocumentFragment: () => resultNode() }, el: resultNode, runCallout: () => null, number: String, badge: () => resultNode(), sectionTitle: () => resultNode(), setEvidenceTab: (tab: string) => { state.evidenceTab = tab; } });
  runInContext(source.slice(source.indexOf("function valueText("), source.indexOf("function cellText(")) + source.slice(source.indexOf("function historyResultsMode("), source.indexOf("// 更新证据内容")) + source.slice(source.indexOf("function resultKeys("), source.indexOf("function artifactUrl(")), context);
  runInContext(source.slice(source.indexOf("function setMobileTab("), source.indexOf("function closeSidebar(")), context);
  return { state, nodes, viewport, render: () => runInContext("renderResults()", context), layout: () => runInContext("renderHistoryResultsLayout()", context), mobile: (tab: string) => runInContext(`setMobileTab(${JSON.stringify(tab)})`, context) };
}

it("prioritizes existing history pricing fields without dropping optional keys or mutating records", async () => {
  const client = await resultClient();
  const before = JSON.stringify(client.state.run.records.items);
  const table = client.render();
  const headers = descendants(table, "th").map((node) => node.textContent);
  expect(headers).toEqual(["#", "origin", "destination", "20GP卖价", "40GP卖价", "40HQ卖价", "运价有效开始时间", "运价有效结束时间", "recordId", "sourceId", "ETD", "运价备注", "自定义字段"]);
  const rows = descendants(table, "tbody")[0].children.map((row: any) => row.children.map((cell: any) => cell.textContent));
  expect(rows[0]).toEqual(["1", "SHANGHAI", "SINGAPORE", "120", "230", "245", "2026-11-01", "2026-11-15", "quote-A", "报价!R2C1", "2026-11-03", "合成备注 A", "未提供"]);
  expect(rows[1].slice(0, 12)).toEqual(["2", "NINGBO", "BUSAN", "210", "340", "365", "2026-12-01", "2026-12-20", "quote-B", "报价!R8C1", "2026-12-05", "合成备注 B"]);
  expect(rows[1][12]).toContain("仅记录 B");
  expect(descendants(table, "td").at(-1).title).toBe(rows[1][12]);
  expect(JSON.stringify(client.state.run.records.items)).toBe(before);
});

it("does not invent validity dates from ETD and preserves unknown, null and missing values", async () => {
  const client = await resultClient([{ recordId: "one", ETD: "2026-11-03", unknown: null }, { recordId: "one", ETD: "2026-12-05", extra: { nested: 1 } }]);
  const before = JSON.stringify(client.state.run.records.items);
  const table = client.render();
  expect(descendants(table, "th").map((node) => node.textContent)).toEqual(["#", "recordId", "ETD", "unknown", "extra"]);
  expect(descendants(table, "tbody")[0].children.map((row: any) => row.children.map((cell: any) => cell.textContent))).toEqual([["1", "one", "2026-11-03", "null", "未提供"], ["2", "one", "2026-12-05", "未提供", '{\n  "nested": 1\n}']]);
  expect(JSON.stringify(client.state.run.records.items)).toBe(before);
});

it("enters and exits history mode on evidence and conversation changes without leaking column order", async () => {
  const client = await resultClient();
  client.layout();
  expect(client.nodes.get("workspace").active).toBe(true);
  expect(client.nodes.get(".chat-panel").inert).toBe(true);
  expect(client.nodes.get("history-result-source").textContent).toBe("合成 UI");
  for (const tab of ["activity", "artifacts", "tests"]) {
    client.state.evidenceTab = tab; client.layout();
    expect(client.nodes.get("workspace").active).toBe(false);
    expect(client.nodes.get(".chat-panel").inert).toBe(false);
    expect(client.nodes.get("history-result-context").hidden).toBe(true);
  }
  client.state.evidenceTab = "results";
  client.state.selection = "existing-work"; client.layout();
  expect(client.nodes.get("workspace").active).toBe(false);
  expect(descendants(client.render(), "th").slice(1, 4).map((node) => node.textContent)).toEqual(["recordId", "sourceId", "origin"]);
  client.state.selection = null; client.state.run.run.origin = "live"; client.layout();
  expect(client.nodes.get("workspace").active).toBe(false);
  expect(descendants(client.render(), "th")[1].textContent).toBe("recordId");
  client.state.run = null; client.layout();
  expect(client.nodes.get("workspace").active).toBe(false);
  expect(client.nodes.get(".skip-link").href).toBe("#message-input");
});

it("keeps skip-link labels and chat accessibility in sync across mobile views and the 767px breakpoint", async () => {
  const client = await resultClient();
  client.viewport.narrow = true;
  client.mobile("results");
  expect(client.nodes.get(".skip-link")).toMatchObject({ href: "#evidence-title", textContent: "跳到工作证据" });
  expect(client.nodes.get(".chat-panel").inert).toBe(true);
  client.mobile("chat");
  expect(client.nodes.get(".skip-link")).toMatchObject({ href: "#message-input", textContent: "跳到消息输入" });
  expect(client.nodes.get(".chat-panel").inert).toBe(false);
  client.mobile("results");
  expect(client.nodes.get(".skip-link").href).toBe("#evidence-title");
  client.mobile("chat");
  client.viewport.narrow = false; client.layout();
  expect(client.nodes.get(".chat-panel").inert).toBe(true);
  expect(client.nodes.get(".skip-link")).toMatchObject({ href: "#evidence-title", textContent: "跳到工作证据" });
  client.state.evidenceTab = "activity"; client.layout();
  expect(client.nodes.get(".chat-panel").inert).toBe(false);
  client.state.evidenceTab = "results"; client.layout();
  expect(client.nodes.get(".chat-panel").inert).toBe(true);
  client.viewport.narrow = true; client.layout();
  expect(client.nodes.get(".chat-panel").inert).toBe(false);
  expect(client.nodes.get(".skip-link")).toMatchObject({ href: "#message-input", textContent: "跳到消息输入" });
  const source = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  expect(source).toContain("matchMedia('(max-width:767px)').addEventListener('change', renderHistoryResultsLayout)");
});

it("keeps the evidence skip target focusable while an attempt or page request is pending", async () => {
  const source = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  const html = await readFile(resolve(PROJECT_ROOT, "web/index.html"), "utf8");
  expect(html).toContain('<h2 id="evidence-title" tabindex="-1">工作证据</h2>');
  for (const operation of ["selectAttempt('a1')", "state.offset = 2; loadRun(state.runId, { preserve: true })"]) {
    const nodes = new Map<string, any>();
    const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, { dataset: {}, value: "", textContent: "", classList: { toggle() {} } }); return nodes.get(id); };
    const state: any = { selection: null, mobileTab: "results", evidenceTab: "results", runId: "synthetic-history", offset: 0, runEpoch: 0, run: { run: { origin: "history", sourceName: "合成" } } };
    const requests: string[] = [];
    const context = createContext({ state, $: get, URLSearchParams, matchMedia: () => ({ matches: true }), document: { querySelector: get },
      api: (url: string) => { requests.push(url); return new Promise(() => {}); },
      renderEvidence: () => { runInContext("renderHistoryResultsLayout()", context); get("refresh-run").disabled = state.runLoading; } });
    runInContext(source.slice(source.indexOf("function historyResultsMode("), source.indexOf("// 更新证据内容")) + source.slice(source.indexOf("async function loadRun("), source.indexOf("function setEvidenceTab(")), context);
    runInContext(operation, context);
    expect(state.runLoading).toBe(true);
    expect(get("refresh-run").disabled).toBe(true);
    expect(get(".skip-link")).toMatchObject({ href: "#evidence-title", textContent: "跳到工作证据" });
    expect(requests[0]).toContain(operation.startsWith("selectAttempt") ? "attempt=a1" : "offset=2");
  }
});
