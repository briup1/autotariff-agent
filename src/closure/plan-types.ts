import type { ArtifactRef } from "./models.js";

export type PlanStatus = "candidate" | "confirmed" | "inactive";
export type Plan = {
  planId: string;
  workspace: string;
  name: string;
  normalizedName: string;
  supplier: string;
  supplierKey: string;
  docType: string;
  docTypeKey: string;
  normalizationVersion: "norm-v1";
  status: PlanStatus;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastResult: "REVIEW" | "BLOCKED" | "ANSWERED" | null;
};

export type PlanVersion = {
  planVersionId: string;
  planId: string;
  contractVersion: string;
  requirementsDigest: string;
  contractSha256: string;
  sourceSignatureRef: ArtifactRef | null;
  approvedAt: string;
  createdAt: string;
};

/** Optional for legacy runs; the closure ledger is the authority, never the web receipt. */
export type RunBinding = {
  planId: string;
  planVersionId: string;
  contractVersion: string;
  requirementsDigest: string;
  planNameSnapshot: string;
};

export type ArchivePlan = {
  requestId: string;
  requirementsDigest: string;
  name: string;
  supplier: string;
  docType: string;
  /** sourceSignature-v1 captured from the confirmed source when available. */
  sourceSignature?: string;
};

/** Locks the explicitly chosen rules and the source structure observed before admission. */
export type PlanSelection = {
  planId: string;
  planVersionId: string;
  planUpdatedAt: string;
  sourceSignature: string;
  sourceSha256: string;
};
export type PlanChoice = PlanSelection & {
  name: string;
  supplier: string;
  docType: string;
  contractVersion: string;
};

export type NewPlanVersion = {
  requestId: string;
  requirementsDigest: string;
  contractSha256: string;
  sourceId: string;
  expectedCurrentVersionId: string;
  confirmContract: boolean;
};
