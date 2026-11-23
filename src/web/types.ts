import type { BudgetUsage, Issue } from "../closure/models.js";
import type { Plan, PlanChoice, RunBinding } from "../closure/plan-types.js";

export type SourceOption = {
  id: string;
  label: string;
  filename: string;
  requirementsName: string;
  kind: "sample" | "upload";
  templateName: string;
  supported: boolean;
  reason?: string;
  contractStatus?: "missing" | "candidate" | "confirmed";
  contractVersion?: string;
  supplier?: string;
  docType?: string;
};

export type ConversationSummary = {
  planSelection?: PlanChoice;
  id: string;
  title: string;
  sourceId: string;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  runIds: string[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  runId?: string;
};

export type RunSummary = Partial<RunBinding> & {
  reuseCheckStatus?: "pending" | "clean" | "findings" | "unavailable";
  businessApproval?: false;
  planCurrentName?: string;
  runId: string;
  label: string;
  origin: "live" | "history";
  phase: string;
  decision: string;
  active: boolean;
  createdAt: string;
  sourceName: string;
  attemptCount: number;
  parentRunId?: string;
  contractStatus?: "missing" | "candidate" | "confirmed";
  contractVersion?: string;
  contractDigest?: string;
  contractSha256?: string;
  uncheckedRules?: Array<{ id: string; reason: string }>;
  issueCount?: number;
  recordCount?: number;
  error?: string;
  stopReason?: string;
  conversationId?: string;
};

export type ActionView = {
  id: string;
  operation: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type AttemptView = {
  id: string;
  parentAttemptId: string | null;
  status: string;
  route?: string;
  issueCount?: number;
  validationStatus?: string;
  reportStatus: "available" | "pending" | "error";
  recordCount?: number;
  xlsxStatus: "missing" | "available" | "error";
  xlsxPath?: string;
  finalResultPath?: string;
};

export type ArtifactView = {
  path: string;
  label: string;
  kind: string;
  bytes: number;
};

export type RunDetail = {
  run: RunSummary;
  actions: ActionView[];
  attempts: AttemptView[];
  selectedAttemptId?: string;
  records: { status: "available" | "pending" | "error"; items: Record<string, unknown>[]; total: number; offset: number; limit: number };
  issues: Issue[];
  artifacts: ArtifactView[];
  usage: BudgetUsage;
  stopReason?: string;
  modelFailure?: string;
};

export type ArtifactContent = {
  path: string;
  content: string;
  kind: string;
  bytes: number;
  truncated: boolean;
  sheets?: Array<{ name: string; rows: unknown[][]; truncated: boolean; totalRows: number; totalColumns: number }>;
};

export type TestEvidence = {
  id: string;
  label: string;
  origin: "offline" | "live";
  createdAt: string;
  status: "PASS" | "FAIL" | "MISSING";
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  path?: string;
};

export type BudgetView = {
  taskId: string;
  maxCalls: number;
  usedCalls: number;
  reservedCalls: number;
  remainingCalls: number;
  uncertainCalls: number;
  inputTokens: number;
  outputTokens: number;
  amount: null;
};

export type BootstrapView = {
  plans: Plan[];
  sources: SourceOption[];
  conversations: ConversationSummary[];
  history: RunSummary[];
  budget: BudgetView;
  tests: TestEvidence[];
  modelConfigured: boolean;
};

export type ConversationDetail = {
  conversation: ConversationSummary;
  messages: ChatMessage[];
  runs: RunSummary[];
};
