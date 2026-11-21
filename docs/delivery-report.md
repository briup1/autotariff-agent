# 全批次交付报告

2026-11-03。批次 0–6 的本地工程开发与验收完成。54 项离线测试通过，C01–C24 与 R01–R13 全部关联实际证据；6 个必需真实模型场景通过；全新 npm 和 Python 环境安装后运行通过。未部署、推送、合并、创建外部 PR 或发布正式模板，旧项目只读。

工程 PASS 与业务批准分开。怡升昌真实结果仍为 **REVIEW**，第二轮有 144 个工作解释差异/问题需要复核。没有独立业务答案，不报告真实准确率。

## 每批交付

| 批次 | 实现结果 | 验证 |
|---|---|---|
| 0 | 核查旧原型；统一 A 基础和 B 恢复语义；独立 uv 环境；本单证原文/工作解释摘要；需求矩阵 | 原 9 项仅作基线；当前源码、配置与全套回归 |
| 1 | SQLite 动作和预算、单运行写者、不可变产物、动作幂等、预留/结算、绝对时限、四处阶段恢复、OS 沙箱 | C16、C17、C19；真实 SIGKILL、文件/网络/进程/资源对抗 |
| 2 | 原始坐标/样式、分页、合并、多表头、主/附加费意图、局部和共享上下文；5005 行 | C06–C14；完整扫描、实际脚本故障定位、分页不变性 |
| 3 | Pi 从原文生成实际脚本、读具体产物、参考复制修改、新轮次修复与差异；字段后处理；独立检查 | C01、C02、C15；真实怡升昌 + 受控漏项修复；实际错价/额外记录/后处理错误 |
| 4 | PDF/Word/图片本地探查、转换和映射、直接模型抽取、物理转换丢行后切换 | C03–C05；下表实际请求、原件与报告 |
| 5 | 本单证全文要求、稳定条款、实现位置和检查绑定；候选适用性、要求冲突、新版本与进行中绑定 | C18、C20–C24；当前试点候选 v003，旧版本保留 |
| 6 | 安装说明、离线/live 入口、完整回归、重新安装检查与交付索引 | 必需命令全部执行；缺项/跳过/失败不能返回整体成功 |

## 最终命令与实际证据

- `npm run typecheck`：通过；另执行严格未使用导入/参数检查。
- `npm test`：由 `verify:offline` 调用同一入口，54 项通过。
- `npm run verify:offline`：PASS，0 失败、0 跳过，offline-1793678923469。[template_runs/offline-1793678923469/vitest.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/offline-1793678923469/vitest.json)。
- `npm run verify:live`：PASS。已实际执行的模型记录按摘要复核；后续核验不再收费。[template_runs/live-acceptance/verification.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/live-acceptance/verification.json)。
- `npm run verify:reinstall`：PASS，reinstall-1793678942272。新依赖目录与新 Python venv 执行应用副本，输入/证据指向项目根目录；没有复制私有 env，也没有调用模型。[template_runs/reinstall-1793678942272/summary.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/reinstall-1793678942272/summary.json)。

## 真实模型场景

| 场景 | run_id | 实际路径 | attempt 数 | 报告 | 工程 / 业务 |
|---|---|---|---|---|---|
| repair | run-1793666811037-c7a06905 | excel_script | 2 | [template_runs/run-1793666811037-c7a06905/validation/attempt-002/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793666811037-c7a06905/validation/attempt-002/report.json) | PASS / REVIEW |
| reuse | run-1793666919879-a6c4de67 | excel_script | 1 | [template_runs/run-1793666919879-a6c4de67/validation/attempt-001/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793666919879-a6c4de67/validation/attempt-001/report.json) | PASS / REVIEW |
| pdf | run-1793666985617-c40e252c | converted_excel_script | 1 | [template_runs/run-1793666985617-c40e252c/validation/attempt-001/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793666985617-c40e252c/validation/attempt-001/report.json) | PASS / REVIEW |
| word | run-1793667026223-e1836877 | direct_llm | 1 | [template_runs/run-1793667026223-e1836877/validation/attempt-001/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793667026223-e1836877/validation/attempt-001/report.json) | PASS / REVIEW |
| image | run-1793667076755-0bd4bf19 | direct_llm | 1 | [template_runs/run-1793667076755-0bd4bf19/validation/attempt-001/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793667076755-0bd4bf19/validation/attempt-001/report.json) | PASS / REVIEW |
| switch | run-1793667246501-d15c37ff | direct_llm | 2 | [template_runs/run-1793667246501-d15c37ff/validation/attempt-002/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793667246501-d15c37ff/validation/attempt-002/report.json) | PASS / REVIEW |

Word 的真实后续模型请求包含独立检查反馈，已由 live 核验入口检查。实际 live 改写脚本另在原试点输入上执行回归，零差异：[template_runs/live-acceptance/reuse-regression.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/live-acceptance/reuse-regression.json)。当前候选 v003 重新执行同一 Pi 脚本并绑定自己的要求原文：[template_runs/live-acceptance/current-pilot.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/live-acceptance/current-pilot.json)。

