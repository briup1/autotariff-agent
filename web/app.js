
const $ = (id) => document.getElementById(id);
const state = {
  bootstrap: null,
  conversation: null,
  run: null,
  selection: null,
  runId: null,
  attemptId: null,
  offset: 0,
  evidenceTab: 'activity',
  mobileTab: 'chat',
  sourceMode: 'sample',
  sending: false,
  sourceBusy: false,
  connected: false,
  loading: true,
  runLoading: false,
  epoch: 0,
  runEpoch: 0,
  notice: '',
  drafts: new Map(),
  pending: new Map(),
  messagesKey: '',
  runKey: '',
  artifactEpoch: 0,
};

const statuses = {
  PREPARE: '准备中', INVENTORIED: '原文已盘点', ATTEMPT_READY: '准备抽取', RUNNING: '执行中',
  VALIDATED: '已检查', REPAIR_PENDING: '等待修复', PASS: 'PASS', AWAITING_HUMAN_REVIEW: '待人工复核',
  REVIEW: '待复核', FAIL: 'FAIL', BLOCKED: '已阻断', READY: '已准备', EXECUTED: '已执行',
  ANSWERED: '已回答', CONTRACT_PENDING: '等待声明契约',
  FAILED: '失败', RESERVED: '执行中', SUCCEEDED: '已完成', UNCERTAIN: '回执不确定',
  REJECTED: '已拒绝', MISSING: '未产生', queued: '等待执行', running: '执行中', completed: '已完成',
  NONE: '尚未判定', STARTED: '执行中', COMPLETED: '已完成', INTERRUPTED: '已中断', UNAVAILABLE: '证据不可用', REPORT_UNAVAILABLE: '报告不可用',
};
const operations = {
  inventory: '盘点原文', inventory_source: '盘点原文', inspect_source: '读取原文件',
  extract: '抽取运价', execute_parser: '运行抽取脚本', execute_attempt: '运行抽取',
  post_process: '后处理结果', validate: '独立检查', validate_attempt: '独立检查',
  repair: '修复抽取', llm: '调用模型', write_parser: '保存抽取脚本',
  model_request: '请求模型', inspect_page: '读取原文分页', prepare_attempt: '准备抽取方案',
  read_artifact: '读取证据', read_solution: '读取参考方案', find_solutions: '查询参考方案',
  read_requirement: '读取字段说明', convert_source: '转换原文件', stop_for_review: '提交人工复核',
};
const iconPaths = {
  file: ['M14 3H6v18h12V7Z', 'M14 3v5h5', 'M9 12h6m-6 4h6'],
  view: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  download: ['M12 3v12m-4-4 4 4 4-4', 'M4 16v5h16v-5'],
  evidence: ['M8 4h12v17H8Z', 'M4 8v13', 'M11 9h6m-6 4h6m-6 4h3'],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of iconPaths[name] || iconPaths.file) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
