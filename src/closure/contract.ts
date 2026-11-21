import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { digest } from "./artifacts.js";
import { runsRootFor } from "./paths.js";
import { normalizePlanKey } from "./plan-normalization.js";

/**
 * A contract is the only place that says what a document means.
 * It is produced from the uploaded requirements, or from observed source structure,
 * and it must be confirmed by a person before a run counts as a real extraction.
 */

export type ContractFieldRole = "text" | "code" | "price" | "date" | "enum";

export type ContractFieldSource =
  | { kind: "column" }
  | { kind: "route_split"; from: string; side: "origin" | "destination" }
  | { kind: "join"; from: string[]; separator: string }
  | { kind: "constant"; value: string };

export type ContractField = {
  name: string;
  role: ContractFieldRole;
  aliases?: string[];
  source?: ContractFieldSource;
  required?: boolean;
  keepNegative?: boolean;
  enum?: string[];
  pattern?: string;
  fillFrom?: string;
  emit?: boolean;
};

export type ContractCheck = {
  id: string;
  kind:
    | "required_fields"
    | "price_preserved"
    | "enum"
    | "pattern"
    | "route_split"
    | "join_order"
    | "unique_source_ids"
    | "date_normalize"
    | "source_coverage";
  params: Record<string, unknown>;
  quote: string;
  status?: "active" | "unchecked";
  reason?: string;
};

export type Contract = {
  version: string;
  requirementsDigest: string;
  requirementsSource: "uploaded" | "observed";
  fields: ContractField[];
  route: { kind: "split" | "columns"; separators: string[] };
  checks: ContractCheck[];
  notes?: string[];
  questions?: string[];
};

export type ContractApproval = {
  approver: string;
  approvedAt: string;
  contractVersion: string;
  requirementsDigest: string;
  contractSha256: string;
};

export type ContractIssue = { code: string; message: string; path?: string };

const RESERVED = new Set(["recordId", "sourceId", "tariffType"]);
const ROLES = new Set<ContractFieldRole>(["text", "code", "price", "date", "enum"]);
/** Business vocabulary the model reaches for; mapped instead of rejected so a first draft can succeed. */
const ROLE_ALIASES: Record<string, ContractFieldRole> = {
  text: "text",
  string: "text",
  origin: "text",
  destination: "text",
  route: "text",
  remark: "text",
  remarks: "text",
  note: "text",
  port: "text",
  code: "code",
  price: "price",
  money: "price",
  amount: "price",
  number: "price",
  numeric: "price",
  date: "date",
  datetime: "date",
  time: "date",
  enum: "enum",
  currency: "enum",
  category: "enum",
};
export function normalizedRole(field: Partial<ContractField>): ContractFieldRole | undefined {
  const raw = typeof field.role === "string" ? field.role.trim().toLowerCase() : "";
  if (!raw) return "text";
  const mapped = ROLE_ALIASES[raw];
  if (!mapped) return undefined;
  if (mapped === "enum" && !(field.enum ?? []).length) return "text";
  return mapped;
}

/** Align a model's split-route wording with the source field the scanner reads. */
function normalizeSplitRouteFields(
  fields: ContractField[],
  route: unknown,
  checks: ContractCheck[],
): ContractField[] {
  if (!route || typeof route !== "object" || (route as { kind?: unknown }).kind !== "split")
    return fields;
  if (fields.some((field) => typeof field?.name !== "string" || !field.name.trim()))
    return fields;
  const origin = fields.find((field) => normalizePlanKey(field.name).toUpperCase() === "ORIGIN"),
    destination = fields.find((field) => normalizePlanKey(field.name).toUpperCase() === "DESTINATION");
  if (!origin || !destination) return fields;
  const routeCheck = checks.find((check) => check.kind === "route_split"),
    requested = Array.isArray(routeCheck?.params?.fields)
      ? (routeCheck.params.fields as unknown[]).filter((field): field is string => typeof field === "string")
      : [origin.name, destination.name],
    splitTargets = new Set(requested),
    originAliases = new Set((origin.aliases ?? []).map(normalizeAlias)),
    destinationAliases = new Set((destination.aliases ?? []).map(normalizeAlias)),
    sharedAliases = [...originAliases].filter((alias) => destinationAliases.has(alias) && ["航线", "ROUTE"].includes(alias));
  const routeFields = fields.filter(
    (field) =>
      ![origin.name, destination.name].includes(field.name) &&
      (field.aliases ?? []).some((alias) => ["航线", "ROUTE"].includes(normalizeAlias(alias))),
  );
  if (routeFields.length > 1) return fields;
  let routeField = routeFields[0];
  if (routeField && (routeField.source?.kind ?? "column") !== "column") return fields;
  if (!routeField && sharedAliases.length &&
    !fields.some((field) => normalizeAlias(field.name) === "ROUTE") &&
    [origin, destination].every((field) =>
      (field.source?.kind ?? "column") === "column" &&
      (field.aliases ?? []).every((alias) => sharedAliases.includes(normalizeAlias(alias))),
    )) {
    routeField = {
      name: "route",
      role: "text",
      aliases: sharedAliases,
      source: { kind: "column" },
      emit: false,
    };
    fields = [routeField, ...fields];
  }
  if (!routeField) return fields;
  const routeAliases = new Set((routeField.aliases ?? []).map(normalizeAlias));
  return fields.map((field) => {
    if (!splitTargets.has(field.name) || ![origin.name, destination.name].includes(field.name)) return field;
    const aliases = (field.aliases ?? []).map(normalizeAlias);
    if ((field.source?.kind ?? "column") !== "column") return field;
    if (!aliases.length || !aliases.every((alias) => ["航线", "ROUTE"].includes(alias) && routeAliases.has(alias))) return field;
    return {
      ...field,
      aliases: [],
      source: { kind: "route_split", from: routeField!.name, side: field.name === origin.name ? "origin" : "destination" },
    };
  });
}

