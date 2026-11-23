import { randomUUID } from "node:crypto";
import { constants, mkdirSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ConversationSummary, SourceOption } from "./types.js";
import type { RunBinding, PlanChoice } from "../closure/plan-types.js";
import { PlanError } from "../closure/plans.js";

export class WebError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type RegisteredSource = Omit<SourceOption, "hasRequirements"> & { sourcePath: string; requirementsPath?: string };
export type Job = {
  id: string; conversationId: string; requestId: string; content: string;
  state: "ADMITTED" | "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED";
  runId?: string; parentRunId?: string; createdAt: string; error?: string;
  bindingReceipt?: RunBinding;
  planSelection?: PlanChoice;
};

export class ConversationStore {
  readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS service_lock(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(conversation,request));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(conversation) WHERE state IN ('ADMITTED','RUNNING');`);
    try {
      this.transaction(() => {
        const previous = this.db.prepare("SELECT pid FROM service_lock WHERE id=1").get() as { pid: number } | undefined;
        if (previous) {
          let alive = true;
          try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
          if (alive) throw new WebError(409, "另一个工作台服务正在运行，请使用已有地址。");
        }
        this.db.prepare("INSERT OR REPLACE INTO service_lock VALUES(1,?,?)").run(this.owner, process.pid);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  sources(): RegisteredSource[] {
    return this.rows<RegisteredSource>("SELECT data FROM sources ORDER BY rowid");
  }
  putSource(source: RegisteredSource): void {
    this.db.prepare("INSERT INTO sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(source.id, JSON.stringify(source));
  }
  source(id: string): RegisteredSource {
    const source = this.sources().find((entry) => entry.id === id);
    if (!source) throw new WebError(404, "未找到原文件，请重新选择。");
    return source;
  }
  private rows<T>(sql: string, ...args: string[]): T[] {
    return (this.db.prepare(sql).all(...args) as { data: string }[]).map((row) => JSON.parse(row.data) as T);
  }
  conversations(): ConversationSummary[] {
    return this.rows<ConversationSummary>("SELECT data FROM conversations ORDER BY rowid DESC");
  }
  conversation(id: string): ConversationSummary {
    const value = this.rows<ConversationSummary>("SELECT data FROM conversations WHERE id=?", id)[0];
    if (!value) throw new WebError(404, "会话不存在。");
    return value;
  }
  private saveConversation(value: ConversationSummary): void {
    this.db.prepare("INSERT INTO conversations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(value.id, JSON.stringify(value));
  }
  create(sourceId: string, title?: string, planSelection?: PlanChoice): ConversationSummary {
    const source = this.source(sourceId), now = new Date().toISOString();
    const value: ConversationSummary = { id: randomUUID(), title: title || source.label, sourceId, createdAt: now, updatedAt: now, runIds: [], ...(planSelection ? { planSelection } : {}) };
    this.saveConversation(value);
    return value;
  }
  messages(id: string): ChatMessage[] {
    return this.rows<ChatMessage>("SELECT data FROM messages WHERE conversation=? ORDER BY rowid", id);
  }
  message(id: string, role: ChatMessage["role"], content: string, runId?: string): void {
    const message: ChatMessage = { id: randomUUID(), role, content, createdAt: new Date().toISOString(), ...(runId ? { runId } : {}) };
    this.db.prepare("INSERT INTO messages VALUES(?,?,?)").run(message.id, id, JSON.stringify(message));
    const conversation = this.conversation(id);
    conversation.updatedAt = message.createdAt;
    this.saveConversation(conversation);
  }
  job(conversation: string, request: string): Job | undefined {
    return this.rows<Job>("SELECT data FROM jobs WHERE conversation=? AND request=?", conversation, request)[0];
  }
  jobs(): Job[] { return this.rows<Job>("SELECT data FROM jobs ORDER BY rowid"); }
  admit(conversationId: string, requestId: string, content: string, planSelection?: PlanChoice): { job: Job; created: boolean } {
    return this.transaction(() => {
      const duplicate = this.job(conversationId, requestId);
      if (duplicate) {
        if (duplicate.content !== content || duplicate.planSelection?.planId !== planSelection?.planId || duplicate.planSelection?.planVersionId !== planSelection?.planVersionId)
          throw new WebError(409, "此请求标识已用于另一条消息或方案。");
        return { job: duplicate, created: false };
      }
      const conversation = this.conversation(conversationId);
      if (this.db.prepare("SELECT id FROM jobs WHERE conversation=? AND state IN ('ADMITTED','RUNNING')").get(conversationId))
        throw new WebError(409, "当前会话正在执行，请等待结束后再发送。");
      const job: Job = { id: randomUUID(), conversationId, requestId, content, state: "ADMITTED", parentRunId: conversation.runIds.at(-1), createdAt: new Date().toISOString(), ...(planSelection ? { planSelection } : {}) };
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?)").run(job.id, conversationId, requestId, job.state, JSON.stringify(job));
      this.message(conversationId, "user", content);
      return { job, created: true };
    });
  }
  private saveJob(job: Job): void {
    this.db.prepare("UPDATE jobs SET state=?,data=? WHERE id=?").run(job.state, JSON.stringify(job), job.id);
  }
  bind(job: Job, runId: string, bindingReceipt?: RunBinding): void {
    this.transaction(() => {
      if (job.runId && job.runId !== runId) throw new WebError(409, "请求已绑定其他运行。");
      if (bindingReceipt) job.bindingReceipt = bindingReceipt;
      job.runId = runId; job.state = "RUNNING";
      this.saveJob(job);
      const conversation = this.conversation(job.conversationId);
      if (!conversation.runIds.includes(runId)) conversation.runIds.push(runId);
      conversation.activeRunId = runId;
      this.saveConversation(conversation);
      const messages = this.messages(conversation.id);
      const user = [...messages].reverse().find((message) => message.role === "user" && !message.runId);
      if (user) {
        user.runId = runId;
        this.db.prepare("UPDATE messages SET data=? WHERE id=?").run(JSON.stringify(user), user.id);
      }
    });
  }
  complete(job: Job, error?: string, interrupted = false): void {
    this.transaction(() => {
      job.state = interrupted ? "INTERRUPTED" : error ? "FAILED" : "COMPLETED";
      job.error = error;
      this.saveJob(job);
      const conversation = this.conversation(job.conversationId);
      delete conversation.activeRunId;
      conversation.updatedAt = new Date().toISOString();
      this.saveConversation(conversation);
      if (error) this.message(job.conversationId, "system", error, job.runId);
    });
  }
  recover(): void {
    for (const job of this.jobs().filter((entry) => !entry.planSelection && ["ADMITTED", "RUNNING"].includes(entry.state)))
      this.complete(job, "服务已重启，本次请求已中断。已保存运行证据；收费回执须核对后再决定下一步，系统不会自动重发。", true);
  }
  close(): void {
    this.db.prepare("DELETE FROM service_lock WHERE owner=?").run(this.owner);
    this.db.close();
  }
}

// 从已保存引用核对说明与原文件可用性；不把名称或契约状态当作附件事实。
export async function publicSource({ sourcePath, requirementsPath, ...source }: RegisteredSource): Promise<SourceOption> {
  let hasRequirements = false;
  if (requirementsPath) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(requirementsPath));
      hasRequirements = Boolean(text.trim()) && Buffer.byteLength(text) <= 64 * 1024 && !text.includes("\0");
    } catch { /* 配套说明不可读时仅将当前来源标为不可用，不影响其他来源。 */ }
  }
  const sourceAvailable = await access(sourcePath, constants.R_OK).then(() => true, () => false);
  const reason = !sourceAvailable ? "原文件未找到或不可读取，请检查本机文件。"
    : requirementsPath && !hasRequirements ? "配套抽取说明缺失、不可读取或内容无效，请检查本机说明。" : source.reason;
  return { ...source, hasRequirements, supported: source.supported && sourceAvailable && (!requirementsPath || hasRequirements), ...(reason ? { reason } : {}) };
}

export function safeError(error: unknown): string {
  if (error instanceof WebError || error instanceof PlanError) return error.message;
  const value = String(error);
  if (/OPENAI_API_KEY|PI_MODEL_ID/.test(value)) return "模型未配置。请在本机 .env.local 设置 OPENAI_API_KEY 和 PI_MODEL_ID，再重新发送。";
  if (/Budget exhausted|budget|wall time|max_turns/i.test(value)) return "运行预算已用尽。请查看已保存结果和调用用量。";
  if (/uncertain|receipt|reconciliation/i.test(value)) return "模型回执不确定。系统已停止，需核对回执后再执行。";
  if (/independent business approval missing/i.test(value)) return "抽取结果与当前工作解释一致，仍需人工确认业务正确性。";
  if (/execution stopped before independent checking/i.test(value)) return "execution stopped before independent checking";
  if (value.startsWith("复用方案的独立检查发现异常")) return "复用方案的独立检查发现异常，版式可能变化；请人工复核原文、预期与实际值，规则变化须人工创建新版本。";
  if (/Agent response completed/i.test(value)) return "Agent 已完成本次回复，结果待人工复核。";
  if (/回答完成|没有执行抽取/.test(value)) return "这一轮只是回答，没有执行抽取。";
  if (/No progress in consecutive attempts/i.test(value)) return "连续修复未取得进展。请核对已保存的检查问题和脚本。";
  if (/unmapped|requirements.*changed|contract.*conflict|unknown.*rule/i.test(value)) return "说明尚未匹配已登记规则。请选择配套说明或先登记对应规则版本。";
  // Model gateway outages are actionable for the user, so keep the provider text (bounded and scrubbed of paths).
  if (/overloaded|rate limit|too many requests|timeout|timed out|ECONNRESET|ETIMEDOUT|socket hang up|502|503|504/i.test(value))
    return `模型网关暂时不可用：${value.replace(/\s+/g, " ").slice(0, 200)}`;
  return "操作失败。请查看运行状态与已保存证据。";
}
