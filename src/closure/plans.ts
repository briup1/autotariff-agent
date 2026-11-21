import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { digest } from "./artifacts.js";
import { CONTRACT_ROOT, contractKey, validateContract, type Contract, type ContractApproval, type StoredContract } from "./contract.js";
import { Ledger } from "./ledger.js";
import { normalizePlanKey } from "./plan-normalization.js";
import type { ArchivePlan, Plan, PlanVersion, PlanSelection, RunBinding, NewPlanVersion } from "./plan-types.js";
import type { RunManifest } from "./models.js";
import { runsRootFor } from "./paths.js";

export class PlanError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Plan metadata and immutable version identities share the authoritative closure database. */
export class PlanLibrary {
  readonly ledger: Ledger;
  readonly workspace: string;
  constructor(readonly root: string) {
    this.workspace = resolve(root);
    this.ledger = new Ledger(resolve(runsRootFor(root), "closure.sqlite"));
  }
  list(): Plan[] {
    return (this.ledger.db.prepare("SELECT data FROM plans WHERE workspace=? ORDER BY rowid DESC").all(this.workspace) as { data: string }[])
      .map((row) => JSON.parse(row.data) as Plan);
  }
  get(planId: string): Plan {
    const row = this.ledger.db.prepare("SELECT data FROM plans WHERE id=? AND workspace=?").get(planId, this.workspace) as { data: string } | undefined;
    if (!row) throw new PlanError(404, "PLAN_NOT_FOUND", "方案不存在。");
    return JSON.parse(row.data) as Plan;
  }
  version(planVersionId: string): PlanVersion {
    const row = this.ledger.db.prepare("SELECT v.data FROM plan_versions v JOIN plans p ON p.id=v.plan_id WHERE v.id=? AND p.workspace=?")
      .get(planVersionId, this.workspace) as { data: string } | undefined;
    if (!row) throw new PlanError(404, "PLAN_VERSION_NOT_FOUND", "方案版本不存在。");
    return JSON.parse(row.data) as PlanVersion;
  }
  versions(planId: string): PlanVersion[] {
    this.get(planId);
    return (this.ledger.db.prepare("SELECT data FROM plan_versions WHERE plan_id=? ORDER BY rowid DESC").all(planId) as {data:string}[])
      .map(row=>JSON.parse(row.data) as PlanVersion);
  }
  previewContract(requirementsDigest: string) {
    try {
      const key = contractKey(requirementsDigest);
      const bytes = readFileSync(resolve(runsRootFor(this.root), CONTRACT_ROOT, key, "contract.json"));
      const contract = JSON.parse(bytes.toString()) as Contract;
      if (validateContract(contract).issues.length || contract.requirementsDigest !== key) throw new Error("invalid contract");
      return {contract,bytes,contractSha256:digest(bytes)};
    } catch { throw new PlanError(422,"PLAN_CONTRACT_INVALID","新契约缺失或损坏，请重新生成并核对后确认。"); }
  }
  versionRequest(planId: string, requestId: string): {plan:Plan;version:PlanVersion} | undefined {
    const row = this.ledger.db.prepare("SELECT plan_id,version_id FROM plan_version_requests WHERE workspace=? AND request_id=?")
      .get(this.workspace,requestId) as {plan_id:string;version_id:string}|undefined;
    if (!row) return undefined;
    if (row.plan_id !== planId) throw new PlanError(409,"PLAN_REQUEST_CONFLICT","请求标识已用于其他方案。");
    return {plan:this.get(planId),version:this.version(row.version_id)};
  }
  appendVersion(planId: string, input: NewPlanVersion, source: {sourceSignature:string;sourceSha256:string}) {
    let directory:string|undefined;
    try {
      return this.ledger.transaction(()=>{
        const requestId = required(input.requestId,"requestId",128);
        if (!/^[\w-]+$/.test(requestId)) throw new PlanError(400,"PLAN_FIELD_INVALID","请求标识无效。");
        const duplicate = this.versionRequest(planId,requestId);
        if (duplicate) return duplicate;
        if (input.confirmContract !== true) throw new PlanError(400,"PLAN_CONFIRMATION_REQUIRED","请人工确认预览中的新契约，再创建版本。");
        const plan = this.get(planId);
        if (plan.status !== "confirmed") throw new PlanError(422,"PLAN_NOT_CONFIRMED","请先恢复已确认方案，再创建版本。");
        if (plan.currentVersionId !== input.expectedCurrentVersionId) throw stalePlan();
        const preview = this.previewContract(input.requirementsDigest);
        if (preview.contractSha256 !== input.contractSha256) throw stalePlan();
        const current = this.readContract(plan.currentVersionId);
        if (rulesDigest(current.contract) === rulesDigest(preview.contract)) throw new PlanError(422,"PLAN_RULES_UNCHANGED","抽取规则未发生实质变化，无需创建新版本。");
        if (!/^[a-f0-9]{64}$/.test(source.sourceSignature) || !/^[a-f0-9]{64}$/.test(source.sourceSha256))
          throw new PlanError(422,"PLAN_SOURCE_INVALID","缺少有效原文件结构证据。");
        const next = (this.ledger.db.prepare("SELECT MAX(CAST(substr(contract_version,2) AS INTEGER)) AS n FROM plan_versions WHERE plan_id=?").get(planId) as {n:number}).n + 1;
        const contractVersion = `v${next}`, planVersionId = randomUUID(), now = new Date().toISOString();
        const contract = {...preview.contract,version:contractVersion}, bytes = JSON.stringify(contract,null,2), sha256 = digest(bytes);
        const signatureBytes = JSON.stringify({version:"sourceSignature-v1",sourceSignature:source.sourceSignature,sourceSha256:source.sourceSha256,sourceId:input.sourceId},null,2);
        const relativePath = `${planId}/${planVersionId}/source-signature.json`;
        const version:PlanVersion = {planId,planVersionId,contractVersion,requirementsDigest:input.requirementsDigest,contractSha256:sha256,
          sourceSignatureRef:{artifactId:`plans:${relativePath}`,kind:"source-signature",relativePath,sha256:digest(signatureBytes),bytes:Buffer.byteLength(signatureBytes)},approvedAt:now,createdAt:now};
        const target = this.directory(version);
        mkdirSync(dirname(target),{recursive:true});mkdirSync(target);directory = target;
        const approval = {approver:"local-user",approvedAt:now,contractVersion,requirementsDigest:input.requirementsDigest,contractSha256:sha256};
        for (const [name,value] of [["contract.json",bytes],["approval.json",JSON.stringify(approval,null,2)],["source-contract.json",preview.bytes],
          ["source-signature.json",signatureBytes],["confirmation.json",JSON.stringify({requestId,previewContractSha256:input.contractSha256,...approval},null,2)]] as const)
          writeFileSync(resolve(target,name),value,{flag:"wx",flush:true});
        this.ledger.db.prepare("INSERT INTO plan_versions VALUES(?,?,?,?)").run(planVersionId,planId,contractVersion,JSON.stringify(version));
        this.ledger.db.prepare("INSERT INTO plan_version_requests VALUES(?,?,?,?)").run(this.workspace,requestId,planId,planVersionId);
        plan.currentVersionId = planVersionId;
        return {plan:this.save(plan),version};
      });
    } catch (error) {
      if (directory) rmSync(directory,{recursive:true,force:true});
      throw error;
    }
  }
  validateSelection(selection: PlanSelection): { plan: Plan; version: PlanVersion; stored: StoredContract } {
    try {
      const plan = this.get(selection.planId), version = this.version(selection.planVersionId);
      if (plan.status !== "confirmed" || plan.currentVersionId !== version.planVersionId || version.planId !== plan.planId || plan.updatedAt !== selection.planUpdatedAt)
        throw new Error("stale");
      return { plan, version, stored: this.readContract(version.planVersionId) };
    } catch { throw stalePlan(); }
  }
  requestBinding(requestId: string): { runId: string; binding: RunBinding; manifest: RunManifest } | undefined {
    const row = this.ledger.db.prepare("SELECT b.run_id,b.data,r.state FROM run_bindings b JOIN runs r ON r.id=b.run_id WHERE b.workspace=? AND b.request_id=?")
      .get(this.workspace, requestId) as { run_id: string; data: string; state: string } | undefined;
    return row ? { runId: row.run_id, binding: JSON.parse(row.data), manifest: JSON.parse(row.state) } : undefined;
  }
  commitRun(ledger: Ledger, manifest: RunManifest, selection: PlanSelection, requestId: string, conversationId: string): void {
    ledger.transaction(() => {
      const { plan, version, stored } = this.validateSelection(selection);
      if (manifest.sourceSha256 !== selection.sourceSha256) throw stalePlan();
      const binding: RunBinding = { planId: plan.planId, planVersionId: version.planVersionId, contractVersion: version.contractVersion,
        requirementsDigest: version.requirementsDigest, planNameSnapshot: plan.name };
      manifest.binding = { ...manifest.binding, ...binding, contractStatus: "confirmed", contractRequired: true,
        interpretationVersion: version.contractVersion, contractApprovedAt: stored.approval!.approvedAt, contractDigest: version.requirementsDigest,
        sourceSignature: selection.sourceSignature, conversationId, requestId };
      ledger.create(manifest.runId, manifest);
      ledger.db.prepare("INSERT INTO run_bindings VALUES(?,?,?,?,?,?)")
        .run(manifest.runId, this.workspace, requestId, plan.planId, version.planVersionId, JSON.stringify(binding));
      ledger.db.prepare("UPDATE plans SET data=json_set(data,'$.lastUsedAt',?) WHERE id=? AND workspace=?")
        .run(new Date().toISOString(), plan.planId, this.workspace);
    });
  }
  private directory(version: PlanVersion): string {
    return resolve(runsRootFor(this.root), "plans", version.planId, version.planVersionId);
  }
  readContract(planVersionId: string): StoredContract {
    const version = this.version(planVersionId), directory = this.directory(version);
    const stored = this.confirmedContract(directory, version.requirementsDigest);
    if (stored.contract.version !== version.contractVersion || stored.approval!.contractSha256 !== version.contractSha256)
      throw new PlanError(422, "PLAN_CONTRACT_INVALID", "方案契约版本或摘要不一致，请核对原始证据。");
    return stored;
  }
  canArchive(requirementsDigest: string): boolean {
    try {
      this.confirmedContract(resolve(runsRootFor(this.root), CONTRACT_ROOT, contractKey(requirementsDigest)), requirementsDigest);
      return true;
    } catch { return false; }
  }
  private confirmedContract(directory: string, requirementsDigest: string): StoredContract & { contractBytes: Buffer; approvalBytes: Buffer } {
    try {
      const bytes = readFileSync(resolve(directory, "contract.json"));
      const contract = JSON.parse(bytes.toString()) as Contract;
      const approvalBytes = readFileSync(resolve(directory, "approval.json"));
      const approval = JSON.parse(approvalBytes.toString()) as ContractApproval;
      if (validateContract(contract).issues.length || typeof contract.version !== "string" || !contract.version.trim() || contract.requirementsDigest !== requirementsDigest ||
          approval.requirementsDigest !== requirementsDigest || approval.contractVersion !== contract.version ||
          approval.contractSha256 !== digest(bytes) || !approval.approver?.trim() || typeof approval.approvedAt !== "string" || !Number.isFinite(Date.parse(approval.approvedAt))) throw new Error("invalid approval");
      return { contract, approval, approved: true, directory, contractBytes: bytes, approvalBytes };
    } catch {
      throw new PlanError(422, "PLAN_CONTRACT_INVALID", "请先确认有效的候选契约；契约或确认凭据缺失、损坏时不能归档。");
    }
  }
  archive(input: ArchivePlan): Plan {
    let directory: string | undefined;
    let signatureDirectory: string | undefined;
    try {
      return this.ledger.transaction(() => {
        const requestId = required(input.requestId, "requestId", 128);
        if (!/^[\w-]+$/.test(requestId)) throw new PlanError(400, "PLAN_FIELD_INVALID", "请求标识无效。");
        const duplicate = this.ledger.db.prepare("SELECT plan_id FROM plan_archive_requests WHERE workspace=? AND request_id=?")
          .get(this.workspace, requestId) as { plan_id: string } | undefined;
        if (duplicate) return this.get(duplicate.plan_id);
        const name = required(input.name, "名称", 160), supplier = required(input.supplier, "供应商", 160), docType = required(input.docType, "单证类型", 160);
        const key = required(input.requirementsDigest, "契约标识", 64);
        try { contractKey(key); } catch { throw new PlanError(400, "PLAN_FIELD_INVALID", "契约标识无效。"); }
        if (input.sourceSignature !== undefined && !/^[a-f0-9]{64}$/.test(input.sourceSignature))
          throw new PlanError(400, "PLAN_FIELD_INVALID", "方案结构签名无效。");
        this.assertUniqueName(name);
        const stored = this.confirmedContract(resolve(runsRootFor(this.root), CONTRACT_ROOT, key), key);
        const now = new Date().toISOString(), planId = randomUUID(), planVersionId = randomUUID();
        const contract = { ...stored.contract, version: "v1" }, bytes = JSON.stringify(contract, null, 2);
        const approval = { ...stored.approval!, contractVersion: "v1", contractSha256: digest(bytes) };
        const sourceSignatureRef = input.sourceSignature ? this.writeSourceSignature(planVersionId, input.sourceSignature) : null;
        signatureDirectory = sourceSignatureRef ? resolve(runsRootFor(this.root), planVersionId) : undefined;
        const version: PlanVersion = {
          planId, planVersionId, contractVersion: "v1", requirementsDigest: key, contractSha256: approval.contractSha256,
          sourceSignatureRef, approvedAt: approval.approvedAt, createdAt: now,
        };
        const plan: Plan = {
          planId, workspace: this.workspace, name, normalizedName: normalizePlanKey(name), supplier, supplierKey: normalizePlanKey(supplier),
          docType, docTypeKey: normalizePlanKey(docType), normalizationVersion: "norm-v1", status: "confirmed", currentVersionId: planVersionId,
          createdAt: now, updatedAt: now, lastUsedAt: null, lastResult: null,
        };
        const target = this.directory(version);
        mkdirSync(dirname(target), { recursive: true });
        mkdirSync(target);
        directory = target;
        writeFileSync(resolve(directory, "contract.json"), bytes, { flag: "wx", flush: true });
        writeFileSync(resolve(directory, "approval.json"), JSON.stringify(approval, null, 2), { flag: "wx", flush: true });
        writeFileSync(resolve(directory, "source-contract.json"), stored.contractBytes, { flag: "wx", flush: true });
        writeFileSync(resolve(directory, "source-approval.json"), stored.approvalBytes, { flag: "wx", flush: true });
        this.ledger.db.prepare("INSERT INTO plans VALUES(?,?,?,?,?)").run(planId, this.workspace, plan.normalizedName, plan.status, JSON.stringify(plan));
        this.ledger.db.prepare("INSERT INTO plan_versions VALUES(?,?,?,?)")
          .run(planVersionId, planId, version.contractVersion, JSON.stringify(version));
        this.ledger.db.prepare("INSERT INTO plan_archive_requests VALUES(?,?,?)").run(this.workspace, requestId, planId);
        return plan;
      });
    } catch (error) {
      if (directory) rmSync(directory, { recursive: true, force: true });
      if (signatureDirectory) rmSync(signatureDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  private writeSourceSignature(planVersionId: string, sourceSignature: string): PlanVersion["sourceSignatureRef"] {
    const target = resolve(runsRootFor(this.root), planVersionId, "source-signature.json");
    mkdirSync(dirname(target), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ version: "sourceSignature-v1", sourceSignature }));
    writeFileSync(target, bytes, { flag: "wx", flush: true });
    return { artifactId: planVersionId, kind: "source-signature", relativePath: "source-signature.json", sha256: digest(bytes), bytes: bytes.length };
  }
  private assertUniqueName(name: string, except = ""): void {
    if (this.ledger.db.prepare("SELECT id FROM plans WHERE workspace=? AND normalized_name=? AND id<>?").get(this.workspace, normalizePlanKey(name), except))
      throw new PlanError(409, "PLAN_NAME_DUPLICATE", "此工作区已有同名方案，请使用其他名称。");
  }
  rename(planId: string, value: string): Plan {
    return this.ledger.transaction(() => {
      const plan = this.get(planId), name = required(value, "名称", 160);
      this.assertUniqueName(name, planId);
      plan.name = name; plan.normalizedName = normalizePlanKey(name);
      return this.save(plan);
    });
  }
  setInactive(planId: string, inactive: boolean): Plan {
    return this.ledger.transaction(() => {
      const plan = this.get(planId);
      if (!inactive) {
        if (plan.status === "candidate") throw new PlanError(422, "PLAN_NOT_CONFIRMED", "候选方案不能直接恢复为已确认。");
        this.readContract(plan.currentVersionId);
      }
      plan.status = inactive ? "inactive" : "confirmed";
      return this.save(plan);
    });
  }
  private save(plan: Plan): Plan {
    plan.updatedAt = new Date().toISOString();
    this.ledger.db.prepare("UPDATE plans SET normalized_name=?,status=?,data=? WHERE id=? AND workspace=?")
      .run(plan.normalizedName, plan.status, JSON.stringify(plan), plan.planId, this.workspace);
    return plan;
  }
  close(): void { this.ledger.close(); }
}

export function stalePlan(): PlanError {
  return new PlanError(409, "PLAN_VERSION_STALE", "方案或原文件已变化，请重新选择方案；系统不会改用其他规则。");
}

function required(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !normalizePlanKey(value) || value.length > maximum || value.includes("\0"))
    throw new PlanError(400, "PLAN_FIELD_INVALID", `${label}不能为空且不能超过 ${maximum} 字符。`);
  return value.trim();
}

function rulesDigest(contract: Contract): string {
  const {version:_version,requirementsDigest:_digest,requirementsSource:_source,...rules} = validateContract(contract).contract;
  return digest(JSON.stringify(rules,(_key,value:unknown)=>value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value));
}
