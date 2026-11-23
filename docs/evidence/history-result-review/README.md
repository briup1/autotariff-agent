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

操作中曾因未滚到可见按钮而出现 agent-browser 等待超时；滚到可见区域后重新实际点击成功，非应用回归，未将失败步骤算作通过。无未解决验收项。核验结束关闭隔离浏览器并仅停止 5130 监听进程。
