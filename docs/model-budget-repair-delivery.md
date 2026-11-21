# 模型上下文、续问与并发审批修复交付

工作区：/Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux
基线：a220951；未启动任何 HTTP 服务、未占用共享 3000。

## 判断

后端阶段可在原预算内获得真实抽取及独立检查，但完整产品验收仍为 **NO-GO**。最后一次自然续问生成 262 条记录，独立报告 BLOCKED / 1872 findings。不得批准、归档或把结果称为可用运价。独立初评 approve with should-fix；C1/C2/C3 已接受并修复，最终独立复核 approve，新增 blocker / should-fix / nit 均为 0。提交号见最终交付消息。

## 根因及方案

原 QA 将每个历史工具结果重新加入下一轮请求；inspect_source 重复返回相同 regions、原始单元格元数据和逐渐增长的证据清单。上一轮 result/report/parser 最多各 24000 字节直接内联，未带候选契约进度。候选契约同时出现在调用参数及返回值中。LiveAudit 以请求 JSON 字节数 + 1024 保守预留，实际累计 42k/44k 不代表下一轮能在 100000 总上限中预留成功。

方案 A：复用不可变 artifact，保留关键小型完整证据页、候选自检结论、原文坐标样本，移除重复内容，其余按引用读取。方案 B：提高单轮预算。采用 A；未调整任何预算配置、预留算法、总任务保护、并发准入、SDK 重试或不确定回执门禁。费用仍未知，不能声称免费或有真实货币报价保护。

一次过度裁剪导致反复读取已看过的工作解释，真实复测失败；后续改为保留一份完整小型证据，且对候选自检保留各类问题总数。大型原始工具结果完整、格式化落盘并登记，可由 read_artifact 分页读取，不依赖模型保存隐含记忆。

自然续问只携带上一轮不可变引用和摘要；同一原文件及说明可导入上一轮候选契约作为未确认参考。不会自动绑定或批准旧候选，也不把上一轮报告当作本轮检查。说明变化则不导入旧候选。

S1 根因：approveStoredContract 在异步读取后使用旧批准状态；替换候选残留旧 approval 时，并发确认可各写一个结果。修复为在同一事件循环内重新读取当前契约和批准记录，再校验、复用或写入。既有单工作区服务所有权限制保留。

无需表结构、API 字段或冻结检查规则变更，无数据库迁移。回滚为仅还原本批源码和测试；不可变证据及已有批准保留，不回滚业务数据。

## 改动范围（源码 5 处，测试 4 处）

- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/src/index.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/src/closure/runtime.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/src/models.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/src/closure/contract.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/src/web/service.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/tests/host-termination.test.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/tests/model-context.test.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/tests/plans.test.ts
- /Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/tests/web.test.ts

初版 6 个文件；评审确认需在真实自检上游及模型终态收口处修正，因此扩展为 9 个文件。增加的源码仅保存真实问题总数和模型停止原因；没有扩展到前端、抽取语义、独立 checker 或数据模型。

## 真实验证

原始证据目录：/Users/ziyun/workdir/worktrees/autotariff-agent/contract-confirmation-ux/.work/budget-context-fix/，包括 real-evidence.json、live*.log 及 runtime/template_runs/。输入 SHA 与 QA 原件相同，模型均为真实 gpt-6.1-sol。没有 Mock 模型或替换报告。

