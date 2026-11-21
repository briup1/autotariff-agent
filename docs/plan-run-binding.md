# 显式选择方案与运行绑定（Ticket 02）

场景：“沿用怡升昌周报的 v1 规则”。

```text
上传本周表
  → 查看可用方案，默认不选
  → 明确选择怡升昌周报与 v1
  → 预留这条消息
  → 原子保存运行、五项身份与最近使用时间
  → 写回会话回执
  → 按绑定快照执行
  → 结果页展示原名称与固定版本
```

## 选择与输入边界

`GET /api/sources/:sourceId/plans` 返回当前工作区的可选方案，每项包括方案名称、供应商、单证类型、contractVersion，以及：

| 选择令牌 | 含义 |
|---|---|
| planId / planVersionId | 显式选择的方案与不可变版本 |
| planUpdatedAt | 选择时的方案元数据修订时间 |
| sourceSignature | 选择时新文件的 sourceSignature-v1 |
| sourceSha256 | 选择时新文件的原始字节摘要 |

列表只接受 confirmed 方案、有效版本与确认凭据、可识别的契约结构。candidate、inactive、契约缺失/损坏、无法识别所需列的方案不进入列表。原文件解析不可用时返回可操作错误，不伪装为空匹配。页面不预选任何方案，用户也可明确选择“不使用方案”走原说明摘要/首次观察路径。

本 Ticket 的结构检查只验证表头可以由该契约识别，不判断供应商业务身份。供应商与单证类型仍由用户确认。没有实现 Ticket 04A 的 supplier + docType + signature 自动匹配、预选或排序决策。

结构签名在 `src/closure/plan-source.ts` 统一生成：固定顺序的 JSON 包含规范化 docType、按原顺序的 sheet 名称、结构区域的 sheet/列边界/字段位置以及规范化表头标签；字段位置按列号排序。数据行内容、价格、数据行数量和时间不进入签名。每次列出选择项只解析一次文件，所有方案共享该原文盘点。

Ticket 01 产生的 PlanVersion.sourceSignatureRef 可以为 null。此时允许用户显式选择并通过新文件的结构校验，锁定选择时结构；null 本身不构成历史版式匹配证据。有签名引用时额外校验其不可变 artifact，JSON 的 sourceSignature 必须与新文件一致。

`POST /api/conversations` 和 `POST /api/conversations/:id/messages` 增加可选 planSelection。新会话会保存服务端重新验证得到的标签；发送消息携带同一令牌。请求 ID 限定字符与长度，摘要必须为 64 位十六进制，不能传入任意本机文件路径。

状态、当前版本、确认凭据、文件字节或选择时结构发生变化，返回 HTTP 409 / `PLAN_VERSION_STALE`，要求重新选择。不会改用其他版本或摘要契约。可从“新建”重新选择该文件与可用方案，旧会话、草稿与运行证据保留。

## reserve → ledger commit → receipt

1. Web ConversationStore 在自己的事务中保存 ADMITTED Job、原消息和 planSelection，继续保留单会话单活跃 Job 约束。
2. 在模型派发之前写入独立运行 artifact：原文件副本、解释、确认契约和确认凭据。再次校验方案与文件；同一个 closure SQLite 事务创建 runs、插入 run_bindings、更新 Plan.lastUsedAt。
3. web store 将权威五字段写入 bindingReceipt，并把原 Job、用户消息、会话链接到同一个 runId。
4. 只有以上步骤完成后才执行现有 runner。生产 runner 恢复这个预先创建的 runId，不能再创建新运行。

五字段为 `planId + planVersionId + contractVersion + requirementsDigest + planNameSnapshot`。同工作区 requestId、runId 各自唯一。RunBinding 的数据库行禁止 UPDATE；Ledger.save 同样拒绝改写 manifest 中的五字段。运行详情从 closure ledger 投影，不相信前端标签或回执来决定身份。

显式方案运行从自己的契约/批准 artifact 恢复规则。已选方案的运行禁止 draftContract；规则变化须进入后续人工创建版本流程。即使原 requirementsDigest 目录被删除，也不回退到其他规则。

生产预创建读取原有 loadConfig 的运行日期、年份和预算，并保存原工作台 liveBudgetTask。继续执行原模型额度、运行预算和收费回执保护。注入的离线测试 runner 使用默认测试预算。projectRoot 可由工作台传给运行器，使持久化与测试根目录一致；原 Python 环境限制及沙箱保持原样。

## 重试与恢复

| 中断边界 | 恢复行为 |
|---|---|
| 只有 ADMITTED 预留，没有 ledger binding | 校验原选择，再提交一次本地运行绑定，派发一次 runner |
| 已提交 ledger binding，web receipt 缺失 | 按 requestId 补写原 runId 与原绑定；终态直接完成，非终态标中断，不自动重发模型 |
| receipt 已存在但 Job 仍 RUNNING | 返回原运行；终态完成，非终态标中断 |
| 已提交但响应丢失，原请求重试 | 返回原运行；必要时立即补回执，不必等重启 |
| 同时重复提交 | 等待同一 admission 的完成，不返回空运行占位，不创建第二个运行 |
| 请求 ID 试图改内容、换方案、换版本或复用于其他会话 | 拒绝，不借用另一会话的运行 |
| 绑定事务失败 | runs、run_bindings、lastUsedAt 一并回滚；web Job 保存失败信息，无可见虚构运行 |

legacy Job 继续使用原重启中断策略，不猜测 Plan 身份。已有绑定的重试不再按当前方案状态重新选规则，因此改名或停用不会破坏历史查询。

## 派生字段

- lastUsedAt 在运行与绑定事务成功时更新。
- terminal manifest 保存 finishedAt。SQLite 的终态投影在保存运行状态的同一事务内，选取该方案最近完成的 REVIEW / BLOCKED / ANSWERED，保存枚举本身到 lastResult。
- RUNNING、拒绝、未落账绑定、重启标中断均不替换 lastResult。不存在跨结果优先级，也不会自动升级方案状态或版本。

## 验证与回滚

行为与故障边界：`tests/plan-binding.test.ts`。页面选择、上传分阶段和同请求重试：`tests/plan-selection-client.test.ts`。旧契约摘要复用、运行恢复、registry、sandbox 和 web 测试保持回归。

回滚恢复 Ticket 02 前的代码，保留新增触发器、绑定和 artifact。停止新方案运行入口后再回滚；旧版不会为 ADMITTED Job 推断新身份或自动重发。保留历史证据，不物理删除绑定。后续重新启用时继续按原 requestId 对账。

不包含 Ticket 03 的新增版本入口、Ticket 04A 的自动候选匹配、Ticket 04B 的复用异常处理。结构可识别与自动化通过均不代表业务准确性审批。
