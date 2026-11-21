# 02: 新表选择方案并绑定运行版本

**What to build:** 用户上传同类新运价表后，可以选择一个已确认且可用的方案；运行前看到供应商、单证类型和规则版本，运行结果保留同一方案身份。

**Blocked by:** 01: 把确认契约归档为可管理方案。

**Status:** ready-for-human

**Labels:** ready-for-human

- [x] 上传新文件时显示可用的已确认方案。
- [x] 停用、候选和不适用方案不会被静默当作可运行方案。
- [x] 用户选择方案后，运行前显示方案名称、供应商、单证类型和 `contractVersion`。
- [x] 运行记录和结果页保存并展示同一组 `planId + planVersionId + contractVersion + requirementsDigest + planNameSnapshot`。
- [x] 方案选择与运行创建之间发生状态、版本或 source signature 变化时返回 `PLAN_VERSION_STALE`，并要求重新选择。
- [x] 同一 request ID 重试返回原运行，不创建第二个运行；服务重启后绑定仍可读取。
- [x] 验证 web request/job 保留、closure ledger 提交、receipt 写回和重启 reconcile 的每个边界。
- [x] 运行成功绑定后更新 `lastUsedAt`；最近一次终态运行更新 `lastResult`；运行中断或拒绝不覆盖最近结论。
- [x] `lastResult` 保存最近一次终态枚举值本身；终态集合固定为 `REVIEW`、`BLOCKED`、`ANSWERED`。
- [x] 现有按说明摘要的强复用路径继续通过回归测试。

开发者实现与自测证据：`.work/plan-library-ticket-02/evidence.md`。独立评审与 QA 尚未执行。