- 中间真实运行 run-1794716882777-8ee992c2：5 次模型请求，45905 输入 token；262 条记录，独立报告 BLOCKED / 1104 issues。模型预算拒绝后的宿主 finalizeBest 完成后处理和检查。
- 另一轮 run-1794717157425-5d8a8c7a：5 次模型请求，41198 输入 token；未生成 attempt，仍因下一轮保守预留停止。
- 在同一会话的自然续问 run-1794717274130-afc8fed8：父运行即上条；6 次模型请求，53229 输入 token、2028 输出；1 个真实 attempt，262 条记录、独立报告 BLOCKED / 1872 issues。候选契约通过 context/previous-candidate-contract.json 按引用导入。
- 最后一次仍有后续模型输入预留失败（pi-settled 文件可核对）；宿主补完独立检查并阻断，系统聊天明确展示 1872 条问题及不可确认、不可作为通过结果使用。**不得把“宿主完成检查”写成“预算问题全面消失”或“模型完成正常最终答复”。**
- 1872 问题包括 FIELD_MISMATCH 1475、UNDISPOSED_SOURCE 382、UNCHECKED_REQUIREMENT 7、AMBIGUOUS_HEADER 4、CONTRACT_ROUTE_SPLIT 3、CONTRACT_PRICE_PRESERVED 1。未修改检查规则或修饰报告。
- 旧 QA 的 1899 问题原件未更改；新增回归另使用 1899 条测试问题验证裁剪仅影响上下文，完整证据仍可读取。

## 回归

- 修复前：model-context 两项失败（新能力不存在）；并发确认在残留旧 approval 时失败，见 red.log、approval-red.log。
- npm test：27 files / 213 tests passed，真实退出 0，npm-test-final.log（评审修正后最终一次全量结果）。
- npm run typecheck：退出 0，typecheck.log。
- git diff --check：退出 0。
- 覆盖：原始证据分页读回、历史关键证据保留与重复页去重、1899 条完整问题保留、候选自检分项总数不伪装零问题、同源候选引用及说明变更拒绝继承、20 并发首次/替换确认一致、预算与 BLOCKED 终态聊天。
- 既有无报告、摘要不符、错运行、findings 阻断、审批幂等/重启等回归包含在全量结果内。
- 单测中的离线模型边界替身仅验证上下文装配，未当作真实模型旅程证据。

## 未覆盖与风险

独立初评及三项修正复核已完成，QA 未签字；未重新做浏览器视觉验收；无真实零问题候选，未做真实批准成功、继续与归档；未部署、未推送、未演练实际回滚。不能交付用户体验或声称全功能可用。

仍合理的下一项候选是进一步压缩阶段上下文或显式本机预算配置；当前根本阻断还包含真实候选契约/原文覆盖解释及字段差异，需要负责人单独界定修复范围，不得通过放宽报告门禁解决。


## 评审意见逐条回应

| ID | 作者回应 | 修正与证据 |
|---|---|---|
| S1 | accept | 同一事件循环重读契约与已有批准；首次及残留旧批准文件两种 20 并发回归均返回同一回执。初评已确认闭环。 |
| C1 | accept | selfCheckContract 在 slice 前记录 scanIssuesTotal / positiveIssuesTotal；上下文保留已有总数。旧样本缺总数时只记 SampleCount。新增真实 Python 工作簿→扫描→起草→模型上下文回归：30 条真实扫描问题不能变成 8。 |
| C2 | accept | runPi 在宿主补完检查前持久记录 modelStopReason。聊天分别展示预算原因、BLOCKED、报告可用/缺失及真实问题数。新增预算+BLOCKED并存、模型失败被检查原因覆盖、REVIEW无报告且已有助手文本，以及真实 runPi 终态收口回归。 |
| C3 | accept | 原文件 SHA 与上传说明 artifact SHA 比较；两边没有说明时按同一原文件识别。新增实际起草流程的有/无说明续问回归；说明或原文件变化均不继承候选。旧候选仍仅作参考，未自动绑定或批准。 |

三项修正前失败证据：review-red.log、review-context-red.log。修正未重跑付费模型；真实模型观察仍以上文回执为准，新增离线回归不能替代真实用户验收。


## 最终独立复核

评审工程师对 C1/C2/C3 全部确认关闭；独立重跑 27 文件 / 213 项通过，类型及 diff 检查退出 0。复核仅放行本批有限代码修复，不放行真实用户旅程。初评与复核分别对应 97d1803c-a720-462a-a05b-5c071b4590eb、035c117c-d9d5-47c1-87af-c6386bdccc4f。

本批变更为上列 9 个代码/测试文件及本文交付说明。原件、旧 QA 1899 问题、真实新报告 1872 问题均保留；未启动共享 3000，未推送或发布。
