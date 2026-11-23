import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { PROJECT_ROOT } from '../src/closure/paths.js';

type RecordData = Record<string, unknown>;

// 提供渲染所需的最小 DOM，并记录真实按钮事件。
class TestNode {
  textContent = '';
  className = '';
  children: TestNode[] = [];
  handlers: Record<string, () => unknown> = {};
  disabled = false;
  hidden = false;
  scrollTop = 0;
  dataset = {};
  // 保存标签以按表格结构定位逐行提示。
  constructor(public tagName = '') {}
  // 按原顺序追加 DOM 子节点。
  append(...children: TestNode[]) { this.children.push(...children); }
  // 模拟整体替换，确保测试能发现旧页提示残留。
  replaceChildren(...children: TestNode[]) { this.children = children; }
  // 此替身无需保存不影响文本与交互的可访问性属性。
  setAttribute() {}
  // 记录点击事件供测试走真实分页与轮次路径。
  addEventListener(event: string, handler: () => unknown) { this.handlers[event] = handler; }
  // 本测试不模拟焦点，避免干扰真实渲染逻辑。
  contains() { return false; }
  // 本测试没有已聚焦控件，返回空的焦点候选列表。
  querySelectorAll() { return []; }
}

// 展开节点可见文本，不读取源码字符串作为行为断言。
function text(node: TestNode): string {
  return [node.textContent, ...node.children.map(text)].join(' ');
}

// 从真实 DOM 结构中递归查找节点。
function find(node: TestNode, predicate: (node: TestNode) => boolean): TestNode[] {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => find(child, predicate))];
}

// 构造已知历史字段，测试不读取或写入任何历史账本。
function record(start: unknown = '2026-11-03', end: unknown = '2026-08-30', sourceId = 'Rates!R2C1'): RecordData {
  return { sourceId, '运价有效开始时间': start, '运价有效结束时间': end };
}

// 构造原零问题、待复核报告及两个可切换轮次。
function detail(items: RecordData[], offset = 0, attempt = 'a1') {
  return {
    run: { runId: 'r1', decision: 'REVIEW', origin: 'history', active: false, issueCount: 0 },
    attempts: ['a1', 'a2'].map(id => ({ id, reportStatus: 'available', validationStatus: 'REVIEW', issueCount: 0 })),
    selectedAttemptId: attempt,
    records: { status: 'available', items, offset, limit: 50, total: 51 },
    issues: [],
  };
}

// 在隔离 VM 中执行真实 DOM 工具、结果渲染、状态栏及加载交互代码。
async function setup(initial = detail([record(), record('2026-11-03', '2026-08-07', 'Rates!R3C1')])) {
  const code = await readFile(resolve(PROJECT_ROOT, 'web/app.js'), 'utf8');
  const nodes = new Map<string, TestNode>();
  const requests: string[] = [];
  const state = { run: initial, runId: 'r1', offset: initial.records.offset, attemptId: initial.selectedAttemptId, runEpoch: 0, evidenceTab: 'results', runKey: '', runLoading: false };
  let response = (url: URL) => detail([record('2026-08-01', '2026-08-30')], Number(url.searchParams.get('offset')), url.searchParams.get('attempt') || 'a1');
  // 获取固定页面节点，使重新渲染能够替换同一容器。
  const getNode = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new TestNode());
    return nodes.get(id)!;
  };
  const context = createContext({
    state, URLSearchParams,
    $: getNode,
    document: {
      activeElement: null,
      createElement: (tag: string) => new TestNode(tag),
      createDocumentFragment: () => new TestNode('fragment'),
      createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    },
    syncSelect() {}, markConnected() {}, markDisconnected() {}, renderConversationHeader() {}, renderMessages() {}, updateLocation() {}, toast() {},
    renderActivity() {}, renderArtifacts() {},
    // 仅允许真实加载代码的读取接口；任何写请求立即使测试失败。
    api: async (path: string, options?: unknown) => {
      expect(options).toBeUndefined();
      expect(path).toMatch(/^\/api\/runs\/r1\?/);
      requests.push(path);
      return response(new URL(path, 'http://127.0.0.1'));
    },
  });
  runInContext(
    code.slice(code.indexOf('const statuses ='), code.indexOf('const operations ='))
    + code.slice(code.indexOf('const iconPaths ='), code.indexOf('function bytes('))
    + code.slice(code.indexOf('function renderRunChrome('), code.indexOf('function renderActivity('))
    + code.slice(code.indexOf('function isResultDate('), code.indexOf('function artifactUrl('))
    + code.slice(code.indexOf('async function loadRun('), code.indexOf('function setEvidenceTab(')), context);
  // 调用真实证据渲染，包含运行状态、轮次状态和结果容器替换。
  const render = () => runInContext('renderEvidence()', context);
  render();
  return { state, nodes, requests, context, render, root: () => getNode('evidence-content'), call: (source: string) => runInContext(source, context), respond: (next: typeof response) => { response = next; } };
}