/** Structural gate: a contract that fails here can never reach extraction. */
export function validateContract(input: unknown): { contract: Contract; issues: ContractIssue[] } {
  const issues: ContractIssue[] = [];
  const report = (code: string, message: string, path?: string): void => {
    issues.push({ code, message, ...(path ? { path } : {}) });
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Contract must be a JSON object");
  const value = input as Partial<Contract> & { fields?: unknown; checks?: unknown; route?: unknown };
  let fields = Array.isArray(value.fields) ? (value.fields as ContractField[]) : [];
  const checks = Array.isArray(value.checks) ? (value.checks as ContractCheck[]) : [];
  const route = value.route as Contract["route"] | undefined;
  fields = normalizeSplitRouteFields(fields, route, checks);
  const names = new Set<string>();
  if (!fields.length) report("NO_FIELDS", "Contract must declare at least one field");
  for (const [index, field] of fields.entries()) {
    const path = `fields[${index}]`;
    const name = typeof field?.name === "string" ? field.name.trim() : "";
    if (!name) { report("FIELD_NAME", "Field name is required", path); continue; }
    if (RESERVED.has(name)) report("FIELD_RESERVED", `Field name ${name} is owned by the host`, path);
    if (names.has(name)) report("FIELD_DUPLICATE", `Field ${name} is declared twice`, path);
    names.add(name);
    const role = normalizedRole(field);
    if (!role)
      report(
        "FIELD_ROLE",
        `Field ${name} has an unknown role ${JSON.stringify(field.role)}; allowed: text, code, price, date, enum`,
        path,
      );
    const source = field.source?.kind ?? "column";
    if (source === "column" && !(field.aliases ?? []).some((alias) => typeof alias === "string" && alias.trim()))
      report(
        "FIELD_ALIAS",
        `Field ${name} needs at least one header alias, for example {"name":"${name}","aliases":["表头文字"]}`,
        path,
      );
    if (source === "route_split") {
      if (field.source?.kind !== "route_split" || !field.source.from)
        report("FIELD_SOURCE", `Field ${name} must name the route field it splits`, path);
      else if (field.source.from === name)
        report("FIELD_SOURCE", `Field ${name} cannot split itself`, path);
      else if (!fields.some((other) => other?.name === (field.source as { from: string }).from))
        report("FIELD_SOURCE", `Field ${name} splits unknown field ${(field.source as { from: string }).from}`, path);
    }
    if (source === "join" && field.source?.kind === "join") {
      for (const from of field.source.from)
        if (!fields.some((other) => other?.name === from))
          report("FIELD_SOURCE", `Field ${name} joins unknown field ${from}`, path);
    }
    if (field.pattern) {
      try { new RegExp(field.pattern); }
      catch { report("FIELD_PATTERN", `Field ${name} has an invalid pattern`, path); }
    }
    if (field.fillFrom && !fields.some((other) => other?.name === field.fillFrom))
      report("FIELD_FILL", `Field ${name} fills from unknown field ${field.fillFrom}`, path);
  }
  if (!route || !["split", "columns"].includes(route.kind))
    report("ROUTE_KIND", "Contract must declare route kind split or columns");
  else if (route.kind === "split" && !(route.separators ?? []).length)
    report("ROUTE_SEPARATOR", "Split routes need at least one separator");
  if (route?.kind === "split") {
    const routeCheck = checks.find((check) => check.kind === "route_split"),
      targets = Array.isArray(routeCheck?.params?.fields)
        ? (routeCheck.params.fields as unknown[]).filter((field): field is string => typeof field === "string")
        : ["origin", "destination"].filter((name) => names.has(name));
    for (const target of targets) {
      const field = fields.find((candidate) => candidate.name === target);
      if (field && field.source?.kind !== "route_split")
        report("ROUTE_SOURCE", `Split route field ${target} must derive from the original route column`);
    }
  }
  const ids = new Set<string>();
  for (const [index, check] of checks.entries()) {
    const path = `checks[${index}]`;
    const id = typeof check?.id === "string" ? check.id.trim() : "";
    if (!id) { report("CHECK_ID", "Check id is required", path); continue; }
    if (ids.has(id)) report("CHECK_DUPLICATE", `Check ${id} appears twice`, path);
    ids.add(id);
    if (!check.quote || !check.quote.trim())
      report("CHECK_QUOTE", `Check ${id} must quote the requirement it enforces`, path);
    if (!check.kind) report("CHECK_KIND", `Check ${id} has no kind`, path);
    for (const field of referencedFields(check))
      if (!names.has(field))
        report("CHECK_FIELD", `Check ${id} references undeclared field ${field}`, path);
  }
  const atLeastOneValue = fields.some((field) => field.role === "price") || fields.some((field) => field.required);
  if (!atLeastOneValue)
    report("NO_VALUE_FIELD", "Contract needs a price or required field so records can be located");
  const contract: Contract = {
    version: typeof value.version === "string" && value.version.trim() ? value.version.trim() : `contract-${digest(JSON.stringify(input)).slice(0, 12)}`,
    requirementsDigest: typeof value.requirementsDigest === "string" ? value.requirementsDigest : "",
    requirementsSource: value.requirementsSource === "observed" ? "observed" : "uploaded",
    fields: fields.map((field) => ({
      ...field,
      role: normalizedRole(field) ?? "text",
      source: field.source ?? { kind: "column" },
    })),
    route: route && ["split", "columns"].includes(route.kind) ? { kind: route.kind, separators: route.separators ?? ["-", "="] } : { kind: "split", separators: ["-", "="] },
    checks: checks.map((check) => ({ ...check, params: check.params ?? {} })),
    ...(Array.isArray(value.notes) ? { notes: value.notes.map(String) } : {}),
    ...(Array.isArray(value.questions) ? { questions: value.questions.map(String) } : {}),
  };
  return { contract, issues };
}

function referencedFields(check: ContractCheck): string[] {
  const params = check.params ?? {};
  const single = ["field", "target", "routeField"];
  const many = ["fields", "from"];
  const out: string[] = [];
  for (const key of single) if (typeof params[key] === "string") out.push(params[key] as string);
  for (const key of many) if (Array.isArray(params[key])) out.push(...(params[key] as string[]));
  return out;
}

/** Fields that carry a record value and therefore appear in the output. */
export const emitFields = (contract: Contract): ContractField[] =>
  contract.fields.filter((field) => field.emit !== false && field.source?.kind !== "constant");

export const priceFields = (contract: Contract): string[] =>
  emitFields(contract).filter((field) => field.role === "price").map((field) => field.name);

export const requiredFields = (contract: Contract): string[] =>
  emitFields(contract).filter((field) => field.required).map((field) => field.name);

export type ScanConfig = {
  fields: ContractField[];
  route: Contract["route"];
  priceFields: string[];
  regionStartFields: string[];
  aliasToField: Map<string, string>;
  remarkJoins: Array<{ target: string; from: string[]; separator: string }>;
  routeSplits: Array<{ target: string; from: string; side: "origin" | "destination" }>;
  /** Header vocabulary override; the legacy freight vocabulary is the fallback. */
  resolveAlias?: (value: unknown) => string;
  /** Whether document-level remarks join into the remark field. */
  contextRemarks?: boolean;
  /** Contract mode: header runs define regions, so arbitrary column layouts work. */
  detectRegions?: boolean;
};

export const normalizeAlias = (value: unknown): string =>
  normalizePlanKey(String(value ?? ""))
    .replace(/[\s'’′"]/g, "")
    .toUpperCase();

/** Map a contract onto the scanning primitives the independent source re-scan needs. */
export function scanConfig(contract: Contract): ScanConfig {
  const aliasToField = new Map<string, string>();
  for (const field of contract.fields)
    for (const alias of field.aliases ?? []) {
      const key = normalizeAlias(alias);
      if (key && !aliasToField.has(key)) aliasToField.set(key, field.name);
    }
  const routeSplits = contract.fields
    .filter((field) => field.source?.kind === "route_split")
    .map((field) => ({
      target: field.name,
      from: (field.source as { from: string }).from,
      side: (field.source as { side: "origin" | "destination" }).side,
    }));
  const remarkJoins = contract.fields
    .filter((field) => field.source?.kind === "join")
    .map((field) => ({
      target: field.name,
      from: (field.source as { from: string[] }).from,
      separator: (field.source as { separator: string }).separator ?? " | ",
    }));
  const regionStartFields = [
    ...new Set([
      ...routeSplits.map((split) => split.from),
      ...contract.fields.filter((field) => normalizeAlias(field.name) === "ORIGIN" && field.source?.kind !== "route_split").map((field) => field.name),
    ]),
  ];
  return {
    fields: contract.fields,
    route: contract.route,
    priceFields: priceFields(contract),
    regionStartFields,
    aliasToField,
    remarkJoins,
    routeSplits,
    detectRegions: true,
  };
}

/** Registry: one folder per requirements digest, holding the contract and its approval. */
export const CONTRACT_ROOT = "contracts";

export type StoredContract = {
  contract: Contract;
  approved: boolean;
  approval?: ContractApproval;
  directory: string;
};

export function contractKey(requirementsDigest: string): string {
  if (!/^[a-f0-9]{64}$/.test(requirementsDigest))
    throw new Error("Requirements digest must be a sha256 hex string");
  return requirementsDigest;
}

export async function readStoredContract(root: string, requirementsDigest: string): Promise<StoredContract | undefined> {
  const directory = resolve(runsRootFor(root), CONTRACT_ROOT, contractKey(requirementsDigest));
  const file = resolve(directory, "contract.json");
  if (!existsSync(file)) return undefined;
  const contract = JSON.parse(await readFile(file, "utf8")) as Contract;
  const approvalFile = resolve(directory, "approval.json");
  if (!existsSync(approvalFile)) return { contract, approved: false, directory };
  const approval = JSON.parse(await readFile(approvalFile, "utf8")) as ContractApproval;
  const approved = approval.contractSha256 === digest(await readFile(file));
  return { contract, approved, approval, directory };
}

export async function listStoredContracts(root: string): Promise<StoredContract[]> {
  const base = resolve(runsRootFor(root), CONTRACT_ROOT);
  if (!existsSync(base)) return [];
  const out: StoredContract[] = [];
  for (const name of await readdir(base))
    try {
      const stored = await readStoredContract(root, name);
      if (stored) out.push(stored);
    } catch {}
  return out;
}

export function contractIsUsable(stored: StoredContract | undefined): boolean {
  return Boolean(stored && stored.approved);
}

/** Persist a drafted contract into the registry so later uploads of the same requirements reuse it. */
export async function writeStoredContract(root: string, contract: Contract): Promise<StoredContract> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  contractKey(contract.requirementsDigest);
  const directory = resolve(runsRootFor(root), CONTRACT_ROOT, contract.requirementsDigest);
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, "contract.json");
  await writeFile(file, JSON.stringify(contract, null, 2));
  const existing = await readStoredContract(root, contract.requirementsDigest);
  const approved = Boolean(existing?.approved);
  return { contract, approved, ...(approved && existing?.approval ? { approval: existing.approval } : {}), directory };
}

/** Human confirmation. Only this makes a contract the accepted baseline for a document. */
export async function approveStoredContract(
  root: string,
  requirementsDigest: string,
  approver: string,
  expectedContractSha256?: string,
  expectedContractVersion?: string,
): Promise<ContractApproval> {
  const stored = await readStoredContract(root, requirementsDigest);
  if (!stored) throw new Error("Contract has not been drafted yet");
  const file = resolve(stored.directory, "contract.json");
  // Read and validate the immutable candidate synchronously before writing the approval.
  // This keeps the identity check and approval write in one event-loop turn.
  const bytes = readFileSync(file);
  const currentContract = JSON.parse(bytes.toString()) as Contract;
  const contractSha256 = digest(bytes);
  if (expectedContractSha256 && contractSha256 !== expectedContractSha256)
    throw new Error("Contract candidate was replaced while awaiting confirmation");
  if (expectedContractVersion && currentContract.version !== expectedContractVersion)
    throw new Error("Contract candidate version changed while awaiting confirmation");
  const approvalFile = resolve(stored.directory, "approval.json");
  // Re-read after the async lookup: another confirmation may already have committed.
  const existing = existsSync(approvalFile) ? JSON.parse(readFileSync(approvalFile, "utf8")) as ContractApproval : undefined;
  if (existing?.contractSha256 === contractSha256 && existing.contractVersion === currentContract.version && existing.requirementsDigest === requirementsDigest)
    return existing;
  const approval: ContractApproval = {
    approver,
    approvedAt: new Date().toISOString(),
    contractVersion: currentContract.version,
    requirementsDigest,
    contractSha256,
  };
  writeFileSync(approvalFile, JSON.stringify(approval, null, 2));
  return approval;
}
