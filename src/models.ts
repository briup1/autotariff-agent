import {
  createModels,
  createProvider,
  envApiKeyAuth,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Model,
  type Models,
  type ProviderStreams,
  type StreamOptions,
  type TranscriptContext,
  type Api,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { RuntimeConfig } from "./config.js";
import type { LiveAudit } from "./closure/live-budget.js";
import { digest } from "./closure/artifacts.js";
import type { ClosureRuntime } from "./closure/runtime.js";

/** Trim transport context only; every original remains registered and readable by the model. */
export async function compactModelPayload(payload: unknown, runtime: ClosureRuntime): Promise<void> {
  const messages = (payload as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? [];
  let lastAssistant = -1;
  for (const [index, message] of messages.entries()) if (message.role === "assistant") lastAssistant = index;
  let changed = false;
  const regionsSeen = new Set<string>();
  const lastCopies = new Map<string, number>();
  for (const [index, message] of messages.entries())
    if (message.role === "tool" && typeof message.content === "string") lastCopies.set(digest(message.content), index);
  for (const [index, message] of messages.entries()) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(message.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {}
    const fullResponse = data.fullResponse as { relativePath?: string; sha256?: string } | undefined;
    if (fullResponse && Object.values(runtime.manifest.refs ?? {}).some(ref =>
      ref.relativePath === fullResponse.relativePath && ref.sha256 === fullResponse.sha256)) continue;
    const original = message.content;
    // Small receipts already carry the state needed by later turns.
    if (Buffer.byteLength(original) <= 1500) continue;
    const hash = digest(original);
    let evidence = original;
    try { evidence = JSON.stringify(JSON.parse(original), null, 2); } catch {}
    const ref = await runtime.save(`context/tool-results/${hash}.json`, evidence, "tool-evidence");
    runtime.manifest.refs![`tool-evidence-${hash}`] = ref;
    changed = true;
    const summary: Record<string, unknown> = {};
    for (const key of ["accepted", "error", "decision", "phase", "status", "nextCursor", "totalCells", "totalLines", "path", "sha256"])
      if (data?.[key] !== undefined) summary[key] = data[key];
    if (Array.isArray(data?.issues)) { summary.totalIssues = data.totalIssues ?? data.issues.length; summary.issues = data.issues.slice(0, 8); }
    const duplicate = lastCopies.get(hash) !== index;
    // Preserve one complete small evidence page: erasing it forces repeated reads on every turn.
    if (!duplicate && data?.path && Buffer.byteLength(original) <= 8000) continue;
    let view = data;
    if (typeof data.accepted === "boolean" && data.selfCheck && typeof data.selfCheck === "object") {
      const { contract: _contract, ...receipt } = data;
      const selfCheck = { ...data.selfCheck } as Record<string, unknown>;
      for (const key of ["issues", "scanIssues", "positiveIssues"]) {
        const issues = selfCheck[key];
        if (!Array.isArray(issues)) continue;
        const totalKey = key === "issues" ? "totalIssues" : `${key}Total`;
        if (selfCheck[totalKey] === undefined) {
          if (key === "issues" || issues.length > 8) selfCheck[totalKey] = issues.length;
          else selfCheck[`${key}SampleCount`] = issues.length;
        }
        selfCheck[key] = issues.slice(0, 8);
      }
      view = { ...receipt, selfCheck };
    }
    if (Array.isArray(data?.cells)) {
      const cells = data.cells;
      const first = index > lastAssistant ? 8 : 2, last = index > lastAssistant ? 4 : 2;
      view = { ...data, cells: [...cells.slice(0, first), ...cells.slice(Math.max(first, cells.length - last))].map((cell: Record<string, unknown>) => ({
        sourceId: cell.sourceId, row: cell.row, column: cell.column, value: cell.value,
        ...(cell.formula ? { formula: cell.formula } : {}),
        ...(cell.hiddenRow ? { hiddenRow: true } : {}), ...(cell.hiddenColumn ? { hiddenColumn: true } : {}),
        ...(cell.hiddenSheet ? { hiddenSheet: true } : {}), ...(cell.mergedRange ? { mergedRange: cell.mergedRange } : {}),
        style: cell.style, unsupported: cell.unsupported,
      })), omittedCells: Math.max(0, cells.length - first - last) };
      if (Array.isArray(data.regions)) {
        const key = digest(JSON.stringify(data.regions));
        if (regionsSeen.has(key)) delete view.regions;
        regionsSeen.add(key);
      }
      if (Array.isArray(data.artifacts)) view.artifacts = data.artifacts.filter((path: string) => !path.startsWith("context/tool-results/"));
    }
    if (Array.isArray(view?.issues) && view.issues.length > 8)
      view = { ...view, totalIssues: view.issues.length, issues: view.issues.slice(0, 8) };
    const current = JSON.stringify(view);
    if (!duplicate && Buffer.byteLength(current) <= 8000 && (index > lastAssistant || data?.cells || typeof data.accepted === "boolean")) {
      message.content = JSON.stringify({ ...view, contextExcerpt: true, fullResponse: ref }); continue;
    }
    if (!duplicate && index > lastAssistant)
      summary.excerpt = Buffer.from(original).subarray(0, 8000).toString("utf8");
    message.content = JSON.stringify({ ...summary, contextExcerpt: true, fullResponse: ref,
      readHint: "Use read_artifact with fullResponse.relativePath and line pagination for complete evidence." });
  }
  if (changed) {
    runtime.controller.persist(runtime.manifest);
    await runtime.controller.snapshot(runtime.manifest);
  }
}
export function createConfiguredModels(
  config: RuntimeConfig,
  audit: LiveAudit,
): Models {
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 6000,
  };
  const api = openAICompletionsApi();
  const REFUSED_RETRIES = Number(process.env.PI_REFUSED_RETRIES ?? 2);
  const REFUSED_RETRY_DELAY_MS = Number(process.env.PI_REFUSED_RETRY_DELAY_MS ?? 1500);
  class RefusedAttempt extends Error {}
  const stream =
    (simple: boolean) =>
    (m: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
      const out = createAssistantMessageEventStream();
      void (async () => {
        // A gateway that refuses the request served no tokens; retry those a bounded number of times.
        const maxAttempts = 1 + REFUSED_RETRIES;
        let failureText = "";
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let ticket: Awaited<ReturnType<LiveAudit["before"]>> | undefined,
          usageSeen = false,
          refused = false,
          audited = false,
          buffered: unknown[] = [];
        try {
          if (audit.runtime.manifest.phase === "TERMINAL")
            throw new Error("HOST_TERMINAL: model dispatch denied");
          const requestId = digest(
            JSON.stringify({ provider: m.provider, model: m.id, context, attempt }),
          );
          const cached = await audit.cached(requestId);
          if (cached) {
            if (
              cached.stopReason === "error" ||
              cached.stopReason === "aborted" ||
              cached.stopReason === "pending"
            )
              throw new Error("Invalid cached model completion");
            out.push({ type: "start", partial: cached });
            out.push({
              type: "done",
              reason: cached.stopReason,
              message: cached,
            });
            return;
          }
          const opts = {
            ...options,
            maxRetries: 0,
            maxTokens: 6000,
            timeoutMs: 120000,
            signal: AbortSignal.any([
              ...(options?.signal ? [options.signal] : []),
              AbortSignal.timeout(
                Math.max(
                  1,
                  Math.min(
                    150000,
                    Date.parse(audit.runtime.manifest.usage.startedAt) +
                      audit.runtime.manifest.budget.maxWallTimeSeconds * 1000 -
                      Date.now(),
                  ),
                ),
              ),
            ]),
            onPayload: async (payload: unknown) => {
              await compactModelPayload(payload, audit.runtime);
              ticket = await audit.before(payload, requestId);
              return payload;
            },
            onProviderStreamEvent: (event: unknown) => {
              const u = (event as { usage?: unknown })?.usage;
              if (u) usageSeen = true;
            },
          };
          const upstream = (simple ? api.streamSimple : api.stream)(
            m,
            context,
            opts,
          );
          for await (const event of upstream) {
            if (event.type === "done" || event.type === "error") {
              const result =
                event.type === "done" ? event.message : event.error;
              failureText =
                event.type === "error"
                  ? String((event.error as { errorMessage?: string })?.errorMessage ?? "stream error")
                  : "";
              if (audit && ticket) {
                audited = true;
                const outcome = await audit.after(
                  ticket,
                  result,
                  event.type === "done",
                  usageSeen,
                  event.type === "error" ? failureText : undefined,
                );
                if (outcome === "not_served") {
                  refused = true;
                  break;
                }
              }
            }
            buffered.push(event);
          }
          if (refused) throw new RefusedAttempt(failureText);
          for (const event of buffered) out.push(event as never);
          out.end();
          return;
        } catch (error) {
          if (audit && ticket && !audited && ticket.local.status === "STARTED") {
            audited = true;
            const outcome = await audit.after(
              ticket,
              undefined,
              false,
              false,
              String(error),
            );
            if (outcome === "not_served") {
              refused = true;
              failureText = String(error);
            }
          }
          if (refused) {
            if (attempt < maxAttempts - 1) {
              await new Promise((done) =>
                setTimeout(done, REFUSED_RETRY_DELAY_MS * (attempt + 1)),
              );
              continue;
            }
            const message = fauxAssistantMessage([]);
            message.stopReason = "error";
            message.errorMessage = failureText || String(error);
            out.push({ type: "error", reason: "error", error: message });
            out.end();
            return;
          }
          const message = fauxAssistantMessage([]);
          message.stopReason = "error";
          message.errorMessage = String(error);
          out.push({ type: "error", reason: "error", error: message });
          out.end();
          return;
        }
        }
      })();
      return out;
    };
  const wrapped: ProviderStreams = {
    stream: stream(false),
    streamSimple: stream(true),
  };
  const provider = createProvider({
    id: config.provider,
    name: "Configured gateway (cost unknown)",
    baseUrl: model.baseUrl,
    auth: { apiKey: envApiKeyAuth("Local gateway key", ["OPENAI_API_KEY"]) },
    models: [model],
    api: wrapped,
  });
  const models = createModels();
  models.setProvider(provider);
  return models;
}