it('locates both known inverted rows while keeping the original zero-finding report and REVIEW states unchanged', async () => {
  const input = detail([record(), record('2026-11-03', '2026-08-07', 'Rates!R3C1')]);
  const before = structuredClone(input);
  const h = await setup(input);
  const rows = find(h.root(), n => n.tagName === 'tbody')[0].children;
  expect(rows).toHaveLength(2);
  for (const [index, end] of ['2026-08-30', '2026-08-07'].entries()) {
    expect(rows[index].children[0].textContent).toBe(String(index + 1));
    expect(text(rows[index].children[1])).toContain('运价有效期倒置');
    expect(text(rows[index].children[1])).toContain('开始日：2026-11-03');
    expect(text(rows[index].children[1])).toContain(`结束日：${end}`);
    expect(text(rows[index].children[1])).toContain('请回查原文');
    expect(text(rows[index])).toContain(`Rates!R${index + 2}C1`);
  }
  expect(find(h.root(), n => n.tagName === 'thead')[0].children[0].children.map(n => n.textContent))
    .toEqual(['#', '当前页面提示', 'sourceId', '运价有效开始时间', '运价有效结束时间']);
  expect(text(h.root())).toContain('当前页面提示仅基于已保存结果，不计入原检查报告，也不改变业务状态。');
  const report = find(h.root(), n => n.className === 'issues-section')[0];
  expect(text(report)).toContain('检查问题 0 项');
  expect(text(report)).toContain('这一轮报告中没有检查问题。业务结论以报告状态和待确认规则为准。');
  expect(text(report)).not.toContain('运价有效期倒置');
  expect(text(h.nodes.get('run-status-row')!)).toContain('待复核');
  expect(h.nodes.get('attempt-status')!.textContent).toBe('待复核');
  expect(h.state.run).toEqual(before);
  h.render();
  expect(h.state.run).toEqual(before);
  expect(h.requests).toEqual([]);
});

const incomparable = [undefined, null, '', 20260807, '2026/08/07', '2026-8-7', '2026-08-07T00:00:00Z', '2026-00-07', '2026-13-07', '2026-02-30', '2026-02-29', '0000-01-01', '10000-01-01', '2026-04-31', '2026-08-00', '2026-08-07\n', ' 2026-08-07'];
it.each(incomparable)('leaves the hint empty for an incomparable value %j in either field', async value => {
  const left = record(value, '0001-01-01');
  const right = record('9999-12-31', value);
  if (value === undefined) { delete left['运价有效开始时间']; delete right['运价有效结束时间']; }
  const h = await setup(detail([left, right]));
  expect(text(h.root())).not.toContain('运价有效期倒置');
  expect(find(h.root(), n => n.className === 'result-date-hint').map(text)).toEqual(['', '']);
});

