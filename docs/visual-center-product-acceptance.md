# 可视化工作台产品验收

2026-11-03。产品验收结论为 PASS。AC-01 至 AC-12 已按冻结范围逐项核对，没有未关闭的 P0 或 P1 产品问题。业务抽取结果仍为 REVIEW，产品验收通过不等于业务批准。

验收直接读取实际页面实现、HTTP GET 返回的会话与运行、业务账本、原始产物、浏览器截图和离线测试报告。产品验收人员未发送消息或模型请求。浏览器操作由主执行者完成，产品验收人员逐张复核归档截图，并直接读取实际数据交叉验证。

## 真实对话与上传闭环

```text
选择 small.xlsx 和 controlled-requirements.txt
    → 真实 Pi Agent 调用工具
    → 抽取 3 条记录并执行后处理
    → 独立检查零差异，业务 REVIEW
    → 追问 Rates!R4C1，实际回答 20GP 卖价 -8 与 REVIEW 原因
    → 继续追问 Rates!R2C1，实际回答 40GP 100、40HQ 100、ETD 2026-08-30
```

会话为 `ab3bacc9-b353-4583-8b81-1e230785d842`。

| 实际运行 | 已核对结果 |
| --- | --- |
| `run-1793686570577-ae855166` | 抽取 3 条。检查问题 0。业务 REVIEW。 |
| `run-1793686710256-34c471e8` | 真实 Agent 读取保存证据，回答 `Rates!R4C1` 的 20GP 卖价为 -8。回复解释负价保留规则和 `business-approval` 待确认项。 |
| `run-1793687185587-75883048` | 真实 Agent 继续回答 `Rates!R2C1` 的 40GP 卖价 100、40HQ 卖价 100、ETD `2026-08-30`，明确对应 SHA 至 BUSAN 的第 1 条记录。没有重新抽取。 |
| `run-1793687359027-a2b1a3af` | 浏览器上传文件后真实抽取 3 条，检查问题 0，业务 REVIEW。会话为 `4dc0eb18-db5d-4d10-97cb-bc85d434ece1`。 |

上传登记 `upload-b49e0004-81db-4cd2-a727-20d95d4f84bb` 指向本地导入副本。该副本与上传运行的 `inputs/small.xlsx` SHA256 均为 `9b26626720a7381339c63f3d21cfd220b2b1de909cd2012293d436ce632bed9e`。上传说明的 SHA256 为 `4b70a519caa674484b0cb465360055339aed5c844c9f2a98be669a534d2d2df6`，与运行绑定一致。

## 逐项判定

| 条目 | 判定 | 证据 |
| --- | --- | --- |
| AC-01 | PASS | README 记录 `scripts/run_with_temp_runtime.sh npm run web` 和本地地址。`workspace-desktop.png` 为 1440 × 900。`mobile-chat.png`、`mobile-results.png` 为 390 × 844。`geometry.json` 记录页面宽度与 scrollWidth 均为 390，发送入口在视口内。 |
| AC-02 | PASS | 上述真实会话、Pi 模型与工具事件、持久运行和结果产物构成实际闭环。真实回复与系统通知使用不同身份。 |
| AC-03 | PASS | `tool-start.json` 捕捉实际上传运行 active 时的 `tool:inspect_source STARTED`。真实账本记录该工具完成后仍有后续模型轮次。`controlled-start` 与 `controlled-completed` 的 JSON 和 PNG 验证实际页面在 active 状态下显示工具开始、完成和后续模型执行。刷新、重连与重复请求由实际恢复核对和离线去重测试覆盖。证据边界见下文。 |
| AC-04 | PASS | 两次真实结果追问均已核对。进一步追问正确继承前次原文件、结果、报告与对话。每次请求有新关联运行，既有终态保留。浏览旧轮次时页面明确提示追问使用本会话最新结果。 |
| AC-05 | PASS | 现有试点选择与实际上传都进入真实流程。`upload-blocked.png` 显示未知说明的具体阻断原因和下一步。上传副本、说明和运行输入的摘要已直接比对。离线测试覆盖不支持输入在模型调用前拒绝。 |
| AC-06 | PASS | 历史真实修复 `run-1793666811037-c7a06905` 的第 1 轮为 2 条、FAIL、缺失 `Rates!R4C1`。第 2 轮为 3 条、零问题、REVIEW。`history-missing-corrected.png` 与 `history-repaired.png` 核对轮次切换和历史只读标签。 |
| AC-07 | PASS | 页面结果与实际后处理产物一致，包含原文坐标。两轮 API 返回对应轮次的记录、脚本和报告。`artifact-view.png` 可预览已登记脚本。实际下载文件与登记脚本 SHA256 一致。未登记路径和产物篡改有离线拒绝测试。 |
| AC-08 | PASS | `engineering-tests.png` 展示工程报告来源、生成时间与统计。结果页单独展示业务 FAIL 或 REVIEW。真实业务检查报告可通过产物入口核对。工程 PASS 不改变业务 REVIEW。缺失报告使用明确缺失状态。 |
| AC-09 | PASS | 历史浏览、离线报告、实时执行有文字区分。无密钥仍可浏览的测试通过。`refresh-and-reconnect.json` 记录浏览器重连前后会话数和模型预算不变。 |
| AC-10 | PASS | 空会话、区域加载、未知上传拒绝、预算拒绝、UNCERTAIN、REVIEW、产物不可用由真实操作或受控离线测试覆盖。`disconnected.png` 保留原消息与证据。`geometry.json` 记录 Shift+Enter 换行、可见焦点和可达发送入口。实现没有无效暂停、取消或排队按钮。 |
| AC-11 | PASS | 新任务身份为 `visual-center-2026-11-03`，上限 1000。完成 15 次，另有 3 次 UNCERTAIN 保留占用，共占用 18 次。`budget-before.json` 与 `budget-after.json` 的旧任务 76 条动作和摘要相同。离线测试验证第 1000 次允许、第 1001 次拒绝以及原运行有限预算。 |
| AC-12 | PASS | 本报告记录实际运行 ID、关键操作、截图、离线测试、修正和失败边界。最新 `template_runs/offline-1793688047254/vitest.json` 为 66 个通过、0 个失败、0 个跳过。真实对话闭环独立存在。 |

