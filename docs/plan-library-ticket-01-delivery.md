# Ticket 01 交付记录

工作区：`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01`

分支：`feature/plan-library-ticket-01`

实现提交：`180ea60b25daf9eb663007566b01b5944247f53b`（feat: add confirmed plan library foundation）。

提交后执行 `git merge --no-edit feature/plan-library-integration`，结果为 `Already up to date.`。集成分支最新提交为 `ca4ea79049e048ec39a2bf85f2afd350e6105f5b`；`git merge-base --is-ancestor feature/plan-library-integration HEAD` 退出 0。仓库未配置远端，核对对象为本地集成分支。

## 实际交付

- 确认契约后归档 Plan / v1 快照；归档字段预填、校验、norm-v1 同工作区名称唯一和请求幂等。
- 方案库与空库入口；改名、停用和恢复；首次最近使用与结论均为空。
- Plan / PlanVersion / RunBinding 存储契约、索引、唯一与归属约束；旧库和旧契约读取兼容。

## 验证

| 检查 | 实际结果 |
|---|---|
| TDD 红灯 | 原 15 项方案行为测试全部失败，方案 API 当时尚未实现 |
| 最终相关范围 | 37 项通过，退出 0 |
| 最终全量 `npm test` | 19 个文件、109 项通过，退出 0 |
| `npm run typecheck` | 退出 0 |
| `git diff --cached --check` | 提交前退出 0 |
| 浏览器自测 | 创建、列表、改名、停用、恢复和取消；关键截图已查看，320 px 弹窗变形无横向溢出 |

初次全量有 1 项旧测试因缺少 `template_runs/live-fixtures/small.xlsx` 失败；用仓库既有 fixture 生成器补齐后，最终全量已通过。没有修改该旧测试以绕过失败。

浏览器使用隔离 fixture；生命周期确认采用固定同意，空态使用 bootstrap 契约 mock；原生确认弹窗、移动设备及独立 QA 视觉验收未覆盖。测试服务与临时 fixture 已清理。

详细文件清单、命令、日志、截图及回滚说明：

`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01/.work/plan-library-ticket-01/evidence.md`

数据契约说明：

`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01/docs/plan-library-storage.md`

## 范围外与风险

Ticket 02+ 的运行绑定、跨库恢复、结构签名与匹配、派生更新、新版本入口均未实现。sourceSignatureRef 初值为 null，不构成匹配证据。

独立评审、QA 签字及真实供应商复用验收尚未执行。回滚恢复本 Ticket 之前的代码，保留新增表与版本目录，旧运行与旧契约继续可读。

## 2026-11-14 · Ticket 01 UI 优化

工作区：`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui`，分支 `feature/plan-library-ticket-01-ui`，基线 `9d8c73b`。

界面改为桌面紧凑列表、小屏字段卡片，归档分来源与方案信息；标题、数量、状态与字段可跨行核对。标题和操作栏保持可见，内容独立滚动；长文本不隐藏，输入框沿用单行可滚动编辑。库和归档都有读取、失败重试、空态；保存和生命周期操作有就地反馈及回焦。未修改 API/后端/数据契约，未实现 Ticket 02；当前前端没有 RunBinding 投影，保持现有运行信息，不显示猜测的绑定身份。

额外修正独立设计评审发现的既有风险：响应丢失后冻结完整提交快照和 requestId，重试只发同一份内容；关闭再打开仍先恢复未决提交。明确 4xx 拒绝（408除外）允许修正，5xx/解析失败保持未决。仅请求在途阻止取消/Esc，结束后恢复。未决快照只在当前页面内存保存；刷新页面后需先到方案库核对，未新增跨刷新恢复能力。

设计与逐项评审回应：`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/docs/plan-library-ticket-01-ui-design.md`。独立设计复核已允许实施；代码独立评审 PASS（approve with should-fix）；唯一清理项 UI-CODE-D1 已 accept：本 worktree 临时 `.venv` 符号链接已删除，主仓 Python 环境未改动。评审报告保留于 `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/.work/reviews/plan-library-ticket-01-ui-code/review.md`。

### 实际验证

