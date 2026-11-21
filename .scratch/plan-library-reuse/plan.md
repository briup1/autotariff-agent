# 实施 Plan：方案库与规则版本复用

状态：ready-for-agent
来源：`.scratch/plan-library-reuse/spec.md`

## 目标

把已确认的抽取契约变成用户可管理、可选择、可追溯的方案，使这条链路成立：

```text
确认契约
  → 保存为 Plan
  → 新表选择 Plan
  → 运行绑定 Plan + contractVersion
  → 结果可追溯
  → 规则变化生成新版本
  → 异常进入 REVIEW，不自动升级
```

## 边界

- 只改方案复用层，不做运价入库、查价分析、云部署和业务准确率审批。
- 保留现有按说明摘要的强复用路径。
- 不覆盖当前 `main` 工作区已有未提交改动；实施必须使用独立 worktree。
- 旧运行没有方案字段时继续可读，视为 legacy run。
- 方案版本一对一绑定确认契约；删除先实现为停用。
- 规则变化必须由人工显式点击“创建新版本”并完成确认；REVIEW 不自动升版。
- closure ledger 是 RunBinding 和运行状态的权威；web store 只负责 request/job 幂等和 receipt。跨库采用 reserve → ledger commit → receipt，并在重启时按 requestId reconcile。

## 影响面

| 区域 | 必须到达的行为 |
|---|---|
| 领域模型/存储 | Plan、PlanVersion、RunBinding、唯一约束、版本化契约存储；closure ledger 权威、web receipt、旧运行兼容 |
| 服务/API | 创建、查询、改名、停用、选择、版本校验、跨库提交/恢复、运行绑定 |
| Web 入口 | 方案库、确认后归档、上传时选方案、运行详情展示绑定信息 |
| 运行投影 | `planId + planVersionId + contractVersion + requirementsDigest + planNameSnapshot` 从运行创建贯穿到结果页 |
| 测试 | Plan 生命周期、选择绑定、版本演进、异常降级、说明摘要复用回归 |

## 执行顺序

### 01：确认契约归档为方案并管理生命周期

交付最小可见方案资产：确认候选契约后通过归档表单创建方案；方案库能列出名称、供应商、单证类型、状态、初始为空的最近使用/结论；支持改名、停用、恢复；空库有创建入口。运行后的派生字段更新由 02 负责。

### 02：新表选择方案并绑定运行

上传新文件时显示可用方案；用户选择后看到供应商、单证类型和规则版本；运行和结果页绑定同一个 `planId + planVersionId + contractVersion + requirementsDigest + planNameSnapshot`。

### 03：不可变版本与历史追溯

规则发生实质变化时，由人工显式点击“创建新版本”后在同一 Plan 下追加不可变 PlanVersion；运行绑定和历史投影保留原版本与名称快照。

### 04A：候选匹配与降级

补精确规范化匹配、唯一候选预选、多候选手选和无候选首次流程。

### 04B：复用异常回流

复用后独立检查发现异常时运行标记 REVIEW，方案不自动升级，历史证据保留。

### 05：完整回归证据

把 AC-1～AC-9 绑定到行为测试、手工步骤、fixture 和证据路径；验证说明摘要强复用、旧运行读取、幂等、stale、重启和回滚。

## 数据与兼容决策

- 新字段为空表示 legacy run，不回填猜测的方案身份。
- Plan 元数据、PlanVersion 和 RunBinding 的唯一边界在同一工作区持久化；新契约 artifact 版本化保存，旧 requirementsDigest 目录只读兼容。
- Plan 唯一键为 workspace + normalized name；PlanVersion 唯一键为 planId + contractVersion；RunBinding 以 runId 唯一并索引 planId/planVersionId。迁移采用可选字段/新表先行、legacy 双读、新写入再切换，失败时删除新元数据不触碰旧契约与旧运行。
- 规范化算法为 `norm-v1`：Unicode NFKC、case-fold、trim、连续空白折叠，标点保留。source signature 使用 `sourceSignature-v1` 的规范化 JSON SHA-256。
- 方案状态只允许 `candidate`、`confirmed`、`inactive`；复用只接受 `confirmed`。
- 版本由系统生成且不可修改；规则变化必须产生新版本。
- 同一 Plan 的 `contractVersion` 按单调递增序列生成（v1、v2……），版本号只在人工确认新版本时分配，不复用旧号。
- 停用保留方案、版本和历史运行；删除按钮不做物理删除。
- 运行创建时只保存不可变方案名快照，改名不影响旧运行绑定；当前名称由 Plan 投影查询。
- 方案选择和运行创建之间以 reserve → ledger commit → receipt 协议校验状态、PlanVersion、sourceSignature 和 requestId；拒绝 stale selection，禁止静默漂移，重复 requestId 返回原运行。
- `lastUsedAt` 在绑定成功时更新；`lastResult` 只由最近一次终态运行更新；inactive Plan 支持显式恢复为 confirmed。
- `lastResult` 保存最近一次终态枚举值本身，不做跨结果覆盖或隐式优先级；终态集合固定为 `REVIEW`、`BLOCKED`、`ANSWERED`。

## 验收映射

| Ticket | 主要 AC |
|---|---|
| 01 | AC-1、AC-2、AC-6、AC-9（方案状态部分，不含运行派生字段更新） |
| 02 | AC-3、AC-4、AC-5，以及完整 RunBinding 字段和跨库恢复 |
| 03 | AC-7、AC-9（历史部分，人工显式创建新版本） |
| 04A | AC-4、AC-5、AC-6 |
| 04B | AC-8 |
| 05 | AC-1～AC-9 完整证据、规范化边界和跨库一致性 |

最低放行门槛是 AC-1、AC-2、AC-3、AC-7、AC-9 全部通过；AC-4、AC-5、AC-6、AC-8 在完整交付前必须补齐。

## 验证策略

- 每个 Ticket 先补行为测试，再实现对应最小路径。
- 运行绑定必须从选择动作、持久化记录、服务重启后的读取、运行详情四个观察面核对同一组身份。
- 既有契约、durable、web、registry 和 sandbox 测试作为回归集合；当前沙箱环境失败单独记录，不与方案库缺陷混判。
- 完成 Ticket 05 后由测试与发布工程师独立执行 AC-1～AC-9；评审工程师再检查设计、代码和安全边界。

## 回滚

- 方案字段采用可选扩展，旧运行继续读取。
- 停用方案可恢复为 confirmed；不物理删除历史。
- 任何运行绑定失败只阻断本次运行，不改写已有契约或历史运行。
- 若前端选择入口异常，可暂时隐藏方案选择，保留旧说明摘要路径。

## 交付顺序

```text
01 → 02 → {03, 04A, 04B} → 05
                 ↘ 评审与测试可在每个 Ticket 完成后独立介入
```