function tone(status) {
  if (['PASS', 'SUCCEEDED', 'COMPLETED', 'VALIDATED', 'completed'].includes(status)) return 'good';
  if (['FAIL', 'FAILED', 'REJECTED'].includes(status)) return 'bad';
  if (['REVIEW', 'AWAITING_HUMAN_REVIEW', 'BLOCKED', 'UNCERTAIN', 'MISSING', 'REPORT_UNAVAILABLE'].includes(status)) return 'warn';
  if (['RUNNING', 'STARTED', 'RESERVED', 'REPAIR_PENDING', 'running', 'PREPARE', 'queued'].includes(status)) return 'active';
  return '';
}
function badge(status) {
  return el('span', `status-badge ${tone(status)}`, statuses[status] || status || '尚未判定');
}
function readableDate(value, compact = false) {
  if (!value) return '时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', compact
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function number(value) { return typeof value === 'number' ? value.toLocaleString('zh-CN') : '未记录'; }
function valueText(value) {
  if (value === null) return 'null';
  if (value === undefined) return '未提供';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}
function cellText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function bytes(value) {
  if (value < 1024) return `${number(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
function isActive() {
  return state.sending === state.selection || Boolean(state.conversation?.runs.some((run) => run.active));
}
function saveDraft() {
  state.drafts.set(state.selection || 'new', $('message-input').value);
}
function storageGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {}
}
function pendingFor(id) {
  if (!id) return null;
  if (!state.pending.has(id)) {
    try { state.pending.set(id, JSON.parse(storageGet(`autotariff:pending:${id}`) || 'null')); } catch { state.pending.set(id, null); }
  }
  return state.pending.get(id);
}
function savePending(id, pending) {
  state.pending.set(id, pending);
  storageSet(`autotariff:pending:${id}`, pending ? JSON.stringify(pending) : null);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch {
    const error = new Error('连接中断。已保留当前内容，请重新连接。');
    error.network = true;
    throw error;
  }
  let body;
  try { body = await response.json(); }
  catch {
    const error = new Error('未收到完整响应。已保留请求，请重新连接后核对。');
    error.network = response.ok;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.error || `读取失败，HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return body;
}
function markConnected() {
  state.connected = true;
  $('connection-dot').className = 'connection-dot connected';
  $('connection-label').textContent = '本地已连接';
  $('connection-banner').hidden = true;
}
function markDisconnected(error) {
  if (!error.network) return;
  state.connected = false;
  $('connection-dot').className = 'connection-dot disconnected';
  $('connection-label').textContent = '连接中断';
  $('connection-error').textContent = '连接中断，已保留消息与证据。重新连接只读取状态。';
  $('connection-banner').hidden = false;
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}
function syncSelect(select, items, selected, emptyLabel) {
  const key = JSON.stringify(items);
  if (select.dataset.options !== key) {
    const options = items.length ? items.map((item) => {
      const option = el('option', '', item.label);
      option.value = item.value;
      return option;
    }) : [el('option', '', emptyLabel)];
    if (!items.length) options[0].value = '';
    select.replaceChildren(...options);
    select.dataset.options = key;
  }
  select.value = selected || '';
  select.disabled = !items.length;
}

function renderSidebar() {
  const boot = state.bootstrap;
  if (!boot) return;
  $('conversation-count').textContent = boot.conversations.length || '';
  const sidebarKey = JSON.stringify([boot.conversations, boot.history, state.selection, state.runId]);
  if ($('conversation-list').dataset.renderKey === sidebarKey) return;
  $('conversation-list').dataset.renderKey = sidebarKey;
  const focusedConversation = document.activeElement?.dataset.conversationId;
  const focusedHistory = document.activeElement?.dataset.historyId;
  const fragment = document.createDocumentFragment();
  for (const conversation of boot.conversations) {
    const button = el('button', `conversation-link${state.selection === conversation.id ? ' active' : ''}`);
    button.title = conversation.title;
    button.dataset.conversationId = conversation.id;
    if (state.selection === conversation.id) button.setAttribute('aria-current', 'page');
    button.append(el('span', 'conversation-title', conversation.title));
    const meta = el('span', 'conversation-date', readableDate(conversation.updatedAt, true));
    if (conversation.activeRunId) meta.append(el('span', '', '有运行记录'));
    button.append(meta);
    button.addEventListener('click', () => selectConversation(conversation.id));
    fragment.append(button);
  }
  if (!boot.conversations.length) fragment.append(el('p', 'sidebar-placeholder', '还没有工作会话。选择原文件后开始。'));
  $('conversation-list').replaceChildren(fragment);
  $('history-count').textContent = boot.history.length || '';
  const histories = document.createDocumentFragment();
  for (const run of boot.history) {
    const button = el('button', `history-link${state.runId === run.runId && !state.selection ? ' active' : ''}`);
    button.title = run.runId;
    button.dataset.historyId = run.runId;
    button.append(el('span', 'conversation-title', run.label || run.sourceName), el('span', 'conversation-date', `${statuses[run.decision] || run.decision || run.phase} · ${readableDate(run.createdAt, true)}`));
    button.addEventListener('click', () => selectHistory(run));
    histories.append(button);
  }
  if (!boot.history.length) histories.append(el('p', 'sidebar-placeholder', '没有可浏览的历史运行。'));
  $('history-list').replaceChildren(histories);
  if (focusedConversation) [...$('conversation-list').querySelectorAll('button')].find((button) => button.dataset.conversationId === focusedConversation)?.focus({ preventScroll: true });
  if (focusedHistory) [...$('history-list').querySelectorAll('button')].find((button) => button.dataset.historyId === focusedHistory)?.focus({ preventScroll: true });
}
function renderBudget() {
  const budget = state.bootstrap?.budget;
  if (!budget) return;
  $('budget-value').textContent = `${number(budget.usedCalls)} / ${number(budget.maxCalls)}`;
  $('budget-summary').title = `当前任务 ${budget.taskId}\n已发起 ${budget.usedCalls}，已预留 ${budget.reservedCalls}，剩余 ${budget.remainingCalls}\n回执不确定 ${budget.uncertainCalls}\n输入 Token ${budget.inputTokens}，输出 Token ${budget.outputTokens}`;
}
function renderConversationHeader() {
  const detail = state.conversation;
  const history = !detail && state.run?.run.origin === 'history';
  $('conversation-title').textContent = detail?.conversation.title || (history ? '历史运行证据' : '开始新的工作');
  $('conversation-meta').textContent = detail
    ? `工作会话 · ${readableDate(detail.conversation.createdAt, true)}`
    : history ? '只读浏览，打开记录不会调用模型' : '一个会话，一份原文件';
  $('view-label').textContent = history ? '历史运行' : '工作会话';
  const source = state.bootstrap?.sources.find((item) => item.id === detail?.conversation.sourceId);
  const plan = detail?.conversation.planSelection;
  $('source-name').textContent = source?.filename || (history ? state.run.run.sourceName : '尚未选择原文件');
  const contractLabel = plan ? `契约 · 已确认 ${plan.contractVersion}` : source ? ({
    missing: '契约 · 未声明，Agent 需先产出候选契约',
    candidate: `契约 · 候选待确认${source.contractVersion ? ` ${source.contractVersion}` : ''}`,
    confirmed: `契约 · 已确认${source.contractVersion ? ` ${source.contractVersion}` : ''}`,
  })[source.contractStatus] || '' : '';
  $('source-requirements').textContent = source
    ? [`抽取说明 · ${source.requirementsName}`, contractLabel].filter(Boolean).join(' · ')
    : history ? '历史运行只读 · 选择新文件可以开始会话' : '选择试点文件，或上传原文件和本单证说明';
  $('source-name').title = $('source-name').textContent;
  $('source-requirements').title = $('source-requirements').textContent;
  $('selected-plan-summary').hidden = !plan;
  $('selected-plan-summary').textContent = plan ? `已选方案：${plan.name} · ${plan.supplier} · ${plan.docType} · ${plan.contractVersion}` : '';
  $('choose-source').textContent = source || history ? '新建' : '选择文件';
  $('choose-source').title = '为另一份文件新建会话';
  $('conversation-state').replaceChildren();
  if (isActive()) $('conversation-state').append(badge('RUNNING'));
  renderComposer();
}
function inlineText(target, text) {
  let cursor = 0;
  for (const match of text.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*/g)) {
    target.append(document.createTextNode(text.slice(cursor, match.index)));
    target.append(el(match[1] === undefined ? 'strong' : 'code', '', match[1] ?? match[2]));
    cursor = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(cursor)));
}
function messageBody(message) {
  const body = el('div', 'message-body');
  if (message.role !== 'assistant') { body.textContent = message.content; return body; }
  body.classList.add('formatted-message');
  let code = null;
  let list = null;
  for (const line of message.content.split('\n')) {
    if (/^\s*```/.test(line)) {
      list = null;
      if (code) code = null;
      else { code = el('code'); const pre = el('pre'); pre.append(code); body.append(pre); }
      continue;
    }
    if (code) { code.append(document.createTextNode(line + '\n')); continue; }
    if (!line.trim()) { list = null; continue; }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) { list = el('ul'); body.append(list); }
      const item = el('li'); inlineText(item, bullet[1]); list.append(item); continue;
    }
    list = null;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const paragraph = el(heading ? 'h3' : 'p');
    inlineText(paragraph, heading ? heading[1] : line);
    body.append(paragraph);
  }
  return body;
}
function renderMessages() {
  const messages = state.conversation?.messages || [];
  const key = JSON.stringify([state.selection, messages, state.run, isActive(), Boolean(state.run?.run.origin === 'history' && !state.selection)]);
  if (state.messagesKey === key) return;
  state.messagesKey = key;
  const focusedRun = document.activeElement?.dataset.messageRun;
  const focusedContract = $('messages').contains(document.activeElement) ? document.activeElement?.dataset.contractRun : null;
  const scroll = $('messages-scroll');
  const followBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const fragment = document.createDocumentFragment();
  if (!messages.length) {
    const empty = el('div', 'empty-conversation');
    const emblem = el('div', 'empty-emblem');
    emblem.setAttribute('aria-hidden', 'true');
    emblem.append(icon(state.selection ? 'file' : 'evidence'));
    const history = !state.selection && state.run?.run.origin === 'history';
    empty.append(emblem, el('h2', '', history ? '查看已有结果。' : state.selection ? '文件已就绪。' : '让每条运价都有依据。'));
    empty.append(el('p', '', history
      ? '这是已保存的历史运行。右侧可以核对每轮结果、检查问题和原始证据。'
      : state.selection ? '输入这份单证的抽取要求。Agent 的回复与工具执行将保存在这个会话。'
        : '选择原文件，用一句话交代要求。\n在这里查看回复，在右侧核对执行过程与结果。'));
    const start = el('button', 'primary-button', state.selection ? '输入要求' : '选择原文件');
    start.addEventListener('click', () => state.selection ? $('message-input').focus() : openSourceDialog());
    empty.append(start, el('div', 'empty-footnote', history ? '历史证据不会被新的运行覆盖' : '从原文到结果，每一轮都有记录'));
    fragment.append(empty);
  }
  for (const message of messages) {
    const article = el('article', `message ${message.role}`);
    const header = el('div', 'message-header');
    const role = message.role === 'user' ? '你' : message.role === 'assistant' ? 'AutoTariff' : '运行通知';
    header.append(el('span', 'message-avatar', message.role === 'user' ? '你' : message.role === 'assistant' ? 'A' : 'i'), el('span', 'message-role', role));
    const time = el('time', '', readableDate(message.createdAt, true));
    time.dateTime = message.createdAt;
    header.append(time);
    const display = contractMessage(message);
    article.append(header, messageBody(display));
    if (display !== message) { const original = el('details', 'original-run-notice'); original.append(el('summary', '', '查看原始运行通知'), el('p', '', message.content)); article.append(original); }
    if (message.runId) {
      const run = el('button', 'message-run', `查看运行 ${message.runId}`);
      run.dataset.messageRun = message.runId;
      run.addEventListener('click', () => loadRun(message.runId));
      article.append(run);
    }
    fragment.append(article);
  }
  if (isActive()) {
    const pending = el('div', 'message-pending');
    pending.append(el('span', 'pulse-dot'), el('span', '', 'Agent 正在执行，可在右侧查看工具记录'));
    fragment.append(pending);
  }
  if (state.selection && state.run?.run.conversationId === state.selection && state.run.run.contractStatus === 'candidate') fragment.append(contractCard(state.run));
  $('messages').replaceChildren(fragment);
  if (focusedRun) [...$('messages').querySelectorAll('button')].find((button) => button.dataset.messageRun === focusedRun)?.focus({ preventScroll: true });
  if (focusedContract) [...$('messages').querySelectorAll('button')].find((button) => button.dataset.contractRun === focusedContract)?.focus({ preventScroll: true });
  if (followBottom) scroll.scrollTop = scroll.scrollHeight;
}
function renderComposer() {
  const active = isActive();
  const pending = pendingFor(state.selection);
  const configured = state.bootstrap?.modelConfigured;
  const budget = state.bootstrap?.budget;
  let notice = state.notice;
  if (!notice && pending && !active) notice = '上次发送未收到确认。重试会使用相同请求编号，避免重复执行。';
  if (!notice && configured === false) notice = '模型尚未配置。当前可以创建会话并浏览已保存证据。';
  if (!notice && budget?.remainingCalls <= 0) notice = '当前任务的模型请求预算已用完。可以继续浏览已有证据。';
  if (!notice && active) notice = '当前会话正在执行。草稿会保留，完成后可以继续发送。';
  $('composer-notice').hidden = !notice;
  $('composer-notice').textContent = notice;
  $('composer-notice').className = `composer-notice${state.notice ? ' error' : ''}`;
  const canSend = Boolean(state.selection && !active && configured !== false && budget?.remainingCalls !== 0 && (pending || $('message-input').value.trim()));
  $('send-button').disabled = !canSend;
  $('send-label').textContent = active ? '执行中' : pending ? '重试同一请求' : '发送';
  $('send-button').title = active ? '当前会话执行完成后可以发送' : !state.selection ? '先选择原文件并创建会话' : configured === false ? '模型尚未配置' : '';
  $('message-input').placeholder = !state.selection ? '选择文件后，输入抽取要求…' : '交代抽取要求，或继续追问结果…';
  const latestRun = state.conversation?.runs.at(-1);
  const olderEvidence = state.selection && latestRun && (state.runId !== latestRun.runId || Boolean(state.attemptId && state.attemptId !== state.run?.attempts.at(-1)?.id));
  $('composer-caption').textContent = !state.selection && state.run?.run.origin === 'history'
    ? '历史记录只读 · 新建会话后可以继续工作'
    : olderEvidence ? '追问基于本会话最新运行结果' : '只有发送消息才会发起模型请求';
}

function renderRunChrome() {
  const focusedContract = $('run-status-row').contains(document.activeElement) ? document.activeElement?.dataset.contractRun : null;
  const detail = state.run;
  const run = detail?.run;
  const runs = state.conversation?.runs || (run ? [run] : []);
  syncSelect($('run-select'), runs.map((item, index) => ({ value: item.runId, label: `${index + 1}. ${item.label || item.runId} · ${statuses[item.decision] || item.decision || statuses[item.phase] || item.phase}` })), state.runId, state.runLoading ? '正在读取运行…' : '尚未产生运行');
  $('run-id').textContent = state.runId || '发送要求后生成运行 ID';
  $('run-id').title = state.runId || '';
  $('copy-run').disabled = !state.runId;
  $('origin-label').textContent = run ? run.origin === 'history' ? '历史记录 · 只读' : run.active ? '实时执行' : '已保存的运行' : '等待运行';
  $('origin-label').className = `read-only-label ${run?.origin === 'history' ? 'history' : run?.active ? 'live' : ''}`;
  $('run-status-row').hidden = !run;
  if (run) {
    $('run-status-row').replaceChildren(badge(run.decision || run.phase), el('span', '', readableDate(run.createdAt, true)));
    if (run.parentRunId) {
      const parent = el('button', 'text-button', '关联前次运行');
      parent.title = run.parentRunId;
      parent.addEventListener('click', () => loadRun(run.parentRunId));
      $('run-status-row').append(parent);
    }
    if (run.contractStatus) {
      const label = { missing: '契约未声明', candidate: '运行时：候选契约（未批准）', confirmed: '契约已确认' }[run.contractStatus] || run.contractStatus;
      const contract = el('span', `contract-chip ${run.contractStatus}`, `${label}${run.contractVersion ? ` · ${run.contractVersion}` : ''}`);
      contract.title = run.contractDigest ? `契约标识 ${run.contractDigest}` : label;
      $('run-status-row').append(contract);
      if (run.contractStatus === 'candidate') $('run-status-row').append(contractCard(detail));
    }
    if (run.planId) {
      const binding = el('span', 'contract-note', `当时方案：${run.planNameSnapshot} · 当前方案：${run.planCurrentName || run.planNameSnapshot} · ${run.contractVersion}`);
      binding.title = `方案 ${run.planId}\n版本 ${run.planVersionId}\n说明 ${run.requirementsDigest}`;
      $('run-status-row').append(binding);
    }
    if (run.uncheckedRules?.length) {
      const note = el('span', 'contract-note', `${number(run.uncheckedRules.length)} 条规则未检查`);
      note.title = run.uncheckedRules.map((rule) => `${rule.id}：${rule.reason}`).join('\n');
      $('run-status-row').append(note);
    }
  }
  const attempts = detail?.attempts || [];
  $('attempt-toolbar').hidden = !attempts.length || state.evidenceTab === 'tests';
  syncSelect($('attempt-select'), attempts.map((attempt, index) => ({ value: attempt.id, label: `第 ${index + 1} 轮 · ${attempt.id}` })), detail?.selectedAttemptId, '尚无轮次');
  const selected = attempts.find((item) => item.id === detail?.selectedAttemptId);
  $('attempt-status').textContent = selected?.reportStatus === 'error' ? '报告不可用' : selected ? statuses[selected.validationStatus || selected.status] || selected.validationStatus || selected.status : '';
  $('evidence-footer-label').textContent = run ? run.active ? '自动读取状态 · 保留当前阅读位置' : `${run.origin === 'history' ? '历史记录' : '已保存'} · ${number(attempts.length)} 轮` : '尚无运行记录';
  $('refresh-run').disabled = state.loading || state.runLoading;
  if (focusedContract) $('run-status-row').querySelector('[data-contract-run]')?.focus({ preventScroll: true });
}
function panelEmpty(title, message) {
  const empty = el('div', 'panel-empty');
  empty.append(icon('evidence'), el('h3', '', title), el('p', '', message));
  return empty;
}
// 仅历史结果页让出聊天空态空间，离开标签或选择会话时同步撤销。
function historyResultsMode() {
  return !state.selection && state.run?.run.origin === 'history' && state.evidenceTab === 'results';
}
// 把只读来源身份留在结果区，隐藏聊天区域也退出键盘焦点序列。
function renderHistoryResultsLayout() {
  const active = historyResultsMode();
  $('workspace').classList.toggle('history-results', active);
  document.querySelector('.chat-panel').inert = active && !matchMedia('(max-width:767px)').matches;
  $('history-result-context').hidden = !active;
  $('history-result-source').textContent = active ? state.run.run.sourceName : '';
  $('history-result-source').title = $('history-result-source').textContent;
  document.querySelector('.skip-link').href = active ? '#refresh-run' : '#message-input';
}
// 更新证据内容前同步布局，避免渲染缓存保留上一页的模式。
function renderEvidence() {
  renderHistoryResultsLayout();
  renderRunChrome();
  const content = $('evidence-content');
  const renderKey = JSON.stringify([state.evidenceTab, state.run, state.runLoading && !state.run, state.evidenceTab === 'tests' ? state.bootstrap?.tests : null]);
  if (state.runKey === renderKey) return;
  state.runKey = renderKey;
  const focusedIndex = [...content.querySelectorAll('button,a,[tabindex]')].indexOf(document.activeElement);
  const scrollTop = $('evidence-scroll').scrollTop;
  if (state.evidenceTab === 'tests') {
    content.replaceChildren(renderTests());
  } else if (state.runLoading && !state.run) {
    content.replaceChildren(el('div', 'loading-state', '正在读取运行证据…'));
  } else if (!state.run) {
    content.replaceChildren(panelEmpty('证据会在这里汇集', '开始一项任务后，查看真实工具记录、每轮结果与独立检查。'));
  } else {
    const views = { activity: renderActivity, results: renderResults, artifacts: renderArtifacts };
    content.replaceChildren(views[state.evidenceTab]());
  }
  $('evidence-scroll').scrollTop = scrollTop;
  if (focusedIndex >= 0) content.querySelectorAll('button,a,[tabindex]')[focusedIndex]?.focus({ preventScroll: true });
}
function sectionTitle(title, detail = '') {
  const heading = el('div', 'section-title');
  heading.append(el('h3', '', title), el('span', '', detail));
  return heading;
}
function runCallout() {
  const run = state.run.run;
  if (state.run.selectedAttemptId && state.run.selectedAttemptId !== state.run.attempts.at(-1)?.id)
    return el('div', 'run-callout neutral', `正在查看 ${state.run.selectedAttemptId}。请按这一轮的结果和检查报告核对；运行结论来自最后一轮。`);
  if (run.contractStatus === 'candidate' && waitingForContract(state.run)) return contractCard(state.run);
  const reuseMessage = run.planId ? {
    findings: '复用方案的独立检查发现异常，版式可能变化。请人工复核原文坐标、预期与实际值；规则变化须人工点击“创建新版本”。',
    clean: '本次独立检查未发现问题，仍需人工确认业务正确性；零问题不代表业务批准。',
    unavailable: '检查报告缺失、损坏或检查无法完成，不能确认检查问题，也不能判定业务正确。',
  }[run.reuseCheckStatus] : '';
  const message = reuseMessage || state.run.stopReason || run.error;
  if (message) {
    const wrap = el('div', `run-callout${tone(run.decision) === 'bad' ? ' error' : ''}`);
    wrap.append(document.createTextNode(message));
    if (reuseMessage && run.error) wrap.append(el('div', 'run-callout-detail', run.error));
    if (run.planId && run.reuseCheckStatus === 'findings') {
      const review = el('button', 'text-button', '人工复核检查问题');
      review.addEventListener('click', () => {
        setEvidenceTab('results'); setMobileTab('results');
        $('evidence-content').querySelector('.issues-section')?.scrollIntoView({ block: 'start' });
      });
      const version = el('button', 'text-button', '创建新版本');
      version.addEventListener('click', async () => {
        try {
          const { plan } = await api(`/api/plans/${encodeURIComponent(run.planId)}`);
          if (plan.status !== 'confirmed') { toast('方案已停用或未确认，请先在方案库核对状态。'); return; }
          await openPlanVersion(plan);
        } catch (error) { toast(`读取方案失败：${error.message}`); }
      });
      const actions = el('div', 'reuse-review-actions');
      actions.append(review, version);
      wrap.append(actions);
    }
    if (state.run.modelFailure) {
      wrap.append(el('div', 'run-callout-detail', `模型网关返回：${state.run.modelFailure}`));
      const retry = el('button', 'text-button', '重新发送这条要求');
      retry.addEventListener('click', () => {
        const last = [...(state.conversation?.messages || [])].reverse().find((entry) => entry.role === 'user');
        const input = $('message-input');
        input.value = last?.content || '';
        input.focus();
        saveDraft();
        renderComposer();
        toast('已填回最后一条要求，确认后发送会创建新运行。');
      });
      wrap.append(retry);
    }
    return wrap;
  }
  if (run.decision === 'AWAITING_HUMAN_REVIEW' || run.decision === 'REVIEW') return el('div', 'run-callout', '业务检查仍需人工复核。请核对待确认规则和原文证据。');
  if (run.origin === 'history') return el('div', 'run-callout neutral', '这是已保存的历史证据。浏览、切换轮次和下载不会发起模型请求。');
  return null;
}
function renderActivity() {
  const detail = state.run;
  const fragment = document.createDocumentFragment();
  const callout = runCallout();
  if (callout) fragment.append(callout);
  fragment.append(sectionTitle('工具执行记录', '公开的执行事件'));
  if (!detail.actions.length) fragment.append(el('p', 'inline-empty', detail.run.active ? '运行已经建立，等待工具开始。' : '此运行没有已保存的工具事件。'));
  const timeline = el('div', 'timeline');
  for (const action of detail.actions) {
    const item = el('div', 'timeline-item');
    item.append(el('span', `timeline-marker ${tone(action.status)}`));
    const top = el('div', 'timeline-top');
    const operation = el('span', 'timeline-operation', operations[action.operation.replace(/^tool:/, '')] || action.operation);
    operation.title = action.operation;
    top.append(operation, badge(action.status));
    item.append(top);
    const meta = el('div', 'timeline-meta');
    if (action.startedAt) meta.append(el('time', '', `开始 ${readableDate(action.startedAt, true)}`));
    if (action.finishedAt) meta.append(el('time', '', `完成 ${readableDate(action.finishedAt, true)}`));
    if (!action.startedAt && !action.finishedAt) meta.append(el('span', '', '未记录时间'));
    item.append(meta);
    if (action.error) item.append(el('p', 'timeline-error', action.error));
    timeline.append(item);
  }
  fragment.append(timeline);
  if (detail.attempts.length) {
    const attempts = el('section', 'attempt-history');
    attempts.append(sectionTitle('修复与轮次', `${number(detail.attempts.length)} 轮`));
    detail.attempts.forEach((attempt, index) => {
      const button = el('button', 'attempt-row');
      button.append(el('span', '', `第 ${index + 1} 轮`), el('code', '', attempt.id), badge(attempt.reportStatus === 'error' ? 'REPORT_UNAVAILABLE' : attempt.validationStatus || attempt.status));
      button.title = attempt.parentAttemptId ? `前一轮 ${attempt.parentAttemptId}` : '首次抽取';
      button.addEventListener('click', () => selectAttempt(attempt.id, 'results'));
      attempts.append(button);
    });
    fragment.append(attempts);
  }
  const usage = el('dl', 'usage-detail');
  for (const [label, value] of [['工具调用', detail.usage.toolCalls], ['Agent 轮转', detail.usage.agentTurns], ['输入 Token', detail.usage.inputTokens], ['输出 Token', detail.usage.outputTokens]]) {
    const row = el('div');
    row.append(el('dt', '', label), el('dd', '', number(value)));
    usage.append(row);
  }
  fragment.append(usage);
  return fragment;
}
// 仅重排当前页已有的业务列，其余列沿用首次出现顺序，不改动记录。
function resultKeys(items) {
  const keys = [...new Set(items.flatMap((row) => Object.keys(row)))];
  if (!historyResultsMode()) return keys;
  const priority = ['origin', 'destination', '20GP卖价', '40GP卖价', '40HQ卖价', '运价有效开始时间', '运价有效结束时间'];
  return [...priority.filter((key) => keys.includes(key)), ...keys.filter((key) => !priority.includes(key))];
}
// 用同一份分页记录呈现结果与检查问题，历史模式只调整显示列序。
function renderResults() {
  const detail = state.run;
  const fragment = document.createDocumentFragment();
  const attempt = detail.attempts.find((item) => item.id === detail.selectedAttemptId);
  const callout = runCallout();
  if (callout) fragment.append(callout);
  if (!attempt) {
    fragment.append(panelEmpty('尚未产生抽取轮次',
      detail.run.active ? 'Agent 正在准备原文。抽取完成后在这里核对结果。'
        : detail.run.decision === 'ANSWERED' ? '这一轮只是回答，没有执行抽取。需要抽取时明确说一句再发。'
          : '此运行没有可查看的结果轮次。请查看执行记录中的阻断原因。'));
    return fragment;
  }
  const summary = el('div', 'result-summary');
  const resultAvailable = detail.records.status === 'available';
  summary.append(el('strong', '', resultAvailable ? number(detail.records.total) : detail.records.status === 'error' ? '读取失败' : '未产生'), el('span', '', resultAvailable ? '条结果记录' : '结果记录'));
  summary.append(badge(attempt.reportStatus === 'error' ? 'REPORT_UNAVAILABLE' : attempt.validationStatus || '尚未检查'));
  fragment.append(summary);
  if (attempt.xlsxPath) {
    const bar = el('div', 'result-actions');
    const xlsx = el('a', 'primary-button', '下载结果 Excel');
    xlsx.href = artifactUrl(attempt.xlsxPath, true);
    xlsx.download = '';
    const preview = el('button', 'quiet-button', '预览 Excel');
    preview.addEventListener('click', () => openArtifact({ path: attempt.xlsxPath, label: `第 ${detail.attempts.findIndex((item) => item.id === attempt.id) + 1} 轮结果 Excel`, kind: 'result-xlsx', bytes: 0 }));
    bar.append(xlsx, preview);
    fragment.append(bar);
  }
  if (detail.records.items.length) {
    const tableScroll = el('div', 'table-scroll');
    tableScroll.tabIndex = 0;
    tableScroll.setAttribute('aria-label', '结果表格，可横向滚动查看所有字段');
    const table = el('table', 'result-table');
    const keys = resultKeys(detail.records.items);
    const head = el('thead');
    const header = el('tr');
    header.append(el('th', '', '#'));
    for (const key of keys) { const th = el('th', '', key); th.scope = 'col'; header.append(th); }
    head.append(header);
    const body = el('tbody');
    detail.records.items.forEach((record, index) => {
      const row = el('tr');
      row.append(el('td', '', detail.records.offset + index + 1));
      for (const key of keys) { const value = valueText(record[key]); const cell = el('td', '', value); cell.title = value; row.append(cell); }
      body.append(row);
    });
    table.append(head, body);
    tableScroll.append(table);
    fragment.append(tableScroll);
    const pagination = el('div', 'pagination');
    pagination.append(el('span', '', `${detail.records.offset + 1}–${detail.records.offset + detail.records.items.length} / ${number(detail.records.total)}`));
    const buttons = el('div');
    for (const [label, direction] of [['上一页', -1], ['下一页', 1]]) {
      const button = el('button', '', label);
      button.disabled = direction < 0 ? detail.records.offset === 0 : detail.records.offset + detail.records.items.length >= detail.records.total;
      button.addEventListener('click', () => { state.offset = Math.max(0, detail.records.offset + direction * detail.records.limit); loadRun(state.runId, { preserve: true }); });
      buttons.append(button);
    }
    pagination.append(buttons);
    fragment.append(pagination);
  } else {
    fragment.append(el('p', 'inline-empty', detail.records.status === 'error' ? '结果产物读取失败或摘要校验失败，无法确认记录数。请查看产物列表。' : resultAvailable ? '这一轮已保存的结果为零条记录。请同时核对业务检查报告。' : '这一轮尚未产生后处理结果。'));
  }
  const issues = el('section', 'issues-section');
  issues.append(sectionTitle('检查问题', attempt.reportStatus === 'error' ? '报告不可用' : attempt.reportStatus === 'available' ? `${number(detail.issues.length)} 项` : '尚未产生报告'));
  if (!detail.issues.length) issues.append(el('p', 'inline-empty', attempt.reportStatus === 'error' ? '检查报告缺失、未登记或摘要校验失败，无法确认检查问题。' : attempt.validationStatus ? '这一轮报告中没有检查问题。业务结论以报告状态和待确认规则为准。' : '这一轮尚未产生业务检查报告。'));
  for (const issue of detail.issues) {
    const card = el('article', 'issue');
    const heading = el('div', 'issue-heading');
    heading.append(el('span', '', issue.message));
    card.append(heading, el('code', '', `${issue.code} · ${issue.stage}`));
    const comparison = el('dl');
    comparison.append(el('dt', '', '预期'), el('dd', '', valueText(issue.expected)), el('dt', '', '实际'), el('dd', '', valueText(issue.actual)));
    card.append(comparison);
    const sources = issue.sourceIds.length ? issue.sourceIds.join('，') : '未提供原文坐标';
    card.append(el('p', 'issue-source', `原文坐标 · ${sources}\n轮次 · ${detail.selectedAttemptId || '未提供'}`));
    if (issue.resultIds.length) card.append(el('p', 'issue-source', `对应结果 · ${issue.resultIds.join('，')}`));
    issues.append(card);
  }
  fragment.append(issues);
  return fragment;
}
function artifactUrl(path, download = false) {
  const query = new URLSearchParams({ runId: state.runId, path });
  if (download) query.set('download', '1');
  return `/api/artifacts?${query}`;
}
function renderArtifacts() {
  const fragment = document.createDocumentFragment();
  fragment.append(el('p', 'evidence-note', '查看当前轮次已登记的脚本、抽取响应、原始结果、后处理结果与检查报告。缺少的产物不会被补造。'));
  if (!state.run.artifacts.length) {
    fragment.append(panelEmpty('尚未登记产物', '产物保存后可以在这里查看或下载。执行失败时也可以检查已保存的证据。'));
    return fragment;
  }
  const list = el('div', 'artifact-list');
  for (const artifact of state.run.artifacts) {
    const item = el('div', 'artifact-item');
    const glyph = el('span', 'artifact-glyph');
    glyph.append(icon('file'));
    const copy = el('div', 'artifact-copy');
    copy.append(el('strong', '', artifact.label), el('span', '', `${artifact.kind} · ${bytes(artifact.bytes)}\n${artifact.path}`));
    const actions = el('div', 'artifact-actions');
    const view = el('button');
    view.title = `查看${artifact.label}`;
    view.setAttribute('aria-label', view.title);
    view.append(icon('view'));
    view.addEventListener('click', () => openArtifact(artifact));
    const download = el('a');
    download.href = artifactUrl(artifact.path, true);
    download.download = '';
    download.title = `下载${artifact.label}`;
    download.setAttribute('aria-label', download.title);
    download.append(icon('download'));
    actions.append(view, download);
    item.append(glyph, copy, actions);
    list.append(item);
  }
  fragment.append(list);
  return fragment;
}
function renderTests() {
  const fragment = document.createDocumentFragment();
  fragment.append(el('p', 'evidence-note', '工程测试检查程序行为。业务检查见各轮结果。离线测试通过不代表实时模型已成功执行。'));
  const tests = state.bootstrap?.tests || [];
  if (!tests.length) fragment.append(panelEmpty('没有已保存的工程测试报告', '页面不会代填测试统计。运行工程验证并保存报告后，刷新查看。'));
  for (const test of tests) {
    const card = el('article', 'test-card');
    const head = el('div', 'test-card-head');
    const label = el('div');
    label.append(el('h3', '', test.label), el('span', 'test-origin', `${test.origin === 'offline' ? '离线报告' : '实时验证报告'} · ${readableDate(test.createdAt)}`));
    head.append(label, badge(test.status));
    card.append(head);
    const counts = [];
    if (test.passed !== undefined) counts.push(`通过 ${number(test.passed)}`);
    if (test.failed !== undefined) counts.push(`失败 ${number(test.failed)}`);
    if (test.skipped !== undefined) counts.push(`跳过 ${number(test.skipped)}`);
    if (test.total !== undefined) counts.push(`合计 ${number(test.total)}`);
    card.append(el('p', '', test.status === 'MISSING' ? '报告文件未产生或不可读取。' : counts.join(' · ') || '报告没有统计项，查看原文了解验证范围。'));
    if (test.path) {
      const view = el('button', '', '查看报告原文');
      view.addEventListener('click', () => openTest(test));
      card.append(view);
    }
    fragment.append(card);
  }
  return fragment;
}

function updateLocation() {
  const url = new URL(location.href);
  url.search = '';
  if (state.selection) url.searchParams.set('conversation', state.selection);
  else if (state.runId) url.searchParams.set('run', state.runId);
  history.replaceState(null, '', url);
  storageSet('autotariff:selection', state.selection ? `conversation:${state.selection}` : state.runId ? `run:${state.runId}` : null);
}
function updateConversationSummary(conversation) {
  if (!state.bootstrap) return;
  state.bootstrap.conversations = [conversation, ...state.bootstrap.conversations.filter((item) => item.id !== conversation.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function selectConversation(id) {
  saveDraft();
  const epoch = ++state.epoch;
  ++state.runEpoch;
  state.selection = id;
  state.conversation = null;
  state.run = null;
  state.runId = null;
  state.attemptId = null;
  state.offset = 0;
  state.notice = '';
  state.messagesKey = '';
  $('message-input').value = state.drafts.get(id) ?? pendingFor(id)?.content ?? '';
  $('messages').replaceChildren(el('div', 'loading-state', '正在读取会话…'));
  closeSidebar();
  setMobileTab('chat');
  renderSidebar();
  renderConversationHeader();
  renderEvidence();
  updateLocation();
  try {
    const detail = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (epoch !== state.epoch) return;
    markConnected();
    state.conversation = detail;
    updateConversationSummary(detail.conversation);
    confirmPending(detail);
    renderSidebar();
    renderConversationHeader();
    renderMessages();
    const run = detail.runs.find((item) => item.active) || detail.runs.at(-1);
    if (run) await loadRun(run.runId);
    else renderEvidence();
  } catch (error) {
    if (epoch !== state.epoch) return;
    markDisconnected(error);
    state.notice = error.message;
    $('messages').replaceChildren(panelEmpty('会话读取失败', error.message));
    renderComposer();
  }
}
async function selectHistory(run) {
  saveDraft();
  ++state.epoch;
  state.selection = null;
  state.conversation = null;
  state.notice = '';
  state.attemptId = null;
  state.offset = 0;
  $('message-input').value = state.drafts.get('new') || '';
  closeSidebar();
  setMobileTab('results');
  setEvidenceTab('results');
  await loadRun(run.runId);
  renderSidebar();
  renderConversationHeader();
  renderMessages();
  updateLocation();
}
async function loadRun(id, { preserve = false, quiet = false } = {}) {
  const epoch = ++state.runEpoch;
  if (!preserve || state.runId !== id) {
    state.run = null;
    state.attemptId = null;
    state.offset = 0;
    $('evidence-scroll').scrollTop = 0;
  }
  state.runId = id;
  state.runLoading = true;
  if (!quiet) renderEvidence();
  const query = new URLSearchParams({ offset: String(state.offset), limit: '50' });
  if (state.attemptId) query.set('attempt', state.attemptId);
  try {
    const detail = await api(`/api/runs/${encodeURIComponent(id)}?${query}`);
    if (epoch !== state.runEpoch) return;
    markConnected();
    state.run = detail;
    state.runId = detail.run.runId;
    state.runLoading = false;
    renderEvidence();
    renderConversationHeader();
    renderMessages();
    updateLocation();
  } catch (error) {
    if (epoch !== state.runEpoch) return;
    state.runLoading = false;
    markDisconnected(error);
    if (state.run) toast(error.message);
    else $('evidence-content').replaceChildren(panelEmpty('运行证据读取失败', error.message));
    renderRunChrome();
  }
}
function selectAttempt(id, tab) {
  state.attemptId = id;
  state.offset = 0;
  if (tab) setEvidenceTab(tab);
  loadRun(state.runId, { preserve: true });
}
function setEvidenceTab(tab) {
  state.evidenceTab = tab;
  document.querySelectorAll('[data-evidence-tab]').forEach((button) => {
    const active = button.dataset.evidenceTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('evidence-scroll').scrollTop = 0;
  renderEvidence();
}
// 保持窄屏导航约定，切回对话时恢复可访问的聊天入口。
function setMobileTab(tab) {
  state.mobileTab = tab;
  renderHistoryResultsLayout();
  $('workspace').dataset.mobileView = tab;
  document.querySelectorAll('[data-mobile-tab]').forEach((button) => {
    const active = button.dataset.mobileTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (tab === 'activity') setEvidenceTab('activity');
  if (tab === 'results' && state.evidenceTab === 'activity') setEvidenceTab('results');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-backdrop').hidden = true;
  $('menu-button').setAttribute('aria-expanded', 'false');
  $('sidebar').inert = matchMedia('(max-width:1199px)').matches;
  document.querySelector('.main-shell').inert = false;
  $('sidebar').removeAttribute('role');
  $('sidebar').removeAttribute('aria-modal');
}
function openSourceDialog() {
  if (state.sourceBusy) return;
  state.sourceMode = 'sample';
  $('source-error').hidden = true;
  $('source-dialog-title').textContent = state.selection ? '为另一份文件新建会话' : '选择一份原文件';
  refreshSources();
  setSourceMode('sample');
  closeSidebar();
  if (!$('source-dialog').open) $('source-dialog').showModal();
}
function setSourceMode(mode) {
  state.sourceMode = mode;
  document.querySelectorAll('[data-source-mode]').forEach((button) => {
    const active = button.dataset.sourceMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('sample-fields').hidden = mode !== 'sample';
  $('upload-fields').hidden = mode !== 'upload';
  $('source-select').required = mode === 'sample';
  $('original-file').required = mode === 'upload';
  $('requirements-file').required = false;
  $('source-error').hidden = true;
  renderSourceDetail();
  state.uploadSourceId = null;
  state.sourcePlanSelection = 'none';
  state.sourcePlanPreselected = '';
  if (mode === 'sample') void loadSourcePlans($('source-select').value);
  else { state.sourcePlanEpoch = (state.sourcePlanEpoch || 0) + 1; state.sourcePlanChoices = []; $('source-plan-fields').hidden = true; }
  $('create-conversation').textContent = mode === 'upload' ? '导入并选择方案' : '创建会话';
}
async function loadSourcePlans(sourceId) {
  const epoch = (state.sourcePlanEpoch || 0) + 1;
  state.sourcePlanEpoch = epoch;
  state.sourcePlanChoices = [];
  state.sourcePlanSelection = 'none';
  state.sourcePlanPreselected = '';
  $('source-plan-fields').hidden = true;
  if (!sourceId) return;
  try {
    const data = await api(`/api/sources/${encodeURIComponent(sourceId)}/plans`);
    if (state.sourcePlanEpoch !== epoch) return;
    state.sourcePlanChoices = data.plans || [];
    state.sourcePlanSelection = data.selection || 'none';
    state.sourcePlanPreselected = data.preselectedPlanVersionId || '';
    const none = el('option', '', '不使用方案，沿用说明或首次观察'); none.value = '';
    $('source-plan-select').replaceChildren(none, ...state.sourcePlanChoices.map((plan) => {
      const option = el('option', '', `${plan.name} · ${plan.supplier} · ${plan.docType} · ${plan.contractVersion}`);
      option.value = plan.planVersionId;
      return option;
    }));
    $('source-plan-select').value = state.sourcePlanPreselected || '';
    $('source-plan-fields').hidden = false;
    renderSourcePlan();
  } catch (error) {
    if (state.sourcePlanEpoch === epoch) { $('source-error').textContent = `方案暂不可读取：${error.message}；可重试，或不使用方案继续。`; $('source-error').hidden = false; }
  }
}
function renderSourcePlan() {
  const plan = state.sourcePlanChoices?.find((entry) => entry.planVersionId === $('source-plan-select').value);
  const note = state.sourcePlanSelection === 'unique'
    ? '已预选唯一精确匹配，请核对后继续；系统不会静默运行。'
    : state.sourcePlanSelection === 'multiple'
      ? '发现多个精确匹配方案，请手动选择；系统不会按最近使用时间代选。'
      : '';
  $('source-plan-detail').textContent = plan
    ? `${note}${note ? ' ' : ''}将使用 ${plan.name} · 供应商 ${plan.supplier} · 单证 ${plan.docType} · 规则 ${plan.contractVersion}。发送消息后执行。`
    : note ||
      (state.sourcePlanChoices?.length ? '请明确选择方案。系统不会自动替你选择。' : '当前没有可用方案，可继续首次观察与确认。');
}
function refreshSources() {
  const sources = state.bootstrap?.sources || [];
  const selected = $('source-select').value || sources.find((source) => source.supported)?.id || sources[0]?.id;
  syncSelect($('source-select'), sources.map((source) => ({ value: source.id, label: `${source.kind === 'upload' ? '已上传' : '试点'} · ${source.label}${source.supported ? '' : '（暂不可用）'}` })), selected, '没有可选择的文件');
  renderSourceDetail();
}
function renderSourceDetail() {
  const source = state.bootstrap?.sources.find((item) => item.id === $('source-select').value);
  const content = $('source-detail');
  content.replaceChildren();
  if (source) {
    const original = el('p');
    original.append(el('strong', '', '原文件 '), document.createTextNode(source.filename));
    const requirements = el('p');
    requirements.append(el('strong', '', '抽取说明 '), document.createTextNode(source.requirementsName));
    content.append(original, requirements);
    if (!source.supported) content.append(el('p', '', source.reason || '当前规则尚不支持此文件。请选择支持的试点。'));
  } else content.append(el('p', '', '可以上传一个原文件和对应的抽取说明。'));
  $('create-conversation').disabled = state.sourceBusy || (state.sourceMode === 'sample' && !source?.supported);
}
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取原文件，请重新选择。'));
    reader.readAsDataURL(file);
  });
}
async function createConversation(event) {
  event.preventDefault();
  if (state.sourceBusy) return;
  state.sourceBusy = true;
  $('close-source').disabled = true;
  document.querySelectorAll('[data-source-mode]').forEach((button) => { button.disabled = true; });
  $('source-error').hidden = true;
  $('create-conversation').disabled = true;
  $('create-conversation').textContent = state.sourceMode === 'upload' ? '导入文件…' : '创建中…';
  try {
    if (!state.bootstrap) await loadBootstrap();
    let sourceId = $('source-select').value;
    if (state.sourceMode === 'upload' && !state.uploadSourceId) {
      const original = $('original-file').files[0];
      const requirements = $('requirements-file').files[0];
      if (!original) throw new Error('请选择一个原文件。');
      if (!/\.(xlsx|pdf|docx|png|jpe?g)$/i.test(original.name)) throw new Error('原文件支持 XLSX、PDF、DOCX、PNG 和 JPEG。');
      if (original.size > 15 * 1024 * 1024) throw new Error('原文件超过 15 MiB，请选择较小的原文件。');
      let requirementsText;
      if (requirements) {
        if (!/\.(txt|md)$/i.test(requirements.name)) throw new Error('抽取说明需要 TXT 或 Markdown 文件。');
        try { requirementsText = new TextDecoder('utf-8', { fatal: true }).decode(await requirements.arrayBuffer()); }
        catch { throw new Error('抽取说明不是 UTF-8 文本。请另存为 UTF-8 后重试。'); }
      }
      const imported = await api('/api/uploads', { method: 'POST', body: JSON.stringify({ name: original.name, base64: await readBase64(original), ...(requirements ? { requirementsName: requirements.name, requirementsText } : {}) }) });
      markConnected();
      state.bootstrap.sources = [imported, ...state.bootstrap.sources.filter((source) => source.id !== imported.id)];
      refreshSources();
      $('source-select').value = imported.id;
      if (!imported.supported) throw new Error(imported.reason || '文件已导入，但该文件暂不支持。');
      sourceId = imported.id;
      state.uploadSourceId = imported.id;
      await loadSourcePlans(sourceId);
      return;
    }
    if (state.sourceMode === 'upload') sourceId = state.uploadSourceId;
    const planSelection = state.sourcePlanChoices?.find((entry) => entry.planVersionId === $('source-plan-select').value);
    if (state.sourcePlanSelection === 'multiple' && !planSelection)
      throw new Error('发现多个精确匹配方案，请先手动选择方案后继续。');
    const detail = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ sourceId, ...(planSelection ? {planSelection} : {}) }) });
    markConnected();
    updateConversationSummary(detail.conversation);
    $('source-dialog').close();
    await selectConversation(detail.conversation.id);
    $('message-input').focus();
    toast('会话已创建，可以输入抽取要求');
  } catch (error) {
    markDisconnected(error);
    $('source-error').textContent = error.message;
    $('source-error').hidden = false;
  } finally {
    state.sourceBusy = false;
    $('close-source').disabled = false;
    document.querySelectorAll('[data-source-mode]').forEach((button) => { button.disabled = false; });
    $('create-conversation').textContent = state.sourceMode === 'upload' && !state.uploadSourceId ? '导入并选择方案' : '创建会话';
    renderSourceDetail();
  }
}
async function sendMessage(event) {
  event.preventDefault();
  const id = state.selection;
  if (!id || isActive() || $('send-button').disabled) return;
  let pending = pendingFor(id);
  if (!pending) {
    const content = $('message-input').value.trim();
    if (!content) return;
    pending = { requestId: crypto.randomUUID(), content, ...(state.conversation?.conversation?.planSelection ? {planSelection:state.conversation.conversation.planSelection} : {}), createdAt: Date.now(), previousMessageIds: state.conversation?.messages.map((message) => message.id) || [] };
    savePending(id, pending);
  }
  state.sending = id;
  state.notice = '';
  renderComposer();
  renderMessages();
  try {
    const detail = await api(`/api/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ requestId: pending.requestId, content: pending.content, ...(pending.planSelection ? {planSelection:pending.planSelection} : {}) }) });
    if (detail?.conversation?.id !== id || !Array.isArray(detail.messages) || !Array.isArray(detail.runs)) {
      const error = new Error('未收到有效发送确认。请重新连接后核对。');
      error.network = true;
      throw error;
    }
    markConnected();
    savePending(id, null);
    updateConversationSummary(detail.conversation);
    const draft = state.selection === id ? $('message-input').value : state.drafts.get(id) || '';
    const clearDraft = draft.trim() === pending.content;
    if (clearDraft) state.drafts.set(id, '');
    if (state.selection === id) {
      state.conversation = detail;
      if (clearDraft) $('message-input').value = '';
      state.notice = '';
      const run = detail.runs.find((item) => item.active) || detail.runs.at(-1);
      if (run) await loadRun(run.runId);
    }
  } catch (error) {
    markDisconnected(error);
    if (!error.network) savePending(id, null);
    if (state.selection === id) state.notice = error.network
      ? '未收到发送确认。请先重新连接，再点击“重试同一请求”。系统不会自动重复提交。'
      : error.message;
  } finally {
    state.sending = false;
    renderSidebar();
    renderConversationHeader();
    renderMessages();
    renderComposer();
  }
}
function contractMessage(message) {
  if (message.role !== 'system' || message.runId !== state.run?.run.runId || !waitingForContract(state.run) || !message.content.includes('操作失败')) return message;
  const saved = contractApproval(state.run.run);
  const content = saved?.status === 'approved' ? '这份契约已确认。确认已保存；原运行检查结论保持不变。'
    : saved?.status === 'unknown' ? '契约确认结果待核实。请打开原预览核对，必要时手动重试原确认，不要重新发送模型请求。'
      : contractCurrentSource(state.run.run)?.contractStatus === 'confirmed' ? '运行时为候选，当前确认状态待核实。请打开原预览核对；来源已确认不代表这份快照已确认。'
        : '候选契约已生成，等待人工确认契约。请核对规则后批准，无需重新发送要求。';
  return { ...message, content };
}
function contractCurrentSource(run) {
  const conversation = state.bootstrap?.conversations.find((item) => item.id === run.conversationId);
  return state.bootstrap?.sources.find((item) => item.id === conversation?.sourceId);
}
function contractIdentity(run) {
  return { runId: run.runId, requirementsDigest: run.requirementsDigest, contractSha256: run.contractSha256 };
}
function contractApproval(run) {
  try {
    const saved = state.contractApprovals?.get(run.runId) || JSON.parse(storageGet(`autotariff:approval:${run.runId}`) || 'null');
    return saved && ['approved', 'unknown'].includes(saved.status) && saved.requirementsDigest === run.requirementsDigest && saved.contractSha256 === run.contractSha256 && saved.contractVersion === run.contractVersion ? saved : null;
  } catch { return null; }
}
function saveContractApproval(preview, status) {
  const saved = { ...preview.identity, contractVersion: preview.detail.run.contractVersion, status };
  (state.contractApprovals ||= new Map()).set(preview.runId, saved);
  storageSet(`autotariff:approval:${preview.runId}`, JSON.stringify(saved));
}
function waitingForContract(detail) {
  const run = detail.run, latest = detail.attempts.at(-1);
  return run.phase === 'TERMINAL' && run.decision === 'REVIEW' && run.contractStatus === 'candidate' && !run.error && !detail.modelFailure
    && /^[a-f0-9]{64}$/.test(run.requirementsDigest || '') && /^[a-f0-9]{64}$/.test(run.contractSha256 || '')
    && run.issueCount === 0 && latest?.reportStatus === 'available' && latest.validationStatus === 'REVIEW' && latest.issueCount === 0;
}
function contractCard(detail) {
  const saved = contractApproval(detail.run);
  const currentConfirmed = contractCurrentSource(detail.run)?.contractStatus === 'confirmed';
  const waiting = waitingForContract(detail) && !currentConfirmed;
  const card = el('div', 'contract-next-step');
  const title = saved?.status === 'approved' ? '这份契约已确认' : saved?.status === 'unknown' ? '契约确认结果待核实'
    : detail.run.decision === 'BLOCKED' ? '本次运行已阻断，候选契约需核对' : detail.run.issueCount > 0 ? '检查发现问题，候选契约需核对' : currentConfirmed ? '运行时为候选，当前确认状态待核实' : waiting ? '等待人工确认契约' : '候选契约需核对';
  card.append(el('strong', '', title), el('p', '', saved?.status === 'approved' ? '确认已保存；原运行检查结论保持不变。'
    : saved?.status === 'unknown' ? '未收到匹配回执。请打开原预览核对，不要重新发送模型请求。'
      : waiting ? '契约已生成。下一步核对规则并人工批准，无需再次发送要求。' : `请先查看检查问题或缺失证据。${detail.run.issueCount > 0 ? `独立检查发现 ${detail.run.issueCount} 条问题。` : ''}核对契约不会覆盖运行结论。`));
  const view = el('button', 'text-button', saved?.status === 'approved' ? '查看已确认契约' : waiting ? '查看并确认契约' : '查看候选契约');
  view.dataset.contractRun = detail.run.runId;
  view.addEventListener('click', (event) => openContractPreview(detail.run.runId, event.currentTarget));
  card.append(view);
  return card;
}
function contractFieldSource(field) {
  const source = field.source;
  if (!source || source.kind === 'column') return '按列名及别名识别';
  if (source.kind === 'route_split') return `拆分“${source.from}”，取${source.side === 'origin' ? '起运港' : '目的港'}`;
  if (source.kind === 'join') return `${source.from.join('、')}按顺序拼接，分隔符“${source.separator}”`;
  if (source.kind === 'constant') return `固定值“${source.value}”`;
  return '来源未识别，请查看完整原文';
}
function renderContractDialog() {
  const preview = state.contractPreview;
  if (!preview) return;
  const saved = preview.detail && contractApproval(preview.detail.run);
  const approved = saved?.status === 'approved', unknown = saved?.status === 'unknown';
  $('contract-status').textContent = preview.busy ? '正在提交人工确认，请稍候…' : approved ? '这份契约已确认，可另行归档为方案。'
    : unknown ? '确认结果待核实。网络等待结束不代表服务端撤销；可关闭，或手动重试原确认。'
      : preview.loading ? '正在读取运行快照与检查报告…' : preview.ready ? '请核对下方规则，再决定是否批准。' : '当前不能批准，请核对错误与检查证据。';
  $('contract-error').hidden = !preview.error;
  $('contract-error').textContent = preview.error || '';
  $('approve-contract').disabled = Boolean(!preview.ready || preview.busy || approved || preview.rejected);
  $('approve-contract').textContent = preview.busy ? '正在确认…' : unknown ? '重试原确认' : approved ? '已确认' : '批准这份契约';
  $('close-contract').disabled = Boolean(preview.busy);
  $('reload-contract').hidden = preview.loading || approved || unknown;
  $('reload-contract').disabled = Boolean(preview.busy);
  $('archive-confirmed-contract').hidden = !approved;
}
async function openContractPreview(runId, trigger = document.activeElement) {
  if ($('contract-dialog').open) return;
  state.contractTrigger = trigger;
  state.contractPreview = { runId };
  $('contract-dialog').showModal();
  $('close-contract').focus();
  await loadContractPreview();
}
async function loadContractPreview() {
  const previous = state.contractPreview;
  if (!previous || previous.busy) return;
  const preview = state.contractPreview = { runId: previous.runId, loading: true };
  const current = () => state.contractPreview === preview && $('contract-dialog').open;
  $('contract-preview-content').replaceChildren();
  renderContractDialog();
  try {
    const detail = await api(`/api/runs/${encodeURIComponent(preview.runId)}`);
    if (!current()) return;
    preview.detail = detail;
    const run = detail.run;
    if (run.runId !== preview.runId) throw new Error('读取的运行与预览入口不一致。');
    const missingBinding = !/^[a-f0-9]{64}$/.test(run.requirementsDigest || '') || !/^[a-f0-9]{64}$/.test(run.contractSha256 || '');
    preview.identity = contractIdentity(run);
    const artifacts = detail.artifacts.filter((item) => item.kind === 'contract');
    let raw, contract;
    for (const artifact of artifacts) {
      const result = await api(`/api/artifacts?${new URLSearchParams({runId: preview.runId, path: artifact.path})}`);
      if (!current()) return;
      if (result.truncated || typeof result.content !== 'string') continue;
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.content)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!current()) return;
      if (hash === run.contractSha256 || (!run.contractSha256 && artifacts.length === 1)) { raw = result.content; preview.contentSha256 = hash; try { contract = JSON.parse(raw); } catch { throw new Error('契约原文不是有效的 JSON，不能批准。'); } break; }
    }
    if (!contract) throw new Error('契约产物缺失、被截断或摘要不匹配，请重新读取证据。');
    if (contract.requirementsDigest !== run.requirementsDigest || contract.version !== run.contractVersion || !Array.isArray(contract.fields) || !Array.isArray(contract.checks)) throw new Error('契约内容与运行绑定不一致，请重新读取预览。');
    const body = $('contract-preview-content');
    const source = contractCurrentSource(run);
    const meta = el('dl', 'contract-snapshot');
    for (const [label, value] of [['来源文件', run.sourceName], ['抽取说明', contract.requirementsSource === 'observed' ? '从原文观察生成，未上传说明' : source?.requirementsName || '说明文件名未登记，请结合完整契约核对'], ['契约版本', run.contractVersion], ['说明摘要', run.requirementsDigest], [run.contractSha256 ? '契约摘要' : '内容摘要（仅预览）', run.contractSha256 || preview.contentSha256]]) {
      const valueNode = el('dd', '', label.includes('摘要') ? `${value.slice(0, 12)}…${value.slice(-8)}` : value);
      valueNode.title = value;
      meta.append(el('dt', '', label), valueNode);
    }
    body.append(meta, el('h3', '', '规则概览'));
    const fields = el('ul');
    for (const field of contract.fields) fields.append(el('li', '', `${field.name} · ${{text:'文本',code:'编码',price:'价格',date:'日期',enum:'枚举'}[field.role] || field.role}${field.required ? ' · 必填' : ''} · 来源：${contractFieldSource(field)}${field.aliases?.length ? ` · 别名：${field.aliases.join('、')}` : ''}`));
    body.append(fields, el('h3', '', '独立检查规则'));
    const checks = el('ul');
    for (const check of contract.checks) checks.append(el('li', '', `${check.quote || check.id}${check.status === 'unchecked' ? `（未检查：${check.reason || '未说明'}）` : ''}`));
    body.append(checks);
    if (!contract.checks.length) body.append(el('p', '', '未声明检查规则，请人工核对业务正确性。'));
    for (const [label, items] of [['规则备注', contract.notes], ['待确认问题', contract.questions]]) {
      if (items?.length) { body.append(el('h3', '', label)); const list = el('ul'); for (const item of items) list.append(el('li', '', item)); body.append(list); }
    }
    const full = el('details'); full.append(el('summary', '', '查看完整契约原文'), el('pre', '', raw)); body.append(full);
    preview.ready = !missingBinding && waitingForContract(detail);
    if (!preview.ready && !contractApproval(run)) preview.error = [run.error, detail.modelFailure, missingBinding ? '历史运行缺少绑定的契约摘要，仅供核对，不能批准。' : '', run.decision === 'BLOCKED' ? `本次运行已阻断${run.issueCount > 0 ? `，独立检查发现 ${run.issueCount} 条问题` : ''}。请先查看检查问题。` : '最新轮次未满足可读的 REVIEW 零问题报告条件，不能批准契约。'].filter(Boolean).join(' ');
  } catch (error) {
    if (!current()) return;
    preview.error = error.message;
    preview.ready = false;
  } finally {
    if (current()) { preview.loading = false; renderContractDialog(); }
  }
}
function closeContractPreview() {
  if (state.contractPreview?.busy) return;
  state.contractPreview = null;
  $('contract-dialog').close();
  const trigger = state.contractTrigger;
  const fallback = state.runId && [...document.querySelectorAll(`[data-contract-run="${CSS.escape(state.runId)}"]`)].find((button) => button.getClientRects().length);
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  else (fallback || $(state.mobileTab === 'chat' ? 'message-input' : 'refresh-run')).focus({ preventScroll: true });
}
async function approveContract() {
  const preview = state.contractPreview;
  if (!preview?.ready || preview.busy || preview.rejected || contractApproval(preview.detail.run)?.status === 'approved') return;
  const wasUnknown = contractApproval(preview.detail.run)?.status === 'unknown';
  preview.busy = true; preview.error = '';
  saveContractApproval(preview, 'unknown');
  renderContractDialog();
  const controller = new AbortController();
  let timer;
  try {
    const receipt = await Promise.race([
      api('/api/contracts/approve', { method: 'POST', body: JSON.stringify(preview.identity), signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('等待确认回执超时。')); }, 30000); }),
    ]);
    if (receipt?.requirementsDigest !== preview.identity.requirementsDigest || receipt?.contractSha256 !== preview.identity.contractSha256 || receipt?.contractVersion !== preview.detail.run.contractVersion || !receipt?.approvedAt) throw new Error('未收到与这份契约匹配的批准回执。');
    saveContractApproval(preview, 'approved');
  } catch (error) {
    const rejected = [400, 403, 404, 409, 422].includes(error.status);
    if (rejected && !wasUnknown) { state.contractApprovals?.delete(preview.runId); storageSet(`autotariff:approval:${preview.runId}`, null); }
    preview.rejected = rejected;
    preview.error = `${error.message}${rejected && !wasUnknown ? ' 请重新读取并核对后再确认。' : ' 此前确认结果仍待核实，不会自动重提。'}`;
  } finally {
    clearTimeout(timer);
    preview.busy = false;
    renderContractDialog();
    state.messagesKey = ''; state.runKey = '';
    renderMessages(); renderEvidence();
  }
}
async function archiveConfirmedContract() {
  const preview = state.contractPreview;
  if (!preview?.detail || contractApproval(preview.detail.run)?.status !== 'approved') return;
  const digest = preview.identity.requirementsDigest;
  closeContractPreview();
  await openArchivePlan(digest);
}
function renderPlanLibrary() {
  const content = $('plan-library-content');
  content.replaceChildren();
  content.setAttribute('aria-busy', 'false');
  $('plan-library-error').hidden = true;
  $('retry-plan-library').hidden = true;
  const plans = state.bootstrap?.plans || [];
  $('plan-count').textContent = `${plans.length} 个方案`;
  if (!plans.length) {
    const empty = el('div', 'plan-empty');
    const mark = el('span', 'plan-empty-mark', '01');
    mark.setAttribute('aria-hidden', 'true');
    const steps = el('div', 'plan-empty-steps');
    for (const label of ['选择原文件', '人工确认规则', '归档为方案']) steps.append(el('span', '', label));
    empty.append(mark, el('h3', '', '尚无方案，从一份原文件开始'), el('p', '', '确认抽取契约后，为规则取名归档。已有确认契约可直接保存。'), steps);
    content.append(empty);
    return;
  }
  for (const plan of plans) {
    const card = el('section', 'plan-row');
    card.setAttribute('role', 'listitem');
    const identity = el('div', 'plan-identity');
    const heading = el('h3', '', plan.name);
    heading.id = `plan-title-${plan.planId}`;
    card.setAttribute('aria-labelledby', heading.id);
    identity.append(heading, el('p', '', `供应商：${plan.supplier || '未填写'}`), el('p', '', `单证类型：${plan.docType || '未填写'}`));
    const status = el('span', `plan-state ${plan.status}`, { confirmed: '已确认', inactive: '已停用', candidate: '候选待确认' }[plan.status] || plan.status);
    const usage = el('dl', 'plan-usage');
    usage.append(el('dt', '', '最近使用'), el('dd', '', plan.lastUsedAt ? readableDate(plan.lastUsedAt) : '尚未使用'), el('dt', '', '最近结论'), el('dd', '', plan.lastResult || '暂无'));
    const actions = el('div', 'plan-actions');
    const rename = el('button', 'quiet-button', '改名');
    rename.id = `plan-rename-${plan.planId}`;
    rename.setAttribute('aria-label', `改名：${plan.name}`);
    rename.addEventListener('click', () => openRenamePlan(plan));
    const lifecycle = el('button', `quiet-button ${plan.status === 'inactive' ? '' : 'plan-deactivate'}`, plan.status === 'inactive' ? '恢复' : '停用');
    lifecycle.id = `plan-status-${plan.planId}`;
    lifecycle.setAttribute('aria-label', `${plan.status === 'inactive' ? '恢复' : '停用'}：${plan.name}`);
    lifecycle.addEventListener('click', () => changePlanStatus(plan));
    actions.append(rename, lifecycle);
    const newVersion = el('button', 'quiet-button', '创建新版本');
    newVersion.id = `plan-version-${plan.planId}`;
    newVersion.disabled = plan.status !== 'confirmed';
    newVersion.setAttribute('aria-label', `创建新版本：${plan.name}`);
    newVersion.addEventListener('click', () => openPlanVersion(plan));
    actions.append(newVersion);
    card.append(identity, status, usage, actions);
    content.append(card);
  }
}
function focusPlanAction(planId, action = 'rename') {
  ($('plan-library-content').querySelector(`#plan-${action}-${planId}`) || $('close-plan-library')).focus();
}
function closePlanLibrary() { state.planLibraryEpoch = (state.planLibraryEpoch || 0) + 1; $('plan-library-dialog').close(); }
async function openPlanLibrary() {
  if ($('plan-library-dialog').open) return;
  $('plan-library-dialog').showModal();
  await loadPlanLibrary();
}
async function loadPlanLibrary() {
  const epoch = state.planLibraryEpoch = (state.planLibraryEpoch || 0) + 1;
  const current = () => $('plan-library-dialog').open && epoch === state.planLibraryEpoch;
  $('plan-library-status').textContent = '正在读取方案…';
  $('plan-count').textContent = '';
  $('plan-library-error').hidden = true;
  $('retry-plan-library').hidden = true;
  $('retry-plan-library').disabled = true;
  $('plan-library-content').replaceChildren();
  $('plan-library-content').setAttribute('aria-busy', 'true');
  try {
    const { plans } = await api('/api/plans');
    if (!current()) return;
    if (!Array.isArray(plans)) throw new Error('未收到有效方案列表，请重新读取。');
    if (state.bootstrap) state.bootstrap.plans = plans;
    else state.bootstrap = { plans };
    renderPlanLibrary();
    $('plan-library-status').textContent = plans.length ? '已读取。改名和停用均保留历史规则与运行。' : '';
  } catch (error) {
    if (!current()) return;
    $('plan-library-status').textContent = '';
    $('plan-library-error').textContent = `读取方案失败：${error.message}`;
    $('plan-library-error').hidden = false;
    $('retry-plan-library').hidden = false;
  } finally {
    if (current()) { $('plan-library-content').setAttribute('aria-busy', 'false'); $('retry-plan-library').disabled = false; }
  }
}
function prefillPlanArchive() {
  const option = state.archiveOptions?.find((entry) => (entry.selectionKey || entry.requirementsDigest) === $('plan-contract').value);
  $('plan-name').value = option?.name || '';
  $('plan-supplier').value = option?.supplier || '';
  $('plan-doc-type').value = option?.docType || '';
  $('plan-contract-summary').textContent = option ? `${option.name || '已确认契约'} · ${option.contractVersion} · ${option.requirementsDigest}` : '';
  if (state.planVersionTarget) {
    $('plan-contract-summary').textContent = option ? `${option.sourceName} · ${option.contractVersion} · ${option.contractSha256}` : '';
    $('plan-contract-preview').textContent = option ? JSON.stringify(option.contract, null, 2) : '';
    $('confirm-plan-version').checked = false;
  }
}
function configurePlanForm(rename, version = false) {
  $('plan-archive-fields').hidden = rename;
  $('plan-source-fields').hidden = rename;
  for (const id of ['plan-contract', 'plan-supplier', 'plan-doc-type']) $(id).disabled = rename;
  $('plan-metadata-fields').hidden = version;
  for (const id of ['plan-name', 'plan-supplier', 'plan-doc-type']) $(id).disabled = rename ? id !== 'plan-name' : version;
  $('plan-version-fields').hidden = !version;
  $('confirm-plan-version').disabled = !version;
  $('confirm-plan-version').required = version;
  $('confirm-plan-version').checked = false;
  $('plan-error').hidden = true;
  $('retry-plan-archive').hidden = true;
  $('plan-fields').hidden = false;
  $('plan-fields').disabled = false;
  $('save-plan').disabled = false;
  $('save-plan').textContent = version ? '确认并创建新版本' : rename ? '保存名称' : '保存方案';
  $('plan-form-status').textContent = '';
  $('plan-form-title').textContent = version ? '创建新版本' : rename ? '修改方案名称' : '保存为方案';
  $('plan-form-description').textContent = version ? `为“${state.planVersionTarget?.name}”追加已确认规则。旧版本与历史运行保持原样。` : rename ? '名称只影响展示，规则身份与历史运行保持原样。' : '核对规则来源，为它取一个下次能认出的名称。';
}
function closePlanForm() {
  if (!state.planSaving) { state.planFormEpoch = (state.planFormEpoch || 0) + 1; $('plan-form-dialog').close(); }
}
function restorePlanSubmission() {
  const submission = state.planSubmission;
  state.planEdit = submission.editId;
  state.planVersionTarget = submission.versionTarget || null;
  configurePlanForm(!!submission.editId, !!submission.versionTarget);
  for (const [id, key] of [['plan-name', 'name'], ['plan-supplier', 'supplier'], ['plan-doc-type', 'docType'], ['plan-contract', 'requirementsDigest']]) $(id).value = submission.body[key] || '';
  if (submission.versionTarget) {
    $('plan-contract').value = `${submission.body.requirementsDigest}:${submission.body.sourceId}`;
    prefillPlanArchive();
    $('confirm-plan-version').checked = true;
  }
  $('plan-fields').disabled = true;
  $('save-plan').textContent = '重试原提交';
  $('plan-form-status').textContent = '上次保存结果尚未确认，已保留并锁定原提交。重试只会发送这份内容。';
}
async function openArchivePlan(requirementsDigest) {
  if ($('plan-form-dialog').open) return;
  state.planFormTrigger = document.activeElement;
  state.planEdit = null;
  state.planVersionTarget = null;
  configurePlanForm(false);
  $('plan-form-dialog').showModal();
  if (state.planSubmission) { restorePlanSubmission(); return; }
  await loadPlanArchive(requirementsDigest);
}
async function loadPlanArchive(requirementsDigest) {
  const epoch = state.planFormEpoch = (state.planFormEpoch || 0) + 1;
  const current = () => $('plan-form-dialog').open && epoch === state.planFormEpoch;
  $('plan-fields').hidden = true;
  $('plan-fields').disabled = true;
  $('save-plan').disabled = true;
  $('retry-plan-archive').hidden = true;
  $('retry-plan-archive').disabled = true;
  $('plan-error').hidden = true;
  $('plan-form-status').textContent = '正在读取已确认契约…';
  try {
    const versionTarget = state.planVersionTarget;
    const { contracts } = await api(versionTarget ? `/api/plans/${encodeURIComponent(versionTarget.planId)}/version-options` : '/api/plans/archive-options');
    if (!current()) return;
    if (!Array.isArray(contracts)) throw new Error('未收到有效契约列表，请重新读取。');
    if (!contracts.length) {
      $('plan-form-status').textContent = versionTarget ? '尚无关联原文件的新契约。请先上传原文件并生成候选契约，再回到这里确认新版本。' : '尚无已确认契约。请先取消，选择原文件并确认候选契约，再保存方案。';
      return;
    }
    state.archiveOptions = contracts.map(entry => ({...entry, selectionKey:versionTarget ? `${entry.requirementsDigest}:${entry.sourceId}` : entry.requirementsDigest}));
    $('plan-contract').replaceChildren(...state.archiveOptions.map((entry) => {
      const option = el('option', '', `${entry.name || entry.sourceName || '已确认契约'} · ${entry.contractVersion} · ${entry.requirementsDigest.slice(0, 12)}`);
      option.value = entry.selectionKey;
      return option;
    }));
    $('plan-contract').value = state.archiveOptions.find((entry) => entry.requirementsDigest === requirementsDigest)?.selectionKey || state.archiveOptions[0].selectionKey;
    prefillPlanArchive();
    $('plan-fields').hidden = false;
    $('plan-fields').disabled = false;
    $('save-plan').disabled = false;
    $('plan-form-status').textContent = '';
    $(versionTarget ? 'plan-contract' : 'plan-name').focus();
  } catch (error) {
    if (!current()) return;
    $('plan-form-status').textContent = '';
    $('plan-error').textContent = `读取归档字段失败：${error.message}`;
    $('plan-error').hidden = false;
    $('retry-plan-archive').hidden = false;
  } finally { if (current()) $('retry-plan-archive').disabled = false; }
}
function openRenamePlan(plan) {
  if ($('plan-form-dialog').open) return;
  state.planFormTrigger = document.activeElement;
  state.planEdit = plan.planId;
  state.planVersionTarget = null;
  configurePlanForm(true);
  $('plan-name').value = plan.name;
  $('plan-form-dialog').showModal();
  if (state.planSubmission) restorePlanSubmission();
  else $('plan-name').focus();
}
async function openPlanVersion(plan) {
  if ($('plan-form-dialog').open) return;
  state.planFormTrigger = document.activeElement;
  state.planEdit = null;
  state.planVersionTarget = plan;
  configurePlanForm(false, true);
  $('plan-form-dialog').showModal();
  if (state.planSubmission) { restorePlanSubmission(); return; }
  await loadPlanArchive();
}
async function savePlan(event) {
  event.preventDefault();
  const button = $('save-plan');
  if (button.disabled || state.planSaving) return;
  if (!state.planSubmission) {
    if (state.planVersionTarget) {
      const option = state.archiveOptions?.find(entry => entry.selectionKey === $('plan-contract').value);
      if (!option || !$('confirm-plan-version').checked) {
        $('plan-error').textContent = '请先核对并确认新契约。'; $('plan-error').hidden = false; return;
      }
      state.planSubmission = { editId:null, versionTarget:state.planVersionTarget, path:`/api/plans/${encodeURIComponent(state.planVersionTarget.planId)}/versions`,
        body:{requestId:crypto.randomUUID(),requirementsDigest:option.requirementsDigest,contractSha256:option.contractSha256,sourceId:option.sourceId,expectedCurrentVersionId:state.planVersionTarget.currentVersionId,confirmContract:true} };
    } else state.planSubmission = { editId: state.planEdit, path: state.planEdit ? `/api/plans/${encodeURIComponent(state.planEdit)}/rename` : '/api/plans', body: state.planEdit ? { name: $('plan-name').value } : {
      requestId: crypto.randomUUID(), requirementsDigest: $('plan-contract').value,
      name: $('plan-name').value, supplier: $('plan-supplier').value, docType: $('plan-doc-type').value,
      ...(state.archiveOptions?.find((entry) => entry.requirementsDigest === $('plan-contract').value)?.sourceSignature
        ? { sourceSignature: state.archiveOptions.find((entry) => entry.requirementsDigest === $('plan-contract').value).sourceSignature }
        : {}),
    } };
  }
  state.planSaving = true;
  button.disabled = true;
  button.textContent = '正在保存…';
  $('cancel-plan').disabled = true;
  $('plan-fields').disabled = true;
  $('plan-error').hidden = true;
  $('plan-form-status').textContent = '正在保存，请等待确认…';
  try {
    const { path, body } = state.planSubmission;
    const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
    const version = state.planSubmission.versionTarget ? response.version : undefined;
    const plan = state.planSubmission.versionTarget ? response.plan : response;
    if (!plan?.planId || !plan?.currentVersionId) throw new Error('未收到有效方案保存确认。');
    if (state.planSubmission.versionTarget && !version?.planVersionId) throw new Error('未收到有效新版本保存确认。');
    state.planSubmission = null;
    state.planFormTrigger = null;
    $('plan-form-dialog').close();
    if (state.bootstrap) state.bootstrap.plans = [plan, ...(state.bootstrap.plans || []).filter((entry) => entry.planId !== plan.planId)];
    else state.bootstrap = { plans: [plan] };
    state.planLibraryEpoch = (state.planLibraryEpoch || 0) + 1;
    renderPlanLibrary();
    if (!$('plan-library-dialog').open) $('plan-library-dialog').showModal();
    $('plan-library-status').textContent = version ? `已创建“${plan.name}”的 ${version.contractVersion}。` : `已保存方案“${plan.name}”。`;
    focusPlanAction(plan.planId);
  } catch (error) {
    // Only a definite client rejection permits a different submission; 5xx may follow a commit.
    if (error.status >= 400 && error.status < 500 && error.status !== 408) state.planSubmission = null;
    $('plan-error').textContent = `${error.message}${state.planSubmission ? ' 保存结果尚未确认，请重试原提交；内容已锁定。' : ' 请修正后重新保存。'}`;
    $('plan-error').hidden = false;
    $('plan-form-status').textContent = state.planSubmission ? '原提交已保留，不会生成另一份归档。' : '';
    $('plan-error').focus();
  } finally {
    state.planSaving = false;
    button.disabled = false;
    button.textContent = state.planSubmission ? '重试原提交' : state.planVersionTarget ? '确认并创建新版本' : state.planEdit ? '保存名称' : '保存方案';
    $('cancel-plan').disabled = false;
    $('plan-fields').disabled = !!state.planSubmission;
  }
}
async function changePlanStatus(plan) {
  if (state.planStatusBusy) return;
  const action = plan.status === 'inactive' ? 'restore' : 'deactivate';
  const label = action === 'restore' ? '恢复' : '停用';
  if (!window.confirm(`${label}方案“${plan.name}”？历史规则和运行将保留。`)) return;
  state.planStatusBusy = true;
  const lifecycle = $('plan-library-content').querySelector(`#plan-status-${plan.planId}`);
  const rename = $('plan-library-content').querySelector(`#plan-rename-${plan.planId}`);
  if (lifecycle) { lifecycle.disabled = true; lifecycle.textContent = `正在${label}…`; }
  if (rename) rename.disabled = true;
  $('plan-library-status').textContent = `正在${label}“${plan.name}”…`;
  $('plan-library-error').hidden = true;
  try {
    const updated = await api(`/api/plans/${encodeURIComponent(plan.planId)}/${action}`, { method: 'POST', body: '{}' });
    if (!updated?.planId || !updated?.currentVersionId) throw new Error('未收到有效状态确认，请重新读取方案核对。');
    state.bootstrap.plans = state.bootstrap.plans.map((entry) => entry.planId === updated.planId ? updated : entry);
    renderPlanLibrary();
    $('plan-library-status').textContent = `已${label}方案“${updated.name}”。历史规则与运行已保留。`;
  } catch (error) {
    $('plan-library-status').textContent = '';
    $('plan-library-error').textContent = `${label}失败：${error.message}`;
    $('plan-library-error').hidden = false;
    $('retry-plan-library').hidden = false;
    if (lifecycle) { lifecycle.disabled = false; lifecycle.textContent = label; }
    if (rename) rename.disabled = false;
  } finally { state.planStatusBusy = false; if ($('plan-library-dialog').open) focusPlanAction(plan.planId, 'status'); }
}
async function openArtifact(artifact) {
  const epoch = ++state.artifactEpoch;
  $('artifact-title').textContent = artifact.label;
  $('artifact-kind').textContent = artifact.kind;
  $('artifact-meta').textContent = `${artifact.path} · ${bytes(artifact.bytes)}`;
  $('artifact-content').textContent = '正在读取产物…';
  $('artifact-truncated').textContent = '';
  $('artifact-download').href = artifactUrl(artifact.path, true);
  $('artifact-download').download = '';
  $('artifact-download').hidden = false;
  $('artifact-dialog').showModal();
  const url = artifactUrl(artifact.path);
  try {
    const content = await api(url);
    if (epoch !== state.artifactEpoch) return;
    markConnected();
    const target = $('artifact-content');
    target.textContent = '';
    const sheets = Array.isArray(content.sheets) ? content.sheets : null;
    target.classList.toggle('sheet', Boolean(sheets));
    if (sheets) {
      if (!sheets.length) target.append(el('p', 'inline-empty', '这个工作簿没有可预览的工作表。'));
      for (const sheet of sheets) {
        const block = el('section', 'sheet-block');
        block.append(el('h3', 'sheet-name', `${sheet.name} · ${number(sheet.totalRows)} 行 × ${number(sheet.totalColumns)} 列`));
        if (!sheet.rows.length) block.append(el('p', 'inline-empty', '这个工作表没有内容。'));
        else {
          const width = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
          const columns = Math.max(width, 1);
          const scroll = el('div', 'table-scroll');
          scroll.tabIndex = 0;
          scroll.setAttribute('aria-label', `${sheet.name} 工作表预览，可横向滚动`);
          const table = el('table', 'result-table');
          const head = el('thead'), header = el('tr');
          header.append(el('th', '', '#'));
          for (let column = 0; column < columns; column += 1) {
            const th = el('th', '', cellText(sheet.rows[0]?.[column]) || `第 ${column + 1} 列`);
            th.scope = 'col';
            header.append(th);
          }
          head.append(header);
          const body = el('tbody');
          sheet.rows.slice(1).forEach((row, index) => {
            const tr = el('tr');
            tr.append(el('td', '', String(index + 1)));
            for (let column = 0; column < columns; column += 1) {
              const text = cellText(row[column]);
              const cell = el('td', '', text);
              cell.title = text;
              tr.append(cell);
            }
            body.append(tr);
          });
          table.append(head, body);
          scroll.append(table);
          block.append(scroll);
        }
        if (sheet.truncated) block.append(el('p', 'inline-empty', '预览只显示前 200 行与前 40 列，下载可查看完整内容。'));
        target.append(block);
      }
    } else {
      target.textContent = content.content;
    }
    $('artifact-truncated').textContent = content.truncated ? '预览已截断，下载可查看完整内容' : '完整预览';
  } catch (error) {
    if (epoch !== state.artifactEpoch) return;
    markDisconnected(error);
    $('artifact-content').classList.remove('sheet');
    $('artifact-content').textContent = `产物读取失败。${error.message}`;
    $('artifact-truncated').textContent = '内容读取失败';
  }
}
async function openTest(test) {
  const epoch = ++state.artifactEpoch;
  $('artifact-title').textContent = test.label;
  $('artifact-kind').textContent = test.origin === 'offline' ? '离线工程测试报告' : '实时工程测试报告';
  $('artifact-meta').textContent = `${test.path || ''} · ${readableDate(test.createdAt)}`;
  $('artifact-content').textContent = '正在读取报告…';
  $('artifact-truncated').textContent = '';
  $('artifact-download').hidden = true;
  $('artifact-dialog').showModal();
  try {
    const result = await api(`/api/tests/${encodeURIComponent(test.id)}`);
    if (epoch !== state.artifactEpoch) return;
    markConnected();
    $('artifact-content').textContent = result.content;
    $('artifact-truncated').textContent = result.truncated ? '预览已截断' : '完整报告';
    const blobUrl = URL.createObjectURL(new Blob([result.content], { type: 'text/plain;charset=utf-8' }));
    if ($('artifact-download').dataset.blobUrl) URL.revokeObjectURL($('artifact-download').dataset.blobUrl);
    $('artifact-download').href = blobUrl;
    $('artifact-download').dataset.blobUrl = blobUrl;
    $('artifact-download').download = `${test.id}.txt`;
    $('artifact-download').hidden = result.truncated;
  } catch (error) {
    if (epoch !== state.artifactEpoch) return;
    markDisconnected(error);
    $('artifact-content').textContent = `报告读取失败。${error.message}`;
  }
}

