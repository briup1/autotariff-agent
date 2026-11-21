# 04A: 候选匹配与降级

**What to build:** 新文件无说明时，系统按规范化供应商、单证类型和 source signature 做精确匹配；唯一候选可预选，多候选必须手选，无候选进入首次建规流程。

**Blocked by:** 02: 新表选择方案并绑定运行版本。

**Status:** ready-for-agent

**Labels:** ready-for-agent

- [ ] supplier、docType 和 source signature 的规范化规则固定，并用于候选计算。
- [ ] 唯一精确候选只做可见预选，不静默运行；用户可以更换方案。
- [ ] 多个候选全部展示，系统不按最近使用或任意排序自动决策。
- [ ] 无候选时进入原有观察、候选契约和人工确认流程。
- [ ] 候选状态、inactive 状态和 source signature 不匹配的方案不会进入可运行候选。
- [ ] 为唯一、多候选、无候选、候选隔离补行为测试和手工证据。
