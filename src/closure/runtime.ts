import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str, num, opt, oneOf } from "@earendil-works/pi-schema";
import { ArtifactStore, digest, textDiff } from "./artifacts.js";
import { ClosureController } from "./controller.js";
import { executeParser } from "./execute.js";
import { inspectSource, inventoryPage } from "./source.js";
import {
  validateAttempt,
  detectPostProcessMutation,
  compareReports,
  compareResults,
  expectedFinal,
} from "./validation.js";
import { postProcess, postProcessContract } from "./postprocess.js";
import { exportRecords } from "./spreadsheet.js";
import { runContractChecks } from "./contract-checks.js";
import {
  contractKey,
  priceFields as contractPriceFields,
  emitFields,
  normalizeAlias,
  readStoredContract,
  requiredFields as contractRequiredFields,
  scanConfig,
  validateContract,
  writeStoredContract,
  type Contract,
  type StoredContract,
} from "./contract.js";
import { PROJECT_ROOT, PYTHON, runsRootFor } from "./paths.js";
import { scanExpected } from "./oracle.js";
import { TemplateRegistry } from "./registry.js";
import { workingProfile } from "./interpretation.js";
import {
  inspectDocument,
  convertDocument,
  type DocumentEvidence,
} from "./documents.js";
import type {
  Attempt,
  Budget,
  RunManifest,
  SourceInventory,
  ValidationReport,
  ArtifactRef,
} from "./models.js";
import type { RuntimeConfig } from "../config.js";
export const DEFAULT_BUDGET: Budget = {
  maxAgentTurns: 12,
  maxAttempts: 3,
  maxToolCalls: 40,
  maxExternalActions: 12,
  maxWallTimeSeconds: 1200,
  maxAttemptTimeSeconds: 360,
  maxInputTokens: 100000,
  maxOutputTokens: 30000,
  maxNoProgressAttempts: 2,
  maxSameActionRetries: 1,
};
export class ClosureRuntime {
  private readonly toolContext = new AsyncLocalStorage<boolean>();
  private get toolUsage(): { toolCalls: number } {
    return { toolCalls: this.toolContext.getStore() ? 0 : 1 };
  }
  async withToolCall<T>(
    name: string,
    args: unknown,
    callId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.controller.action(
      this.manifest,
      `tool:${name}`,
      { callId, argsDigest: digest(JSON.stringify(args)) },
      { toolCalls: 1 },
      () => this.toolContext.run(true, fn),
    );
  }
  readonly initialBudget: Budget;
  readonly controller: ClosureController;
  readonly pythonBin: string;
  readonly projectRoot: string;
  readonly runsRoot: string;
  manifest!: RunManifest;
  inventory!: SourceInventory;
  attempt!: Attempt;
  records: Record<string, unknown>[] = [];
  document?: DocumentEvidence;
  contract?: Contract;
  contractStored?: StoredContract;
  /** Monotonic counter for immutable contract evidence: a draft never overwrites an earlier one. */
  private contractRevisions = 0;
  constructor(
    readonly config: RuntimeConfig,
    initialBudget?: Budget,
    runsRoot?: string,
  ) {
    this.projectRoot = resolve(config.projectRoot ?? PROJECT_ROOT);
    this.runsRoot = resolve(runsRoot ?? runsRootFor(this.projectRoot));
    this.initialBudget =
      initialBudget ?? {
        ...DEFAULT_BUDGET,
        ...config.budget,
        ...(config.maxAgentTurns === undefined
          ? {}
          : { maxAgentTurns: config.maxAgentTurns }),
      } as Budget;
    this.pythonBin = resolve(PROJECT_ROOT, config.pythonBin || PYTHON);
    if (!this.pythonBin.startsWith(PROJECT_ROOT + "/"))
      throw new Error("Python environment must belong to the new project");
    this.controller = new ClosureController(
      new ArtifactStore(this.projectRoot),
      this.projectRoot,
      this.initialBudget,
    );
  }
  async bootstrap(runId?: string): Promise<void> {
    if (runId) {
      this.manifest = await this.controller.readManifest(runId);
      if (this.manifest.refs?.contract && this.manifest.binding?.contractStatus === "confirmed") {
        const ref = this.manifest.refs.contract;
        this.contract = JSON.parse((await this.store.read(ref)).toString()) as Contract;
        if (this.manifest.binding.planId) {
          const approval = this.manifest.refs.approval ? JSON.parse((await this.store.read(this.manifest.refs.approval)).toString()) : undefined;
          if (!approval || approval.contractSha256 !== ref.sha256 || approval.contractVersion !== this.contract.version ||
            approval.requirementsDigest !== this.contract.requirementsDigest || this.contract.version !== this.manifest.binding.contractVersion)
            throw new Error("Bound contract approval mismatch");
          this.contractStored = {contract:this.contract,approved:true,approval,directory:dirname(this.store.path(runId,ref.relativePath))};
        }
      }
      if (this.manifest.currentAttemptId)
        this.attempt =
          this.manifest.attemptStates![this.manifest.currentAttemptId];
      if (this.manifest.refs?.inventory)
        this.inventory = JSON.parse(
          (
            await this.controller.store.read(this.manifest.refs.inventory)
          ).toString(),
        );
      if (this.manifest.refs?.document)
        this.document = JSON.parse(
          (await this.store.read(this.manifest.refs.document)).toString(),
        );
      const pending = this.controller.ledger
        .list(runId)
        .filter(
          (a) =>
            a.policy === "never_auto_retry" &&
            ["STARTED", "UNCERTAIN"].includes(a.status),
        );
      if (pending.length) {
        for (const action of pending) {
          action.status = "UNCERTAIN";
          action.error =
            "Host restarted without complete paid receipt; manual reconciliation required";
          this.controller.ledger.put(runId, action);
        }
        await this.save(
          `recovery/uncertain-${Date.now()}.json`,
          pending,
          "uncertain-actions",
        );
        await this.controller.stop(
          this.manifest,
          "BLOCKED",
          "Uncertain paid action; no automatic retry",
        );
      }
      return;
    }
    if (
      ![".xlsx", ".pdf", ".docx", ".png", ".jpg", ".jpeg"].includes(
        extname(this.config.sourcePath).toLowerCase(),
      )
    )
      throw new Error("BLOCKED: unsupported source type; no input imported");
    if (
      this.config.requirementsPath &&
      ![".txt", ".md"].includes(
        extname(this.config.requirementsPath).toLowerCase(),
      )
    )
      throw new Error(
        "BLOCKED: requirements must be an explicit text document",
      );
    const sourceRequirements = this.config.requirementsPath
      ? await readFile(this.config.requirementsPath, "utf8")
      : undefined;
    // Contract-first runs treat a missing requirements file as an observed document.
    const interpretation =
      sourceRequirements === undefined && this.config.contractFirst
        ? {
            version: "contract-observed",
            sourceText: "",
            sourceRequirementsDigest: digest(""),
            clauses: [],
            unsupported: true,
          }
        : await workingProfile(sourceRequirements, this.config.runYear);
    this.manifest = await this.controller.startRun(
      resolve(this.projectRoot, this.config.sourcePath),
      interpretation,
      this.config.runDate,
      this.config.runYear,
    );
    if (this.config.requirementsPath)
      this.manifest.refs!.requirements = await this.save(
        "contract/source-requirements.txt",
        sourceRequirements!,
        "requirements",
      );
    this.manifest.binding = {
      ...this.manifest.binding,
      template: this.config.templateName ?? "controlled",
      interpretationVersion: interpretation.version,
      requirementsDigest:
        this.manifest.refs!.requirements?.sha256 ??
        this.manifest.interpretationRef.sha256,
      liveBudgetTask: this.config.liveBudgetTask ?? "all-batches-2026-11-03",
    };
    // Requirements text keys the contract when it exists; otherwise the source file identifies the document.
    const contractKeyDigest =
      this.manifest.refs!.requirements?.sha256 ??
      (this.config.contractFirst ? this.manifest.sourceSha256 : undefined);
    const stored = contractKeyDigest
      ? await readStoredContract(this.projectRoot, contractKeyDigest)
      : undefined;
    // Only a person's confirmation may bind a contract to a new run; a stale candidate must be re-drafted.
    if (stored && stored.approved) {
      this.contract = stored.contract;
      this.contractStored = stored;
      this.manifest.refs!.contract = await this.save(
        "contract/contract.json",
        stored.contract,
        "contract",
      );
      this.manifest.binding = {
        ...this.manifest.binding,
        contractVersion: stored.contract.version,
        contractStatus: stored.approved ? "confirmed" : "candidate",
        contractSha256: this.manifest.refs!.contract.sha256,
        ...(stored.approval ? { contractApprovedAt: stored.approval.approvedAt } : {}),
      };
    }
    const baseline = await new TemplateRegistry(this.store).current(
      String(this.manifest.binding.template),
    );
    if (baseline) {
      if (
        this.manifest.refs!.requirements &&
        baseline.requirements.sha256 !== this.manifest.refs!.requirements.sha256
      ) {
        const reason =
          "Source requirements changed; register a matching new template version";
        this.manifest.refs!.contractConflict = await this.save(
          "contract/conflict.json",
          {
            baseline: baseline.requirements,
            actual: this.manifest.refs!.requirements,
            baselineVersion: baseline.version,
          },
          "contract-conflict",
        );
        await this.controller.stop(this.manifest, "BLOCKED", reason);
        throw new Error(
          "BLOCKED: source requirements changed; register a matching new template version",
        );
      }
      this.manifest.binding = {
        ...this.manifest.binding,
        templateVersion: baseline.version,
        baselineParser: baseline.parser.sha256,
      };
      this.manifest.refs!.baselineParser = await this.store.put(
        this.manifest.runId,
        "contract/baseline-parser.py",
        await this.store.read(baseline.parser),
        "baseline-parser",
      );
      this.manifest.refs!.baselineRequirements = await this.store.put(
        this.manifest.runId,
        "contract/baseline-requirements.txt",
        await this.store.read(baseline.requirements),
        "requirements",
      );
    }
    if (interpretation.unsupported && !this.contract) {
      // No registered interpretation and no confirmed contract yet: the Agent must declare one.
      this.manifest.binding = {
        ...this.manifest.binding,
        contractRequired: true,
        contractStatus: "missing",
      };
      this.manifest.phase = "CONTRACT_PENDING";
      this.manifest.status = "CONTRACT_PENDING";
    } else if (interpretation.unsupported) {
      this.manifest.binding = {
        ...this.manifest.binding,
        contractRequired: true,
      };
    }
    this.controller.persist(this.manifest);
    await this.controller.snapshot(this.manifest);
  }
  get store(): ArtifactStore {
    return this.controller.store;
  }
  /** Independent re-scan shape: contract-driven when a contract exists, freight default otherwise. */
  get scanShape() {
    return this.contract ? scanConfig(this.contract) : undefined;
  }
  get contractConfirmed(): boolean {
    return Boolean(this.contractStored?.approved);
  }
  get budget(): Budget {
    return this.manifest?.budget ?? this.initialBudget;
  }
  async save(path: string, value: unknown, kind: string): Promise<ArtifactRef> {
    return this.store.put(
      this.manifest.runId,
      path,
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
      kind,
    );
  }
  async inspect(offset = 0, limit = 100, sheet = ""): Promise<unknown> {
    return this.controller.action(
      this.manifest,
      "inspect_page",
      { offset, limit, sheet },
      this.toolUsage,
      async () => {
        await this.controller.action(
          this.manifest,
          "inventory",
          { source: this.manifest.sourceSha256 },
          {},
          async () => {
            if (extname(this.manifest.sourcePath) === ".xlsx")
              this.inventory = await inspectSource(
                this.manifest.sourcePath,
                this.pythonBin,
              );
            else {
              this.document = await inspectDocument(
                this.manifest.sourcePath,
                this.pythonBin,
              );
              this.inventory = this.document.inventory;
              this.manifest.refs!.document = await this.save(
                "outputs/original-document.json",
                this.document,
                "original-document",
              );
            }
            this.manifest.refs!.inventory = await this.save(
              "outputs/source_inventory.json",
              this.inventory,
              "source-inventory",
            );
            const scan = scanExpected(this.inventory, this.scanShape);
            this.manifest.binding!.sourceExpectationDigest = digest(
              JSON.stringify(scan.records),
            );
            this.manifest.binding!.postExpectationDigest = digest(
              JSON.stringify(
                expectedFinal(
                  scan.records,
                  String(this.manifest.binding!.runDate),
                  Number(this.manifest.binding!.runYear),
                  this.contract,
                ),
              ),
            );
            this.manifest.refs!.regions = await this.save(
              "outputs/source_regions.json",
              {
                regions: scan.regions,
                dispositions: scan.dispositions,
                issues: scan.issues,
              },
              "source-regions",
            );
            this.manifest.status = "INVENTORIED";
            this.manifest.phase = "INVENTORIED";
            return this.manifest.refs!.inventory;
          },
        );
        return {
          regions: scanExpected(this.inventory, this.scanShape).regions,
          artifacts: Object.values(this.manifest.refs ?? {}).map(
            (r) => r.relativePath,
          ),
          originalText: this.document?.units.map((u) => ({
            unit: u.id,
            text: u.text.slice(0, 6000),
            truncated: u.text.length > 6000,
          })),
          ...(inventoryPage(this.inventory, offset, limit, sheet) as object),
        };
      },
    );
  }
  async prepare(
    parser: string,
    plan: Record<string, unknown> = {
      route: "excel_script",
      reason: "Agent selected",
    },
    reference?: ArtifactRef,
  ): Promise<unknown> {
    const route = String(plan.route ?? "excel_script");
    if (
      !["excel_script", "converted_excel_script", "direct_llm"].includes(route)
    )
      throw new Error(
        "Invalid extraction route; allowed: excel_script, converted_excel_script, direct_llm",
      );
    if (
      typeof parser !== "string" ||
      parser.length < 10 ||
      parser.length > 200000
    )
      throw new Error("Parser must be supplied by Agent");
    if (!plan.reason) throw new Error("Route requires a reason");
    if (!this.contract && this.manifest.binding?.contractRequired === true)
      throw new Error(
        "No contract is declared for this document yet; call draft_contract before prepare_attempt",
      );
    if (
      this.manifest.phase === "ATTEMPT_READY" &&
      this.attempt?.parser.sha256 === digest(parser)
    )
      return this.attempt;
    if (!["INVENTORIED", "REPAIR_PENDING"].includes(this.manifest.phase ?? ""))
      throw new Error("Invalid phase for preparing attempt");
    reference ??=
      this.manifest.phase === "REPAIR_PENDING"
        ? this.attempt?.parser
        : undefined;
    const input = {
      parser: digest(parser),
      plan,
      reference,
      parentAttempt: this.manifest.currentAttemptId,
    };
    return this.controller.action(
      this.manifest,
      "prepare_attempt",
      input,
      { ...this.toolUsage, attempts: 1 },
      async () => {
        const id = `attempt-${String(this.manifest.attempts.length + 1).padStart(3, "0")}`,
          parent = this.manifest.currentAttemptId;
        const feedback =
          parent && this.manifest.attemptStates![parent].validation
            ? [this.manifest.attemptStates![parent].validation!.relativePath]
            : parent && this.manifest.attemptStates![parent].failure
              ? [this.manifest.attemptStates![parent].failure!.relativePath]
              : [];
        const planRef = await this.save(
          `outputs/${id}/plan.json`,
          {
            ...plan,
            feedbackRefs: feedback,
            sourceSha256: this.manifest.sourceSha256,
            binding: this.manifest.binding,
            reference,
          },
          "plan",
        );
        if (reference) {
          const original = (await this.store.read(reference)).toString();
          this.manifest.refs![`${id}-reference`] = await this.save(
            `outputs/${id}/reference.py`,
            original,
            "reference-parser",
          );
          this.manifest.refs![`${id}-diff`] = await this.save(
            `outputs/${id}/diff.json`,
            {
              from: reference.sha256,
              to: digest(parser),
              ...textDiff(original, parser),
            },
            "script-diff",
          );
        }
        const parserRef = await this.save(
          `outputs/${id}/${route === "direct_llm" ? "direct_response.json" : "parser.py"}`,
          parser,
          route === "direct_llm" ? "model-direct-response" : "parser",
        );
        this.attempt = {
          attemptId: id,
          parentAttemptId: parent,
          status: "READY",
          plan: planRef,
          parser: parserRef,
          inputSnapshotSha256: this.manifest.sourceSha256,
          route: route as Attempt["route"],
          feedbackRefs: feedback,
          startedAt: new Date().toISOString(),
        };
        this.manifest.attemptStates![id] = this.attempt;
        this.manifest.attempts.push(id);
        this.manifest.currentAttemptId = id;
        this.manifest.phase = "ATTEMPT_READY";
        this.manifest.status = "ATTEMPT_READY";
        return this.attempt;
      },
    );
  }
  async execute(): Promise<unknown> {
    if (!this.attempt) throw new Error("No attempt prepared");
    const attempt = this.attempt;
    let result: unknown;
    try {
      result = await this.controller.action(
        this.manifest,
        "extract",
        { attempt: attempt.attemptId, parser: attempt.parser.sha256 },
        { ...this.toolUsage, externalActions: 1 },
        async () => {
          await this.store.read(attempt.parser);
          await this.store.read(this.manifest.refs!.input);
          const parserPath = this.store.path(
              this.manifest.runId,
              attempt.parser.relativePath,
            ),
            outputPath = this.store.path(
              this.manifest.runId,
              `outputs/${attempt.attemptId}/candidate.json`,
            );
          if (attempt.route === "direct_llm") {
            const direct: unknown = JSON.parse(
              (await this.store.read(attempt.parser)).toString(),
            );
            if (
              !Array.isArray(direct) ||
              direct.some(
                (r) => !r || typeof r !== "object" || Array.isArray(r),
              )
            )
              throw new Error("Direct extraction must be an array of records");
            this.records = direct;
          } else {
            const source =
              attempt.route === "converted_excel_script"
                ? this.manifest.refs!.converted
                  ? this.store.path(
                      this.manifest.runId,
                      this.manifest.refs!.converted.relativePath,
                    )
                  : ""
                : this.manifest.sourcePath;
            if (!source)
              throw new Error(
                "Conversion required before converted script execution",
              );
            if (attempt.route === "converted_excel_script") {
              const ref = this.manifest.refs!.converted;
              await this.store.read(ref);
              const inventory = await inspectSource(source, this.pythonBin);
              const check = compareResults(
                "conversion",
                scanExpected(inventory).records,
                scanExpected(this.inventory).records,
                "source-conversion-v001",
              );
              check.issues = check.issues.map((i) => ({
                ...i,
                stage: "conversion",
              }));
              this.manifest.refs!.conversionCheck = await this.save(
                `outputs/conversion-check-${ref.sha256}.json`,
                check,
                "conversion-report",
              );
            }
            this.records = await executeParser(
              this.pythonBin,
              parserPath,
              source,
              outputPath,
              {
                provider: "macos_sandbox",
                network: "disabled",
                readRoots: [parserPath, source],
                writeRoots: [resolve(outputPath, "..")],
                timeoutSeconds: Math.max(
                  0.01,
                  this.budget.maxAttemptTimeSeconds -
                    (Date.now() - Date.parse(attempt.startedAt!)) / 1000,
                ),
              },
            );
          }
          attempt.rawResult = await this.save(
            `outputs/${attempt.attemptId}/raw_result.json`,
            this.records,
            "raw-result",
          );
          const action = this.controller.ledger
            .list(this.manifest.runId)
            .filter((a) => a.operation === "extract" && a.status === "STARTED")
            .at(-1)!;
          attempt.executionReceipt = await this.save(
            `outputs/${attempt.attemptId}/execution-receipt-${action.id}-${action.retries}.json`,
            {
              actionId: action.id,
              route: attempt.route,
              scriptSha256: attempt.parser.sha256,
              inputSha256: this.manifest.sourceSha256,
              rawResult: attempt.rawResult,
              hostPid: process.pid,
              startedAt: action.startedAt,
              finishedAt: new Date().toISOString(),
              exitCode: attempt.route === "direct_llm" ? null : 0,
              isolation:
                attempt.route === "direct_llm"
                  ? "host-validated model JSON"
                  : "macos_sandbox, no network, only current input and scratch writes",
            },
            "execution-receipt",
          );
          attempt.rawCommitted = true;
          attempt.status = "EXECUTED";
          this.manifest.phase = "EXTRACTED";
          this.manifest.status = "RUNNING";
          return {
            attemptId: attempt.attemptId,
            records: this.records.length,
            rawResult: attempt.rawResult,
          };
        },
      );
    } catch (error) {
      attempt.status = "FAILED";
      attempt.failure = await this.save(
        `outputs/${attempt.attemptId}/execution-failure-${Date.now()}.json`,
        {
          stage: "extraction",
          error: String(error),
          script: attempt.parser,
          sourceSha256: this.manifest.sourceSha256,
        },
        "execution-failure",
      );
      if (String(error).includes("BLOCKED"))
        await this.controller.stop(this.manifest, "BLOCKED", String(error));
      else {
        this.manifest.phase = "REPAIR_PENDING";
        this.manifest.status = "REPAIR_PENDING";
        this.controller.persist(this.manifest);
        await this.controller.snapshot(this.manifest);
      }
      throw error;
    }
    this.crash("after-extract");
    return result;
  }
  async postprocess(): Promise<unknown> {
    if (!this.attempt.rawResult) throw new Error("Extraction not committed");
    return this.controller.action(
      this.manifest,
      "post_process",
      {
        attempt: this.attempt.attemptId,
        raw: this.attempt.rawResult.sha256,
        version: this.manifest.binding?.postprocess,
      },
      this.toolUsage,
      async () => {
        const raw = JSON.parse(
          (await this.store.read(this.attempt.rawResult!)).toString(),
        ) as Record<string, unknown>[];
        const date = String(this.manifest.binding!.runDate),
          year = Number(this.manifest.binding!.runYear),
          final = this.contract
            ? postProcessContract(raw, this.contract, date, year)
            : postProcess(raw, date, year);
        this.attempt.finalResult = await this.save(
          `outputs/${this.attempt.attemptId}/final_result.json`,
          final,
          "final-result",
        );
        await this.exportWorkbook(this.attempt, final);
        this.manifest.phase = "POSTPROCESSED";
        return this.attempt.finalResult;
      },
    );
  }
  /** Same immutable records as the JSON result, written as a real .xlsx for download. */
  private async exportWorkbook(
    attempt: Attempt,
    rows: unknown[],
  ): Promise<void> {
    if (attempt.resultXlsx) return;
    try {
      const bytes = await exportRecords(this.pythonBin, rows);
      attempt.resultXlsx = await this.store.put(
        this.manifest.runId,
        `outputs/${attempt.attemptId}/result.xlsx`,
        bytes,
        "result-xlsx",
      );
    } catch (error) {
      this.manifest.binding = {
        ...this.manifest.binding,
        exportError: String(error),
      };
    }
  }
  /**
   * Terminal fallback: whatever the best available output is, make it downloadable before the run ends.
   * Local and deterministic, so it never reserves model budget and never throws.
   */
  async finalizeBest(reason: string): Promise<void> {
    if (!this.manifest) return;
    try {
      const date = String(this.manifest.binding?.runDate ?? "");
      const year = Number(this.manifest.binding?.runYear ?? date.slice(0, 4));
      for (const attempt of Object.values(this.manifest.attemptStates ?? {})) {
        try {
          if (!attempt.finalResult && attempt.rawResult) {
            const raw = JSON.parse(
              (await this.store.read(attempt.rawResult)).toString(),
            ) as Record<string, unknown>[];
            const final = this.contract
              ? postProcessContract(raw, this.contract, date, year)
              : postProcess(raw, date, year);
            attempt.finalResult = await this.store.put(
              this.manifest.runId,
              `outputs/${attempt.attemptId}/final_result.json`,
              JSON.stringify(final, null, 2),
              "final-result",
            );
            if (attempt.status === "READY") attempt.status = "EXECUTED";
          }
          if (attempt.finalResult) {
            const rows = JSON.parse(
              (await this.store.read(attempt.finalResult)).toString(),
            ) as unknown[];
            await this.exportWorkbook(attempt, rows);
          }
        } catch (error) {
          this.manifest.binding = {
            ...this.manifest.binding,
            [`finalize-${attempt.attemptId}`]: String(error),
          };
        }
      }
      this.manifest.binding = {
        ...this.manifest.binding,
        finalizedReason: reason,
        finalizedAt: new Date().toISOString(),
      };
      this.controller.persist(this.manifest);
      await this.controller.snapshot(this.manifest);
    } catch (error) {
      try {
        this.manifest.binding = {
          ...this.manifest.binding,
          finalizeError: String(error),
        };
        this.controller.persist(this.manifest);
      } catch {}
    }
  }
  async validate(): Promise<ValidationReport> {
    this.crash("before-validate");
    if (!this.attempt.finalResult)
      throw new Error("Post-processing not committed");
    let report: ValidationReport;
    try {
      report = await this.controller.action(
        this.manifest,
        "validate",
        {
          attempt: this.attempt.attemptId,
          final: this.attempt.finalResult.sha256,
        },
        this.toolUsage,
        async () => {
          // Reopen the original input; do not trust cached candidate inventory or coverage claims.
          const doc =
            extname(this.manifest.sourcePath) === ".xlsx"
              ? undefined
              : await inspectDocument(this.manifest.sourcePath, this.pythonBin);
          const inventory =
            doc?.inventory ??
            (await inspectSource(this.manifest.sourcePath, this.pythonBin));
          const sourceExpectation = scanExpected(
            inventory,
            this.scanShape,
          ).records;
          const rawDigest = digest(JSON.stringify(sourceExpectation)),
            postDigest = digest(
              JSON.stringify(
                expectedFinal(
                  sourceExpectation,
                  String(this.manifest.binding!.runDate),
                  Number(this.manifest.binding!.runYear),
                  this.contract,
                ),
              ),
            );
          if (
            (this.manifest.binding?.sourceExpectationDigest &&
              this.manifest.binding.sourceExpectationDigest !== rawDigest) ||
            (this.manifest.binding?.postExpectationDigest &&
              this.manifest.binding.postExpectationDigest !== postDigest)
          )
            throw new Error(
              `SOURCE_EXPECTATION_DRIFT: actual raw ${rawDigest}, actual normalized ${postDigest}; frozen basis cannot change with candidate results`,
            );
          const raw = JSON.parse(
            (await this.store.read(this.attempt.rawResult!)).toString(),
          ) as Record<string, unknown>[];
          const final = JSON.parse(
            (await this.store.read(this.attempt.finalResult!)).toString(),
          ) as Record<string, unknown>[];
          const checked = validateAttempt(
            this.attempt,
            raw,
            inventory,
            String(
              this.manifest.binding?.interpretationVersion ??
                "yishengchang-v002",
            ),
            Number(this.manifest.binding!.runYear),
            this.contract,
          );
          const post = detectPostProcessMutation(
            this.attempt.attemptId,
            raw,
            final,
            String(
              this.manifest.binding?.interpretationVersion ??
                "yishengchang-v002",
            ),
            String(this.manifest.binding!.runDate),
            Number(this.manifest.binding!.runYear),
            this.contract,
          );
          checked.issues.push(...post.issues);
          if (post.issues.length) checked.status = "FAIL";
          checked.checkedRuleIds.push(
            ...(this.contract
              ? ["postprocess:contract", "validity"]
              : ["postprocess:fields-v002", "validity", "negative-price-preservation"]),
          );
          if (
            doc?.warnings.some(
              (w) =>
                w.code === "UNMAPPED_ORIGINAL_TEXT" ||
                w.code === "IMAGE_ONLY_PDF",
            )
          ) {
            checked.status = "BLOCKED";
            checked.issues.push({
              issueId: "ORIGINAL_COVERAGE_GAP",
              code: "ORIGINAL_COVERAGE_GAP",
              stage: "conversion",
              sourceIds: doc.warnings.map((w) => w.unit),
              resultIds: [],
              message: "Original content has no verified structured coverage",
            });
          }
          if (
            this.attempt.route === "converted_excel_script" &&
            this.manifest.refs!.conversionCheck
          ) {
            const conversion = JSON.parse(
              (
                await this.store.read(this.manifest.refs!.conversionCheck)
              ).toString(),
            ) as ValidationReport;
            checked.issues.push(...conversion.issues);
            if (conversion.issues.length) checked.status = "FAIL";
          }
          const interpretation = JSON.parse(
            (await this.store.read(this.manifest.interpretationRef)).toString(),
          ).interpretation as {
            clauses: Array<{ id: string; checker?: string }>;
          };
          const clauses = this.contract
            ? interpretation.clauses.filter(
                (clause) => clause.id !== "UNMAPPED_REQUIREMENTS",
              )
            : interpretation.clauses;
          for (const clause of clauses) {
            if (checked.checkedRuleIds.includes(clause.checker ?? clause.id))
              checked.checkedRuleIds.push(clause.id);
            else {
              checked.unresolvedRuleIds.push(clause.id);
              checked.issues.push({
                issueId: `UNCHECKED_REQUIREMENT:${clause.id}`,
                code: "UNCHECKED_REQUIREMENT",
                stage: "validation",
                sourceIds: [],
                resultIds: [],
                message: `No independent check for required clause ${clause.id}`,
              });
              checked.status = "BLOCKED";
            }
          }
          this.attempt.validation = await this.save(
            `validation/${this.attempt.attemptId}/report.json`,
            checked,
            "validation-report",
          );
          this.attempt.status = "VALIDATED";
          this.manifest.phase = checked.issues.length
            ? "REPAIR_PENDING"
            : "VALIDATED";
          this.manifest.status = checked.issues.length
            ? "REPAIR_PENDING"
            : "VALIDATED";
          if (this.attempt.parentAttemptId) {
            const parent =
              this.manifest.attemptStates![this.attempt.parentAttemptId];
            if (parent.validation) {
              const before = JSON.parse(
                (await this.store.read(parent.validation)).toString(),
              ) as ValidationReport;
              await this.save(
                `validation/${this.attempt.attemptId}/comparison.json`,
                compareReports(before, checked),
                "comparison",
              );
              this.manifest.noProgress =
                checked.issues.length >= before.issues.length
                  ? (this.manifest.noProgress ?? 0) + 1
                  : 0;
            }
          }
          return checked;
        },
      );
    } catch (error) {
      const failure: ValidationReport = {
        attemptId: this.attempt.attemptId,
        status: "BLOCKED",
        issues: [
          {
            issueId: "CHECKER_FAILED",
            code: String(error).includes("SOURCE_EXPECTATION_DRIFT")
              ? "SOURCE_EXPECTATION_DRIFT"
              : "CHECKER_FAILED",
            stage: "validation",
            sourceIds: [],
            resultIds: [],
            expected: { value: "unknown; checker unavailable" },
            actual: { error: String(error) },
            message:
              "Independent checking failed; no success decision permitted",
          },
        ],
        checkedRuleIds: [],
        unresolvedRuleIds: ["source-coverage", "all-required-fields"],
        generatedFromInterpretation: String(
          this.manifest.binding?.interpretationVersion ?? "yishengchang-v002",
        ),
      };
      this.attempt.validation = await this.save(
        `validation/${this.attempt.attemptId}/checker-failure-${Date.now()}.json`,
        failure,
        "validation-report",
      );
      await this.controller.stop(this.manifest, "BLOCKED", String(error));
      return failure;
    }
    this.crash("after-validate");
    // Bound-plan findings go to a person; checker exceptions already returned BLOCKED above.
    if (this.manifest.binding?.planId && report.issues.length)
      await this.finish("复用方案的独立检查发现异常，版式可能变化；请人工复核原文、预期与实际值，规则变化须人工创建新版本。");
    else if (report.status === "BLOCKED")
      await this.controller.stop(
        this.manifest,
        "BLOCKED",
        "Independent checker cannot establish coverage",
      );
    else if (!report.issues.length)
      await this.finish(
        "Working interpretation consistent; independent business approval missing",
      );
    else if (
      (this.manifest.noProgress ?? 0) >= this.budget.maxNoProgressAttempts
    )
      await this.finish("No progress in consecutive attempts");
    return report;
  }
  /**
   * Declare what this document means. Structural errors are returned, never silently accepted.
   * The host then re-scans the source with the draft so a wrong contract is visible immediately.
   */
  async draftContract(input: {
    contract: string;
    requirements?: string;
    source?: "uploaded" | "observed";
  }): Promise<unknown> {
    if (this.manifest.binding?.planId) throw new Error("已绑定方案版本；规则变更必须人工创建新版本，不能在本次运行中改写。");
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.contract);
    } catch (error) {
      throw new Error(`Contract must be JSON: ${String(error)}`);
    }
    const { contract, issues } = validateContract(parsed);
    if (issues.length) {
      // Keep rejected drafts: a failure the user cannot inspect cannot be corrected later.
      const rejected = await this.save(
        `contract/rejected-${++this.contractRevisions}.json`,
        { issues, draft: parsed },
        "contract-candidate",
      );
      this.manifest.refs![`rejected-${this.contractRevisions}`] = rejected;
      this.controller.persist(this.manifest);
      return {
        accepted: false,
        issues,
        rejectedAt: rejected.relativePath,
        hint: "Fix the listed issues and draft again.",
      };
    }
    if (!this.inventory)
      throw new Error("Call inspect_source before drafting a contract");
    // An uploaded requirements file is frozen: the Agent may never replace it by drafting again.
    const uploaded = this.manifest.refs!.requirements;
    const requirementsText = uploaded
      ? (await this.store.read(uploaded)).toString()
      : input.requirements;
    if (!uploaded && input.requirements) {
      // Agent-provided requirements are evidence: immutable, and never overwriting an earlier draft.
      const path =
        this.manifest.refs!.observedRequirements
          ? `contract/observed-requirements-${digest(input.requirements).slice(0, 8)}.txt`
          : "contract/observed-requirements.txt";
      this.manifest.refs!.observedRequirements = await this.save(
        path,
        input.requirements,
        "requirements",
      );
    }
    const digestValue =
      this.manifest.refs!.requirements?.sha256 ?? this.manifest.sourceSha256;
    const drafted: Contract = {
      ...contract,
      requirementsDigest: digestValue,
      requirementsSource:
        input.source === "observed" || !requirementsText ? "observed" : "uploaded",
    };
    const stored = await writeStoredContract(this.projectRoot, drafted);
    this.contract = drafted;
    this.contractStored = stored;
    const revision = ++this.contractRevisions;
    this.manifest.refs!.contract = await this.save(
      `contract/drafts/contract-${revision}.json`,
      drafted,
      "contract",
    );
    this.manifest.refs![`contract-draft-${revision}`] = this.manifest.refs!.contract;
    this.manifest.binding = {
      ...this.manifest.binding,
      contractVersion: drafted.version,
      contractStatus: stored.approved ? "confirmed" : "candidate",
      requirementsDigest: digestValue,
      contractDigest: digestValue,
      contractSha256: this.manifest.refs!.contract.sha256,
    };
    // The declared contract IS the frozen basis: re-freeze it now so later attempt results cannot move it.
    const frozen = scanExpected(this.inventory, scanConfig(drafted)).records;
    this.manifest.binding = {
      ...this.manifest.binding,
      sourceExpectationDigest: digest(JSON.stringify(frozen)),
      postExpectationDigest: digest(
        JSON.stringify(
          expectedFinal(
            frozen,
            String(this.manifest.binding!.runDate),
            Number(this.manifest.binding!.runYear),
            drafted,
          ),
        ),
      ),
      expectationFrozenAt: "contract-declared",
    };
    const selfCheck = this.selfCheckContract(drafted);
    this.manifest.refs!.contractSelfCheck = await this.save(
      `contract/drafts/self-check-${revision}.json`,
      selfCheck,
      "contract-self-check",
    );
    this.controller.persist(this.manifest);
    await this.controller.snapshot(this.manifest);
    return { accepted: true, contract: drafted, selfCheck };
  }
  private selfCheckContract(contract: Contract) {
    const scan = scanExpected(this.inventory, scanConfig(contract)),
      date = String(this.manifest.binding!.runDate),
      year = Number(this.manifest.binding!.runYear),
      expected = postProcessContract(scan.records, contract, date, year),
      positive = runContractChecks(contract, expected);
    const headerText = new Set(
      this.inventory.cells
        .map((cell) => normalizeAlias(cell.value))
        .filter(Boolean),
    );
    const unmatched = emitFields(contract)
      .filter((field) => (field.source?.kind ?? "column") === "column")
      .filter(
        (field) =>
          !(field.aliases ?? []).some((alias) => headerText.has(normalizeAlias(alias))),
      )
      .map((field) => field.name);
    const caught = new Map<string, number>();
    const mutations: Array<[string, Record<string, unknown>[]]> = [];
    const sample = expected[0];
    if (sample) {
      const required = contractRequiredFields(contract);
      if (required.length) {
        const blank = { ...sample };
        for (const field of required) blank[field] = null;
        mutations.push(["清空必填字段", [blank, ...expected.slice(1)]]);
      }
      const prices = contractPriceFields(contract);
      if (prices.length) {
        const broken = { ...sample };
        for (const field of prices) broken[field] = "not-a-number";
        mutations.push(["价格改成非数值", [broken, ...expected.slice(1)]]);
      }
      const dates = contract.fields.filter((field) => field.role === "date").map((field) => field.name);
      if (dates.length) {
        const broken = { ...sample };
        for (const field of dates) broken[field] = "not-a-date";
        mutations.push(["日期改成不可解析", [broken, ...expected.slice(1)]]);
      }
      const enumerated = contract.fields.filter((field) => field.role === "enum").map((field) => field.name);
      if (enumerated.length) {
        const broken = { ...sample };
        for (const field of enumerated) broken[field] = "__NOT_ALLOWED__";
        mutations.push(["枚举值越界", [broken, ...expected.slice(1)]]);
      }
      if (contract.checks.some((check) => check.kind === "unique_source_ids")) {
        mutations.push(["重复原文坐标", [sample, ...expected.slice(0, 1), ...expected.slice(1)]]);
      }
    }
    for (const [, rows] of mutations)
      for (const issue of runContractChecks(contract, rows).issues)
        caught.set(issue.issueId, 1);
    const caughtIds = new Set(
      [...caught.keys()].map((id) => id.split(":")[0]),
    );
    const blind = contract.checks
      .filter((check) => check.status !== "unchecked")
      .filter((check) => !["source_coverage", "join_order"].includes(check.kind))
      .filter((check) => !caughtIds.has(check.id))
      .map((check) => check.id);
    return {
      contractVersion: contract.version,
      required: this.manifest.binding?.contractRequired === true,
      approved: Boolean(this.contractStored?.approved),
      regions: scan.regions.length,
      expectedRecords: expected.length,
      scanIssues: scan.issues.slice(0, 8),
      scanIssuesTotal: scan.issues.length,
      unmatchedAliases: unmatched,
      positiveIssues: positive.issues.slice(0, 8),
      positiveIssuesTotal: positive.issues.length,
      checkedRules: positive.checkedRuleIds,
      uncheckedRules: positive.unchecked,
      blindChecks: blind,
      mutations: mutations.map(([name]) => name),
      expectedSample: expected.slice(0, 3),
    };
  }
  async readContract(): Promise<unknown> {
    return {
      contract: this.contract ?? null,
      status:
        this.manifest.binding?.contractStatus ??
        (this.contract ? "candidate" : "missing"),
      approved: Boolean(this.contractStored?.approved),
      required: this.manifest.binding?.contractRequired === true,
    };
  }

  /** A conversational turn: the Agent answered, no extraction was requested or attempted. */
  async answer(reason: string): Promise<unknown> {
    const record = await this.save(
      "answer.json",
      { runId: this.manifest.runId, reason, attempts: 0, businessApproval: false },
      "answer",
    );
    this.manifest.refs!.answer = record;
    await this.controller.stop(this.manifest, "ANSWERED", reason);
    return { decision: this.manifest.decision, answer: record };
  }
  async finish(reason = "Agent requested review"): Promise<unknown> {
    await this.finalizeBest(reason);
    const packet = await this.save(
      "review_packet.json",
      {
        runId: this.manifest.runId,
        attempt: this.manifest.currentAttemptId,
        reason,
        businessApproval: false,
        accuracy: null,
        cost: null,
      },
      "review",
    );
    this.manifest.refs!.review = packet;
    await this.controller.stop(this.manifest, "REVIEW", reason);
    return { decision: this.manifest.decision, review: packet };
  }
  async readArtifact(path: string, offset = 0, limit = 100): Promise<unknown> {
    return this.controller.action(
      this.manifest,
      "read_artifact",
      { path, offset, limit },
      this.toolUsage,
      async () => {
        if (!Number.isFinite(offset) || !Number.isFinite(limit))
          throw new Error(
            "Artifact page bounds must be numbers: offset >= 0 and limit between 1 and 500",
          );
        offset = Math.max(0, Math.trunc(offset));
        limit = Math.min(500, Math.max(1, Math.trunc(limit)));
        const refs = [
          ...Object.values(this.manifest.refs ?? {}),
          this.manifest.interpretationRef,
          ...Object.values(this.manifest.attemptStates ?? {}).flatMap((a) =>
            [
              a.parser,
              a.plan,
              a.rawResult,
              a.finalResult,
              a.validation,
              a.failure,
              a.executionReceipt,
            ].filter((r): r is ArtifactRef => !!r),
          ),
        ];
        const ref = refs.find((r) => r.relativePath === path);
        if (!ref) throw new Error("Artifact not registered to this run");
        const bytes = await this.store.read(ref);
        const lines = bytes.toString().split("\n");
        return {
          path,
          sha256: ref.sha256,
          totalLines: lines.length,
          text: lines.slice(offset, offset + limit).join("\n"),
          nextCursor: offset + limit < lines.length ? offset + limit : null,
          truncated: offset + limit < lines.length,
        };
      },
    );
  }
  async findSolutions(): Promise<unknown> {
    return this.controller.action(
      this.manifest,
      "find_solutions",
      { template: this.manifest.binding!.template },
      this.toolUsage,
      () =>
        new TemplateRegistry(this.store).find(
          String(this.manifest.binding!.template),
          this.inventory,
        ),
    );
  }
  async readSolution(version: string): Promise<unknown> {
    return this.controller.action(
      this.manifest,
      "read_solution",
      { version },
      this.toolUsage,
      async () => {
        const v = await new TemplateRegistry(this.store).get(
          String(this.manifest.binding!.template),
          version,
        );
        return {
          version: v,
          requirements: (await this.store.read(v.requirements)).toString(),
          parser: (await this.store.read(v.parser)).toString(),
        };
      },
    );
  }
  async readRequirement(version: string, fieldId: string): Promise<unknown> {
    return this.controller.action(
      this.manifest,
      "read_requirement",
      { version, fieldId },
      this.toolUsage,
      () =>
        new TemplateRegistry(this.store).requirement(
          String(this.manifest.binding!.template),
          version,
          fieldId,
        ),
    );
  }
  async convert(): Promise<unknown> {
    return this.controller.action(
      this.manifest,
      "convert_source",
      { source: this.manifest.sourceSha256 },
      { ...this.toolUsage, externalActions: 1 },
      async () => {
        const converted = await convertDocument(
          this.manifest.sourcePath,
          this.pythonBin,
        );
        const ref = await this.store.put(
          this.manifest.runId,
          "outputs/converted.xlsx",
          converted.bytes,
          "converted-workbook",
        );
        this.manifest.refs!.converted = ref;
        const inventory = await inspectSource(
          this.store.path(this.manifest.runId, ref.relativePath),
          this.pythonBin,
        );
        const report = compareResults(
          "conversion",
          scanExpected(inventory).records,
          scanExpected(this.inventory).records,
          "source-conversion-v001",
        );
        report.issues = report.issues.map((i) => ({
          ...i,
          stage: "conversion",
        }));
        this.manifest.refs!.conversionCheck = await this.save(
          "outputs/conversion-report.json",
          report,
          "conversion-report",
        );
        this.manifest.refs!.conversionMap = await this.save(
          "outputs/conversion-map.json",
          converted.evidence,
          "conversion-map",
        );
        return {
          converted: ref,
          coverage: report,
          warnings: converted.evidence.warnings,
        };
      },
    );
  }
  crash(point: string): void {
    if (process.env.PI_FAULT_POINT === point)
      process.kill(process.pid, "SIGKILL");
  }
  close(): void {
    this.controller.close(this.manifest);
  }
  async resumeForRepair(): Promise<void> {
    if (
      this.manifest.decision !== "BLOCKED" &&
      this.manifest.decision !== "NONE"
    )
      throw new Error(
        "Only active or interrupted blocked runs can be explicitly resumed",
      );
    if (
      this.controller.ledger
        .list(this.manifest.runId)
        .some((a) => a.status === "UNCERTAIN")
    )
      throw new Error("Uncertain paid action requires manual reconciliation");
    await this.save(
      `resume/${Date.now()}.json`,
      {
        previousDecision: this.manifest.decision,
        reason: this.manifest.binding?.stopReason,
        budgetsUnchanged: true,
      },
      "resume-event",
    );
    this.manifest.decision = "NONE";
    this.manifest.phase = this.attempt?.validation
      ? "REPAIR_PENDING"
      : this.attempt?.finalResult
        ? "POSTPROCESSED"
        : this.attempt?.rawResult
          ? "EXTRACTED"
          : this.attempt
            ? "ATTEMPT_READY"
            : this.inventory
              ? "INVENTORIED"
              : "PREPARE";
    this.manifest.status = this.manifest.phase as RunManifest["status"];
    this.controller.persist(this.manifest);
    await this.controller.snapshot(this.manifest);
  }
}
export function createClosureExtension(runtime: ClosureRuntime) {
  let queue: Promise<unknown> = Promise.resolve();
  const tool = <T>(
    name: string,
    description: string,
    parameters: T,
    fn: (args: any) => Promise<unknown>,
  ) =>
    defineTool({
      name,
      description,
      parameters: parameters as any,
      replay: "safe" as const,
      execute: async (args: any, api) => {
        const task = queue.then(async () => {
          try {
            if (
              runtime.manifest.phase === "TERMINAL" &&
              ![
                "read_artifact",
                "find_solutions",
                "read_solution",
                "read_requirement",
                "read_contract",
              ].includes(name)
            )
              throw new Error("Host has terminated this run");
            return await runtime.withToolCall(name, args, api.callId, () =>
              fn(args),
            );
          } catch (error) {
            const message = String(error);
            if (message.includes("Budget exhausted"))
              await runtime.controller.stop(
                runtime.manifest,
                "REVIEW",
                message,
              );
            else if (
              message.includes("BLOCKED:") ||
              message.includes("ModuleNotFoundError") ||
              message.includes("digest mismatch")
            )
              await runtime.controller.stop(
                runtime.manifest,
                "BLOCKED",
                message,
              );
            return {
              error: message,
              phase: runtime.manifest.phase,
              decision: runtime.manifest.decision,
              registeredPaths: Object.values(runtime.manifest.refs ?? {}).map(
                (r) => r.relativePath,
              ),
            };
          }
        });
        queue = task.catch(() => {});
        return {
          output: [{ type: "text" as const, text: JSON.stringify(await task) }],
        };
      },
    });
  return defineExtension({
    name: "closure",
    tools: [
      tool(
        "inspect_source",
        "Read original coordinates, values, styles and regions. Pagination never changes coverage.",
        obj({ offset: opt(num()), limit: opt(num()), sheet: opt(str()) }),
        (a) => runtime.inspect(a.offset, a.limit, a.sheet),
      ),
      tool(
        "read_artifact",
        "Read registered artifact contents, paged by lines.",
        obj({ path: str(), offset: opt(num()), limit: opt(num()) }),
        (a) => runtime.readArtifact(a.path, a.offset, a.limit),
      ),
      tool(
        "convert_source",
        "Convert PDF, DOCX or image locally to source-mapped Excel. Conversion coverage errors require repair or route switching.",
        obj({}),
        () => runtime.convert(),
      ),
      defineTool({
        name: "view_source_image",
        description:
          "Read actual original image for direct model extraction; no secrets or arbitrary paths.",
        parameters: obj({}),
        replay: "safe" as const,
        execute: async (args, api) =>
          runtime.withToolCall(
            "view_source_image",
            args,
            api.callId,
            async () => {
              if (
                ![".png", ".jpg", ".jpeg"].includes(
                  extname(runtime.manifest.sourcePath),
                )
              )
                throw new Error("Current source is not an image");
              await runtime.controller.action(
                runtime.manifest,
                "view_source_image",
                { digest: runtime.manifest.sourceSha256 },
                {},
                async () => ({ viewed: true }),
              );
              const bytes = await runtime.store.read(
                runtime.manifest.refs!.input,
              );
              return {
                output: [
                  {
                    type: "image" as const,
                    data: bytes.toString("base64"),
                    mimeType:
                      extname(runtime.manifest.sourcePath) === ".png"
                        ? "image/png"
                        : "image/jpeg",
                  },
                ],
              };
            },
          ),
      }),
      tool(
        "find_solutions",
        "Query pilot reference versions and applicability. Reuse never grants business approval.",
        obj({}),
        () => runtime.findSolutions(),
      ),
      tool(
        "read_solution",
        "Read the actual parser, frozen requirements and verification bindings of a pilot reference.",
        obj({ version: str() }),
        (a) => runtime.readSolution(a.version),
      ),
      tool(
        "read_requirement",
        "Read one stable field requirement, its dependencies and the complete frozen original text.",
        obj({ version: str(), fieldId: str() }),
        (a) => runtime.readRequirement(a.version, a.fieldId),
      ),
      tool(
        "read_contract",
        "Read the current extraction contract and whether a person has confirmed it.",
        obj({}),
        () => runtime.readContract(),
      ),
      tool(
        "draft_contract",
        readFileSync(
          resolve(PROJECT_ROOT, "config/llm/tools/draft-contract.md"),
          "utf8",
        ).trim(),
        obj({
          contract: str(),
          requirements: opt(str()),
          source: opt(oneOf(["uploaded", "observed"])),
        }),
        (a) => runtime.draftContract(a as { contract: string; requirements?: string; source?: "uploaded" | "observed" }),
      ),
      tool(
        "prepare_attempt",
        "Supply actual Python source (sys.argv[1] input xlsx, sys.argv[2] output JSON). New attempt required for repairs; source IDs sheet!R{row}C{route-column}. For reuse supply referenceVersion.",
        obj({
          parser: str(),
          plan: obj({
            route: oneOf([
              "excel_script",
              "converted_excel_script",
              "direct_llm",
            ]),
            reason: str(),
          }),
          referenceVersion: opt(str()),
        }),
        async (a) => {
          let reference: ArtifactRef | undefined;
          if (a.referenceVersion) {
            const matches = await new TemplateRegistry(runtime.store).find(
              String(runtime.manifest.binding!.template),
              runtime.inventory,
            );
            const found = matches.find(
              (v) => v.version.version === a.referenceVersion,
            );
            if (!found?.applicable)
              throw new Error("Reference not applicable to input");
            reference = found.version.parser;
          }
          const plan =
            typeof a.plan === "string"
              ? a.plan.trim().startsWith("{")
                ? JSON.parse(a.plan)
                : { route: "excel_script", reason: a.plan }
              : a.plan;
          return runtime.prepare(a.parser, plan, reference);
        },
      ),
      tool(
        "execute_attempt",
        "Execute current immutable parser in OS sandbox. Commits raw records only.",
        obj({}),
        () => runtime.execute(),
      ),
      tool(
        "post_process",
        "Apply complete frozen field contract to raw records.",
        obj({}),
        () => runtime.postprocess(),
      ),
      tool(
        "validate_attempt",
        "Independent original-source and post-process checks; returns actionable evidence. Host owns final decision.",
        obj({}),
        async () => {
          const report = await runtime.validate();
          return {
            ...report,
            issues: report.issues.slice(0, 8),
            totalIssues: report.issues.length,
            fullReport: runtime.attempt.validation?.relativePath,
            truncated: report.issues.length > 8,
          };
        },
      ),
      tool(
        "stop_for_review",
        "Stop with explicit reason and archive current results. Requires one trial extraction when a contract is declared.",
        obj({ reason: str() }),
        (a) => {
          if (runtime.contract && !runtime.manifest.attempts.length)
            throw new Error(
              "A contract is declared but no trial extraction exists. Run prepare_attempt, execute_attempt, post_process and validate_attempt once, then stop; the person needs the trial result to confirm the contract.",
            );
          return runtime.finish(a.reason);
        },
      ),
    ],
  });
}