it.each([
  ['2026-08-01', '2026-08-30', false], ['2026-08-07', '2026-08-07', false],
  ['2024-03-01', '2024-02-29', true], ['2026-03-01', '2026-02-29', false],
  ['2026-09-01', '2026-08-31', true], ['2026-01-01', '2025-12-31', true],
  ['2000-03-01', '2000-02-29', true], ['1900-03-01', '1900-02-29', false],
  ['9999-12-31', '0001-01-01', true], ['0001-01-01', '0001-01-01', false],
])('compares strict calendar dates %s to %s without timezone conversion', async (start, end, inverted) => {
  const h = await setup(detail([record(start, end)]));
  expect(text(h.root()).includes('运价有效期倒置')).toBe(inverted);
});

it('replaces hints on actual pagination and attempt selection, and restores them when returning', async () => {
  const original = detail([record(), record('2026-11-03', '2026-08-07', 'Rates!R3C1')]);
  const h = await setup(original);
  h.respond(url => {
    const offset = Number(url.searchParams.get('offset'));
    const attempt = url.searchParams.get('attempt') || 'a1';
    return attempt === 'a1' && offset === 0 ? structuredClone(original) : detail([record('2026-08-07', '2026-08-07', 'Other!R1C1')], offset, attempt);
  });
  find(h.root(), n => n.tagName === 'button' && n.textContent === '下一页')[0].handlers.click();
  await vi.waitFor(() => expect(h.state.run.records.offset).toBe(50));
  expect(text(h.root())).not.toContain('运价有效期倒置');
  expect(text(h.root())).not.toContain('Rates!R2C1');
  expect(find(h.root(), n => n.tagName === 'tbody')[0].children[0].children[0].textContent).toBe('51');
  find(h.root(), n => n.tagName === 'button' && n.textContent === '上一页')[0].handlers.click();
  await vi.waitFor(() => expect(h.state.run.records.offset).toBe(0));
  expect(find(h.root(), n => n.tagName === 'strong' && n.textContent === '运价有效期倒置')).toHaveLength(2);
  h.call("selectAttempt('a2')");
  await vi.waitFor(() => expect(h.state.run.selectedAttemptId).toBe('a2'));
  expect(text(h.root())).not.toContain('运价有效期倒置');
  expect(text(h.root())).toContain('Other!R1C1');
  expect(text(h.root())).toContain('检查问题 0 项');
  h.call("selectAttempt('a1')");
  await vi.waitFor(() => expect(h.state.run.selectedAttemptId).toBe('a1'));
  expect(find(h.root(), n => n.tagName === 'strong' && n.textContent === '运价有效期倒置')).toHaveLength(2);
  expect(h.state.run).toEqual(original);
  expect(h.requests.map(path => new URL(path, 'http://127.0.0.1').searchParams.get('attempt'))).toEqual(['a1', 'a1', 'a2', 'a1']);
});

it.each([
  ['available', '这一轮已保存的结果为零条记录。'],
  ['missing', '这一轮尚未产生后处理结果。'],
  ['error', '结果产物读取失败或摘要校验失败，无法确认记录数。'],
])('preserves the %s result state and original report availability', async (status, message) => {
  const data = detail([]);
  data.records.status = status;
  const h = await setup(data);
  expect(text(h.root())).toContain(message);
  expect(text(h.root())).not.toContain('运价有效期倒置');
  expect(text(h.root())).toContain('检查问题 0 项');
  data.attempts[0].reportStatus = 'error';
  h.render();
  expect(text(h.root())).toContain('报告不可用');
  expect(text(h.root())).toContain('检查报告缺失、未登记或摘要校验失败，无法确认检查问题。');
});

it('does not render stale records when results are unavailable or no attempt exists', async () => {
  const data = detail([record()]);
  data.records.status = 'error';
  const h = await setup(data);
  expect(text(h.root())).not.toContain('运价有效期倒置');
  expect(text(h.root())).toContain('读取失败');
  data.attempts = [];
  h.render();
  expect(text(h.root())).toContain('尚未产生抽取轮次');
  expect(text(h.root())).not.toContain('运价有效期倒置');
});
