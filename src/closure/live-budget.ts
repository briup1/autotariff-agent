import { resolve } from "node:path";
import { Ledger, type LedgerAction } from "./ledger.js";
import { PROJECT_ROOT, runsRootFor } from "./paths.js";
import type { ClosureRuntime } from "./runtime.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ArtifactRef, Budget } from "./models.js";
import { DEFAULT_BUDGET } from "./runtime.js";
import { digest } from "./artifacts.js";
export const VISUAL_TASK_ID = "visual-center-2026-11-03";
/** A provider that refuses the request outright produced no tokens, so the reservation is returned. */
export type ModelOutcome = "completed" | "uncertain" | "not_served";
export const providerRefused = (failure?: string): boolean =>
  Boolean(failure) &&
  /overloaded|over capacity|rate limit|too many requests|429|50[234]|service unavailable|temporarily unavailable/i.test(
    failure ?? "",
  );
export const VISUAL_TASK_POLICY: Budget = {
  ...DEFAULT_BUDGET,
  maxAttempts: 1000,
  maxAgentTurns: 1000,
  maxExternalActions: 1000,
  maxInputTokens: 100000000,
  maxOutputTokens: 6000000,
  maxWallTimeSeconds: 366 * 86400,
};
export class LiveAudit {
  readonly global: Ledger;
  readonly globalId: string;
  readonly startedAt = "2026-11-03T00:00:00+08:00";
  readonly policy: Budget = {
    ...DEFAULT_BUDGET,
    maxAttempts: 10,
    maxInputTokens: 1000000,
    maxOutputTokens: 300000,
    maxWallTimeSeconds: 366 * 86400,
    maxAgentTurns: 120,
    maxExternalActions: 160,
  };
  constructor(readonly runtime: ClosureRuntime) {
    const task = runtime.manifest.binding?.liveBudgetTask;
    if (task && ![VISUAL_TASK_ID, "all-batches-2026-11-03"].includes(String(task)))
      throw new Error("BLOCKED: unknown model budget authorization");
    this.globalId = task === VISUAL_TASK_ID ? VISUAL_TASK_ID : "all-batches-2026-11-03";
    if (this.globalId === VISUAL_TASK_ID) this.policy = { ...VISUAL_TASK_POLICY };
    this.global = new Ledger(
      resolve(runsRootFor(PROJECT_ROOT), "live-budget.sqlite"),
    );
    if (
      !this.global.db
        .prepare("SELECT id FROM runs WHERE id=?")
        .get(this.globalId)
    )
      this.global.create(this.globalId, {
        limits: this.policy,
        pricing: "unknown",
        providerInternalRetries: "unobservable; SDK retries disabled",
      });
    const key = `top:${runtime.manifest.runId}`;
    try {
      const a = this.global.reserve(
        this.globalId,
        key,
        "top_level_run",
        { attempts: 1 },
        this.policy,
        this.startedAt,
      );
      a.status = "COMPLETED";
      a.actual = { attempts: 1 };
      this.global.put(this.globalId, a);
    } catch (error) {
      this.global.close();
      throw error;
    }
  }
  async before(
    payload: unknown,
    requestId: string,
  ): Promise<{ local: LedgerAction; global: LedgerAction; requestId: string }> {
    const bytes = Buffer.byteLength(JSON.stringify(payload)),
      reservation = {
        agentTurns: 1,
        externalActions: 1,
        inputTokens: bytes + 1024,
        outputTokens: 6000,
      };
    const local = this.runtime.controller.ledger.reserve(
      this.runtime.manifest.runId,
      `model:${requestId}`,
      "model_request",
      reservation,
      this.runtime.manifest.budget,
      this.runtime.manifest.usage.startedAt,
      "never_auto_retry",
    );
    if (local.status !== "STARTED")
      throw new Error(
        "BLOCKED: paid model action is already completed or uncertain; do not redispatch",
      );
    let global: LedgerAction | undefined;
    try {
      global = this.global.reserve(
        this.globalId,
        `model:${this.runtime.manifest.runId}:${requestId}`,
        "model_request",
        reservation,
        this.policy,
        this.startedAt,
        "never_auto_retry",
      );
      if (global.status !== "STARTED")
        throw new Error(
          "BLOCKED: global model receipt already exists; do not redispatch",
        );
      await this.runtime.save(
        `model/${requestId}/request.json`,
        {
          requestId,
          payload,
          sdkRetries: 0,
          requestSha256: digest(JSON.stringify(payload)),
          cost: null,
        },
        "model-request",
      );
      return { local, global, requestId };
    } catch (error) {
      for (const [ledger, id, action] of [
        [this.runtime.controller.ledger, this.runtime.manifest.runId, local],
        [this.global, this.globalId, global],
      ] as const) {
        if (!action || action.status !== "STARTED") continue;
        action.status = "REJECTED";
        action.actual = {
          agentTurns: 0,
          externalActions: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        action.error = "Preflight rejected before dispatch: " + String(error);
        ledger.put(id, action);
      }
      throw error;
    }
  }
  async after(
    ticket: { local: LedgerAction; global: LedgerAction; requestId: string },
    response: AssistantMessage | undefined,
    complete: boolean,
    usageSeen: boolean,
    failure?: string,
  ): Promise<ModelOutcome> {
    const usage = response?.usage;
    const actual =
      complete && usageSeen && usage
        ? {
            agentTurns: 1,
            externalActions: 1,
            inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
            outputTokens: usage.output,
          }
        : undefined;
    const refused = !actual && !usageSeen && providerRefused(failure);
    const responseRef =
      actual && response
        ? await this.runtime.save(
            `model/${ticket.requestId}/response.json`,
            response,
            "model-response",
          )
        : undefined;
    await this.runtime.save(
      `model/${ticket.requestId}/receipt.json`,
      {
        requestId: ticket.requestId,
        status: actual ? "COMPLETED" : refused ? "REJECTED" : "UNCERTAIN",
        usage: actual ?? null,
        cost: null,
        providerInternalRetries: "unknown",
        sdkRetries: 0,
        responseRef,
        ...(actual ? {} : { complete, usageSeen, failure: failure ?? "no reason returned" }),
      },
      "model-receipt",
    );
    for (const [ledger, id, action] of [
      [
        this.runtime.controller.ledger,
        this.runtime.manifest.runId,
        ticket.local,
      ],
      [this.global, this.globalId, ticket.global],
    ] as const) {
      action.status = actual ? "COMPLETED" : refused ? "REJECTED" : "UNCERTAIN";
      if (actual) action.actual = actual;
      else if (refused) {
        action.actual = { agentTurns: 0, externalActions: 0, inputTokens: 0, outputTokens: 0 };
        action.error = `Provider refused the request without serving it: ${failure}`;
      } else
        action.error =
          "No complete provider usage receipt; reservation retained, no automatic retry";
      if (responseRef) action.result = { responseRef };
      ledger.put(id, action);
    }
    if (actual) {
      const binding = { ...this.runtime.manifest.binding };
      delete binding.lastModelFailure;
      delete binding.lastModelFailureAt;
      this.runtime.manifest.binding = binding;
    } else
      this.runtime.manifest.binding = {
        ...this.runtime.manifest.binding,
        lastModelFailure: failure ?? "provider usage receipt missing",
        lastModelFailureAt: new Date().toISOString(),
      };
    this.runtime.controller.persist(this.runtime.manifest);
    await this.runtime.controller.snapshot(this.runtime.manifest);
    // A refused request already returned its reservation; only an unknown receipt ends the run here.
    if (!actual && !refused)
      await this.runtime.controller.stop(
        this.runtime.manifest,
        "BLOCKED",
        "Uncertain model receipt; manual reconciliation required",
      );
    return actual ? "completed" : refused ? "not_served" : "uncertain";
  }
  async cached(requestId: string): Promise<AssistantMessage | undefined> {
    const local = this.runtime.controller.ledger.get(
      this.runtime.manifest.runId,
      `model:${requestId}`,
    );
    if (!local || local.status !== "COMPLETED") return;
    const ref = (local.result as { responseRef?: ArtifactRef })?.responseRef;
    if (!ref)
      throw new Error(
        "BLOCKED: completed model action has no response artifact",
      );
    const response = JSON.parse(
      (await this.runtime.store.read(ref)).toString(),
    ) as AssistantMessage;
    const global = this.global.get(
      this.globalId,
      `model:${this.runtime.manifest.runId}:${requestId}`,
    );
    if (global && global.status !== "COMPLETED") {
      global.status = "COMPLETED";
      global.actual = local.actual;
      global.result = local.result;
      this.global.put(this.globalId, global);
    }
    response.usage = {
      ...response.usage,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
    return response;
  }
  close(): void {
    this.global.close();
  }
}
