import type { RunStatus } from "./models.js";

const transitions: Record<RunStatus, RunStatus[]> = {
  PREPARE: ["INVENTORIED", "BLOCKED"],
  INVENTORIED: ["ATTEMPT_READY", "CONTRACT_PENDING", "BLOCKED"],
  CONTRACT_PENDING: ["ATTEMPT_READY", "INVENTORIED", "BLOCKED"],
  ATTEMPT_READY: ["RUNNING", "BLOCKED"],
  RUNNING: ["VALIDATED", "BLOCKED"],
  VALIDATED: ["REPAIR_PENDING", "PASS", "AWAITING_HUMAN_REVIEW", "FAIL", "BLOCKED"],
  REPAIR_PENDING: ["ATTEMPT_READY", "BLOCKED"],
  ANSWERED: [],
  PASS: [],
  AWAITING_HUMAN_REVIEW: [],
  FAIL: [],
  BLOCKED: [],
};

export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (!transitions[from].includes(to)) throw new Error(`Invalid run transition ${from} -> ${to}`);
  return to;
}
