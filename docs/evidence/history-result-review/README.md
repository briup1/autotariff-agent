# 历史结果核价：合成 UI 核验

2026-11-23。本材料只证明真实前端的显示、交互和只读请求，不代表真实报价准确率、业务批准或真实模型验收。未修改既有「真实复用 · Excel」及任何交付运行。

## 复现入口

在仓库工作树完成 `npm ci`、`uv sync --locked` 后启动（不会加载应用 `.env.local`、业务运行时或账本）：

```bash
PORT=5130 scripts/run_with_temp_runtime.sh node scripts/history-result-review.mjs
```

打开 `http://127.0.0.1:5130`，展开「历史运行」，选择「合成 UI · 两行核价」。真实页面资源直接来自 `web/index.html`、`web/app.js`、`web/styles.css`，不是另绘的演示表格。服务只监听回环，所有非 GET 请求返回 405；没有模型或任务提交入口。结束后 `Ctrl-C` 停止服务。`/verification-requests` 返回只读请求日志、临时工作簿路径和 SHA-256；临时路径随启动变化。

- 记录夹具：`tests/fixtures/history-result-review.json`。故意先写 `recordId`、`sourceId`；B 独有自定义长字段，两行 ETD 与有效期不同。
- 工作簿夹具：`tests/fixtures/history-result-review.xlsx`。由相同 JSON 的列并集以原顺序写入，原始第一列 `recordId`；服务只复制到临时目录，下载返回原字节。第一页 a2 与工作簿基准两行相同；a1、第二页、无有效期变体仅供交互验证，并非额外导出。
- 固定文件 SHA-256：`14b06b287efe1e161b640c95735271b4de657e882f6e05763fd1006e92c1e347`。
- a1 价格变为 121／211，报告显示 a1；下一页返回 XIAMEN／QINGDAO、quote-C／quote-D、行号 3／4。夹具故意以 `limit: 2` 返回，客户端按既有响应 limit 翻页；原请求仍传 `limit=50`。
- 「合成 UI · 仅 ETD 无有效期」删除有效期字段而保留 ETD；「合成 UI · 工作会话回归」保留原列顺序及输入框。

## 实际执行命令

浏览器全部使用 `agent-browser --session 003-issue-builder`。先执行 `skills get core`，再执行以下操作（CSS 选择器便于复核，真实点击而非直接调用应用函数）：

```bash
agent-browser --session 003-issue-builder set viewport 1600 760
agent-browser --session 003-issue-builder open http://127.0.0.1:5130
agent-browser --session 003-issue-builder click '#history-toggle'
agent-browser --session 003-issue-builder click '[data-history-id="synthetic-history"]'
agent-browser --session 003-issue-builder select '#attempt-select' a1
agent-browser --session 003-issue-builder scrollintoview '.pagination'
agent-browser --session 003-issue-builder click '.pagination button:last-child'
agent-browser --session 003-issue-builder click '.pagination button:first-child'
agent-browser --session 003-issue-builder select '#attempt-select' a2
```

切到 a2 后滚到证据区顶部，点「预览 Excel」；核对工作簿表头从 `recordId`、`sourceId` 开始，关闭预览再下载：

```bash
agent-browser --session 003-issue-builder eval 'document.querySelector("#evidence-scroll").scrollTop=0'
agent-browser --session 003-issue-builder download '.result-actions a' "$PWD/.tmp/synthetic-downloaded.xlsx"
shasum -a 256 .tmp/synthetic-downloaded.xlsx tests/fixtures/history-result-review.xlsx
npm exec vitest run tests/web-client.test.ts tests/plan-review-client.test.ts tests/web.test.ts
bash /Users/ziyun/workdir/remote_project/autotariff-agent/factory/checks.sh
```

实际定向测试 24/24 通过；工厂门禁类型检查通过、28 个文件 237/237 测试通过。仓库未配置 formatter/linter，未运行全文件格式化。

## 布局与交互结论