- TDD：扩展后的10项行为测试在实现前为2通过、8失败；随后补保存忙态、Esc和归档读取重试，总12项。
- `npm test -- tests/plan-client.test.ts tests/web-client.test.ts tests/web.test.ts tests/web-budget.test.ts tests/plans.test.ts tests/conversation.test.ts`：6文件52项通过，退出0。
- 最后局部状态重置修改后，`npm test -- tests/plan-client.test.ts`：12项通过，退出0；其他测试输入未改变，复用上述通过结果。
- `npm run typecheck`：退出0。`git diff --check`：退出0。
- 环境：Node v22.22.0；`npm ci --ignore-scripts --no-audit --no-fund` 使用锁文件既有依赖，未新增依赖。首次 Web 测试2项失败是 worktree 缺 `.venv/bin/python` 导致结果导出失败；只读复用主仓既有 Python 环境后这2项及整个 Web 9项通过。用既有 fixture 生成器补齐本 worktree 忽略目录 `template_runs/live-fixtures`，未改测试绕过。
- 浏览器使用 `.tmp/ticket-01-ui/serve.ts` 的隔离数据库与已确认合成契约，真实方案 API；空库/加载/读取错误采用与 `/api/plans` 相符的定长合成响应，不代表真实业务数据。测试代理只服务本地隔离 fixture，并提供同源 iframe 用于375/768/1024/1440 CSS宽度核验；未改生产服务安全头。
- 列表与归档各4宽度，160字名称/供应商/类型：无页面或内容区横向溢出，操作目标均 >=44×44px，操作栏可见；表单末字段 focus 后自动滚入视区。数据见 `docs/evidence/plan-library-ticket-01-ui/layout-checks.json`；截图已逐张查看。
- 实际键盘：Tab由名称进入供应商，始终留在表单；Esc普通取消后回到 `archive-plan`；库Esc关闭回到 `open-plan-library`；保存延迟期间Esc被阻止、取消/保存禁用；保存/改名后焦点回新方案改名按钮，停用/恢复后回同方案状态按钮。
- 响应丢失反例：服务器已提交后主动丢弃首个响应；原内容锁定，重试两次payload完全一致，方案数从3增至4，仅新增1个。随后实际改名、停用、恢复均成功并回读；原生确认在浏览器测试中固定同意，真实原生确认由单测取消分支补充，不冒充人工弹窗验收。
- 辅助正文对白色5.99:1，边界3.77:1，焦点5.42:1。既有 reduced-motion 媒体规则已通过 CSSOM 静态核对；未开启系统偏好模拟，不声称实际减少动态效果验收通过。未引入动画。
- 一次等待 requestAnimationFrame 的截图调用未返回，恢复测试浏览器后重新采集最终8张响应式截图；旧采集不计为最终证据，未重复业务写入。

### 文件与证据

- `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/web/index.html`
- `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/web/styles.css`
- `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/web/app.js`
- `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/tests/plan-client.test.ts`
- `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/docs/plan-library-ticket-01-ui-design.md`
- `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/docs/plan-library-ticket-01-delivery.md`
- `/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-01-ui/docs/evidence/plan-library-ticket-01-ui/`：`list-{375,768,1024,1440}.png`、`form-{375,768,1024,1440}.png`、`empty.png`、`loading.png`、`error.png`、`success.png` 和 `layout-checks.json`。

未覆盖：真实供应商抽取、模型调用、独立QA、读屏实际播报、真实移动硬件、系统减少动态效果模拟、Ticket02运行绑定。当前仅浅色主题，未新增暗色主题；未运行无关全仓测试及无独立脚本的前端构建。截图是开发者查看的候选视觉证据，不代表设计奖评定。

回滚仅还原本轮 Web 三文件；不涉及数据迁移或删除。实现提交为 `b134d1ab2b698e6bc09a58b5ce44d2d12c9e3168`（feat: refine plan library layout and archive feedback）。提交后执行 `git merge --no-edit feature/plan-library-integration`，结果 `Already up to date.`；本地 integration 最新为 `9d8c73bfd6c31a9ddcc0966f17339b6470926492`，已在本分支历史中。仓库未配置远端，因此“最新”指本地 integration，不宣称已核对远端。合并没有改变有效测试输入，不重复运行已通过测试。未推送、未发布。

交付清理核对：临时 `.venv` 链接已删除；隔离预览端口58796未监听，未保留本轮测试服务。`.tmp`与生成fixture保留在Git忽略目录供复核，不纳入提交。设计、交付文档、12张截图、布局核验JSON与独立评审报告明确纳入本轮交付。

代码审查版本一致性：提交后四个代码/测试文件相对基线diff的SHA-256仍为 `1bade1e4c87fc1d238403ad71db7f92d5119fa935e98ead940e97b318178da2f`，与独立评审一致。独立评审报告中的 `.venv` 清理项已闭环；原报告保留不改写签字内容。最终仅此交付记录追加提交/合并证据。
