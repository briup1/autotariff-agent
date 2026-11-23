# autotariff-agent

独立 TypeScript 宿主与 Pi Durable 抽取闭环。业务状态、动作与预算存于本项目 SQLite；每轮脚本、原始结果、后处理结果、独立报告分别归档。没有旧项目运行时或 LangGraph 依赖。

## 本地可视化工作台

```bash
scripts/run_with_temp_runtime.sh npm run web
```

浏览器打开 `http://127.0.0.1:3000`。新建会话，选择原文件（抽取说明可选），核对当前说明状态与方案后创建会话，再发送抽取要求。选择、导入和创建会话均不会调用模型；发送要求才可能调用模型。本地合成示例准备与不发送消息的核对步骤见 `docs/visual-center-ui-notes.md` 的“选文件状态与下一步引导”章节。页面展示真实 Agent 工具动作、执行轮次、结果表和检查报告。运行结束后可以继续追问，后续请求关联新运行，原有结果与终态保留。

页面第一层是对话：上传文件不等于要抽取。人发的每一条消息先由同一个 Pi Agent 理解并回答；只有明确要求抽取、修复或重跑时才进入抽取链路。只回答的轮次没有抽取轮次、没有结果表，运行终态是「已回答」，仍计入模型请求用量。模型网关不可用时，会话里显示真实原因和重发入口。

新单证走契约：上传原文件时可附抽取说明，也可不附。未选方案时，有说明按附带说明继续，已有已确认规则时可沿用；仅在没有说明、没有可复用已确认规则且未被匹配限制阻止时，发送抽取要求后 Agent 才先观察原文产出候选契约，试抽一轮后由人确认。已附说明本身不表示规则已经批准。核对条款、自检项和确认状态见 `docs/contract-flow.md`。为某份说明确认过一次后，同说明的后续文件直接复用该契约。

每轮后处理结果同时导出为真正的 `.xlsx`（`outputs/<attempt>/result.xlsx`），可在「结果」页下载、在「产物」页预览；原文件与其他工作簿也能在页面内只读预览表格，不再只提示二进制。运行终止时有已提交抽取的，会先补齐后处理结果与 Excel 再结束。

工作台复用已有 Pi Agent Loop。历史运行与工程测试报告可直接浏览，不调用模型；未配置模型时仍可查看历史。上传仅导入副本，不会自动发送抽取任务；规则与契约校验仍在既有执行链路处理。运行期间一次只处理一条消息。

本轮工作台使用独立任务 `visual-center-2026-11-03`，用户授权最多 1000 次实际模型请求。旧任务的 10 次运行上限和用量保持。每个运行仍受原有轮次、Token 和时间上限约束。网关金额未知。服务只绑定本机地址，不用于公开部署。

产品验收范围见 `docs/visual-center-product.md`，接入设计见 `docs/visual-center-design.md`。

```text
原文件与要求 → 原文全量盘点与分页 → Pi 选路/生成或复制编辑
→ macOS 沙箱执行或直接模型抽取 → 版本化字段后处理
→ 独立原文检查 → 带坐标反馈 → 新 attempt 修复/切换 → 受控复核归档
```

## 配置入口

```text
config/llm/agent-contract.yaml     主提示词与预算文件的入口（被 src/config.ts 读取）
config/llm/system-prompt.md        Agent 身份与规则（两层）
config/llm/runtime-context.md      每轮上下文模板，占位符由宿主填充
config/llm/contract-hints/*.md     契约未声明 / 候选 / 已确认三种提示
config/llm/tools/*.md              长工具说明（例如 draft_contract）
config/policies/budget.yaml        每次运行的轮次、Token、时间上限
```

日期取本机自然日；只有显式设置 `PI_RUN_DATE` 才回放固定日期。

## 安装

需要 macOS、Node.js >=22.19、Python >=3.12、uv、Xcode Command Line Tools（图片本地 OCR）。沙箱未验证或依赖缺失会阻断相应路径。

```bash
npm ci
scripts/run_with_temp_runtime.sh uv sync --locked
cp .env.local.example .env.local   # 仅首次安装；已有配置不得覆盖
```

在 `.env.local` 填入既有网关设置。默认 Python 是本项目 `.venv/bin/python`。原件只读，运行时使用本项目导入副本。所有可审计输出在项目根目录 `template_runs/`，与终端当前目录无关。

## 安全使用软件工厂