场景提示用于触发必需路径，实际工具参数、计划、Python/直接响应、反馈和修复都由真实 Pi 输出；未用固定宿主序列代替全部 Agent 能力。未测量任意新文件的选路最优率。

## 真实怡升昌

运行 run-1793666364570-579fa2de 读取指定原件与说明。真实 Pi 生成 parser.py、实际执行、收到独立漏表/字段反馈后生成 attempt-002 并重跑。第一轮 370 个规则差异，第二轮 144 个，均保留，不把减少的问题数换算为业务准确率。

[template_runs/run-1793666364570-579fa2de/validation/attempt-002/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793666364570-579fa2de/validation/attempt-002/report.json)；[template_runs/run-1793666364570-579fa2de/validation/attempt-002/script-diff.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/run-1793666364570-579fa2de/validation/attempt-002/script-diff.json)。没有读取 _real_values 作为真值，没有改答案或抬高预算来消除差异。

## 预算、安全和恢复

本次共 10/10 个顶层 live 运行；累计输入 414903/1000000 Token、输出 14322/300000 Token。SDK 重试为 0，未知回执 0。金额未知，不能按零元解释。上游网关内部重试细节不可观测，记录为未知。最初失败的运行也计入总额，没有删除或豁免。

额度已用满；新收费任务需要新的明确授权，程序不会自动增加总额。现有证据与离线检查可重复运行。

每个实际工具派发先登记身份与额度；拒绝参数也计数，内部阶段不重复计数。模型、脚本和本地 worker 遵守剩余绝对时限。已完成动作按摘要复用；中断后未知收费结果阻断，不自动重试。源预期与归一化预期在候选前固定摘要，变化会 BLOCKED。SQLite 打开竞争曾使一次回归失败，已把 busy_timeout 放在 WAL 初始化前，随后全量通过，失败记录保留。

源文件/参考文件只读，生成脚本只读指定输入和运行库、只写隔离 scratch，网络和派生进程被 OS 拒绝。CPU/文件大小/句柄有限制，RSS 每 25ms 检查并终止进程组；RSS 不是零超额的硬分配限制。四个已证明恢复断点见矩阵；SIGKILL 或机器故障不保证 shell 清理，不能删除仍有活跃进程的临时目录。

安全扫描检查 7829 个源码、配置、文档、测试及持久文件，已配置密钥出现 0 次；私有 .env.local 明确排除。[template_runs/security-audit/report.json](/Users/ziyun/workdir/remote_project/autotariff-agent/template_runs/security-audit/report.json)。

## 支持范围与业务缺口

- 本次运行环境是 macOS + Node 22.22.0 + 独立 Python 3.12；不宣称 Linux/Windows 沙箱已经实现。Pi 与依赖通过 package-lock/uv.lock 固定。
- Excel 支持已验证的别名字段、重复/多层表头、上下/左右区域、合并继承、隐藏、整格与局部删除线、不可见显示与公式缓存。没有实现完整 Excel 渲染、条件格式计算和公式重算；缺缓存或无法解释的必要结构明确阻断。
- PDF 验证的是本地可读表格，DOCX 验证段落/表格与限定叙述语法，图片验证 Apple Vision 英文 OCR 加原图模型。样本均标为合成，没有冒充业务留出集。不承诺任意扫描版 PDF、叙述文法、语言和复杂版式都能自动通过。
- 已纳入的字段链为字段契约 fields-v002，包含价格/日期归一化、箱型补值、备注与有效期关系。没有把旧项目所有模板的动态规则都搬入新项目。
- 新说明需要匹配自身的工作解释及独立检查。未知规则在模型前 BLOCKED，不能借用其他单证条款。版本管理覆盖已纳入规则的试点复用、布局调整与更新，不代表任意新业务规则已经自动实现。
- 缺少真实独立业务答案和人工批准，当前输出与候选均不可作为正式业务 PASS 或正式发布模板；真实质量缺口是已保留的人工复核项。

## 来源、边界与后续核验

完整来源与通用规则边界见 [docs/provenance.md](/Users/ziyun/workdir/remote_project/autotariff-agent/docs/provenance.md)，设计见 [docs/design-synthesis.md](/Users/ziyun/workdir/remote_project/autotariff-agent/docs/design-synthesis.md)，需求明细见 [docs/acceptance-matrix.md](/Users/ziyun/workdir/remote_project/autotariff-agent/docs/acceptance-matrix.md)，执行过程见 [docs/execution-log.md](/Users/ziyun/workdir/remote_project/autotariff-agent/docs/execution-log.md)。原件、旧代码、旧虚拟环境、历史方案及生产入口未修改。没有提交、推送、合并、部署、对外发信或发布正式模板。

最终补测：合法的金额、日期、箱型补值及备注数组归一化可以在抽取中提前发生，按固定规范化投影比较，不作为错误；原始源事实与脚本实际输出分别归档。错误价格、额外记录和非法后处理变化仍会阻断。
