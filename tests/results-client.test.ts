import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { PROJECT_ROOT } from '../src/closure/paths.js';

type RecordData = Record<string, unknown>;
type AttemptData = { id: string; reportStatus: string; validationStatus: string; issueCount: number; xlsxStatus: string; xlsxPath?: string; finalResultPath?: string };

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
    run: { runId: 'r1', label: '真实复用 · Excel', decision: 'REVIEW', origin: 'history', active: false, issueCount: 0 },
    attempts: ['a1', 'a2'].map((id): AttemptData => ({ id, reportStatus: 'available', validationStatus: 'REVIEW', issueCount: 0, xlsxStatus: 'missing' })),
    selectedAttemptId: attempt,
    records: { status: 'available', items, offset, limit: 50, total: 51 },
    issues: [] as Array<{ message: string; code: string; stage: string; expected: unknown; actual: unknown; sourceIds: string[]; resultIds: string[] }>,
  };
}

// 在隔离 VM 中执行真实 DOM 工具、结果渲染、状态栏及加载交互代码。
async function setup(initial = detail([record(), record('2026-11-03', '2026-08-07', 'Rates!R3C1')])) {
  const code = await readFile(resolve(PROJECT_ROOT, 'web/app.js'), 'utf8');
  const nodes = new Map<string, TestNode>();
  const requests: string[] = [];
  const state = { run: initial, runId: initial.run.runId, offset: initial.records.offset, attemptId: initial.selectedAttemptId, runEpoch: 0, evidenceTab: 'results', runKey: '', runLoading: false };
  const previews: unknown[] = [];
  // 默认返回正常日期记录，并沿用读取请求的分页偏移与轮次。
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
    // 捕获现有预览入口的调用参数，不执行或导出工作簿。
    openArtifact: (artifact: unknown) => { previews.push(artifact); },
    // 仅允许真实加载代码的读取接口；任何写请求立即使测试失败。
    api: async (path: string, options?: unknown) => {
      expect(options).toBeUndefined();
      expect(path).toMatch(/^\/api\/runs\/[\w-]+\?/);
      requests.push(path);
      return response(new URL(path, 'http://127.0.0.1'));
    },
  });
  runInContext(
    code.slice(code.indexOf('const statuses ='), code.indexOf('const operations ='))
    + code.slice(code.indexOf('const iconPaths ='), code.indexOf('function bytes('))
    + code.slice(code.indexOf('function renderRunChrome('), code.indexOf('function renderActivity('))
    + code.slice(code.indexOf('function isResultDate('), code.indexOf('function renderArtifacts('))
    + code.slice(code.indexOf('async function loadRun('), code.indexOf('function setEvidenceTab(')), context);
  // 调用真实证据渲染，包含运行状态、轮次状态和结果容器替换。
  const render = () => runInContext('renderEvidence()', context);
  render();
  return {
    state, nodes, requests, previews, context, render,
    // 读取当前结果容器，便于断言重新渲染后的页面内容。
    root: () => getNode('evidence-content'),
    // 执行真实客户端入口，用于触发轮次切换等交互。
    call: (source: string) => runInContext(source, context),
    // 替换只读响应桩，使各页与各轮返回可区分的数据。
    respond: (next: typeof response) => { response = next; },
  };
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
  // 为第二轮提供独立问题卡片，确保记录和原报告一起切换。
  h.respond(url => {
    const offset = Number(url.searchParams.get('offset'));
    const attempt = url.searchParams.get('attempt') || 'a1';
    if (attempt === 'a1' && offset === 0) return structuredClone(original);
    const next = detail([record('2026-08-07', '2026-08-07', 'Other!R1C1')], offset, attempt);
    if (attempt === 'a2') {
      next.attempts[1].issueCount = 1;
      next.issues = [{ message: '第二轮原报告：请核对币种', code: 'CURRENCY', stage: 'validation', expected: 'USD', actual: 'CNY', sourceIds: ['Other!R1C1'], resultIds: ['r2'] }];
    }
    return next;
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
  expect(text(h.root())).toContain('检查问题 1 项');
  expect(text(h.root())).toContain('第二轮原报告：请核对币种');
  expect(text(h.root())).toContain('CURRENCY · validation');
  expect(text(h.root())).not.toContain('这一轮报告中没有检查问题。');
  expect(h.state.run.attempts[1].issueCount).toBe(1);
  h.call("selectAttempt('a1')");
  await vi.waitFor(() => expect(h.state.run.selectedAttemptId).toBe('a1'));
  expect(find(h.root(), n => n.tagName === 'strong' && n.textContent === '运价有效期倒置')).toHaveLength(2);
  expect(text(h.root())).toContain('检查问题 0 项');
  expect(text(h.root())).toContain('这一轮报告中没有检查问题。');
  expect(text(h.root())).not.toContain('第二轮原报告：请核对币种');
  expect(h.state.run).toEqual(original);
  expect(h.requests.map(path => new URL(path, 'http://127.0.0.1').searchParams.get('attempt'))).toEqual(['a1', 'a1', 'a2', 'a1']);
});

