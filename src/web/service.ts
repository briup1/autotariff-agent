import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { loadConfig, localDate } from "../config.js";
import { workingProfile } from "../closure/interpretation.js";
import { digest } from "../closure/artifacts.js";
import { approveStoredContract, readStoredContract, listStoredContracts } from "../closure/contract.js";
import { PlanError, PlanLibrary, stalePlan } from "../closure/plans.js";
import { inspectPlanSource, planSource } from "../closure/plan-source.js";
import { normalizePlanKey } from "../closure/plan-normalization.js";
import type { PlanChoice, PlanSelection, NewPlanVersion } from "../closure/plan-types.js";
import { ClosureController } from "../closure/controller.js";
import { DEFAULT_BUDGET } from "../closure/runtime.js";
import { VISUAL_TASK_ID } from "../closure/live-budget.js";
import { PROJECT_ROOT, runsRootFor } from "../closure/paths.js";
import type { BootstrapView, ConversationDetail, SourceOption } from "./types.js";
import { RunProjection } from "./projection.js";
import { ConversationStore, WebError, publicSource, safeError, type Job, type RegisteredSource } from "./store.js";

export type RunJobContext = {
  job: Job; source: RegisteredSource;
  bindRun: (runId: string) => void;
  assistantText: (text: string) => void;
  service: WorkbenchService;
};
export type WorkbenchOptions = {
  projectRoot?: string;
  sources?: RegisteredSource[];
  runner?: (context: RunJobContext) => Promise<void>;
  modelConfigured?: () => boolean;
};

