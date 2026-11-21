# Ticket 02 交付记录

工作区：`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-02`

分支：`feature/plan-library-ticket-02`

实现提交：`45f8216c3567eab8d686295172a91a43428f863c`（feat: bind selected plans to durable runs with restart reconciliation）。

提交后执行 `git merge --no-edit feature/plan-library-integration`，结果为 `Already up to date.`。最新集成提交为 `f624e451a8b56a402e1b48945c175d0b1638251a`，`git merge-base --is-ancestor feature/plan-library-integration HEAD` 退出 0。没有合并冲突，没有修改 integration 工作区、main 或其他 worktree。

## 已交付

- 新表导入后显式选择已确认、结构可识别的方案，运行前展示名称、供应商、单证类型、contractVersion；不自动预选。
- `planId + planVersionId + contractVersion + requirementsDigest + planNameSnapshot` 从选择、持久化、运行恢复到结果投影保持一致。
- web reserve → closure ledger commit → receipt；数据库唯一约束、请求幂等、并发去重、typed stale 和重启对账；回执丢失也不创建第二次运行或重发已绑定运行的模型请求。
- lastUsedAt 在绑定事务成功时更新；lastResult 使用最近终态枚举，运行中、中断、拒绝不覆盖。
- 生产预算、日期、工作台模型额度作用域保持；旧说明摘要强复用通过回归。

## 实际验证

| 检查 | 结果 |
|---|---|
| TDD 首轮 | 新增的最初 9 项行为测试在实现前失败 |
| 最终 `npm test` | 退出 0；21 个文件、139 项全部通过，包含 19 项新绑定行为和 3 项选择客户端用例 |
| 最终运行时间 | 2026-11-14 22:22:49 开始，14.88 秒 |
| `npm run typecheck` | 退出 0 |
| 提交前 `git diff --cached --check` | 退出 0 |
| 实际运行器 | 不使用 legacy 契约目录，从绑定快照完成沙箱脚本抽取、后处理与独立检查；解释版本为 v1，结果仍为 REVIEW |
| 跨库恢复 | 在 reserve / commit / receipt 三个真实落盘状态后重开服务，各保留一个运行；ledger 失败回滚和 receipt 失败恢复通过 |
| 页面 | 隔离样本的显式选择、标签与运行身份展示已检查；320 px 弹窗变形无横向溢出 |

详细证据、真实日志、截图和完整改动文件清单：

`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-02/.work/plan-library-ticket-02/evidence.md`

协议、API 和回滚说明：

`/Users/ziyun/workdir/worktrees/autotariff-agent-plan-ticket-02/docs/plan-run-binding.md`

## 未覆盖与风险

浏览器文件输入拒绝读取独立 worktree 的样表，因此没有在浏览器完成文件上传；上传 API 与导入后选择的客户端状态已自动化验证。浏览器样本 runner 是无模型的 ANSWERED fixture；实际抽取和检查由上述真实运行器测试覆盖。没有独立 QA 视觉基准、评审签字、真实供应商业务准确性验收、收费模型联调、OS SIGKILL 新边界注入或发布。

Ticket 03、04A、04B 保持范围外。历史版本的 sourceSignatureRef 为空时，只做用户显式选择与新文件结构检查，不宣称已经匹配供应商历史版式。自动化通过不等于业务 PASS。

回滚前停止新方案入口，恢复旧代码，保留绑定与 artifact。artifact 先写后提交数据库，失败可能留下未引用目录，但不会产生可见虚构运行；不删除历史证据。