it.each([
  ['available', '这一轮已保存的结果为零条记录。'],
  ['pending', '这一轮尚未产生后处理结果。'],
  ['error', '结果产物读取失败或摘要校验失败，无法确认记录数。'],
])('preserves the %s result state and original report availability', async (status, message) => {
  const data = detail([]);
  data.records = { status, items: [], total: 0, offset: 0, limit: 50 };
  const h = await setup(data);
  expect(text(find(h.root(), n => n.className === 'result-summary')[0])).toContain(status === 'available' ? '0 条结果记录' : status === 'pending' ? '未产生 结果记录' : '读取失败 结果记录');
  expect(text(h.root())).toContain(message);
  expect(text(h.root())).not.toContain('运价有效期倒置');
  expect(text(h.root())).toContain('检查问题 0 项');
  data.attempts[0].reportStatus = 'error';
  h.render();
  expect(text(h.root())).toContain('报告不可用');
  expect(text(h.root())).toContain('检查报告缺失、未登记或摘要校验失败，无法确认检查问题。');
});

// 从真实节点读取下载 URL，避免以源码字符串代替行为断言。
function links(node: TestNode) {
  return find(node, n => n.tagName === 'a').map(n => ({ label: n.textContent, url: new URL((n as TestNode & { href: string }).href, 'http://127.0.0.1') }));
}

it.each(['missing', 'error', 'available'])('renders workbook state %s independently of final JSON and report state', async xlsxStatus => {
  const data = detail([record(), record('2026-11-03', '2026-08-07', 'Rates!R3C1')]);
  Object.assign(data.attempts[0], { xlsxStatus, xlsxPath: xlsxStatus === 'available' ? 'saved/book.xlsx' : undefined, finalResultPath: 'saved/complete.json' });
  const before = structuredClone(data);
  const h = await setup(data);
  expect(find(h.root(), n => n.tagName === 'tbody')[0].children).toHaveLength(2);
  expect(text(h.root())).toContain('Rates!R2C1');
  expect(text(h.root())).toContain('Rates!R3C1');
  expect(text(h.root()).includes('本轮未生成结果工作簿')).toBe(xlsxStatus === 'missing');
  expect(text(h.root()).includes('已登记但缺失或校验失败')).toBe(xlsxStatus === 'error');
  const downloads = links(h.root());
  expect(downloads.map(item => item.label)).toEqual([xlsxStatus === 'available' ? '下载结果 Excel' : '下载最终 JSON']);
  expect(Object.fromEntries(downloads[0].url.searchParams)).toEqual({ runId: 'r1', path: xlsxStatus === 'available' ? 'saved/book.xlsx' : 'saved/complete.json', download: '1' });
  const preview = find(h.root(), n => n.textContent === '预览 Excel');
  expect(preview).toHaveLength(xlsxStatus === 'available' ? 1 : 0);
  if (preview.length) {
    preview[0].handlers.click();
    expect(h.previews).toEqual([{ path: 'saved/book.xlsx', label: '第 1 轮结果 Excel', kind: 'result-xlsx', bytes: 0 }]);
  }
  h.render();
  expect(h.state.run).toEqual(before);
  data.attempts[0].reportStatus = 'error';
  h.render();
  expect(text(h.root())).toContain('报告不可用');
  expect(links(h.root()).map(item => item.url.href)).toEqual(downloads.map(item => item.url.href));
  expect(h.requests).toEqual([]);
});