async function loadBootstrap() {
  const boot = await api('/api/bootstrap');
  state.bootstrap = boot;
  markConnected();
  renderSidebar();
  renderBudget();
  renderComposer();
  if ($('source-dialog').open) refreshSources();
  return boot;
}
async function reconnect() {
  $('reconnect-button').disabled = true;
  try {
    await loadBootstrap();
    if (state.selection) await refreshConversation();
    else if (state.runId) await loadRun(state.runId, { preserve: true });
    else renderEvidence();
  } catch (error) { markDisconnected(error); toast(error.message); }
  finally { $('reconnect-button').disabled = false; }
}
function confirmPending(detail) {
  const id = detail.conversation.id;
  const pending = pendingFor(id);
  if (!pending) return;
  const accepted = detail.messages.some((message) => message.role === 'user' && message.content === pending.content && !pending.previousMessageIds?.includes(message.id) && new Date(message.createdAt).getTime() >= pending.createdAt - 1000);
  if (!accepted) return;
  savePending(id, null);
  const draft = state.selection === id ? $('message-input').value : state.drafts.get(id) || '';
  if (draft.trim() === pending.content) {
    state.drafts.set(id, '');
    if (state.selection === id) $('message-input').value = '';
  }
  if (state.selection === id) state.notice = '';
}
async function refreshConversation() {
  const id = state.selection;
  const epoch = state.epoch;
  if (!id) return;
  const detail = await api(`/api/conversations/${encodeURIComponent(id)}`);
  if (epoch !== state.epoch || id !== state.selection) return;
  markConnected();
  state.conversation = detail;
  confirmPending(detail);
  updateConversationSummary(detail.conversation);
  renderSidebar();
  renderConversationHeader();
  renderMessages();
  const latest = detail.runs.find((run) => run.active) || detail.runs.at(-1);
  if (latest && (!state.runId || (latest.active && !state.run?.run.active && state.runId === detail.runs.at(-2)?.runId))) {
    await loadRun(latest.runId);
  } else if (state.runId) await loadRun(state.runId, { preserve: true, quiet: true });
}
async function poll() {
  try {
    if (!document.hidden && !state.loading && (isActive() || state.run?.run.active || pendingFor(state.selection))) {
      await loadBootstrap();
      if (state.selection) await refreshConversation();
      else if (state.runId) await loadRun(state.runId, { preserve: true, quiet: true });
    }
  } catch (error) { markDisconnected(error); }
  finally { setTimeout(poll, 2200); }
}