截图与操作 JSON 均位于 `template_runs/visual-center-acceptance/`。离线报告为实际文件，未以固定统计替代。

## 已关闭修正

| 修正 | 复核结果 |
| --- | --- |
| P1。历史第 1 轮 FAIL 却显示最终运行“一致”横幅。 | 已改成明确的旧轮次提示。`history-missing-corrected.png` 显示当前轮次 2 条、FAIL，并说明运行结论来自最后一轮。 |
| P2。实际 Agent 回复直接显示 Markdown 标记。 | `workspace-desktop.png` 已显示分段、列表、加粗与代码。消息内容保持原值，通过安全文本节点显示。 |
| P2。准备阶段显示内部状态 NONE。 | `live-start.png` 显示“尚未判定”，并保留执行中状态。 |
| P2。工具动作与完成状态缺少中文。 | 复核截图显示“读取原文件”“请求模型”“执行中”和“已完成”。技术标识仍可查看。 |

已下载的 `downloaded-parser.py` 与历史第 2 轮登记脚本 SHA256 均为 `73558bc15446dccbad5b17383839af636486dab8a2a8ff4308baa9ac06203849`。

## 保留的失败与证据边界

三个运行以 UNCERTAIN 保留，不计作成功闭环，也未自动重放原请求。

- `run-1793686187185-c4cf9368` 为初次适配故障。后续使用明确的新请求。
- `run-1793686913845-87402ad5` 为进一步追问时的回执不确定。该运行保留前次结果、报告和脚本，不能归因为上下文丢失。后续独立新请求回答成功。
- `run-1793687467492-fdda3bd5` 为上传后继续核对时的回执不确定。其证据保留，未再为截图发起收费请求。

AC-03 使用组合证据。实际工具 STARTED 已在 active 状态捕捉。实际工具的结束时间早于后续模型请求。页面的 active 状态切换由明确标注“受控视觉状态核验，不调用模型”的截图证明。没有同步捕捉真实工具 COMPLETED 且运行仍 active 的截图，不能把受控截图说成真实模型运行。

`tool-completed-before-end.json` 和同名 PNG 实际捕捉终态，文件名不准确。本验收不使用它们证明完成前可见。`tools-live.png` 也实际为初次 UNCERTAIN 终态。旧截图保留审计，新截图证明修正结果。

浏览旧结果不会重绑定下一条消息。追问使用本会话最新可继承结果，页面已说明。未知新说明仍会阻断。没有增加通用规则解释、业务审批、发布或企业管理能力。

Experience First 原则使本次只修正会影响现有对话和复核过程的问题。Prove It Works 原则使实际运行、受控页面验证、工程测试和业务 REVIEW 分别有证据，不互相替代。