it('keeps available Excel actions when final JSON is unavailable', async () => {
  const data = detail([]);
  data.records.status = 'error';
  Object.assign(data.attempts[0], { xlsxStatus: 'available', xlsxPath: 'saved/book.xlsx' });
  const h = await setup(data);
  expect(links(h.root()).map(item => item.label)).toEqual(['下载结果 Excel']);
  expect(find(h.root(), n => n.textContent === '预览 Excel')).toHaveLength(1);
  expect(text(h.root())).not.toContain('本轮未生成');
  expect(text(h.root())).not.toContain('已登记但缺失');
  expect(text(h.root())).toContain('结果产物读取失败');
});

it.each(['missing', 'error'])('omits unavailable JSON actions with workbook state %s while preserving empty states', async xlsxStatus => {
  for (const status of ['pending', 'error', 'available']) {
    const data = detail([]);
    data.attempts[0].xlsxStatus = xlsxStatus;
    data.records = { status, items: [], offset: 0, limit: 50, total: 0 };
    const h = await setup(data);
    expect(links(h.root())).toEqual([]);
    expect(text(h.root())).not.toContain('预览 Excel');
    expect(text(h.root())).toContain(status === 'pending' ? '尚未产生后处理结果' : status === 'error' ? '结果产物读取失败' : '0 条结果记录');
    if (status === 'available') {
      data.attempts[0].finalResultPath = 'saved/empty.json';
      h.render();
      expect(links(h.root())[0].label).toBe('下载最终 JSON');
    }
  }
});

it('updates download links on real pagination, attempt selection, return and run switching', async () => {
  const original = detail([record(), record('2026-11-03', '2026-08-07', 'Rates!R3C1')]);
  original.attempts[0].finalResultPath = 'archive/reused.json';
  Object.assign(original.attempts[1], { xlsxStatus: 'available', xlsxPath: 'archive/new.xlsx' });
  const before = structuredClone(original);
  const h = await setup(original);
  h.respond(url => {
    const attempt = url.searchParams.get('attempt') || 'a1';
    const offset = Number(url.searchParams.get('offset'));
    const next = structuredClone(original);
    next.selectedAttemptId = attempt;
    next.records.offset = offset;
    if (offset || attempt === 'a2') next.records.items = [record('2026-08-01', '2026-08-30', 'Other!R1C1')];
    if (url.pathname.endsWith('/r2')) { next.run.runId = 'r2'; next.attempts[0].finalResultPath = 'another/result.json'; }
    return next;
  });
  find(h.root(), n => n.textContent === '下一页')[0].handlers.click();
  await vi.waitFor(() => expect(h.state.run.records.offset).toBe(50));
  expect(links(h.root())[0].url.searchParams.get('path')).toBe('archive/reused.json');
  h.call("selectAttempt('a2')");
  await vi.waitFor(() => expect(h.state.run.selectedAttemptId).toBe('a2'));
  expect(links(h.root()).map(item => item.label)).toEqual(['下载结果 Excel']);
  expect(links(h.root())[0].url.searchParams.get('path')).toBe('archive/new.xlsx');
  expect(text(h.root())).not.toContain('本轮未生成');
  expect(text(h.root())).not.toContain('Rates!R2C1');
  h.call("selectAttempt('a1')");
  await vi.waitFor(() => expect(h.state.run.selectedAttemptId).toBe('a1'));
  expect(links(h.root())[0].url.searchParams.get('path')).toBe('archive/reused.json');
  expect(text(h.root())).toContain('Rates!R2C1');
  await h.call("loadRun('r2')");
  expect(Object.fromEntries(links(h.root())[0].url.searchParams)).toEqual({ runId: 'r2', path: 'another/result.json', download: '1' });
  expect(original).toEqual(before);
  expect(h.requests).toHaveLength(4);
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
  expect(text(h.root())).not.toContain('本轮未生成结果工作簿');
  expect(links(h.root())).toEqual([]);
});