$('new-conversation').addEventListener('click', openSourceDialog);
$('history-result-new').addEventListener('click', openSourceDialog);
$('open-plan-library').addEventListener('click', openPlanLibrary);
$('close-plan-library').addEventListener('click', closePlanLibrary);
$('retry-plan-library').addEventListener('click', loadPlanLibrary);
$('retry-plan-archive').addEventListener('click', () => loadPlanArchive());
$('plan-library-dialog').addEventListener('close', () => { if (!$('plan-library-dialog').open) state.planLibraryEpoch = (state.planLibraryEpoch || 0) + 1; });
$('archive-plan').addEventListener('click', () => openArchivePlan());
$('cancel-plan').addEventListener('click', closePlanForm);
$('plan-form-dialog').addEventListener('cancel', (event) => { if (state.planSaving) event.preventDefault(); });
$('plan-form-dialog').addEventListener('close', () => { if (!$('plan-form-dialog').open) { state.planFormEpoch = (state.planFormEpoch || 0) + 1; state.planFormTrigger?.focus(); } });
$('plan-form').addEventListener('submit', savePlan);
$('plan-contract').addEventListener('change', prefillPlanArchive);
$('plan-first-source').addEventListener('click', () => { $('plan-library-dialog').close(); openSourceDialog(); });
$('choose-source').addEventListener('click', openSourceDialog);
$('empty-start').addEventListener('click', openSourceDialog);
$('close-source').addEventListener('click', () => { if (!state.sourceBusy) $('source-dialog').close(); });
$('source-form').addEventListener('submit', createConversation);
$('source-select').addEventListener('change', () => { renderSourceDetail(); void loadSourcePlans($('source-select').value); });
$('source-plan-select').addEventListener('change', renderSourcePlan);
$('original-file').addEventListener('change', () => { state.uploadSourceId = null; state.sourcePlanEpoch = (state.sourcePlanEpoch || 0) + 1; state.sourcePlanChoices = []; $('source-plan-fields').hidden = true; $('create-conversation').textContent = '导入并选择方案'; });
$('source-dialog').addEventListener('cancel', (event) => { if (state.sourceBusy) event.preventDefault(); });
$('message-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', () => { saveDraft(); renderComposer(); });
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('message-form').requestSubmit();
  }
});
$('run-select').addEventListener('change', () => loadRun($('run-select').value));
$('attempt-select').addEventListener('change', () => selectAttempt($('attempt-select').value));
$('refresh-run').addEventListener('click', reconnect);
$('reconnect-button').addEventListener('click', reconnect);
$('connection-button').addEventListener('click', reconnect);
$('history-toggle').addEventListener('click', () => {
  const expanded = $('history-toggle').getAttribute('aria-expanded') !== 'true';
  $('history-toggle').setAttribute('aria-expanded', String(expanded));
  $('history-list').hidden = !expanded;
});
$('menu-button').addEventListener('click', () => {
  const open = !$('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', open);
  $('sidebar-backdrop').hidden = !open;
  $('menu-button').setAttribute('aria-expanded', String(open));
  $('sidebar').inert = !open;
  document.querySelector('.main-shell').inert = open;
  if (open) {
    $('sidebar').setAttribute('role', 'dialog');
    $('sidebar').setAttribute('aria-modal', 'true');
    $('new-conversation').focus();
  }
});
$('sidebar-backdrop').addEventListener('click', closeSidebar);
$('copy-run').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.runId); toast('运行 ID 已复制'); }
  catch { toast('复制失败，可以从运行编号中手动复制'); }
});
$('close-artifact').addEventListener('click', () => $('artifact-dialog').close());
$('artifact-dialog').addEventListener('close', () => { ++state.artifactEpoch; });
$('close-contract').addEventListener('click', closeContractPreview);
$('contract-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeContractPreview(); });
$('approve-contract').addEventListener('click', approveContract);
$('reload-contract').addEventListener('click', loadContractPreview);
$('archive-confirmed-contract').addEventListener('click', archiveConfirmedContract);
for (const button of document.querySelectorAll('[data-evidence-tab]')) button.addEventListener('click', () => setEvidenceTab(button.dataset.evidenceTab));
for (const button of document.querySelectorAll('[data-mobile-tab]')) button.addEventListener('click', () => setMobileTab(button.dataset.mobileTab));
for (const button of document.querySelectorAll('[data-source-mode]')) button.addEventListener('click', () => setSourceMode(button.dataset.sourceMode));
for (const [inputId, labelId, defaultLabel] of [['original-file', 'original-file-name', '选择原文件'], ['requirements-file', 'requirements-file-name', '选择本单证的抽取说明（可选）']]) {
  $(inputId).addEventListener('change', () => { $(labelId).textContent = $(inputId).files[0]?.name || defaultLabel; });
}
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSourceDialog(); }
  if (event.key === 'Tab' && $('sidebar').classList.contains('open')) {
    const targets = [...$('sidebar').querySelectorAll('a,button:not(:disabled)')].filter((node) => node.getClientRects().length);
    if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0]?.focus(); }
  }
  if (event.key === 'Escape' && $('sidebar').classList.contains('open')) { closeSidebar(); $('menu-button').focus(); }
});
window.addEventListener('online', reconnect);
window.addEventListener('offline', () => markDisconnected({ network: true }));

async function init() {
  closeSidebar();
  matchMedia('(max-width:1199px)').addEventListener('change', closeSidebar);
  try {
    await loadBootstrap();
    const query = new URLSearchParams(location.search);
    const saved = storageGet('autotariff:selection') || '';
    const conversationId = query.get('conversation') || (saved.startsWith('conversation:') ? saved.slice(13) : null);
    const runId = query.get('run') || (!conversationId && saved.startsWith('run:') ? saved.slice(4) : null);
    if (conversationId) await selectConversation(conversationId);
    else if (runId) {
      const run = state.bootstrap.history.find((item) => item.runId === runId) || { runId };
      await selectHistory(run);
    } else {
      renderConversationHeader();
      renderMessages();
      renderEvidence();
    }
  } catch (error) {
    markDisconnected(error);
    $('conversation-list').replaceChildren(el('p', 'sidebar-placeholder', '会话暂时不可读取。重新连接后会保留已有记录。'));
    state.notice = error.message;
    renderComposer();
  } finally {
    state.loading = false;
    renderRunChrome();
    poll();
  }
}
init();
