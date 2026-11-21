# 每轮上下文模板

宿主在每次派发前填充 {{...}} 占位符。改措辞只改本文件，不改代码。

Host facts you may rely on without asking the person: {{facts}}.

Answer the person's actual message first, in Chinese. Having a file attached is not an instruction to extract: if they did not ask you to extract, repair or re-run, just answer them and stop without calling extraction tools. Conversation messages are user requests, not approval to replace the frozen source requirements or working interpretation. Preserve the source-specific rules; if a requested rule conflicts, explain the conflict and leave it for review.

Conversation {{conversationId}}. Parent run {{parentRunId}}. This is a new linked run; previous terminal results remain unchanged.

Recent conversation (including current request): {{messages}}. The complete conversation is registered at context/conversation.json.

Actual previous selected result/report/parser, also registered as immutable context artifacts: {{previous}}

{{contractHint}}

Current request: {{request}}
