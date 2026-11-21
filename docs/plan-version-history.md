# 不可变版本与历史追溯（Ticket 03）

场景：“怡升昌周报原来只抽 PORT，现在需要加入 PRICE 并保留负价”。

```text
旧运行使用 v1
  → 用户点击创建新版本
  → 核对新契约与对应原文件
  → 人工确认
  → 同一方案追加 v2，并切换当前版本
  → 新请求选择 v2
旧运行继续使用 v1，并展示当时名称与当前名称
```

## 人工确认入口

方案库的 confirmed 方案显示“创建新版本”。弹窗复用现有方案表单，但隐藏不可编辑的方案标签，展示关联原文件、候选契约的准确内容与摘要，并要求勾选人工确认。候选契约可以尚未在 legacy 摘要注册表中批准；本次人工确认只批准新增的 PlanVersion，不修改或全局批准 legacy 契约。

- `GET /api/plans/:planId/version-options` 返回已登记原文件能关联到的契约，以及 requirementsDigest、contractSha256、sourceId 和预览。没有关联来源或内容损坏的契约不会伪装成可确认选项。
- `POST /api/plans/:planId/versions` 接受 requestId、requirementsDigest、预览 contractSha256、sourceId、expectedCurrentVersionId，以及必须为 true 的 confirmContract。
- `GET /api/plans/:planId` 在保留既有 plan / version 字段的同时增加 versions，按新到旧列出版本元数据。

确认前不分配版本号。取消不会写入。接口重新校验来源、结构、契约摘要与当前版本指针；过期预览或指针返回 PLAN_VERSION_STALE。inactive / candidate 方案不能借升版变为 confirmed。

版本请求的 requestId 在 workspace 内唯一。同一个 ID 重试返回最初创建的版本，即使当前版本后来已变为 v3，也不会重新切回 v2；跨方案使用同一请求 ID 被拒绝。客户端在响应丢失或 5xx 后锁定原 payload，保留人工确认和原 requestId，重开也只重试原提交。

## 版本持久化

在同一个 SQLite 事务中：

1. 读取当前 Plan 和已有版本，校验人工确认、预览摘要、当前版本和规则实质变化。
2. 使用该 Plan 已提交版本号的最大值加一，分配 v2 / v3……。版本行禁止 UPDATE 和 DELETE，因此已提交版本号不会被覆盖或回收。失败且未提交的编号不属于已发行版本。
3. 创建新的 planVersionId 目录，排他写入并 flush 独立 artifact。
4. 插入不可变 PlanVersion、plan_version_requests 幂等映射，再切换 Plan.currentVersionId。lastUsedAt、lastResult 和 status 均保留。

并发确认由 BEGIN IMMEDIATE 串行化，第二个指向旧当前版本的不同请求被拒绝；重复同一个请求返回原版本。失败时事务回滚，并删除本次独占创建的目录，旧版本、旧绑定和旧文件保持原样。

新增表 plan_version_requests 使用 workspace + requestId 主键；versionId + planId 复合外键保证归属。迁移只新增表和不可变删除触发器，不回填或改写旧版本。

新目录 `template_runs/plans/<planId>/<planVersionId>/` 包含：

| 文件 | 证据 |
|---|---|
| contract.json | 本次规则与新 contractVersion |
| approval.json | 本次人工确认人、时间、版本与准确摘要 |
| source-contract.json | 人工核对的原候选契约字节 |
| source-signature.json | sourceSignature-v1、结构签名、原文件字节摘要与 sourceId |
| confirmation.json | requestId、预览摘要与本次批准记录 |

PlanVersion.sourceSignatureRef 指向新的不可变签名 artifact。签名沿用 Ticket 02 的结构算法，不加入价格或数据行值。

规则比较对契约验证后的字段、路由、检查、说明与待确认问题进行稳定比较，排除系统版本号、来源类别和 requirementsDigest。只有元数据变化返回 PLAN_RULES_UNCHANGED，不创建空升版。

## 历史读取与新运行

运行的五字段 RunBinding 保持不可变。RunSummary 增加 planCurrentName，按 planId 读取当前标签；历史持久化记录只保留 planNameSnapshot。改名只改变当前显示，原快照和契约身份不变。

新增版本后，旧选择令牌因 currentVersionId 不一致而过期。新请求必须选择新的当前版本。已经提交绑定的请求继续恢复自己的 runId 与运行内契约副本，允许在 v2 发布后继续使用其已绑定的 v1。

当前版本契约、批准或签名 artifact 缺失/损坏时，新的方案运行被阻断，不回退其他版本。旧运行展示读取自己的账本与已复制的证据，仍可查询；不会为了显示当前名称而重新读取方案契约。Plan 的版本元数据也仍可读取。当前契约损坏时，需先恢复证据才能进行依赖旧规则比较的下一次升版。

REVIEW 只更新既有终态投影，不创建版本，不变更 status 或 currentVersionId。本 Ticket 不实现复用异常处理或自动候选匹配。

## 验证、限制与回滚

`tests/plan-versions.test.ts` 覆盖明确确认、v1/v2/v3、同请求与并发、事务失败回滚、源签名、旧 artifact / legacy 目录不变、旧绑定、新旧运行选择、改名前后双名称、损坏证据阻断和 REVIEW 不升版。`tests/plan-client.test.ts` 覆盖预览、取消、确认和响应丢失后锁定重试。

完整自动化回归通过。Browser tab 本轮拒绝访问测试地址，浏览器视觉门禁为 BLOCKED，没有截图验收或独立 QA 签字，不宣称全面验收通过。

回滚恢复本 Ticket 前代码，保留新增版本、请求映射、不可变约束和证据。旧代码仍能使用当前指针与读取旧运行；不要删除已经发布到本地方案的版本行或复用版本号。若只需暂时停用规则，用既有停用入口，不物理删除历史。
