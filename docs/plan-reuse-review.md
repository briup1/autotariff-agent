# 复用异常回到人工复核（Ticket 04B）

场景：“沿用怡升昌周报”，独立检查在 `报价!R2C1` 发现原文 price 为 200，候选结果为 201。

```text
绑定已确认方案 v1
  → 现有独立检查读原文并比较结果
  → 保留 price 200 / 201 与坐标
  → 运行立即转为 REVIEW
  → 人工复核检查问题
  → 规则确实变化时，人工打开创建新版本并另行确认
```

## 运行结论与报告相互独立

- 已绑定方案的运行收到有效的独立检查报告且有问题时，立即保存 REVIEW review packet 并进入终态，不再自动进入新一轮修复。
- 原报告的 FAIL / BLOCKED、问题代码、坐标、预期与实际值保持原样。运行 REVIEW 表示需要人处理，不能把报告伪装成通过。
- 对已经完成的结构/覆盖检查，如原文存在未归类数值，也进入人工 REVIEW；原报告仍可为 BLOCKED。检查器执行异常、依赖不可用或冻结依据漂移走原 catch 分支，运行仍为 BLOCKED，不降格为通过。
- 零问题仍走原 REVIEW 路径，review packet 的 businessApproval 为 false，accuracy / cost 仍为 null。契约已确认仅表示规则批准，不表示结果业务批准。
- Plan.status 与 currentVersionId 不更新，不自动确认、恢复或创建版本。已有 lastResult 投影保存本次终态枚举。
- 未绑定方案的首次抽取继续使用原修复与阻断策略。

## 可观察状态

已绑定运行的 RunSummary 增加可选字段 reuseCheckStatus 与 businessApproval。businessApproval 当前固定为 false；仓库尚无业务批准 API。

| reuseCheckStatus | 含义 |
|---|---|
| pending | 尚在执行，独立检查未产生报告 |
| findings | 有可读报告且存在需人工复核的问题 |
| clean | 独立检查没有问题，仍需人工确认业务正确性 |
| unavailable | 报告缺失、损坏、未登记，或检查器无法完成检查 |

报告不可用时不填充 issueCount=0；对应 AttemptView.reportStatus 为 error。已完成但无报告的运行也不可被解释为 pending 或 clean。运行已有的历史结论不会因为读取时丢失报告而被偷偷改写，页面明确展示当前证据不可用。

`GET /api/runs/:id` 的 issues 继续返回检查器保存的原始证据。没有提供的值不推断、不补造。旧运行无方案绑定时不增加复用状态，不推断业务批准。

## 页面操作

异常页提示“版式可能变化”，显示原文坐标、预期和实际值，提供：

- “人工复核检查问题”：切换桌面和移动视图到结果并滚动到问题卡片，不修改任何批准或方案状态。
- “创建新版本”：只读取当前 Plan 并打开既有人工确认弹窗。inactive / candidate 不会被自动恢复。必须完成 Ticket 03 的独立契约预览和人工确认后才会写新版本。

零问题页明确提示不等于业务批准。报告缺失页的运行提示、轮次标记、结果标记和问题区域都显示报告不可用，避免将曾经检查过但当前缺证的结果误称为“零问题”。模型故障信息与原重试入口保持。

## 验证与回滚

`tests/plan-review.test.ts` 使用真实 Excel、ClosureRuntime、独立检查与 SQLite，覆盖异常、零问题、报告缺失/损坏/未登记、在途 pending、终态缺报告、检查器异常、覆盖异常、Plan 状态和版本不变、重启后证据保留。

`tests/plan-review-client.test.ts` 覆盖人工按钮、零问题与不可用文案、停用隔离；点击之前不请求版本，点击后只读取 Plan 并打开确认，不发送版本创建 POST。

Browser tab 在本轮可访问的隔离地址验证了异常、零问题、报告缺失、人工复核切换和创建新版本后取消。实际 API 保持 v1、confirmed、单一版本。320 px callout 变形使用冻结真实 RunDetail 的只读契约 fixture，未改写账本；无横向溢出。截图属于开发者候选证据，没有独立 QA 或业务准确性签字。

不新增表、不改变检查规则、不变更历史绑定。回滚恢复本 Ticket 前代码即可；已保存的 REVIEW、报告与旧证据保留。没有实现 Ticket 05 的全面验收与证据矩阵。
