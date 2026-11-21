import type { RunBinding } from "./plan-types.js";

export type RunStatus =
  | "PREPARE"
  | "INVENTORIED"
  | "ATTEMPT_READY"
  | "RUNNING"
  | "VALIDATED"
  | "REPAIR_PENDING"
  | "CONTRACT_PENDING"
  | "ANSWERED"
  | "PASS"
  | "AWAITING_HUMAN_REVIEW"
  | "FAIL"
  | "BLOCKED";

export type AttemptStatus = "READY" | "EXECUTED" | "VALIDATED" | "FAILED";
export type ValidationStatus = "PASS" | "REVIEW" | "FAIL" | "BLOCKED";
export type ActionStatus =
  "RESERVED" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "UNCERTAIN" | "REJECTED";

export type Budget = {
  maxAgentTurns: number;
  maxAttempts: number;
  maxToolCalls: number;
  maxExternalActions: number;
  maxWallTimeSeconds: number;
  maxAttemptTimeSeconds: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxNoProgressAttempts: number;
  maxSameActionRetries: number;
};

export type BudgetUsage = {
  agentTurns: number;
  attempts: number;
  toolCalls: number;
  externalActions: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
};

export type ArtifactRef = {
  artifactId: string;
  kind: string;
  relativePath: string;
  sha256: string;
  bytes: number;
};

export type Issue = {
  issueId: string;
  code: string;
  stage:
    "inventory" | "conversion" | "extraction" | "post_process" | "validation";
  sourceIds: string[];
  resultIds: string[];
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  message: string;
};

export type ValidationReport = {
  attemptId: string;
  status: ValidationStatus;
  issues: Issue[];
  checkedRuleIds: string[];
  unresolvedRuleIds: string[];
  uncheckedRules?: Array<{ id: string; reason: string }>;
  generatedFromInterpretation: string;
};

export type SourceCell = {
  rawValue?: unknown;
  displayedValue?: unknown;
  displayApproximate?: boolean;
  hiddenSheet?: boolean;
  mergedRange?: string | null;
  style?: {
    strike: boolean;
    richText: Array<{ text: string; strike: boolean }>;
    numberFormat: string;
    fontColor: string;
    fill: string;
    bold: boolean;
  };
  unsupported?: string[];
  sourceId: string;
  sheet: string;
  coordinate: string;
  row: number;
  column: number;
  value: unknown;
  formula: string | null;
  hiddenRow: boolean;
  hiddenColumn: boolean;
};

export type SourceInventory = {
  sourceSha256: string;
  sheets: Array<{
    name: string;
    maxRow: number;
    maxColumn: number;
    hidden: boolean;
    mergedRanges?: string[];
  }>;
  cells: SourceCell[];
  warnings: string[];
};

export type Attempt = {
  failure?: ArtifactRef;
  executionReceipt?: ArtifactRef;
  route?: "excel_script" | "converted_excel_script" | "direct_llm";
  feedbackRefs?: string[];
  startedAt?: string;
  rawCommitted?: boolean;
  attemptId: string;
  parentAttemptId: string | null;
  status: AttemptStatus;
  plan: ArtifactRef;
  parser: ArtifactRef;
  rawResult?: ArtifactRef;
  finalResult?: ArtifactRef;
  resultXlsx?: ArtifactRef;
  validation?: ArtifactRef;
  inputSnapshotSha256: string;
};

export type ActionReceipt = {
  actionId: string;
  operation: string;
  inputDigest: string;
  status: ActionStatus;
  replaySafe: boolean;
  replayPolicy?: string;
  reserved?: Partial<BudgetUsage>;
  actualUsage?: Partial<BudgetUsage>;
  output?: ArtifactRef[];
  error?: string;
};

export type RunManifest = {
  revision?: number;
  phase?: string;
  decision?: string;
  /** user | live | test — provenance of the run; absent on rows created before 2026-11-13. */
  origin?: string;
  refs?: Record<string, ArtifactRef>;
  attemptStates?: Record<string, Attempt>;
  binding?: Record<string, unknown> & Partial<RunBinding>;
  noProgress?: number;
  runId: string;
  sourcePath: string;
  sourceSha256: string;
  interpretationRef: ArtifactRef;
  status: RunStatus;
  currentAttemptId: string | null;
  budget: Budget;
  usage: BudgetUsage;
  attempts: string[];
  actions: ActionReceipt[];
};
