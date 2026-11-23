// 仅供合成 UI 核验：真实静态前端加只读 API，不加载业务运行时或模型配置。
import { createServer } from 'node:http';
import { readFile, mkdtemp, appendFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const records = JSON.parse(await readFile(resolve(root, 'tests/fixtures/history-result-review.json'), 'utf8'));
const temp = await mkdtemp(resolve(tmpdir(), 'history-result-review-'));
const workbook = resolve(temp, 'synthetic-result.xlsx');
const log = resolve(temp, 'requests.jsonl');
await copyFile(resolve(root, 'tests/fixtures/history-result-review.xlsx'), workbook);
const xlsx = await readFile(workbook);
const sha256 = createHash('sha256').update(xlsx).digest('hex');
const keys = [...new Set(records.flatMap((row) => Object.keys(row)))];
const path = 'outputs/a2/synthetic-result.xlsx';
const createdAt = '2026-11-01T00:00:00.000Z';
const conversation = { id: 'synthetic-work', title: '合成 UI · 工作会话回归', sourceId: 'synthetic-source', createdAt, updatedAt: createdAt, runIds: ['synthetic-live'] };

// 为历史、缺有效期与工作会话分别提供明确的合成身份。
function summary(runId) {
  return { runId, label: runId === 'synthetic-no-validity' ? '合成 UI · 仅 ETD 无有效期' : runId === 'synthetic-live' ? '合成 UI · 工作会话结果' : '合成 UI · 两行核价', origin: runId === 'synthetic-live' ? 'live' : 'history', phase: 'TERMINAL', decision: 'REVIEW', active: false, createdAt, sourceName: '合成 UI 报价.xlsx（非真实业务）', attemptCount: 2 };
}
// 用分页和轮次变体检查既有请求参数，绝不推断日期。
function detail(runId, url) {
  const attempt = url.searchParams.get('attempt') || 'a2';
  const offset = Number(url.searchParams.get('offset') || 0);
  const items = records.map((row, index) => {
    const item = { ...row };
    if (offset) { item.recordId = `quote-${index ? 'D' : 'C'}`; item.origin = index ? 'QINGDAO' : 'XIAMEN'; }
    if (attempt === 'a1') item['20GP卖价'] = index ? 211 : 121;
    if (runId === 'synthetic-no-validity') { delete item['运价有效开始时间']; delete item['运价有效结束时间']; }
    return item;
  });
  return { run: summary(runId), actions: [{ id: 'read', operation: 'read_artifact', status: 'SUCCEEDED', startedAt: createdAt, finishedAt: createdAt }], attempts: ['a1', 'a2'].map((id) => ({ id, parentAttemptId: id === 'a1' ? null : 'a1', status: 'EXECUTED', validationStatus: 'REVIEW', reportStatus: 'available', xlsxPath: path })), selectedAttemptId: attempt, records: { status: 'available', items, total: 4, offset, limit: 2 }, issues: [{ code: 'SYNTHETIC_REVIEW', stage: 'validation', message: `合成检查 · ${attempt}`, expected: '合成预期 120', actual: attempt === 'a1' ? 121 : 120, sourceIds: ['报价!R2C1'], resultIds: ['quote-A'] }], artifacts: [{ path, label: '合成结果 Excel', kind: 'result-xlsx', bytes: xlsx.length }], usage: { toolCalls: 0, agentTurns: 0, inputTokens: 0, outputTokens: 0 } };
}
// 只接收 GET 并记录请求；服务范围固定为真实前端和合成产物。
async function respond(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  await appendFile(log, JSON.stringify({ method: req.method, url: req.url }) + '\n');
  if (req.method !== 'GET') { res.writeHead(405); res.end('仅供只读合成 UI 验证'); return; }
  let body;
  if (url.pathname === '/api/bootstrap') body = { plans: [], sources: [{ id: 'synthetic-source', label: '合成 UI 原文件', filename: '合成 UI 报价.xlsx', requirementsName: '合成说明', kind: 'sample', supported: true }], conversations: [conversation], history: [summary('synthetic-history'), summary('synthetic-no-validity')], tests: [{ id: 'synthetic-test', label: '合成工程报告（非真实验收）', origin: 'offline', createdAt, status: 'PASS', passed: 1, total: 1 }], modelConfigured: false, budget: { taskId: 'synthetic-ui-only', usedCalls: 0, maxCalls: 0, remainingCalls: 0 } };
  else if (url.pathname === '/api/conversations/synthetic-work') body = { conversation, messages: [], runs: [summary('synthetic-live')] };
  else if (url.pathname.startsWith('/api/runs/')) body = detail(url.pathname.split('/').at(-1), url);
  else if (url.pathname.endsWith('/plans')) body = { plans: [] };
  else if (url.pathname === '/api/artifacts' && url.searchParams.get('path') === path) {
    if (url.searchParams.has('download')) { res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="synthetic-result.xlsx"' }); res.end(xlsx); return; }
    body = { path, kind: 'result-xlsx', bytes: xlsx.length, truncated: false, sheets: [{ name: '合成报价', rows: [keys, ...records.map((row) => keys.map((key) => row[key] ?? null))], totalRows: 3, totalColumns: keys.length, truncated: false }] };
  } else if (url.pathname === '/verification-requests') body = { workbook, sha256, requests: (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) };
  else if (['/', '/app.js', '/styles.css'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': url.pathname === '/' ? 'text/html; charset=utf-8' : url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
    res.end(await readFile(resolve(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1)))); return;
  } else { res.writeHead(404); res.end('合成核验未提供此资源'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
}
const server = createServer((req, res) => { respond(req, res).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
server.listen(Number(process.env.PORT || 5130), '127.0.0.1', () => { console.log(`仅供合成 UI 验证 http://127.0.0.1:${server.address().port}\n临时文件 ${temp}\nExcel SHA-256 ${sha256}`); });
