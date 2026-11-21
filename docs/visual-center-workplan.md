# Agent 工作台交付计划

## 工作流

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
- [x] Phase D: Keep the audit trail
- [x] Phase E: Verify and hand back

## 团队与完成标准

协调者负责范围、集成和最终证据。产品经理定义本轮需求并负责最终产品验收。架构师核对既有 Agent Loop 的接入边界。前端与后端开发按独立文件范围实施。独立验证者检查真实浏览器、API、预算与数据边界。

完成标准是浏览器中的用户消息能够触发既有 Pi Agent Loop，展示真实工具动作、脚本修复轮次和检查结果，并能继续对话。页面区分实时执行、历史证据与离线验证。产品经理按预先冻结的标准复核，不以验收为由增加业务范围。

## 具体步骤

1. 核对后端接入、完成有边界的产品需求，并比较两个架构草案。
2. 固定会话、消息、运行、事件、轮次和产物的数据契约。
3. 接入本地 HTTP 服务、持久对话、运行触发和运行状态读取。
4. 实现有设计感的对话工作台与检查结果视图。
5. 执行离线回归、浏览器操作与有限真实模型联调。
6. 产品经理验收，按同一标准修正，交付可打开的本地页面。

## 吞吐检查点

主要未知是现有 Pi 会话如何接续以及终态运行如何被用户继续推动。先查清这两个边界，再并行前后端实施。前端与后端共享契约由协调者维护。候选设计和产品文档各有独立写入范围。只允许一个成员修改同一个实现文件。禁止覆盖既有未提交的工程产物。

## 预算与边界

用户授权本次新任务最多 1000 次模型调用。保留原任务账本及单次运行的有限轮次、Token 和时间限制。验收按需要调用，不以消耗额度为目标。仅在本机启动，不推送、合并或部署。旧项目只读。

## 子流程

- Architect: Ground, Sketch, Agree, Implement, Scrap。
- Arena: Frame, Fan out, Cross-judge, Pick, Graft, Verify。
- Swarm: Frame, Fan out, Aggregate, Report。
- PR: skip: 用户未要求提交或创建 PR，当前工程为未提交初始工作区。

## 最终验证

产品经理已按 AC-01 至 AC-12 验收，记录于 docs/visual-center-product-acceptance.md。最终类型检查通过，离线报告 template_runs/offline-1793688047254/vitest.json 记录 66 项通过、0 项失败和0项跳过。真实浏览器发送、上传、结果追问、历史轮次、报告下载、断线恢复及1440/390像素视图证据集中于 template_runs/visual-center-acceptance/。已明确区分真实事件与受控视觉状态。决策日志为 .audit/visual-center.tsv。
