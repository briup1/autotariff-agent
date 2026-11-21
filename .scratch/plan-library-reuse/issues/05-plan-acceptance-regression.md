# 05: AC-1～AC-9 完整回归与交付证据

**What to build:** 将方案库完整用户旅程固化为可执行的自动和手工验收证据，并证明旧契约复用、legacy 运行、幂等、重启和回滚没有回归。

**Blocked by:** 01: 方案归档与生命周期； 02: 运行绑定； 03: 版本与历史； 04A: 候选匹配； 04B: REVIEW 回流。

**Status:** ready-for-agent

**Labels:** ready-for-agent

- [ ] AC-1～AC-9 每条都有输入 fixture、操作步骤、可观察预期和证据位置。
- [ ] 覆盖创建字段校验、重复提交、stale 冲突、服务重启、缺失/损坏 artifact、取消操作和恢复。
- [ ] 证明同一运行从选择、持久化、跨库提交、重启读取到结果展示始终绑定同一 `planId + planVersionId + contractVersion + requirementsDigest + planNameSnapshot`。
- [ ] 覆盖 `norm-v1` 和 `sourceSignature-v1` 的大小写、Unicode、空白、标点及结构变化边界。
- [ ] 覆盖人工创建新版本、REVIEW 不自动升版和缺失/损坏 artifact。
- [ ] 说明摘要强复用、旧运行读取、请求幂等和单写者保护回归通过。
- [ ] 运行结果中的 REVIEW、BLOCKED、ANSWERED 与方案状态变化符合 Spec。
- [ ] 测试与发布工程师可以按证据独立复核；未执行项明确标记，不以代码存在代替通过。
