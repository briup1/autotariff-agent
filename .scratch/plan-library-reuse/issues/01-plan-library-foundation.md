# 01: 把确认契约归档为可管理方案

**What to build:** 用户确认候选契约后，通过归档表单创建可管理方案；方案库可以展示、改名、停用和恢复方案，并提供空库创建入口。

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

**Labels:** ready-for-human

- [x] 确认候选契约后创建唯一稳定的方案 ID，并绑定一个确认契约版本。
- [x] 持久化契约明确 Plan、PlanVersion、RunBinding 字段、唯一约束、查询索引和 legacy 读取；新契约 artifact 不覆盖旧版本。
- [x] 归档表单提供 `name`、`supplier`、`docType`；已知值可预填，名称去首尾空格后不能为空。
- [x] 同一工作区内规范化后的重复名称被拒绝；相同 request ID 重试返回原方案，不创建第二个方案。
- [x] 方案至少展示名称、供应商、单证类型、状态、最近使用和最近结论。
- [x] 只有确认后的规则可以进入可复用方案；候选规则不能直接进入复用池。
- [x] 方案库为空时显示创建入口，不显示伪造数据或无意义空表。
- [x] 改名保持 `planId` 和当前版本不变；停用后可显式恢复为 confirmed。
- [x] 方案库可展示 `lastUsedAt` 和 `lastResult` 字段；首次创建时两者为空。运行后的更新由 Ticket 02 验收。
- [x] 旧运行和旧契约读取不受影响；没有方案字段的运行保持 legacy 状态。
- [x] 为创建、列表、空库和候选隔离补充行为测试。

实现与开发者自测证据：`.work/plan-library-ticket-01/evidence.md`。独立评审和 QA 验收尚未执行。