| 核验项 | 实测与结论 | 截图／原始证据 |
| --- | --- | --- |
| 桌面 1600×760、100% | PASS。`visualViewport.scale=1`，根宽 1600；表格 clientWidth=1310，初始 scrollLeft=0，可视 x=249–1561；核心列 origin 左界 282.53、destination 左界 377.06、三价格左界 478.09／559.34／640.59、有效期左界 724.33／848.11，核心最右界 971.89。两行 y=607.30–651.30／651.30–694.80，位于页脚上方；核心单元格 scrollWidth=clientWidth，无省略。聊天 display=none。 | `desktop.png`、`desktop-measurements.json` |
| 完整信息 | PASS。窄屏表格 scrollLeft=800、scrollWidth=1270，来源坐标 quote-A／报价!R2C1、quote-B／报价!R8C1 与原行一致；ETD、备注、自定义字段保留。长字段的 title 为完整原值，A 缺失显示「未提供」。桌面字段已全部可达，不需要强行制造横向溢出。 | `full-fields.png`、`narrow-fields.png`、行为测试 |
| 缺有效期 | PASS。表头只有航线、价格、recordId、sourceId、ETD、备注、自定义字段，无伪有效期；ETD 仍为 2026-11-03／2026-12-05。 | `no-validity.png` |
| 轮次与分页 | PASS。实际请求 `offset=0&limit=50&attempt=a1` → `offset=2&limit=50&attempt=a1` → `offset=0&limit=50&attempt=a1` → `attempt=a2`；第二页显示 3–4 / 4，行号 3／4，价格 121／211；报告显示 a1、原文坐标 报价!R2C1、预期「合成预期 120」、实际 121。 | `attempt-page-issues.png`、`requests.json` |
| Excel 原链路 | PASS。预览和实际浏览器下载命中 `/api/artifacts?runId=synthetic-history&path=outputs%2Fa2%2Fsynthetic-result.xlsx`，下载仅增加 `download=1`；预览保持原列序。实际下载与固定夹具 SHA-256 相同（见上）。 | `excel-preview.png`、`requests.json`、固定 xlsx |
| 390×844 | PASS。根 scrollWidth=390，表格 clientWidth=333；侧栏可打开、Escape 关闭，背景 inert 恢复；执行过程、产物、结果及移动「对话」均可切换，对话显示 flex 且非 inert；宽表只在本地容器横移。 | `narrow.png`、`narrow-fields.png`、`narrow-sidebar.png` |
| 1024×760 | PASS。根 scrollWidth=1024，表格 clientWidth=964；侧栏打开、关闭及执行过程／产物／结果切换成功。 | `tablet.png` |
| 桌面模式撤销 | PASS。从历史结果切执行过程时 history-results=false、chat=flex；产物和工程测试可读，再返回结果。选择已有工作会话时表头为 #、recordId、sourceId、origin，输入框可见；进入新建会话仅打开既有选择原文件对话框，不提交创建。 | `work-session.png`、`new-session.png` |
| 只读边界 | PASS。请求日志全部 GET，包括刷新、来源方案读取、预览下载；无消息 POST、模型请求或启动抽取。服务不导入后端模块。git 变更不包含 template_runs、投影、后处理、导出、factory/checks.sh 或 factory/config.json。 | `requests.json`、代码差异 |

操作中曾因未滚到可见按钮而出现 agent-browser 等待超时；滚到可见区域后重新实际点击成功，非应用回归，未将失败步骤算作通过。第 1 轮审查另发现键盘跳转、跨断点 inert 和表头对比度问题，修正核验见下文。核验结束关闭隔离浏览器并仅停止 5130 监听进程。

## 第 2 轮：键盘路径与表头对比度

依据第 1 轮代码及 UI 审查逐项修正；仍使用同一只读合成服务、5130 端口和 `003-issue-builder` 浏览器会话，不调用模型或提交消息。