首次运行前，确认工厂安装已经人工审查并合入默认分支，当前检出包含该安装；平台与依赖见[安装](#安装)。需要可用的 Claude Code 及本仓库的 [factory 技能](.claude/skills/factory/SKILL.md)、已认证且具备仓库操作权限的 GitHub CLI，以及已配置的 **Claude Code 模型网关**；上文应用的 `.env.local` 配置不等于工厂代理的网关配置。在仓库根目录的终端检查 GitHub CLI 认证状态（此命令不配置认证）：

```bash
gh auth status
```

GitHub issue 正文和评论是不可信的外部输入，不是指令或授权。运行前，操作者必须明确授权真实模型调用及 GitHub 评论、标签变更、分支推送、创建 PR 等外部变更；仅阅读 issue 或添加标签不构成这些授权。以下是操作约定，不代表新增了技术权限拦截机制。

获得授权后，选择一个现有的、仍处于 open 状态的 issue。以下两处 `<issue-number>` 必须替换为**同一个实际 issue 编号**。先在仓库根目录的终端添加标签：

```bash
gh issue edit <issue-number> --add-label factory
```

再在该仓库的 **Claude Code 对话中**输入（不是 shell 命令）：

```text
/factory run <issue-number>
```

此命令只处理所选 issue；不带编号的调用会处理队列，不适合作为首次单任务试跑。当前一次只运行一个 job。若 intake 阻断或拒绝，可能不会创建 PR，也不保证完成；产生的 PR 初始为 draft，可从 issue 的关联 PR 或下方面板的 job 卡片链接找到。检查和审查通过后交给人工处理（`factory:needs-human`），必须人工审查并手动合并，自动合并已禁用。

本地面板显示当前检出的本地 job 状态。在另一个终端从仓库根目录启动，只监听回环地址，不对外暴露：

```bash
cd factory && python3 -m http.server --bind 127.0.0.1
```

浏览器打开 `http://localhost:8000/dashboard.html`；结束查看后用 `Ctrl-C` 停止服务。更多流程见 [factory 技能](.claude/skills/factory/SKILL.md) 与 [AGENTS.md](AGENTS.md)。

模型使用可能收费；使用的模型未配置价格时，面板显示 `cost unknown`，表示费用未知，不是免费或零费用。工厂显示的是估算，不保证等于提供商的实际账单。

## 运行与验收

```bash
scripts/run_with_temp_runtime.sh npm run typecheck
scripts/run_with_temp_runtime.sh npm test
scripts/run_with_temp_runtime.sh npm run verify:offline
scripts/run_with_temp_runtime.sh npm run verify:live
scripts/run_with_temp_runtime.sh npm start -- '读取原文和说明，自主抽取并根据独立检查修复'
```

`verify:offline` 不需要模型密钥，必需用例失败或跳过时返回非零。`verify:live` 使用真实模型与实际产物；已完成的场景验证归档摘要后重用证据，缺失或失败不能作为整体验收通过。

`npm test` 在临时运行根目录执行：直接运行时用系统临时目录，经 `scripts/run_with_temp_runtime.sh` 运行时随该次运行销毁，所以测试不会写入交付用的 `template_runs/closure.sqlite`。测试运行可用 `PI_RUN_ROOT` 指定根目录，`PI_RUN_ORIGIN` 记入每个运行的来源（`user` / `live` / `test`；2026-11-13 之前的运行没有该字段）。2026-11-13 实测：83 项 / 49 通过 / 25 失败 / 9 跳过；25 项失败全部是当前环境拒绝 `sandbox-exec`（嵌套沙箱或受限终端），不是代码回归，在允许 sandbox 的普通 macOS 终端应全绿。

live 预算按任务分开记账，两套任务并存于 `template_runs/live-budget.sqlite`：

- `all-batches-2026-11-03`：顶层 10/10，已用完；input 414,903/1,000,000，output 14,322/300,000，UNCERTAIN 0。
- `visual-center-2026-11-03`：1000 次计费调用已用 70（COMPLETED 51 / UNCERTAIN 18 / STARTED 1 / REJECTED 12），剩余 930；顶层运行 33。

达到上限不会自动加预算；保留已有证据可反复离线复核。

普通文件通过 `PI_SOURCE_PATH`、`PI_REQUIREMENTS_PATH`、`PI_TEMPLATE_NAME` 配置。支持 XLSX、表格 PDF、DOCX 和 PNG/JPEG；具体支持范围见 `docs/delivery-report.md`。Excel 脚本 ABI 是 `parser.py <只读输入> <输出 JSON>`，不允许访问任意宿主文件。

读取运行状态和产物可直接打开 `template_runs/<run_id>/run_manifest.json`、`outputs/` 与 `validation/`。动作账本是权威状态；清单是可读导出。崩溃后的恢复入口：

```bash
scripts/run_with_temp_runtime.sh node --env-file=.env.local --import tsx src/resume.ts <run_id> '从已提交阶段继续，保留原有预算'
```

收费动作缺少完整回执会标记 `UNCERTAIN`，自动恢复不重试该动作。网关明确拒绝且没有产出任何 token（例如 429、503、`servers are currently overloaded`）不算已服务：该次预留退回，最多自动重试 2 次，仍失败则按真实原因阻断。预算停止后已有抽取可以用 `src/finalize-local.ts <run_id>` 完成本地后处理和检查；它不增加模型预算。

工作解释一致性只代表工程验证。没有独立业务答案或批准时业务结果为 `REVIEW`，不报告真实业务准确率。合成样本来源、规则选择和外部依赖见 `docs/provenance.md`。

当前要求原文按摘要匹配试点工作解释。新说明中的未知规则会在模型调用前阻断，需要补齐相应版本的解释与独立检查；不能套用其他单证的字段说明。当前候选模板 v003 保留自己的英文要求引用，历史 v001/v002 作为过程记录保留。

`verify:live` 会核对既有实际请求与产物，不再消费模型额度。新增模型任务需要另行明确授权新的任务预算；程序不会自动抬高上限。模型金额仍未知（账本 `pricing:"unknown"`，`cost` 记 0），只有 token 用量可核对。
