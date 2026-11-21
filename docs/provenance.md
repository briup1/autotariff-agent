# 来源与工作解释

执行日期 2026-11-03。旧项目只读参考基线提交 `da8df5cb9b6f740b7cbd51ab8da5e78571b15081`。

真实业务输入仅为 `/Users/ziyun/workdir/remote_project/autotariffextract/data/20260811-识别文件/怡升昌/上海宁波深圳运价表.xlsx` 与同目录 `怡升昌说明.txt`。运行先复制输入与要求并绑定摘要。没有读取 `_real_values.xlsx` 作为答案，没有使用旧提取结果作为预期。

工作解释 v002 在新项目 `config/interpretations/yishengchang-v002.json`；v001 原型文本保留。每条业务规则有原文引用。v002 的分隔符选择、跨行继承、样式保留、40GP/40HQ 补值和日期取值都是明确的工程工作解释，不代表业务批准。运行固定日期、年份、说明、脚本、后处理和检查版本。

字段后处理重新独立实现于 `src/closure/postprocess.ts`。箱型补值和分阶段处理参考旧项目 `src/post_processors/custom_handlers.py::post_process_tariff_data_before_calc`（原参考位置 1333 起）；字段与日期规则来自本单证说明。未导入旧模块，未复制可变 PROCESS_RULES，未声称支持未纳入字段契约的其他模板全局规则。

源扫描器、独立检查器和后处理器均在新项目实现。检查器从原输入重读数据；源覆盖预期不读取候选脚本或候选结果，后处理预期使用与生产转换分离的参考实现。受控样本的固定值由 `src/workers/fixtures.py` 预先给定；`fixtures/reference_parser.py` 只用于离线和故障注入，不替代 live 的模型生成能力。

PDF、DOCX、PNG、5005 行和布局变体都是合成工程样本，生成器与 provenance 文件保留来源。它们不是业务留出样本。`src/closure/conversion-fault-fixture.ts` 与 `tests/fixtures/drop-converted-row.py` 仅生成可追踪的物理转换丢行故障，不暴露给 Agent，正常转换不调用。

PDF 使用本项目 PyMuPDF，DOCX 使用 python-docx，图片使用本机 Apple Vision。转换与 OCR 都在本地完成，不开通新供应方。生成脚本采用 macOS Seatbelt（sandbox-exec），CPU/输出文件/文件句柄硬限制，RSS 每 25ms 采样与进程组终止。RSS 不是零超额的硬分配上限，采样间隔内可能短暂超额。系统文件读取只限 Python 运行时和系统库；网络、派生子进程、宿主凭据与其他业务目录不可读写。

模型仅使用既有 `.env.local` 网关。API 密钥仅用于宿主认证，不写入模型上下文、工作进程环境或运行产物。SDK 重试设为 0；供应方未提供的内部重试与金额记录为未知，不能解释为零。

收尾已把怡升昌与合成输入的原文引用分开：`yishengchang-v002.json` 和 `controlled-v001.json` 各绑定自身的全文与摘要。未知说明不借用其他单证条款，在模型调用前 BLOCKED。当前试点候选 v003 使用同一真实 Pi 脚本，经本地重新执行和独立检查后绑定自己的要求原文；历史候选和报告保留。

早期 Pi 会话中的 SDK 数值成本字段是无计价表时的占位值，不能解释为实际零元。权威用量回执与交付金额均为未知（JSON null）；新响应存档也将未知价格序列化为空值。所有实际请求的 SDK 重试为 0，上游网关内部重试明细不可观测，记录为未知。
