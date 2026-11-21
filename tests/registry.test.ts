import { beforeAll, it, expect } from "vitest";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { ClosureRuntime } from "../src/closure/runtime.js";
import {
  TemplateRegistry,
  type TemplateVersion,
} from "../src/closure/registry.js";
import { PROJECT_ROOT, PYTHON } from "../src/closure/paths.js";
import { runProcess } from "../src/closure/execute.js";
import { inspectSource } from "../src/closure/source.js";
import type { ValidationReport } from "../src/closure/models.js";
const root = resolve(PROJECT_ROOT, "template_runs/registry-fixtures");
const template = `registry-test-${Date.now()}`;
let first: ClosureRuntime,
  registry: TemplateRegistry,
  version: TemplateVersion,
  report: ValidationReport,
  parser: string;
beforeAll(async () => {
  await runProcess(PYTHON, [
    resolve(PROJECT_ROOT, "src/workers/fixtures.py"),
    root,
  ]);
  parser = await readFile(
    resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
    "utf8",
  );
  first = new ClosureRuntime({
    provider: "offline",
    modelId: "none",
    sourcePath: resolve(root, "small.xlsx"),
    requirementsPath: resolve(
      PROJECT_ROOT,
      "fixtures/controlled-requirements.txt",
    ),
    templateName: template,
    pythonBin: PYTHON,
    runDate: "2026-11-03",
    runYear: 2026,
    maxAgentTurns: 12,
    storagePath: ":memory:",
  });
  await first.bootstrap();
  await first.inspect();
  await first.prepare(parser, {
    route: "excel_script",
    reason: "versioned pilot baseline",
  });
  await first.execute();
  await first.postprocess();
  report = await first.validate();
  registry = new TemplateRegistry(first.store);
  version = {
    template,
    version: "v001",
    requirements: first.manifest.refs!.requirements,
    parser: first.attempt.parser,
    verification: first.attempt.validation!,
    signature: registry.signature(first.inventory),
    status: "pilot_candidate",
    postprocessVersion: "fields-v002",
    checkerVersion: "independent-v002",
    fieldRules: [
      { id: "origin", quote: "Route left side is origin", dependencies: [] },
      {
        id: "validity",
        quote: "start frozen date; end ETD",
        dependencies: ["origin"],
      },
    ],
  };
  await registry.register(version, report);
  first.close();
}, 20000);
it("C02 C18 verified candidate applies to unseen matching layout; incompatible input explicitly rejected", async () => {
  const unseen = await inspectSource(resolve(root, "reordered.xlsx"), PYTHON),
    found = await registry.find(template, unseen);
  expect(found[0].applicable).toBe(true);
  const other = await inspectSource(resolve(root, "unsupported.xlsx"), PYTHON);
  expect((await registry.find(template, other))[0].applicable).toBe(false);
});
it("C20 stores verbatim per-field requirements, actual parser and exact independent report bindings", async () => {
  const saved = await registry.get(template, "v001");
  expect(saved.status).toBe("pilot_candidate");
  expect(
    (
      (await registry.requirement(template, "v001", "validity")) as {
        dependencies: unknown[];
      }
    ).dependencies,
  ).toHaveLength(1);
  await expect(
    registry.register(
      { ...version, version: "forged", requirements: version.parser },
      report,
    ),
  ).rejects.toThrow("not bound");
});
it("C21 copies baseline, locally adapts prime header and reordered columns, runs old and unseen regressions", async () => {
  const adapted = parser.replace("[\\s'’]", "[\\s'’′]");
  expect(adapted).not.toBe(parser);
  for (const file of ["small.xlsx", "reordered.xlsx"]) {
    const r = new ClosureRuntime({
      ...first.config,
      sourcePath: resolve(root, file),
    });
    try {
      await r.bootstrap();
      await r.inspect();
      await r.prepare(
        adapted,
        { route: "excel_script", reason: "local header alias adaptation only" },
        version.parser,
      );
      await r.execute();
      await r.postprocess();
      expect((await r.validate()).issues).toEqual([]);
      expect((await r.store.read(version.parser)).toString()).toBe(parser);
    } finally {
      r.close();
    }
  }
}, 20000);
it("C22 changed requirements conflict is explicit and historical version remains readable", async () => {
  const changed = resolve(root, "changed-requirements.txt");
  await writeFile(changed, "Business requirement changed; not yet verified");
  const r = new ClosureRuntime({ ...first.config, requirementsPath: changed });
  try {
    await expect(r.bootstrap()).rejects.toThrow("requirements changed");
    expect((await registry.get(template, "v001")).requirements.sha256).toBe(
      version.requirements.sha256,
    );
  } finally {
    r.close();
  }
});
it("C23 active run pins version and digests; missing or modified artifacts fail closed", async () => {
  const r = new ClosureRuntime(first.config);
  try {
    await r.bootstrap();
    expect(r.manifest.binding?.templateVersion).toBe("v001");
    const pinned = r.manifest.refs!.baselineParser;
    const path = r.store.path(r.manifest.runId, pinned.relativePath);
    await writeFile(path, "tampered");
    await expect(r.store.read(pinned)).rejects.toThrow("digest mismatch");
    await writeFile(path, parser);
    await unlink(path);
    await expect(r.store.read(pinned)).rejects.toThrow();
  } finally {
    r.close();
  }
});
it("C24 long requirements stay fully queryable; unknown mandatory check cannot pass", async () => {
  const r = new ClosureRuntime({
    ...first.config,
    templateName: `long-${Date.now()}`,
  });
  try {
    await r.bootstrap();
    const original = JSON.parse(
      (await r.store.read(r.manifest.interpretationRef)).toString(),
    );
    original.interpretation.clauses.push({
      id: "unknown-required-field",
      quote: "must verify a field with no checker",
    });
    const ref = await r.save(
      "contract/long-requirements.json",
      original,
      "working-interpretation",
    );
    r.manifest.interpretationRef = ref;
    r.manifest.refs!.interpretation = ref;
    for (let n = 0; n < 100; n++)
      original.interpretation.clauses.push({
        id: `long-field-${n}`,
        quote: `Complete original requirement ${n}`,
        checker: "routeSplit",
      });
    const long = await r.save(
      "contract/long-requirements-full.json",
      original,
      "working-interpretation",
    );
    r.manifest.interpretationRef = long;
    r.manifest.refs!.interpretation = long;
    const read = (await r.readArtifact(long.relativePath, 300, 100)) as {
      text: string;
    };
    expect(read.text).toContain("long-field");
    await r.inspect();
    await r.prepare(parser, {
      route: "excel_script",
      reason: "required-rule coverage gate",
    });
    await r.execute();
    await r.postprocess();
    const result = await r.validate();
    expect(result.status).toBe("BLOCKED");
    expect(result.unresolvedRuleIds).toContain("unknown-required-field");
    expect(result.checkedRuleIds).toContain("long-field-99");
  } finally {
    r.close();
  }
}, 15000);
it("C23 a newly verified requirement version updates new runs while an active run retains the old bundle", async () => {
  const old = new ClosureRuntime(first.config);
  await old.bootstrap();
  const newNote = resolve(root, "requirements-v002.txt");
  await writeFile(
    newNote,
    (await readFile(first.config.requirementsPath!, "utf8")) +
      "\nVersion 002: missing-year dates use frozen runYear 2027.\n",
  );
  const verifier = new ClosureRuntime({
    ...first.config,
    templateName: `verification-v2-${Date.now()}`,
    requirementsPath: newNote,
    runYear: 2027,
  });
  try {
    await verifier.bootstrap();
    await verifier.inspect();
    await verifier.prepare(parser, {
      route: "excel_script",
      reason: "new requirement version uses 2027 frozen year",
    });
    await verifier.execute();
    await verifier.postprocess();
    const checked = await verifier.validate();
    expect(checked.issues).toEqual([]);
    const final = JSON.parse(
      (await verifier.store.read(verifier.attempt.finalResult!)).toString(),
    );
    expect(final[0].ETD).toBe("2027-08-30");
    await registry.register(
      {
        ...version,
        version: "v002",
        requirements: verifier.manifest.refs!.requirements,
        parser: verifier.attempt.parser,
        verification: verifier.attempt.validation!,
        fieldRules: [
          ...version.fieldRules,
          {
            id: "etdYear2027",
            checkerId: "etdPriority",
            quote: "Missing-year dates use frozen 2027",
            dependencies: ["validity"],
          },
        ],
      },
      checked,
    );
    expect(old.manifest.binding?.templateVersion).toBe("v001");
    expect(old.manifest.refs!.baselineRequirements.sha256).toBe(
      version.requirements.sha256,
    );
    const next = new ClosureRuntime({
      ...first.config,
      requirementsPath: newNote,
      runYear: 2027,
    });
    try {
      await next.bootstrap();
      expect(next.manifest.binding?.templateVersion).toBe("v002");
      expect(next.manifest.refs!.baselineRequirements.sha256).toBe(
        verifier.manifest.refs!.requirements.sha256,
      );
    } finally {
      next.close();
    }
  } finally {
    old.close();
    verifier.close();
  }
}, 15000);
it("C20 C24 pilot metadata covers every frozen clause with checker identity and actual implementation coordinates", async () => {
  const saved = await registry.get(template, "v001");
  const contract = JSON.parse(
    (await first.store.read(first.manifest.interpretationRef)).toString(),
  );
  for (const clause of contract.interpretation.clauses) {
    const field = saved.fieldRules.find((f) => f.id === clause.id);
    expect(field?.checkerId).toBe(clause.id);
    expect(field?.implementationLines?.length).toBeGreaterThan(0);
  }
});
it("C24 a new unknown requirements file never borrows Yi Sheng Chang clauses and cannot extract without a contract", async () => {
  const note = resolve(root, "unknown-new-template.txt");
  await writeFile(
    note,
    "An additional mandatory field with a new unimplemented business calculation.",
  );
  const r = new ClosureRuntime({
    ...first.config,
    templateName: `unknown-template-${Date.now()}`,
    requirementsPath: note,
  });
  try {
    await r.bootstrap();
    // Fail-closed moved forward: the run stays open only so the Agent can declare a contract.
    expect(r.manifest.binding?.contractRequired).toBe(true);
    expect(r.manifest.binding?.contractStatus).toBe("missing");
    expect(r.manifest.phase).toBe("CONTRACT_PENDING");
    const frozen = JSON.parse(
      (await r.store.read(r.manifest.interpretationRef)).toString(),
    );
    expect(frozen.interpretation.clauses[0].quote).toContain(
      "additional mandatory field",
    );
    expect(
      frozen.interpretation.clauses.some((c: { quote: string }) =>
        c.quote.includes("源文件航线"),
      ),
    ).toBe(false);
    // No contract means no extraction attempt, even if the Agent tries.
    await r.inspect(0, 40);
    await expect(
      r.prepare("import sys\nprint('[]')", { route: "excel_script", reason: "test" }),
    ).rejects.toThrow("draft_contract");
    expect(r.manifest.attempts).toEqual([]);
  } finally {
    r.close();
  }
});
