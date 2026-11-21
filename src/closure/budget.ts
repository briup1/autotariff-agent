import type { Budget, BudgetUsage } from "./models.js";

export function assertBudget(budget: Budget, usage: BudgetUsage, field: keyof Omit<BudgetUsage, "startedAt">): void {
  const limits: Record<string, number> = {
    agentTurns: budget.maxAgentTurns,
    attempts: budget.maxAttempts,
    toolCalls: budget.maxToolCalls,
    externalActions: budget.maxExternalActions,
    inputTokens: budget.maxInputTokens,
    outputTokens: budget.maxOutputTokens,
  };
  if (usage[field] >= limits[field]) throw new Error(`Budget exhausted: ${field}`);
}