/** An admitted message owns one run and can never silently redispatch after a restart. */
export class WorkbenchService {
  readonly root: string;
  readonly store: ConversationStore;
  readonly projection: RunProjection;
  readonly plans: PlanLibrary;
  private readonly pending = new Set<Promise<void>>();
  private readonly planAdmissions = new Map<string,Promise<void>>();
  constructor(readonly options: WorkbenchOptions = {}) {
    this.root = resolve(options.projectRoot ?? PROJECT_ROOT);
    this.store = new ConversationStore(resolve(runsRootFor(this.root), "web/conversations.sqlite"));
    try { this.plans = new PlanLibrary(this.root); }
    catch (error) { this.store.close(); throw error; }
    this.projection = new RunProjection(this.root, this.store);
    this.store.recover();
  }
  configured(): boolean { return this.options.modelConfigured?.() ?? !!(process.env.OPENAI_API_KEY && process.env.PI_MODEL_ID); }
  // 登记内置合成示例，保留来源及规则身份。
  async initialize(): Promise<void> {
    if (this.options.sources) for (const source of this.options.sources) this.store.putSource(source);
    else {
      const candidates = [
        { id: "sample-controlled", label: "海运运价表示例", sourcePath: resolve(runsRootFor(this.root), "live-fixtures/small.xlsx"), requirementsPath: resolve(this.root, "fixtures/controlled-requirements.txt"), templateName: "controlled" },
        { id: "sample-yishengchang", label: "怡升昌 · 上海宁波深圳运价表", sourcePath: resolve(this.root, "../autotariffextract/data/20260811-识别文件/怡升昌/上海宁波深圳运价表.xlsx"), requirementsPath: resolve(this.root, "../autotariffextract/data/20260811-识别文件/怡升昌/怡升昌说明.txt"), templateName: "FREIGHT_YISHENGCHANG_EXCEL_01" },
      ];
      for (const candidate of candidates) {
        const available = existsSync(candidate.sourcePath) && existsSync(candidate.requirementsPath);
        this.store.putSource({ ...candidate, filename: basename(candidate.sourcePath), requirementsName: basename(candidate.requirementsPath), kind: "sample", supported: available, ...(available ? {} : { reason: "原文件或配套说明未找到，请检查本机样本或上传文件。" }) });
      }
    }
    await this.projection.initialize();
    await this.reconcilePlanJobs();
  }
  async bootstrap(): Promise<BootstrapView> {
    return { plans: this.plans.list(), sources: await this.sourcesWithContract(), conversations: this.store.conversations(), history: await this.projection.historyViews(), budget: this.projection.budget(), tests: await this.projection.refreshEvidence(), modelConfigured: this.configured() };
  }
  async planArchiveOptions() {
    const sources = await Promise.all(this.store.sources().map(async (source) => ({ source, key: await digestOf(source.requirementsPath) ?? await digestOf(source.sourcePath) })));
    return Promise.all((await listStoredContracts(this.root)).filter((entry) => this.plans.canArchive(entry.contract.requirementsDigest)).map(async (entry) => {
      const source = sources.find(({ key }) => key === entry.contract.requirementsDigest)?.source;
      let sourceSignature: string | undefined;
      if (source && existsSync(source.sourcePath)) {
        const evidence = await inspectPlanSource(source.sourcePath).catch(() => undefined);
        if (evidence) sourceSignature = planSource(evidence, entry.contract, source.docType ?? "").sourceSignature;
      }
      return {
        requirementsDigest: entry.contract.requirementsDigest, contractVersion: entry.contract.version,
        name: source ? basename(source.filename, extname(source.filename)) : "",
        supplier: source?.supplier ?? "", docType: source?.docType ?? "",
        ...(sourceSignature ? { sourceSignature } : {}),
      };
    }));
  }
  async planVersionOptions(planId: string) {
    this.plans.get(planId);
    const sources = await Promise.all(this.store.sources().map(async source=>({source,key:await digestOf(source.requirementsPath) ?? await digestOf(source.sourcePath)})));
    return (await listStoredContracts(this.root)).flatMap(entry=>{
      try {
        const preview = this.plans.previewContract(entry.contract.requirementsDigest);
        return sources.filter(({key})=>key === preview.contract.requirementsDigest).map(({source})=>({
          requirementsDigest:preview.contract.requirementsDigest,contractSha256:preview.contractSha256,contract:preview.contract,
          sourceId:source.id,sourceName:source.filename,contractVersion:preview.contract.version,
        }));
      } catch {return [];}
    });
  }
  async createPlanVersion(planId: string, input: NewPlanVersion) {
    const duplicate = this.plans.versionRequest(planId,input.requestId);
    if (duplicate) return duplicate;
    if (input.confirmContract !== true) throw new PlanError(400,"PLAN_CONFIRMATION_REQUIRED","请人工确认新契约后再创建版本。");
    const plan = this.plans.get(planId), source = this.store.source(input.sourceId);
    const preview = this.plans.previewContract(input.requirementsDigest);
    if (preview.contractSha256 !== input.contractSha256 || (await digestOf(source.requirementsPath) ?? await digestOf(source.sourcePath)) !== input.requirementsDigest) throw stalePlan();
    const evidence = await inspectPlanSource(source.sourcePath);
    const shape = planSource(evidence,preview.contract,plan.docType);
    if (!shape.applicable) throw new PlanError(422,"PLAN_SOURCE_INVALID","原文件不能识别新契约要求的结构，请先核对契约。");
    return this.plans.appendVersion(planId,input,shape);
  }
  // 独立投影说明可用性和登记规则状态；缺失附件不能使整个列表读取失败。
  private async sourcesWithContract(): Promise<SourceOption[]> {
    const out: SourceOption[] = [];
    for (const source of this.store.sources()) {
      // Same key the runtime uses: requirements text, or the source file when no requirements were uploaded.
      const digest = await digestOf(source.requirementsPath) ?? await digestOf(source.sourcePath);
      const stored = digest ? await readStoredContract(this.root, digest).catch(() => undefined) : undefined;
      // A registered interpretation already is a confirmed baseline; a contract only covers unmapped documents.
      const requirementsText = source.requirementsPath ? await readFile(source.requirementsPath, "utf8").catch(() => undefined) : undefined;
      const registered = requirementsText
        ? await workingProfile(requirementsText, Number(new Date().getFullYear())).catch(() => undefined)
        : undefined;
      out.push(await publicSource({
        ...source,
        ...(registered && !registered.unsupported
          ? { contractStatus: "confirmed" as const, contractVersion: registered.version }
          : {
              contractStatus: (stored ? (stored.approved ? "confirmed" : "candidate") : "missing") as "missing" | "candidate" | "confirmed",
              ...(stored ? { contractVersion: stored.contract.version } : {}),
            }),
      } as RegisteredSource));
    }
    return out;
  }
  /** Human confirmation of a drafted contract. Nothing else can turn a candidate into a baseline. */
  async approveContract(runId: string, requirementsDigest: string, contractSha256: string, approver: string): Promise<unknown> {
    const manifest = this.projection.manifest(runId);
    const binding = manifest.binding ?? {};
    if (manifest.phase !== "TERMINAL" || manifest.decision !== "REVIEW" || binding.contractStatus !== "candidate")
      throw new WebError(409, "该运行当前不在等待契约确认状态；运行结果和失败状态不会被确认动作覆盖。");
    if (binding.requirementsDigest !== requirementsDigest)
      throw new WebError(409, "契约说明与运行绑定不一致，请重新打开当前运行的契约预览。");
    const ref = manifest.refs?.contract;
    if (!ref || ref.kind !== "contract")
      throw new WebError(409, "该运行没有可核对的候选契约产物。");
    if (ref.sha256 !== contractSha256)
      throw new WebError(409, "候选契约已变化，请重新打开当前运行的契约预览。");
    const bytes = await this.projection.artifacts.read(ref).catch(() => undefined);
    if (!bytes || digest(bytes) !== contractSha256)
      throw new WebError(409, "候选契约产物缺失或摘要校验失败，不能确认。");
    let contract: { version?: string; requirementsDigest?: string };
    try { contract = JSON.parse(bytes.toString("utf8")) as typeof contract; }
    catch { throw new WebError(409, "候选契约内容无效，不能确认。"); }
    if (contract.requirementsDigest !== requirementsDigest || contract.version !== binding.contractVersion)
      throw new WebError(409, "候选契约版本或说明摘要与运行绑定不一致，请重新生成候选契约。");
    const attempt = manifest.currentAttemptId ? manifest.attemptStates?.[manifest.currentAttemptId] : undefined;
    if (!attempt?.validation)
      throw new WebError(409, "该运行没有可核对的检查报告，不能把未知状态当作等待确认。");
    let report: { status?: string; issues?: unknown[] };
    try { report = JSON.parse((await this.projection.artifacts.read(attempt.validation)).toString("utf8")) as typeof report; }
    catch { throw new WebError(409, "检查报告缺失或摘要校验失败，不能确认契约。"); }
    if (report.status !== "REVIEW" || !Array.isArray(report.issues) || report.issues.length > 0)
      throw new WebError(409, "该运行存在检查问题或已阻断；请先查看问题，确认契约不会覆盖运行结论。");
    const stored = await readStoredContract(this.root, requirementsDigest).catch(() => undefined);
    if (!stored) throw new WebError(409, "当前登记的候选契约已不存在，请重新生成并核对。");
    if (stored.contract.version !== contract.version)
      throw new WebError(409, "当前登记的候选契约版本已替换，请重新打开预览。");
    try {
      return await approveStoredContract(this.root, requirementsDigest, approver, contractSha256, contract.version);
    } catch (error) {
      if (String(error).includes("replaced") || String(error).includes("version changed"))
        throw new WebError(409, "当前登记的候选契约已替换，请重新打开预览。");
      throw error;
    }
  }
  async archivePlan(input: Parameters<PlanLibrary["archive"]>[0]) {
    const source = (await Promise.all(this.store.sources().map(async (entry) => ({ entry, key: await digestOf(entry.requirementsPath) ?? await digestOf(entry.sourcePath) })))).find(({ key }) => key === input.requirementsDigest)?.entry;
    const stored = source ? await readStoredContract(this.root, input.requirementsDigest).catch(() => undefined) : undefined;
    if (source && stored && existsSync(source.sourcePath)) {
      const evidence = await inspectPlanSource(source.sourcePath).catch(() => undefined);
      if (evidence) input = { ...input, sourceSignature: planSource(evidence, stored.contract, input.docType).sourceSignature };
    }
    return this.plans.archive(input);
  }
  async conversation(id: string): Promise<ConversationDetail> {
    const conversation = this.store.conversation(id);
    const runs = await Promise.all(conversation.runIds.map((runId) => this.projection.summary(runId)));
    return { conversation, messages: this.store.messages(id), runs };
  }
  async availablePlans(sourceId: string): Promise<PlanChoice[]> {
    const source = this.store.source(sourceId), choices: PlanChoice[] = [];
    const plans = this.plans.list().filter((entry) => entry.status === "confirmed");
    if (!plans.length) return choices;
    const evidence = await inspectPlanSource(source.sourcePath).catch(()=>undefined);
    if (!evidence) throw new WebError(422,"原文件结构暂不可读取，请检查文件与本地解析环境后重试。");
    for (const plan of plans) {
      try {
        const stored = this.plans.readContract(plan.currentVersionId);
        const shape = planSource(evidence, stored.contract, plan.docType);
        if (!shape.applicable) continue;
        const version = this.plans.version(plan.currentVersionId);
        if (version.sourceSignatureRef) {
          const signature = JSON.parse((await this.projection.artifacts.read(version.sourceSignatureRef)).toString());
          if (signature.sourceSignature !== shape.sourceSignature) continue;
        }
        if (source.supplier || source.docType) {
          if (!source.supplier || !source.docType) continue;
          if (normalizePlanKey(source.supplier) !== plan.supplierKey || normalizePlanKey(source.docType) !== plan.docTypeKey) continue;
        }
        choices.push({planId:plan.planId,planVersionId:plan.currentVersionId,planUpdatedAt:plan.updatedAt,
          sourceSignature:shape.sourceSignature,sourceSha256:shape.sourceSha256,name:plan.name,supplier:plan.supplier,docType:plan.docType,contractVersion:version.contractVersion});
      } catch { /* Invalid or unreadable evidence never enters the selectable list. */ }
    }
    return choices;
  }
  async availablePlanMatches(sourceId: string): Promise<{ plans: PlanChoice[]; selection: "unique" | "multiple" | "none"; preselectedPlanVersionId?: string }> {
    const plans = await this.availablePlans(sourceId), source = this.store.source(sourceId);
    const identityKnown = Boolean(normalizePlanKey(source.supplier ?? "") && normalizePlanKey(source.docType ?? ""));
    const signatureVerified = plans.length === 1 && Boolean(this.plans.version(plans[0].planVersionId).sourceSignatureRef);
    if (plans.length === 1 && identityKnown && signatureVerified)
      return { plans, selection: "unique", preselectedPlanVersionId: plans[0].planVersionId };
    return { plans, selection: plans.length > 1 ? "multiple" : "none" };
  }
  private async validatePlan(sourceId: string, selection: PlanSelection): Promise<PlanChoice> {
    this.plans.validateSelection(selection);
    const selected = (await this.availablePlans(sourceId).catch(()=>[])).find((choice) => choice.planId === selection.planId && choice.planVersionId === selection.planVersionId);
    if (!selected || selected.sourceSignature !== selection.sourceSignature || selected.sourceSha256 !== selection.sourceSha256) throw stalePlan();
    return selected;
  }
  // 创建只保存会话；不可用来源不能进入会话，不派发执行。
  async create(sourceId: string, title?: string, selection?: PlanSelection): Promise<ConversationDetail> {
    const source = this.store.source(sourceId);
    const available = await publicSource(source);
    if (!available.supported) throw new WebError(422, available.reason ?? "该文件暂不可用。");
    if (!selection && !source.requirementsPath && (await this.availablePlanMatches(sourceId)).selection === "multiple")
      throw new WebError(409, "存在多个精确匹配方案，请先手动选择方案后继续。");
    const plan = selection ? await this.validatePlan(sourceId,selection) : undefined;
    return this.conversation(this.store.create(sourceId, title, plan).id);
  }
  async send(id: string, requestId: string, content: string, selection?: PlanSelection): Promise<ConversationDetail> {
    const conversation = this.store.conversation(id);
    const selected = selection ?? conversation.planSelection;
    const duplicate = this.store.job(id, requestId);
    if (duplicate) {
      if (duplicate.content !== content || !sameSelection(duplicate.planSelection,selected)) throw new WebError(409, "此请求标识已用于另一条消息或方案。");
      const admission = this.planAdmissions.get(duplicate.id);
      if (admission) await admission;
      const saved = this.store.job(id,requestId)!;
      const committed = saved.planSelection ? this.plans.requestBinding(requestId) : undefined;
      if (committed && !saved.bindingReceipt) {
        if (committed.manifest.binding?.conversationId !== id) throw new WebError(409,"请求标识已绑定其他会话。");
        this.store.bind(saved,committed.runId,committed.binding);
        this.store.complete(saved,committed.manifest.phase === "TERMINAL" ? undefined : "已恢复运行回执；不会自动重发模型请求。",committed.manifest.phase !== "TERMINAL");
      }
      return this.conversation(id);
    }
    const source = this.store.source(this.store.conversation(id).sourceId);
    if (!source.supported) throw new WebError(422, source.reason ?? "该文件暂不支持。");
    if (!selected && !source.requirementsPath && (await this.availablePlanMatches(source.id)).selection === "multiple")
      throw new WebError(409, "存在多个精确匹配方案，请先手动选择方案后继续。");
    if (!this.configured()) throw new WebError(503, "模型未配置。请在本机 .env.local 设置 OPENAI_API_KEY 和 PI_MODEL_ID，再重新发送。");
    if (this.projection.budget().remainingCalls === 0) throw new WebError(429, "本次任务的模型调用预算已用尽。");
    const plan = selected ? await this.validatePlan(source.id, selected) : undefined;
    if (plan) {
      const bound = this.plans.requestBinding(requestId);
      if (bound) throw new WebError(409, "此请求标识已绑定另一会话的运行。");
    }
    const { job, created } = this.store.admit(id, requestId, content, plan);
    if (!created) {
      const admission = this.planAdmissions.get(job.id);
      if (admission) await admission;
      return this.conversation(id);
    }
    if (job.planSelection) {
      const admission = (async () => {
        const manifest = await this.preparePlanRun(job);
        this.store.bind(job, manifest.runId, this.plans.ledger.runBinding(manifest.runId));
      })();
      this.planAdmissions.set(job.id,admission);
      try {
        await admission;
      } catch (error) {
        const committed = this.plans.requestBinding(requestId);
        if (!committed || committed.manifest.binding?.conversationId !== job.conversationId) this.store.complete(job, safeError(error));
        throw error;
      } finally { this.planAdmissions.delete(job.id); }
    }
    let ready!: () => void;
    const admitted = new Promise<void>((done) => { ready = done; });
    const task = this.execute(job, source, ready);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    await admitted;
    return this.conversation(id);
  }
  private async execute(job: Job, source: RegisteredSource, ready: () => void): Promise<void> {
    let receivedText = false;
    try {
      await (this.options.runner ?? runDefault)({
        job, source, service: this,
        bindRun: (runId) => {
          if (job.planSelection && job.runId !== runId) throw new WebError(409, "已选方案的请求不得创建第二次运行。");
          this.store.bind(job, runId, job.bindingReceipt); ready();
        },
        assistantText: (text) => {
          if (text.trim()) { receivedText = true; this.store.message(job.conversationId, "assistant", redact(text), job.runId); }
        },
      });
      const summary = job.runId
        ? await this.projection.summary(job.runId).catch(() => undefined)
        : undefined;
      const manifest = job.runId ? this.projection.manifest(job.runId) : undefined;
      const attempt = manifest?.currentAttemptId ? manifest.attemptStates?.[manifest.currentAttemptId] : undefined;
      const budgetStopped = /预算|budget|max_turns|turn_limit/i.test(
        `${manifest?.binding?.modelStopReason ?? ""} ${manifest?.binding?.stopReason ?? ""} ${summary?.stopReason ?? ""}`);
      const reportAvailable = Boolean(attempt?.validation && summary?.issueCount !== undefined);
      const terminalFacts: string[] = [];
      if (budgetStopped) terminalFacts.push("本次因运行预算停止。这不是等待契约确认，也不代表检查通过。可发送“继续试抽取并独立检查”，新一轮会引用上一轮进度；本轮预算不会重置。");
      if (summary?.decision === "BLOCKED") terminalFacts.push(`本次运行已阻断：${summary.stopReason ?? summary.error ?? "请查看原文证据"}。结果不可作为通过检查的运价使用，也不能确认候选契约。`);
      if (summary && ["REVIEW", "BLOCKED"].includes(summary.decision))
        terminalFacts.push(reportAvailable
          ? `独立检查报告已保存，记录了 ${summary.issueCount} 条问题。${summary.issueCount ? "请查看问题坐标后再要求修复。" : "仍需人工确认候选契约及业务口径。"}`
          : "独立检查报告缺失或不可读，不能确认检查通过。请继续试抽取并独立检查后再确认候选契约。");
      if (terminalFacts.length) this.store.message(job.conversationId, "system", terminalFacts.join("\n"), job.runId);
      else if (!receivedText) {
        const reason = summary?.stopReason || summary?.error;
        this.store.message(job.conversationId, "system",
          reason ? `本次运行已结束：${reason}` : "本次运行已结束，没有产生回复文本。请查看执行记录。", job.runId);
      }
      this.store.complete(job);
    } catch (error) { this.store.complete(job, safeError(error)); }
    finally { ready(); }
  }
  async preparePlanRun(job: Job) {
    const existing = this.plans.requestBinding(job.requestId);
    if (existing) {
      if (existing.manifest.binding?.conversationId !== job.conversationId || !sameSelection(job.planSelection,existing.binding))
        throw new WebError(409, "请求标识已绑定其他运行。");
      return existing.manifest;
    }
    const selection = job.planSelection;
    if (!selection) throw new WebError(400, "缺少已选方案。");
    const source = this.store.source(this.store.conversation(job.conversationId).sourceId);
    await this.validatePlan(source.id,selection);
    const { stored } = this.plans.validateSelection(selection);
    const config = this.options.runner ? {runDate:localDate(),runYear:new Date().getFullYear(),budget:DEFAULT_BUDGET,maxAgentTurns:undefined} : loadConfig();
    const budget = {...DEFAULT_BUDGET,...config.budget,...(config.maxAgentTurns === undefined ? {} : {maxAgentTurns:config.maxAgentTurns})};
    const controller = new ClosureController(this.projection.artifacts,this.root,budget);
    let manifest;
    try {
      manifest = await controller.startRun(source.sourcePath,{version:stored.contract.version,sourceText:"",sourceRequirementsDigest:stored.contract.requirementsDigest,clauses:[],unsupported:true},config.runDate,config.runYear,
        {library:this.plans,selection,requestId:job.requestId,conversationId:job.conversationId,stored,
          context:{template:source.templateName,liveBudgetTask:VISUAL_TASK_ID,...(job.parentRunId ? {parentRunId:job.parentRunId} : {})}});
      return manifest;
    } finally { controller.close(manifest); }
  }
  private async reconcilePlanJobs(): Promise<void> {
    for (const job of this.store.jobs().filter((entry) => entry.planSelection && ["ADMITTED","RUNNING"].includes(entry.state))) {
      const existing = this.plans.requestBinding(job.requestId);
      try {
        const manifest = await this.preparePlanRun(job);
        this.store.bind(job,manifest.runId,this.plans.ledger.runBinding(manifest.runId));
        if (existing) {
          if (manifest.phase === "TERMINAL") this.store.complete(job);
          else this.store.complete(job,"服务重启，运行已保留；不会自动重发模型请求。",true);
        } else {
          const source = this.store.source(this.store.conversation(job.conversationId).sourceId);
          const task = this.execute(job,source,()=>{});
          this.pending.add(task); void task.finally(()=>this.pending.delete(task));
        }
      } catch (error) {
        const committed = this.plans.requestBinding(job.requestId);
        if (!committed || committed.manifest.binding?.conversationId !== job.conversationId) this.store.complete(job,safeError(error));
        else throw error;
      }
    }
  }
  async upload(name: string, base64: string, requirementsName?: string, requirementsText?: string): Promise<SourceOption> {
    validateName(name);
    const hasRequirements = Boolean(requirementsName && requirementsText && requirementsText.trim());
    if (hasRequirements) {
      validateName(requirementsName!);
      if (![".txt", ".md"].includes(extname(requirementsName!).toLowerCase())) throw new WebError(422, "配套说明必须为 TXT 或 Markdown 文件。");
      if (Buffer.byteLength(requirementsText!) > 64 * 1024 || requirementsText!.includes("\0")) throw new WebError(422, "说明必须是 64 KiB 以内的文本。");
    }
    if (base64.length > 20 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new WebError(413, "文件编码无效或超过 15 MiB。");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.length > 15 * 1024 * 1024 || bytes.toString("base64") !== base64) throw new WebError(413, "原文件不能为空，且不能超过 15 MiB。");
    validateSignature(name, bytes);
    const profile: { version: string; sourceRequirementsDigest: string; unsupported?: boolean } = hasRequirements
      ? await workingProfile(requirementsText, Number(new Date().getFullYear()))
      : { version: "contract-observed", sourceRequirementsDigest: digest(""), unsupported: true };
    const id = `upload-${randomUUID()}`;
    const sourceRef = await this.projection.artifacts.put("web", `uploads/${id}/${name}`, bytes, "source");
    const requirementsRef = hasRequirements
      ? await this.projection.artifacts.put("web", `uploads/${id}/requirements-${requirementsName}`, requirementsText!, "requirements")
      : undefined;
    const requirementsDigest = profile.sourceRequirementsDigest;
    const contractKey = hasRequirements ? requirementsDigest : digest(bytes);
    const stored = await readStoredContract(this.root, contractKey).catch(() => undefined);
    const registered = profile.version.startsWith("yishengchang");
    const source: RegisteredSource = {
      id, label: name, filename: name, requirementsName: requirementsName ?? "（未上传，由 Agent 观察原文生成候选契约）",
      kind: "upload",
      templateName: registered ? "FREIGHT_YISHENGCHANG_EXCEL_01" : `upload-${requirementsDigest.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
      sourcePath: this.projection.artifacts.path("web", sourceRef.relativePath),
      ...(requirementsRef ? { requirementsPath: this.projection.artifacts.path("web", requirementsRef.relativePath) } : {}),
      supported: true,
      contractStatus: stored ? (stored.approved ? "confirmed" : "candidate") : "missing",
      ...(stored ? { contractVersion: stored.contract.version } : {}),
    };
    this.store.putSource(source);
    return publicSource(source);
  }
  async idle(): Promise<void> { await Promise.all(this.pending); }
  async close(): Promise<void> { await this.idle(); this.plans.close(); this.store.close(); }
}

async function runDefault(context: RunJobContext): Promise<void> {
  const { ClosureRuntime } = await import("../closure/runtime.js"), { runPi } = await import("../index.js");
  const { job, source, service } = context;
  const runtime = new ClosureRuntime({ ...loadConfig(), projectRoot: service.root, sourcePath: source.sourcePath, requirementsPath: source.requirementsPath, templateName: source.templateName, liveBudgetTask: VISUAL_TASK_ID, contractFirst: true }, undefined, runsRootFor(service.root));
  try {
    try { await runtime.bootstrap(job.planSelection ? job.runId : undefined); }
    finally {
      if (runtime.manifest) {
        runtime.manifest.binding = { ...runtime.manifest.binding, conversationId: job.conversationId, requestId: job.requestId, ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}) };
        runtime.controller.persist(runtime.manifest);
        await runtime.controller.snapshot(runtime.manifest);
        context.bindRun(runtime.manifest.runId);
      }
    }
    const transcript = service.store.messages(job.conversationId).map(({ role, content }) => ({ role, content }));
    const messages = transcript.slice(-20);
    runtime.manifest.refs!.conversation = await runtime.save("context/conversation.json", transcript, "conversation-context");
    const previous: { kind: string; path: string; sha256: string; bytes: number }[] = [];
    if (job.parentRunId) {
      const parent = service.projection.manifest(job.parentRunId);
      const attempt = parent.currentAttemptId ? parent.attemptStates?.[parent.currentAttemptId] : undefined;
      const inherited = attempt ? undefined : parent.refs;
      const sameInput = parent.sourceSha256 === runtime.manifest.sourceSha256 &&
        parent.refs?.requirements?.sha256 === runtime.manifest.refs?.requirements?.sha256;
      for (const [kind, ref] of [["result", attempt?.finalResult ?? inherited?.["previous-result"]], ["report", attempt?.validation ?? inherited?.["previous-report"]], ["parser", attempt?.parser ?? inherited?.["previous-parser"]],
        ["candidate-contract", sameInput ? parent.refs?.contract ?? inherited?.["previous-candidate-contract"] : undefined]] as const) {
        if (!ref) continue;
        const bytes = await service.projection.artifacts.read(ref);
        const imported = await runtime.store.put(runtime.manifest.runId, `context/previous-${kind}${extname(ref.relativePath)}`, bytes, `previous-${kind}`);
        runtime.manifest.refs![`previous-${kind}`] = imported;
        previous.push({ kind, path: imported.relativePath, sha256: imported.sha256, bytes: imported.bytes });
      }
    }
    runtime.controller.persist(runtime.manifest);
    await runtime.controller.snapshot(runtime.manifest);
    const runDate = runtime.config.runDate;
    const contractStatus = runtime.manifest.binding?.contractStatus ?? source.contractStatus;
    const contractVersion = runtime.manifest.binding?.contractVersion ?? source.contractVersion;
    const facts = [
      `今天：${runDate}（${weekday(runDate)}）`,
      `当前文件：${source.filename}（${extname(source.filename).replace(".", "").toUpperCase()}）`,
      `契约状态：${
        contractStatus === "confirmed"
          ? `已确认 ${contractVersion ?? ""}`.trim()
          : contractStatus === "candidate"
            ? "候选，等待人确认"
            : "未声明"
      }`,
      ...(job.bindingReceipt ? [`已选方案：${job.bindingReceipt.planNameSnapshot}，固定版本 ${job.bindingReceipt.contractVersion}`] : []),
      job.parentRunId ? `上一轮运行：${job.parentRunId}` : "这是本会话的第一条消息",
    ].join("；");
    const prompt = renderTemplate(await readPrompt("runtime-context.md"), {
      facts,
      conversationId: job.conversationId,
      parentRunId: job.parentRunId ?? "none",
      messages: JSON.stringify(messages),
      previous: JSON.stringify({ artifacts: previous, readHint: "Read these paths with read_artifact as needed. A previous candidate is unconfirmed evidence; inspect and draft it for this run before a trial. Previous results and reports are not this run's validation." }),
      contractHint: await readPrompt(
        `contract-hints/${
          contractStatus === "confirmed"
            ? "confirmed"
            : contractStatus === "candidate"
              ? "candidate"
              : "missing"
        }.md`,
      ),
      request: job.content,
    });
    await runPi(runtime, prompt, { requestId: job.requestId, onAssistantText: context.assistantText });
    if (runtime.manifest.phase !== "TERMINAL") {
      if (terminalOutcome(runtime.manifest.attempts.length) === "answer")
        await runtime.answer("回答完成，本次没有执行抽取");
      else await runtime.finish("Agent response completed; results require human review");
    }
  } catch (error) {
    if (runtime.manifest && runtime.manifest.phase !== "TERMINAL") await runtime.controller.stop(runtime.manifest, "BLOCKED", safeError(error));
    throw error;
  } finally { await runtime.finalizeBest("工作台运行结束"); runtime.close(); }
}

function sameSelection(a: PlanSelection | undefined, b: {planId:string;planVersionId:string} | undefined): boolean {
  return a?.planId === b?.planId && a?.planVersionId === b?.planVersionId;
}

/** A turn without an extraction attempt was a conversation, not a result awaiting review. */
export function terminalOutcome(attempts: number): "answer" | "review" {
  return attempts > 0 ? "review" : "answer";
}
async function readPrompt(name: string): Promise<string> {
  return (await readFile(resolve(PROJECT_ROOT, "config/llm", name), "utf8")).trim();
}
/** Fills {{name}} placeholders. Unknown placeholders stay visible so a template edit cannot fail silently. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? values[key]! : match,
  );
}
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
function weekday(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? "日期未知" : WEEKDAYS[parsed.getUTCDay()]!;
}
async function digestOf(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch { return undefined; }
}
function validateName(name: string): void {
  if (!name || name.length > 180 || name !== basename(name) || /[\\/\x00-\x1f\x7f]/.test(name) || name.startsWith(".")) throw new WebError(422, "文件名无效，请使用普通文件名。");
}
function validateSignature(name: string, bytes: Buffer): void {
  const extension = extname(name).toLowerCase();
  const valid = extension === ".pdf" ? bytes.subarray(0, 5).toString() === "%PDF-"
    : extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : [".jpg", ".jpeg"].includes(extension) ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    : [".xlsx", ".docx"].includes(extension) ? bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) && bytes.includes(Buffer.from("[Content_Types].xml")) && bytes.includes(Buffer.from(extension === ".xlsx" ? "xl/workbook.xml" : "word/document.xml")) : false;
  if (!valid) throw new WebError(422, "文件格式或签名无效。支持 XLSX、PDF、DOCX、PNG 和 JPEG。");
}
function redact(text: string): string {
  let result = text;
  for (const [name, value] of Object.entries(process.env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name) && value && value.length >= 8) result = result.split(value).join("[已隐藏凭据]");
  return result;
}
