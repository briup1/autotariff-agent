# 契约确认 UX 前端交付

实现范围：web/app.js、web/index.html、web/styles.css、tests/contract-confirmation-client.test.ts 及本文档/设计/证据。工作区 `/Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux`，分支 feature/contract-confirmation-ux，配套后端 daf9464。未改后端，无新增依赖。

“上海宁波深圳运价表.xlsx” → 候选状态卡片（聊天与运行摘要） → 完整来源/说明/版本/摘要/规则快照 → 人工批准或关闭 → 匹配回执后可另行归档。真正的 REVIEW 零问题审批等待显示“等待人工确认契约”；BLOCKED/findings/报告缺失继续阻止批准。原运行检查结论不被批准修改。

批准 POST 绑定 runId、requirementsDigest、contractSha256。加载/取消无写入；防重复点击；迟到响应不污染新预览；正文与摘要校验；409人话拒绝；30秒有限等待；未知结果冻结原身份、无自动重试；成功回执在内存和 sessionStorage 优先于历史 candidate。所有入口共用同一弹窗。

验证：
- 新增22项前端行为测试，先执行旧实现看到14项失败，再实现与补充边界测试。最终前端5个文件45项通过；现有 web.test.ts 11项通过，合计56项相关测试。最新前端运行 2026-11-15 12:01；未改动后端，复用11:50的接口结果。
- 命令：`node node_modules/vitest/vitest.mjs run tests/contract-confirmation-client.test.ts tests/web-client.test.ts tests/plan-review-client.test.ts tests/plan-client.test.ts tests/plan-selection-client.test.ts tests/web.test.ts --reporter=dot`；后续仅前端变动重跑前5个文件。
- `node node_modules/typescript/bin/tsc --noEmit`、`node --check web/app.js`、`git diff --check` 通过。package.json 无 build 脚本；这是静态页面与原生JS，未声称执行构建。
- 首次两项API用例因本工作区缺 Python 环境失败，复用仓库已有 .venv 后重跑通过。未新增依赖。node_modules/.venv 仅本地软链接，不提交。

真实浏览器证据：使用挂载的 Browser tab，独立本地端口60347；从 integration 工作区只读复制真实 run-1794711552895-a6cd63c7 与账本到当前工作区 `.tmp/contract-ux-real`，原数据与共享3000均未改动。modelConfigured=false，禁止本轮核验发起模型。此真实运行报告 BLOCKED、1899问题、262记录，缺新版运行绑定SHA；正确显示只读快照并禁用批准。

- 桌面1280×720：聊天入口、运行摘要入口、阻断信息、说明/契约短摘要、规则与完整原文、禁用批准、Escape焦点恢复已检查。
- 窄屏375×700：真实页面HTML/JS/CSS在独立iframe视口渲染，仅测试容器将iframe的地址更新设为无操作；请求、返回、规则、判断均为原实现。无横向溢出，弹窗343px宽，按钮44px高，底部按钮可达，内容可滚动到底，关闭返回入口。未做原生手机或顶层移动视口验收。
- 关键截图已实际查看，见 docs/evidence/contract-confirmation-ux/。页面预览/取消的资源请求无 /approve 或 /messages；模型预算在只读副本保持0。
- 截图是旧真实模型运行的只读UX证据，不是新gpt-6.1-sol调用或真实模型批准成功证据。没有可批准的真实零问题候选，因此浏览器批准成功/归档链路未验收；成功、错误、超时与重试状态有前端行为测试及服务端接口测试支撑，不能冒充真实模型全链路通过。

发布与回滚：必须配套三字段API后端 daf9464。旧单字段前端不可用作回滚目标；安全降级为只读并禁用批准，保持后端校验，或恢复经验证的整套版本。已写入批准不会因静态资源回滚而撤销。本轮不发布、不启动共享3000。

独立代码复核 PASS / approve（评审工程师，2026-11-15）：C1 已解除，R3–R5 沿用初审结论；本轮独立重跑45项前端通过，沿用上轮11项接口通过。报告 `/Users/ziyun/workdir/remote_project/autotariff-agent/.scratch/contract-confirmation-ux-code-review-c1/review.md`。代码与测试指纹已核对一致；之后只更新交付状态文档。QA未签字；本文不是QA或模型全旅程签字。模型配置与新模型全旅程验收仍由负责人统筹，不在本前端改动内宣称完成。
