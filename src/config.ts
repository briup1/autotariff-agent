import process from "node:process";
import { resolve } from "node:path";
import { PROJECT_ROOT, PYTHON } from "./closure/paths.js";
import type { Budget } from "./closure/models.js";
import { optionalInteger, readFlatConfig, requireString } from "./config-file.js";

export type RuntimeConfig = {
  projectRoot?: string;
  provider: string;
  modelId: string;
  storagePath: string;
  baseUrl?: string;
  /** Explicit override; undefined means the configured budget file decides. */
  maxAgentTurns?: number;
  /** Budget overrides read from config/policies/budget.yaml. */
  budget?: Partial<Budget>;
  systemPromptPath?: string;
  sourcePath: string;
  pythonBin: string;
  runDate: string;
  runYear: number;
  templateName?: string;
  requirementsPath?: string;
  liveBudgetTask?: "visual-center-2026-11-03";
  contractFirst?: boolean;
};

const pad = (value: number): string => String(value).padStart(2, "0");
/** Local calendar day. UTC would report yesterday for the first hours of the Beijing morning. */
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const BUDGET_KEYS: Record<keyof Budget, string> = {
  maxAgentTurns: "max_agent_turns",
  maxAttempts: "max_attempts",
  maxToolCalls: "max_tool_calls",
  maxExternalActions: "max_external_actions",
  maxWallTimeSeconds: "max_wall_time_seconds",
  maxAttemptTimeSeconds: "max_attempt_time_seconds",
  maxInputTokens: "max_input_tokens",
  maxOutputTokens: "max_output_tokens",
  maxNoProgressAttempts: "max_no_progress_attempts",
  maxSameActionRetries: "max_same_action_retries",
};

export type AgentContract = {
  version: string;
  systemPrompt: string;
  budget: Partial<Budget>;
};

/** The agent contract is the single entry point for prompt and budget, instead of code defaults. */
export function loadAgentContract(root = PROJECT_ROOT): AgentContract {
  const path = resolve(root, "config/llm/agent-contract.yaml");
  const declared = readFlatConfig(path);
  const version = requireString(declared, "version", path);
  const systemPrompt = resolve(root, requireString(declared, "system_prompt", path));
  const budgetPath = resolve(root, requireString(declared, "budget", path));
  const raw = readFlatConfig(budgetPath);
  const budget: Partial<Budget> = {};
  for (const [field, key] of Object.entries(BUDGET_KEYS) as Array<[keyof Budget, string]>) {
    const value = optionalInteger(raw, key, budgetPath);
    if (value !== undefined) budget[field] = value;
  }
  const unknown = Object.keys(raw).filter((key) => !Object.values(BUDGET_KEYS).includes(key));
  if (unknown.length)
    throw new Error(`${budgetPath} declares unsupported keys: ${unknown.join(", ")}`);
  if (!Object.keys(budget).length) throw new Error(`${budgetPath} declares no budget values`);
  return { version, systemPrompt, budget };
}

export function loadConfig(): RuntimeConfig {
  const provider = process.env.PI_MODEL_PROVIDER ?? "openai";
  const modelId = process.env.PI_MODEL_ID;
  const storagePath =
    process.env.PI_STORAGE_PATH ?? "./template_runs/pi-session.sqlite";
  const baseUrl = process.env.OPENAI_BASE_URL || undefined;
  const maxAgentTurns = process.env.PI_MAX_AGENT_TURNS === undefined
    ? undefined
    : Number(process.env.PI_MAX_AGENT_TURNS);
  const sourcePath =
    process.env.PI_SOURCE_PATH ??
    "../autotariffextract/data/20260811-识别文件/怡升昌/上海宁波深圳运价表.xlsx";
  const pythonBin = process.env.PI_PYTHON_BIN ?? PYTHON;
  const runDate = process.env.PI_RUN_DATE ?? localDate();
  const runYear = Number(process.env.PI_RUN_YEAR ?? runDate.slice(0, 4));
  const contract = loadAgentContract(PROJECT_ROOT);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is empty. Fill it in .env.local before starting the agent.",
    );
  }
  if (
    maxAgentTurns !== undefined &&
    (!Number.isSafeInteger(maxAgentTurns) || maxAgentTurns < 1)
  ) {
    throw new Error("PI_MAX_AGENT_TURNS must be an integer greater than zero.");
  }
  if (!modelId) {
    throw new Error(
      "PI_MODEL_ID is empty. Set the provider model id in .env.local.",
    );
  }
  if (!Number.isInteger(runYear) || runYear < 2000 || runYear > 2100)
    throw new Error("PI_RUN_YEAR must be a valid year.");

  return {
    provider,
    modelId,
    storagePath:
      storagePath === ":memory:"
        ? storagePath
        : resolve(PROJECT_ROOT, storagePath),
    baseUrl,
    ...(maxAgentTurns === undefined ? {} : { maxAgentTurns }),
    budget: contract.budget,
    systemPromptPath: contract.systemPrompt,
    sourcePath: resolve(PROJECT_ROOT, sourcePath),
    pythonBin,
    runDate,
    runYear,
    templateName:
      process.env.PI_TEMPLATE_NAME ?? "FREIGHT_YISHENGCHANG_EXCEL_01",
    requirementsPath:
      process.env.PI_REQUIREMENTS_PATH ??
      resolve(
        PROJECT_ROOT,
        "../autotariffextract/data/20260811-识别文件/怡升昌/怡升昌说明.txt",
      ),
    contractFirst: process.env.PI_CONTRACT_FIRST === "1",
  };
}
