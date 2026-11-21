import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ArtifactStore, digest } from "./artifacts.js";
import { Ledger, type Usage } from "./ledger.js";
import type { Budget, RunManifest, ArtifactRef } from "./models.js";
import { executionDeadline } from "./execute.js";
import type { PlanLibrary } from "./plans.js";
import type { PlanSelection } from "./plan-types.js";
import type { StoredContract } from "./contract.js";
export class ClosureController {
  readonly ledger: Ledger;
  constructor(
    readonly store: ArtifactStore,
    readonly projectRoot: string,
    readonly budget: Budget,
  ) {
    this.ledger = new Ledger(resolve(store.root, "closure.sqlite"));
  }
  async startRun(
    sourcePath: string,
    interpretation: unknown,
    runDate: string,
    runYear: number,
    plan?: { library: PlanLibrary; selection: PlanSelection; requestId: string; conversationId: string; stored: StoredContract;
      context: {template:string;liveBudgetTask:string;parentRunId?:string} },
  ): Promise<RunManifest> {
    const source = await readFile(sourcePath),
      runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const input = await this.store.put(
      runId,
      `inputs/${basename(sourcePath)}`,
      source,
      "source",
    );
    const interpretationRef = await this.store.put(
      runId,
      "contract/working-interpretation.json",
      JSON.stringify({ interpretation, runDate, runYear }, null, 2),
      "working-interpretation",
    );
    const manifest: RunManifest = {
      runId,
      sourcePath: this.store.path(runId, input.relativePath),
      sourceSha256: digest(source),
      interpretationRef,
      status: "PREPARE",
      phase: "PREPARE",
      decision: "NONE",
      origin: process.env.PI_RUN_ORIGIN ?? "user",
      revision: 0,
      currentAttemptId: null,
      budget: this.budget,
      usage: {
        agentTurns: 0,
        attempts: 0,
        toolCalls: 0,
        externalActions: 0,
        inputTokens: 0,
        outputTokens: 0,
        startedAt: new Date().toISOString(),
      },
      attempts: [],
      actions: [],
      refs: { input, interpretation: interpretationRef },
      attemptStates: {},
      binding: {
        runDate,
        runYear,
        postprocess: "fields-v002",
        checker: "independent-v002",
      },
      noProgress: 0,
    };
    if (plan) {
      manifest.binding = {...manifest.binding,...plan.context};
      manifest.refs!.contract = await this.store.put(runId, "contract/contract.json", JSON.stringify(plan.stored.contract, null, 2), "contract");
      manifest.refs!.approval = await this.store.put(runId, "contract/approval.json", JSON.stringify(plan.stored.approval, null, 2), "contract-approval");
      plan.library.commitRun(this.ledger, manifest, plan.selection, plan.requestId, plan.conversationId);
    } else this.ledger.create(runId, manifest);
    await this.snapshot(manifest);
    return manifest;
  }
  async readManifest(runId: string): Promise<RunManifest> {
    const manifest = this.ledger.acquire(runId) as RunManifest;
    try {
      for (const ref of Object.values(manifest.refs ?? {}))
        await this.store.read(ref);
    } catch (error) {
      await this.stop(manifest, "BLOCKED", String(error));
      this.ledger.release(runId);
      throw error;
    }
    return manifest;
  }
  async action<T>(
    manifest: RunManifest,
    operation: string,
    input: unknown,
    usage: Usage,
    fn: () => Promise<T>,
    policy = "local_replayable",
  ): Promise<T> {
    const key = `${operation}:${digest(JSON.stringify(input))}`;
    const action = this.ledger.reserve(
      manifest.runId,
      key,
      operation,
      usage,
      manifest.budget,
      manifest.usage.startedAt,
      policy,
    );
    if (action.status === "COMPLETED") {
      await this.verifyRefs(action.result);
      return action.result as T;
    }
    if (action.status === "UNCERTAIN")
      throw new Error(
        "BLOCKED: uncertain paid action; reconcile receipt before retry",
      );
    try {
      const deadline =
        Date.parse(manifest.usage.startedAt) +
        manifest.budget.maxWallTimeSeconds * 1000;
      const attempt = manifest.currentAttemptId
        ? manifest.attemptStates?.[manifest.currentAttemptId]
        : undefined;
      const attemptDeadline =
        attempt?.startedAt &&
        ["extract", "post_process", "validate"].includes(operation)
          ? Date.parse(attempt.startedAt) +
            manifest.budget.maxAttemptTimeSeconds * 1000
          : Infinity;
      const result = await executionDeadline.run(
        Math.min(
          executionDeadline.getStore() ?? Infinity,
          deadline,
          attemptDeadline,
        ),
        fn,
      );
      this.ledger.transaction(() => {
        action.status = "COMPLETED";
        action.finishedAt = new Date().toISOString();
        action.actual = action.reserved;
        action.result = result;
        this.ledger.put(manifest.runId, action);
        this.persist(manifest);
      });
      await this.snapshot(manifest);
      return result;
    } catch (error) {
      action.status = policy === "never_auto_retry" ? "UNCERTAIN" : "FAILED";
      action.error = String(error);
      action.finishedAt = new Date().toISOString();
      this.ledger.put(manifest.runId, action);
      await this.snapshot(manifest);
      throw error;
    }
  }
  private async verifyRefs(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") return;
    const x = value as Record<string, unknown>;
    if (typeof x.artifactId === "string" && typeof x.sha256 === "string")
      await this.store.read(x as ArtifactRef);
    else for (const v of Object.values(x)) await this.verifyRefs(v);
  }
  persist(manifest: RunManifest): void {
    manifest.revision = (manifest.revision ?? 0) + 1;
    manifest.usage = {
      ...manifest.usage,
      ...this.ledger.totals(manifest.runId),
    };
    manifest.actions = this.ledger.list(manifest.runId).map((a) => ({
      actionId: a.id,
      operation: a.operation,
      inputDigest: a.key,
      status:
        a.status === "COMPLETED"
          ? "SUCCEEDED"
          : a.status === "REJECTED"
            ? "REJECTED"
            : a.status === "UNCERTAIN"
              ? "UNCERTAIN"
              : a.status === "FAILED"
                ? "FAILED"
                : "RESERVED",
      replaySafe: a.policy === "local_replayable",
      replayPolicy: a.policy,
      reserved: a.reserved,
      actualUsage: a.actual,
      error: a.error,
    }));
    this.ledger.save(manifest.runId, manifest);
  }
  async snapshot(manifest: RunManifest): Promise<void> {
    await this.store.snapshot(manifest.runId, "run_manifest.json", manifest);
  }
  async stop(
    manifest: RunManifest,
    decision: string,
    reason: string,
  ): Promise<void> {
    manifest.decision = decision;
    manifest.phase = "TERMINAL";
    manifest.status =
      decision === "REVIEW"
        ? "AWAITING_HUMAN_REVIEW"
        : (decision as RunManifest["status"]);
    manifest.binding = { ...manifest.binding, stopReason: reason, finishedAt: new Date().toISOString() };
    this.persist(manifest);
    await this.snapshot(manifest);
  }
  close(manifest?: RunManifest): void {
    if (manifest) this.ledger.release(manifest.runId);
    this.ledger.close();
  }
}
