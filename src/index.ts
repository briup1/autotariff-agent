import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createConfiguredModels } from "./models.js";
import { ClosureRuntime, createClosureExtension } from "./closure/runtime.js";
import { PROJECT_ROOT } from "./closure/paths.js";
import { LiveAudit } from "./closure/live-budget.js";
export type RunPiOptions = {
  requestId?: string;
  onAssistantText?: (text: string) => void | Promise<void>;
};
export async function runPi(
  runtime: ClosureRuntime,
  prompt: string,
  options: RunPiOptions = {},
): Promise<unknown> {
  if (runtime.manifest.phase === "TERMINAL")
    return {
      runId: runtime.manifest.runId,
      decision: runtime.manifest.decision,
    };
  const context = BACKGROUND_CONTEXT;
  let audit: LiveAudit | undefined;
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  let observation: { stop(): Promise<unknown> } | undefined;
  try {
    audit = new LiveAudit(runtime);
    const models = createConfiguredModels(runtime.config, audit),
      extension = createClosureExtension(runtime),
      registry = createRegistry();
    registry.install(extension);
    const storage = await openNodeSqliteStorage(
      resolve(runtime.store.root, runtime.manifest.runId, "pi.sqlite"),
    );
    harness = await Harness.open(storage, { models, registry }, context);
    const instructions = await readFile(
      runtime.config.systemPromptPath ??
        resolve(PROJECT_ROOT, "config/llm/system-prompt.md"),
      "utf8",
    );
    const root = await harness.root(context, {
      agent: {
        model: {
          provider: runtime.config.provider,
          modelId: runtime.config.modelId,
        },
        extensions: [extension],
        tools: extension.tools,
        modelTools: extension.tools,
        maxTurns: runtime.budget.maxAgentTurns,
        instructions,
      },
    });
    let flushAssistant: (() => Promise<void>) | undefined;
    if (options.onAssistantText) {
      const watch = await root.watch(context, { min: 200, max: 400 });
      observation = watch;
      const seen = new Set(watch.value.entries.map((entry) => entry.id));
      const publish = async (entries: typeof watch.value.entries): Promise<void> => {
        for (const entry of entries) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          for (const message of entry.model ?? []) {
            if (message.role !== "assistant") continue;
            const text = message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n").trim();
            if (text) await options.onAssistantText!(text);
          }
        }
      };
      watch.start(async (call) => {
        if (call.kind === "value") await publish(call.value.entries);
      });
      flushAssistant = () => publish(watch.value.entries);
    }
    const submission = await root.submit(
        {
          type: "input",
          requestId: options.requestId,
          content: `Run ${runtime.manifest.runId}. Initial registered artifacts: ${JSON.stringify(Object.values(runtime.manifest.refs ?? {}).map((r) => r.relativePath))}. ${prompt}`,
        },
        context,
      ),
      settled = await submission.wait(context);
    await flushAssistant?.();
    await runtime.save(`pi-settled-${Date.now()}.json`, settled, "pi-settled");
    const detail = "detail" in settled ? String(settled.detail) : "";
    if (settled.status !== "done" && !detail.includes("HOST_TERMINAL")) {
      if (
        detail.includes("Budget exhausted") ||
        ("reason" in settled && ["max_turns", "turn_limit"].includes(String(settled.reason)))
      ) {
        runtime.manifest.binding = { ...runtime.manifest.binding, modelStopReason: `Model budget exhausted: ${detail || ("reason" in settled ? settled.reason : "turn limit")}` };
        runtime.controller.persist(runtime.manifest);
        await runtime.controller.snapshot(runtime.manifest);
        if (runtime.attempt?.rawResult && !runtime.attempt.finalResult)
          await runtime.postprocess();
        if (runtime.attempt?.finalResult && !runtime.attempt.validation)
          await runtime.validate();
        if (runtime.manifest.phase !== "TERMINAL")
          await runtime.finish(`Model budget exhausted: ${detail}`);
      } else
        throw new Error(`Pi task did not finish: ${settled.status}; ${detail}`);
    }
    return {
      runId: runtime.manifest.runId,
      status: runtime.manifest.status,
      attempts: runtime.manifest.attempts,
      usage: runtime.manifest.usage,
    };
  } catch (error) {
    if (runtime.manifest.phase !== "TERMINAL")
      await runtime.controller.stop(runtime.manifest, "BLOCKED", String(error));
    await runtime.finalizeBest(String(error));
    throw error;
  } finally {
    await observation?.stop();
    await harness?.close(context);
    audit?.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(PROJECT_ROOT, "src/index.ts")
) {
  const runtime = new ClosureRuntime(loadConfig());
  try {
    await runtime.bootstrap(process.env.PI_RESUME_RUN);
    console.log(
      JSON.stringify(
        await runPi(
          runtime,
          process.argv.slice(2).join(" ") ||
            "Inspect this file, read the frozen working interpretation, choose the route, generate a complete parser and run the extraction, postprocess and independent validation. Repair with a new attempt when actionable issues remain.",
        ),
      ),
    );
  } finally {
    runtime.close();
  }
}
