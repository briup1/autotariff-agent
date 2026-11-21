import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Budget, BudgetUsage } from "./models.js";
import type { RunBinding } from "./plan-types.js";

export type Usage = Partial<Omit<BudgetUsage, "startedAt">>;
export type LedgerAction = {
  id: string;
  key: string;
  operation: string;
  status: string;
  policy: string;
  reserved: Usage;
  actual?: Usage;
  result?: unknown;
  error?: string;
  retries: number;
  startedAt?: string;
  finishedAt?: string;
};
const limits: Record<string, keyof Budget> = {
  agentTurns: "maxAgentTurns",
  attempts: "maxAttempts",
  toolCalls: "maxToolCalls",
  externalActions: "maxExternalActions",
  inputTokens: "maxInputTokens",
  outputTokens: "maxOutputTokens",
};

/** SQLite owns action identity, reservations and the business snapshot in one transaction. */
export class Ledger {
  readonly db: DatabaseSync;
  readonly owner = randomUUID();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, state TEXT NOT NULL, owner TEXT, pid INTEGER);
      CREATE TABLE IF NOT EXISTS actions(run TEXT, key TEXT, data TEXT NOT NULL, PRIMARY KEY(run,key));
      CREATE TABLE IF NOT EXISTS plans(
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, normalized_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate','confirmed','inactive')), data TEXT NOT NULL,
        UNIQUE(workspace,normalized_name));
      CREATE INDEX IF NOT EXISTS plans_workspace_status ON plans(workspace,status);
      CREATE TABLE IF NOT EXISTS plan_versions(
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), contract_version TEXT NOT NULL,
        data TEXT NOT NULL, UNIQUE(plan_id,contract_version), UNIQUE(id,plan_id));
      CREATE TRIGGER IF NOT EXISTS plan_versions_immutable BEFORE UPDATE ON plan_versions
        BEGIN SELECT RAISE(ABORT,'PlanVersion is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS plan_versions_immutable_delete BEFORE DELETE ON plan_versions
        BEGIN SELECT RAISE(ABORT,'PlanVersion is immutable'); END;
      CREATE TABLE IF NOT EXISTS plan_version_requests(
        workspace TEXT NOT NULL, request_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id),
        version_id TEXT NOT NULL, PRIMARY KEY(workspace,request_id),
        FOREIGN KEY(version_id,plan_id) REFERENCES plan_versions(id,plan_id));
      CREATE TABLE IF NOT EXISTS plan_archive_requests(
        workspace TEXT NOT NULL, request_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id),
        PRIMARY KEY(workspace,request_id));
      CREATE TABLE IF NOT EXISTS run_bindings(
        run_id TEXT PRIMARY KEY REFERENCES runs(id), workspace TEXT NOT NULL, request_id TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(id), plan_version_id TEXT NOT NULL,
        data TEXT NOT NULL, UNIQUE(workspace,request_id),
        FOREIGN KEY(plan_version_id,plan_id) REFERENCES plan_versions(id,plan_id));
      CREATE INDEX IF NOT EXISTS run_bindings_plan ON run_bindings(plan_id);
      CREATE INDEX IF NOT EXISTS run_bindings_version ON run_bindings(plan_version_id);
      CREATE TRIGGER IF NOT EXISTS run_bindings_immutable BEFORE UPDATE ON run_bindings
        BEGIN SELECT RAISE(ABORT,'RunBinding is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS plan_terminal_result AFTER UPDATE OF state ON runs
        WHEN json_extract(NEW.state,'$.phase')='TERMINAL'
          AND json_extract(NEW.state,'$.decision') IN ('REVIEW','BLOCKED','ANSWERED')
        BEGIN
          UPDATE plans SET data=json_set(data,'$.lastResult',(
            SELECT json_extract(r.state,'$.decision') FROM runs r JOIN run_bindings b ON b.run_id=r.id
            WHERE b.plan_id=plans.id AND json_extract(r.state,'$.phase')='TERMINAL'
              AND json_extract(r.state,'$.decision') IN ('REVIEW','BLOCKED','ANSWERED')
            ORDER BY json_extract(r.state,'$.binding.finishedAt') DESC,r.rowid DESC LIMIT 1
          )) WHERE id=(SELECT plan_id FROM run_bindings WHERE run_id=NEW.id);
        END;`);
  }
  runBinding(runId: string): RunBinding | undefined {
    const row = this.db.prepare("SELECT data FROM run_bindings WHERE run_id=?").get(runId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as RunBinding : undefined;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  create(id: string, state: unknown): void {
    this.db
      .prepare("INSERT INTO runs VALUES(?,?,?,?)")
      .run(id, JSON.stringify(state), this.owner, process.pid);
  }
  acquire(id: string): unknown {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as
        { state: string; owner: string; pid: number } | undefined;
      if (!row) throw new Error("Unknown run");
      if (row.owner && row.owner !== this.owner) {
        let alive = true;
        try {
          process.kill(row.pid, 0);
        } catch {
          alive = false;
        }
        if (alive) throw new Error("Run already has an active writer");
      }
      this.db
        .prepare("UPDATE runs SET owner=?,pid=? WHERE id=?")
        .run(this.owner, process.pid, id);
      return JSON.parse(row.state);
    });
  }
  save(id: string, state: unknown): void {
    const binding = this.runBinding(id);
    if (binding) {
      const actual = (state as {binding?: Record<string,unknown>}).binding;
      if (Object.entries(binding).some(([key,value]) => actual?.[key] !== value)) throw new Error("RunBinding is immutable");
    }
    const changed = this.db
      .prepare("UPDATE runs SET state=? WHERE id=? AND owner=?")
      .run(JSON.stringify(state), id, this.owner);
    if (changed.changes !== 1) throw new Error("Run writer ownership lost");
  }
  list(id: string): LedgerAction[] {
    return (
      this.db
        .prepare("SELECT data FROM actions WHERE run=? ORDER BY rowid")
        .all(id) as { data: string }[]
    ).map((x) => JSON.parse(x.data));
  }
  get(id: string, key: string): LedgerAction | undefined {
    const row = this.db
      .prepare("SELECT data FROM actions WHERE run=? AND key=?")
      .get(id, key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  put(id: string, action: LedgerAction): void {
    this.db
      .prepare(
        "INSERT INTO actions VALUES(?,?,?) ON CONFLICT(run,key) DO UPDATE SET data=excluded.data",
      )
      .run(id, action.key, JSON.stringify(action));
  }
  reserve(
    id: string,
    key: string,
    operation: string,
    usage: Usage,
    budget: Budget,
    startedAt: string,
    policy = "local_replayable",
  ): LedgerAction {
    return this.transaction(() => {
      const old = this.get(id, key);
      if (old?.status === "REJECTED")
        throw new Error("Preflight request was rejected; no automatic retry");
      if (old?.status === "COMPLETED") return old;
      if (old) {
        if (old.policy === "never_auto_retry") {
          old.status = "UNCERTAIN";
          old.error = "Receipt incomplete; manual reconciliation required";
          this.put(id, old);
          return old;
        }
        if (old.retries >= budget.maxSameActionRetries)
          throw new Error("Safe retry budget exhausted");
      }
      if (
        Date.now() - Date.parse(startedAt) >=
        budget.maxWallTimeSeconds * 1000
      )
        throw new Error("BLOCKED: wall time exhausted");
      const actions = this.list(id);
      for (const [field, maximum] of Object.entries(limits)) {
        const total = actions.reduce(
          (n, a) =>
            n +
            (a.actual?.[field as keyof Usage] ??
              a.reserved[field as keyof Usage] ??
              0),
          0,
        );
        if (total + (usage[field as keyof Usage] ?? 0) > budget[maximum])
          throw new Error(`Budget exhausted: ${field}`);
      }
      const reserved: Usage = { ...usage };
      if (old)
        for (const k of Object.keys(limits) as (keyof Usage)[])
          reserved[k] = (old.reserved[k] ?? 0) + (usage[k] ?? 0);
      const action: LedgerAction = {
        startedAt: new Date().toISOString(),
        id: old?.id ?? randomUUID(),
        key,
        operation,
        status: "STARTED",
        policy,
        reserved,
        retries: old ? old.retries + 1 : 0,
      };
      this.put(id, action);
      return action;
    });
  }
  totals(id: string): Usage {
    const out: Usage = {};
    for (const a of this.list(id))
      for (const k of Object.keys(limits) as (keyof Usage)[])
        out[k] = (out[k] ?? 0) + (a.actual?.[k] ?? a.reserved[k] ?? 0);
    return out;
  }
  release(id: string): void {
    this.db
      .prepare("UPDATE runs SET owner=NULL,pid=NULL WHERE id=? AND owner=?")
      .run(id, this.owner);
  }
  close(): void {
    this.db.close();
  }
}