- 跳转入口根据当前可见区域同步文字与目标：对话为「跳到消息输入」→ `#message-input`，证据为「跳到证据刷新」→ `#refresh-run`。
- 新增 767px 媒体查询变化监听，即使未触发重新渲染也同步聊天 `inert` 与跳转入口；隐藏聊天不能聚焦，可见聊天恢复访问。
- 仅历史结果表头复用既有单元格深色 `#4e6888`，背景保持 `#eef3f9`；WCAG 相对亮度公式计算为 **5.1436:1**，高于 12px 小字要求的 4.5:1。工作会话和 Excel 预览表头实测仍为 `rgb(104,128,158)`，未被本次样式改变。
- 合成服务的 `createServer` 回调旁补充简体中文注释，明确异步路由失败转换为 HTTP 500 的职责。
- 证据边界澄清：`new-session.png` **仅证明既有文件选择对话框能打开，未执行创建，不证明创建后的空会话状态**；本轮也未进行创建或消息提交。原有行为测试覆盖空状态模式撤销，不冒充真实页面创建证据。

实际复测命令主干（每条均带隔离会话参数）：

```bash
agent-browser --session 003-issue-builder set viewport 390 844
agent-browser --session 003-issue-builder open 'http://127.0.0.1:5130/?run=synthetic-history'
agent-browser --session 003-issue-builder focus '.skip-link'
agent-browser --session 003-issue-builder press Enter
agent-browser --session 003-issue-builder click '[data-mobile-tab="chat"]'
agent-browser --session 003-issue-builder focus '.skip-link'
agent-browser --session 003-issue-builder press Enter
agent-browser --session 003-issue-builder click '[data-mobile-tab="results"]'
agent-browser --session 003-issue-builder focus '.skip-link'
agent-browser --session 003-issue-builder press Enter
agent-browser --session 003-issue-builder click '[data-mobile-tab="chat"]'
agent-browser --session 003-issue-builder set viewport 1600 760
agent-browser --session 003-issue-builder click '[data-evidence-tab="activity"]'
agent-browser --session 003-issue-builder click '[data-evidence-tab="results"]'
agent-browser --session 003-issue-builder set viewport 390 844
agent-browser --session 003-issue-builder focus '#messages-scroll'
agent-browser --session 003-issue-builder focus '.skip-link'
agent-browser --session 003-issue-builder press Enter
```

真实浏览器结论全部 PASS：

| 场景 | 实测结果 | 证据 |
| --- | --- | --- |
| 手机结果→对话→结果 | 三次激活跳转分别聚焦 `refresh-run`／`message-input`／`refresh-run`，文字和可见目标一致。结果时聊天 inert=true，对话时 false。 | `round-2-measurements.json`、`round-2-mobile-chat-focus.png` |
| 390→1600，执行过程→结果 | 桌面历史结果聊天 display=none、inert=true；尝试聚焦消息记录无效，焦点保留在可见的刷新按钮。跳转文字「跳到证据刷新」正确。 | `round-2-desktop-skip.png`、读数 JSON |
| 再缩回390 | 不点击任何标签即可恢复聊天 display=flex、inert=false，消息记录能聚焦；再激活跳转聚焦 `message-input`，根 scrollWidth=390。 | `round-2-breakpoint-chat.png`、读数 JSON |
| 767→768→767 | 各断点使用 `wait --fn` 实测聊天 inert 为 false→true→false，无需其他重绘动作。 | 命令实际成功输出 `true` |
| 桌面核价保持 | 1600×760、scale=1、表格宽1310，核心列仍 x=282.53–971.89，两行仍 y=607.30–694.80；仅表头文字变深。 | `round-2-desktop.png`、读数 JSON |
| 样式与请求隔离 | Excel 原列序与工作会话原表头色不变；本轮记录10条请求全部 GET。 | `round-2-requests.json` |

新增前端回归用例覆盖手机视图往返、跨断点状态和监听注册；最终定向回归25项通过，完整门禁类型检查通过、28文件238项测试通过，`git diff --check` 通过。浏览器已关闭且仅停止5130监听进程。

