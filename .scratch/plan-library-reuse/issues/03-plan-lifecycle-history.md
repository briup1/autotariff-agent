# 03: 不可变版本与历史追溯

**What to build:** 规则发生实质变化时，在同一方案下生成不可变新版本；历史运行继续指向原方案版本，并能显示运行时名称快照和当前方案名称。

**Blocked by:** 02: 新表选择方案并绑定运行版本。

**Status:** ready-for-human

**Labels:** ready-for-human

- [x] 人工点击“创建新版本”并确认新契约后，生成新的不可变 `contractVersion`。
- [x] `contractVersion` 按同一 Plan 的单调递增序列生成，不复用旧版本号。
- [x] REVIEW 结果不会自动创建版本、改变方案状态或改变当前版本指针。
- [x] 新版本保存新的 `planVersionId`、requirementsDigest、contractSha256 和源签名，不覆盖旧 artifact。
- [x] 旧版本和旧运行不被覆盖；新运行只能绑定新版本。
- [x] 历史运行只依赖不可变名称快照；当前方案改名不会改写历史快照。
- [x] 缺失或损坏的版本 artifact 阻断新运行，并保留旧运行可读。

实现与开发者自测证据：`.work/plan-library-ticket-03/evidence.md`。浏览器视觉门禁受阻，独立评审与 QA 尚未执行。
