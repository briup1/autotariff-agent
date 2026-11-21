# 方案库持久化契约（Ticket 01）

使用场景：将已确认的“怡升昌周报”保存为供应商“怡升昌”、单证类型“海运报价”的方案。

```text
确认怡升昌周报契约
  → 填写归档标签
  → 写入独立的 v1 契约快照
  → 一个事务保存方案、版本和归档请求映射
  → 方案库展示已确认、尚未使用、暂无结论
```

本层只实现归档和管理。运行选择、绑定提交、跨库恢复、派生字段更新及候选匹配由后续 Ticket 实现。

## 数据所有权与约束

权威库为工作区内的 `template_runs/closure.sqlite`。workspace 使用工作区根目录的绝对路径。

| 对象 | 字段与约束 | 查询索引 |
|---|---|---|
| Plan / `plans` | `planId`；workspace；name、normalizedName；supplier、supplierKey；docType、docTypeKey；normalizationVersion；status；currentVersionId；createdAt、updatedAt；lastUsedAt、lastResult | 主键；workspace + normalizedName 唯一；workspace + status |
| PlanVersion / `plan_versions` | `planVersionId`；planId；contractVersion；requirementsDigest；contractSha256；sourceSignatureRef；approvedAt、createdAt。planId + contractVersion 唯一；UPDATE 被拒绝 | 主键；planId + contractVersion；id + planId |
| 归档请求 / `plan_archive_requests` | workspace + requestId 唯一，指向原 Plan；重试先返回该 Plan，不重新读取已变化的 legacy 契约 | workspace + requestId 主键 |
| RunBinding / `run_bindings` | runId 唯一；workspace + requestId 唯一；planId、planVersionId；data 内保存完整 `planId + planVersionId + contractVersion + requirementsDigest + planNameSnapshot` | runId 主键；workspace + requestId；planId；planVersionId |

RunBinding 引用现存 run；复合外键保证版本属于同一 Plan。此 Ticket 只建立存储边界和读取能力，业务运行不会写入绑定。Web Job 增加可选 bindingReceipt 类型，仍只负责请求回执，不替代运行账本。

`sourceSignatureRef` 的类型是 ArtifactRef 或 null。本 Ticket 尚不生成 sourceSignature-v1；null 明确表示尚无结构签名证据，不能当作匹配成功。后续使用时应先补充结构签名流程，不能以 null 绕过校验。

## 名称与生命周期

- norm-v1：Unicode NFKC → full case-fold → 空白折叠与去首尾空白；保留标点。full case-fold 使用本地 Unicode 数据生成的 lowercase 差异表，无新增依赖。
- 名称、供应商、单证类型必填，上限各为 160 字符。相同工作区中，停用方案也保留名称唯一性。
- 仅结构有效、摘要与版本均匹配确认凭据的契约可归档。候选、缺失、损坏或凭据不匹配均返回 `PLAN_CONTRACT_INVALID`。
- 创建后 status 为 confirmed，lastUsedAt 与 lastResult 为 null。枚举允许 candidate、confirmed、inactive；候选没有直接转为可复用方案的 API。
- 改名只修改名称和更新时间。停用保留 ID、当前版本和所有证据；恢复前重新验证当前版本的确认凭据。
- 同工作区重复名称返回 HTTP 409 / `PLAN_NAME_DUPLICATE`；缺失方案返回 HTTP 404 / `PLAN_NOT_FOUND`；输入无效为 HTTP 400。

## 不可变快照与兼容

新版本位置为 `template_runs/plans/<planId>/<planVersionId>/`，创建 v1 时仅重新分配契约版本号；原始字段、检查规则保持不变。目录包含：

- `contract.json`、`approval.json`：v1 版本及其摘要、原确认人和确认时间。
- `source-contract.json`、`source-approval.json`：原确认契约与凭据的原始字节，用于核对来源；不重新序列化原证据。

文件采用排他创建并 flush，写入成功后提交数据库事务；事务失败删除本次生成的快照目录。进程在文件写完、数据库提交前崩溃，可能遗留未被引用的目录，但不会出现可见半成品 Plan。不会自动删除这些孤立证据。

旧 requirementsDigest 目录保持原样，现有强摘要复用仍读原目录。新增表采用 `CREATE IF NOT EXISTS`，旧运行无须回填；没有方案字段或绑定行即为 legacy run，读取返回 undefined，不猜测方案身份。

回滚采用恢复旧代码并保留新增表及版本目录；旧代码忽略它们，旧运行与旧契约不变。无需删除业务数据。停用可通过恢复接口撤回。

## Web API 与入口

| 动作 | API |
|---|---|
| 列表 / 空库 | `GET /api/plans`，bootstrap 同时返回 plans |
| 可归档契约与已知默认值 | `GET /api/plans/archive-options` |
| 归档 | `POST /api/plans`，body：requestId、requirementsDigest、name、supplier、docType |
| 详情与当前版本 | `GET /api/plans/:planId` |
| 改名 | `POST /api/plans/:planId/rename`，body：name |
| 停用 / 恢复 | `POST /api/plans/:planId/deactivate` / `restore` |

归档表单在契约确认成功后打开，也可从方案库进入。已知文件名、供应商、单证类型预填；未知值留空，不推断业务标签。取消表单不会提交。停用、恢复需要显式确认。响应丢失或格式无效时保留同一个归档 requestId 供重试。