## 第 3 轮：加载中的证据跳转与静态读取失败

第2轮UI审查通过；代码审查发现刷新按钮在换轮／翻页请求期间会禁用，因此不适合作为稳定的键盘跳转目标。本轮将证据入口改为「跳到工作证据」→ `#evidence-title`，标题设置 `tabindex="-1"`，可由跳转聚焦但不额外增加常规Tab停靠；对话入口、跨767px同步和核价布局不变。上述第2轮刷新目标记录是该轮历史事实，最终目标以本节为准。

### 实际浏览器复测

仍启动相同的只读合成服务并使用 `agent-browser --session 003-issue-builder`。加载完成后用 `eval` 临时包装浏览器 `window.fetch`：仅 `/api/runs/` 请求保留在Promise中，调用 `window.releaseRun()` 后才转发原始同源GET；未改生产代码，也不提交消息或调用模型。

```bash
agent-browser --session 003-issue-builder set viewport 1600 760
agent-browser --session 003-issue-builder open 'http://127.0.0.1:5130/?run=synthetic-history'
agent-browser --session 003-issue-builder select '#attempt-select' a1
agent-browser --session 003-issue-builder focus '.skip-link'
agent-browser --session 003-issue-builder press Enter
agent-browser --session 003-issue-builder eval 'window.releaseRun();true'
agent-browser --session 003-issue-builder scrollintoview '.pagination'
agent-browser --session 003-issue-builder click '.pagination button:last-child'
agent-browser --session 003-issue-builder focus '.skip-link'
agent-browser --session 003-issue-builder press Enter
```

| 场景 | 实际结论 | 证据 |
| --- | --- | --- |
| 1600×760换轮等待 | PASS。刷新disabled=true时，Enter后焦点为可见的 `evidence-title`，tabIndex=-1，文案为「跳到工作证据」。 | `round-3-pending-attempt-focus.png`、`round-3-measurements.json` |
| 1600×760翻页等待 | PASS。刷新disabled=true时，Enter仍聚焦可见证据标题；释放请求后显示XIAMEN，分页链路保持。 | `round-3-measurements.json`、`round-3-requests.json` |
| 390×844换轮等待 | PASS。刷新disabled=true时，Enter聚焦可见证据标题；释放后返回SHANGHAI。 | `round-3-mobile-pending-focus.png`、读数JSON |
| 对话与跨断点 | PASS。手机对话仍跳到message-input；390→1600→执行过程→结果→390后聊天非inert，跳转仍聚焦消息输入，根宽390。 | 读数JSON |
| 原核价体验 | PASS。1600×760表格宽1310、核心x=282.53–971.89、两行y=607.30–694.80，表头仍为 `rgb(78,104,136)`。 | `round-3-desktop.png`、读数JSON |
| 只读边界 | PASS。10条请求全部GET，无模型、消息提交或启动抽取。 | `round-3-requests.json` |

### 错误处理回归

合成服务静态分支先完成 `readFile()` 再发送200，失败由原请求处理回调发送一次500。新增 `tests/history-result-review.test.ts` 装载真实 `respond()` 与 `createServer` 回调、注入静态读取失败；响应替身会像HTTP响应一样拒绝第二次发送头。断言首请求仅 `[500]` 且包含失败原因，随后同处理函数请求返回 `[200]` 和完整静态内容，无未处理拒绝。前端测试另外执行真实 `selectAttempt()`／`loadRun()` 并延迟响应，验证刷新禁用期间跳转仍指向带 `tabindex=-1` 的标题。

执行 `npm exec vitest run tests/web-client.test.ts tests/history-result-review.test.ts tests/plan-review-client.test.ts tests/web.test.ts`，4文件27项通过；最终 `bash /Users/ziyun/workdir/remote_project/autotariff-agent/factory/checks.sh` 类型检查与29文件240项测试全部通过，`git diff --check`通过。浏览器已关闭，仅停止5130监听进程；不修改后端、交付账本或历史产物。
