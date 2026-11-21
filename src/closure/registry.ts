import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ArtifactStore, digest } from "./artifacts.js";
import type {
  ArtifactRef,
  SourceInventory,
  ValidationReport,
  RunManifest,
} from "./models.js";
import { scanExpected } from "./oracle.js";
export type TemplateVersion = {
  template: string;
  version: string;
  requirements: ArtifactRef;
  parser: ArtifactRef;
  verification: ArtifactRef;
  signature: string[];
  status: "pilot_candidate";
  postprocessVersion: string;
  checkerVersion: string;
  fieldRules: Array<{
    id: string;
    quote: string;
    dependencies: string[];
    checkerId?: string;
    implementationLines?: number[];
  }>;
};
export class TemplateRegistry {
  constructor(readonly store: ArtifactStore) {}
  safe(value: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error("Invalid template or version id");
  }
  signature(inventory: SourceInventory): string[] {
    return [
      ...new Set(
        scanExpected(inventory).regions.flatMap((r) =>
          Object.keys((r as { fields: Record<string, unknown> }).fields),
        ),
      ),
    ].sort();
  }
  async register(
    version: TemplateVersion,
    report: ValidationReport,
  ): Promise<ArtifactRef> {
    this.safe(version.template);
    this.safe(version.version);
    if (
      report.issues.length ||
      report.status === "FAIL" ||
      report.status === "BLOCKED"
    )
      throw new Error("Unverified parser cannot be registered");
    if (
      !version.fieldRules.length ||
      new Set(version.fieldRules.map((r) => r.id)).size !==
        version.fieldRules.length
    )
      throw new Error("Missing or duplicate requirement IDs");
    for (const rule of version.fieldRules)
      if (
        rule.dependencies.some(
          (id) => !version.fieldRules.some((r) => r.id === id),
        )
      )
        throw new Error("Requirement dependency missing");
    for (const ref of [
      version.requirements,
      version.parser,
      version.verification,
    ])
      await this.store.read(ref);
    const storedReport = JSON.parse(
      (await this.store.read(version.verification)).toString(),
    ) as ValidationReport;
    if (JSON.stringify(storedReport) !== JSON.stringify(report))
      throw new Error(
        "Verification report does not match its immutable artifact",
      );
    const runId = version.verification.artifactId.split(":")[0];
    const manifest = JSON.parse(
      await readFile(this.store.path(runId, "run_manifest.json"), "utf8"),
    ) as RunManifest;
    if (
      manifest.attemptStates?.[report.attemptId]?.parser.sha256 !==
        version.parser.sha256 ||
      manifest.refs?.requirements?.sha256 !== version.requirements.sha256
    )
      throw new Error(
        "Requirements, script and verification are not bound to the same validated run",
      );
    const interpretation = JSON.parse(
      (await this.store.read(manifest.interpretationRef)).toString(),
    ).interpretation as {
      clauses: Array<{ id: string; quote: string; checker?: string }>;
    };
    const parserLines = (await this.store.read(version.parser))
      .toString()
      .split("\n");
    const tokens: Record<string, string[]> = {
      routeSplit: ["origin", "destination"],
      containerFields: ["20GP", "40GP", "40HQ"],
      lssAndRemarks: ["运价备注", "remark", "LSS"],
      transitPort: ["中转港"],
      transitTime: ["航程"],
      routeCode: ["航线代码"],
      etdPriority: ["ETD"],
      validity: ["ETD"],
    };
    const fields = [...version.fieldRules];
    for (const clause of interpretation.clauses) {
      if (!report.checkedRuleIds.includes(clause.id))
        throw new Error(`Required clause lacks verification: ${clause.id}`);
      if (!fields.some((f) => f.id === clause.id))
        fields.push({
          id: clause.id,
          quote: clause.quote,
          dependencies: clause.id === "validity" ? ["etdPriority"] : [],
          checkerId: clause.checker ?? clause.id,
        });
    }
    const resolved = {
      ...version,
      fieldRules: fields.map((field) => {
        const checkerId =
          field.checkerId ??
          (report.checkedRuleIds.includes(field.id)
            ? field.id
            : ["origin", "destination"].includes(field.id)
              ? "routeSplit"
              : undefined);
        if (!checkerId || !report.checkedRuleIds.includes(checkerId))
          throw new Error(
            `Field lacks independent checker mapping: ${field.id}`,
          );
        return {
          ...field,
          quote:
            interpretation.clauses.find(
              (c) => c.id === field.id || c.id === checkerId,
            )?.quote ?? field.quote,
          checkerId,
          implementationLines: parserLines.flatMap((line, n) =>
            (tokens[field.id] ?? tokens[checkerId] ?? [field.id]).some(
              (token) => line.includes(token),
            )
              ? [n + 1]
              : [],
          ),
        };
      }),
    };
    const ref = await this.store.put(
      "registry",
      `templates/${version.template}/${version.version}.json`,
      JSON.stringify(resolved, null, 2),
      "template-version",
    );
    await this.store.snapshot(
      "registry",
      `templates/${version.template}/current.json`,
      { version: version.version, sha256: ref.sha256 },
    );
    return ref;
  }
  async get(template: string, version: string): Promise<TemplateVersion> {
    this.safe(template);
    this.safe(version);
    const path = this.store.path(
      "registry",
      `templates/${template}/${version}.json`,
    );
    await this.store.guard(path);
    const value = JSON.parse(await readFile(path, "utf8")) as TemplateVersion;
    for (const ref of [value.requirements, value.parser, value.verification])
      await this.store.read(ref);
    return value;
  }
  async find(
    template: string,
    inventory: SourceInventory,
  ): Promise<
    Array<{
      id: string;
      version: TemplateVersion;
      applicable: boolean;
      reason: string;
    }>
  > {
    this.safe(template);
    let files: string[] = [];
    try {
      files = await readdir(
        resolve(this.store.root, "registry/templates", template),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sig = this.signature(inventory),
      out = [];
    for (const file of files.filter(
      (f) => f.endsWith(".json") && f !== "current.json",
    )) {
      const version = await this.get(template, file.slice(0, -5));
      const applicable = version.signature.every((s) => sig.includes(s));
      out.push({
        id: `${template}@${version.version}`,
        version,
        applicable,
        reason: applicable
          ? "Same semantic fields; inspect layout and revalidate before reuse"
          : "Input lacks required source fields; reuse rejected",
      });
    }
    return out;
  }
  async requirement(
    template: string,
    version: string,
    id: string,
  ): Promise<unknown> {
    const v = await this.get(template, version),
      rule = v.fieldRules.find((r) => r.id === id);
    if (!rule) throw new Error("Unknown requirement");
    return {
      rule,
      dependencies: v.fieldRules.filter((r) =>
        rule.dependencies.includes(r.id),
      ),
      fullRequirements: (await this.store.read(v.requirements)).toString(),
    };
  }
  async current(template: string): Promise<TemplateVersion | undefined> {
    this.safe(template);
    let pointer: { version: string; sha256: string };
    try {
      pointer = JSON.parse(
        await readFile(
          this.store.path("registry", `templates/${template}/current.json`),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const bytes = await readFile(
      this.store.path(
        "registry",
        `templates/${template}/${pointer.version}.json`,
      ),
    );
    if (digest(bytes) !== pointer.sha256)
      throw new Error("Template version digest mismatch");
    return this.get(template, pointer.version);
  }
}
