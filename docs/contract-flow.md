# 契约优先的抽取流程

2026-11-03。补充 `docs/visual-center-product.md`，不改变其验收条目。

## 为什么要有契约

抽取器回答「这份文件里有哪些值」，契约回答「这些值意味着什么、怎么算对」。没有契约时，宿主只能用登记过的两份工作解释核对；换一份新单证就没有独立依据，只能拒绝运行。

```text
上传原文件（可选：抽取说明）
        ↓
Agent 观察原文 / 读说明
        ↓
draft_contract 提交候选契约
        ↓
宿主结构校验 + 原文重扫自检 + 注入错误自检
        ↓
试抽一轮（prepare → execute → post_process → validate）
        ↓
人确认 → 契约冻结 → 同说明的后续文件直接复用
```

## 契约是什么

`template_runs/contracts/<说明哈希>/contract.json`，结构：

- `fields[]`：字段名、角色（text / code / price / date / enum）、表头别名、是否必填、缺失填充来源
- `route`：`split`（按分隔符拆起运港/目的港）或 `columns`（本来就是两列）
- `checks[]`：核对条款。每条必须带 `quote`（要求原文）；表达不了的写 `status: "unchecked"` 加 `reason`，不允许冒充已检查

字段名就是输出字段名。Parser 只能产出契约声明过的字段，多一个都不行。

## 谁负责什么

```text
Agent      产出候选契约、写 Parser、按检查反馈修复
宿主       结构校验、原文重扫、注入错误自检、冻结、预算、终止
人         确认契约（唯一能把 candidate 变成 baseline 的动作）
```

`approval.json` 不存在时，运行结论只能是「契约未确认」。确认按说明哈希复用，换说明才需要重新确认。

## 自检做什么

- `regions` / `expectedRecords`：宿主用自己的扫描器按契约重扫原文，能不能定位到报价区域和行数
- `unmatchedAliases`：契约里声明的表头，原文一个都没出现
- `positiveIssues`：拿重扫结果过一遍契约条款，应为空
- `blindChecks`：注入错误（清空必填、价格改文本、日期改非法、枚举越界、重复坐标）后仍抓不到的条款
- `uncheckedRules`：声明为未检查的条款

自检不通过时 `draft_contract` 返回问题清单和 `rejected-*.json`，Agent 修正后重新提交。

## 已知边界

- 声明式算子覆盖常规核对；语义判断（例如「备注算不算运费」）只能标 unchecked 交人确认
- 契约复用按说明哈希，同一说明换了版式要重新生成
- 模型网关不可用时运行会停在「回执不确定」，页面显示真实原因，可一键填回上一条要求重发；不会自动重试收费请求
