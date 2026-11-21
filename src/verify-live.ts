import { readFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ClosureRuntime } from "./closure/runtime.js";
import { TemplateRegistry, type TemplateVersion } from "./closure/registry.js";
import { PROJECT_ROOT, PYTHON, runsRootFor } from "./closure/paths.js";
import { runProcess } from "./closure/execute.js";
import { ArtifactStore, textDiff } from "./closure/artifacts.js";
import { loadConfig } from "./config.js";
import { runPi } from "./index.js";
import type { ValidationReport } from "./closure/models.js";
import { injectConversionLoss } from "./closure/conversion-fault-fixture.js";
import { DatabaseSync } from "node:sqlite";
import { digest } from "./closure/artifacts.js";
const root = resolve(runsRootFor(PROJECT_ROOT), "live-fixtures"),
  summaryPath = resolve(runsRootFor(PROJECT_ROOT), "live-acceptance.json");
const config = loadConfig(),
  store = new ArtifactStore(PROJECT_ROOT),
  template = "pilot-controlled-live";
type Evidence = {
  runId: string;
  status: "PASS" | "FAIL";
  report?: string;
  details?: unknown;
};
let results: Record<string, Evidence> = {};
async function archiveDiffs(runtime: ClosureRuntime): Promise<void> {
  for (const attempt of Object.values(runtime.manifest.attemptStates ?? {})) {
    if (!attempt.parentAttemptId) continue;
    const parent = runtime.manifest.attemptStates![attempt.parentAttemptId];
    const before = (await runtime.store.read(parent.parser)).toString(),
      after = (await runtime.store.read(attempt.parser)).toString();
    runtime.manifest.refs![`${attempt.attemptId}-audit-diff`] =
      await runtime.save(
        `validation/${attempt.attemptId}/script-diff.json`,
        {
          parent: parent.parser,
          current: attempt.parser,
          ...textDiff(before, after),
        },
        "script-diff",
      );
  }
  runtime.controller.persist(runtime.manifest);
  await runtime.controller.snapshot(runtime.manifest);
}
try {
  results = JSON.parse(await readFile(summaryPath, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
async function save(): Promise<void> {
  await store.snapshot("live-acceptance", "results.json", results);
  const { writeFile, rename } = await import("node:fs/promises");
  await writeFile(summaryPath + ".tmp", JSON.stringify(results, null, 2));
  await rename(summaryPath + ".tmp", summaryPath);
}
async function scenario(
  name: string,
  file: string,
  prompt: string,
  setup?: (r: ClosureRuntime) => Promise<void>,
): Promise<void> {
  if (results[name]?.status === "PASS") {
    const r = new ClosureRuntime(config);
    try {
      await r.bootstrap(results[name].runId);
      if (
        !r.attempt?.validation ||
        !r.attempt.rawResult ||
        !r.attempt.finalResult
      )
        throw new Error("Cached required evidence is incomplete");
      for (const attempt of Object.values(r.manifest.attemptStates ?? {}))
        for (const ref of [
          attempt.parser,
          attempt.plan,
          attempt.rawResult,
          attempt.finalResult,
          attempt.validation,
        ])
          if (ref) await r.store.read(ref);
      const report = JSON.parse(
        (await r.store.read(r.attempt.validation)).toString(),
      ) as ValidationReport;
      if (report.issues.length || ["FAIL", "BLOCKED"].includes(report.status))
        throw new Error("Cached scenario is not a passing engineering result");
      if (
        !r.controller.ledger
          .list(r.manifest.runId)
          .some(
            (a) => a.operation === "model_request" && a.status === "COMPLETED",
          )
      )
        throw new Error("Real model receipt absent");
      if (!r.manifest.sourcePath.endsWith(file))
        throw new Error("Cached source does not match scenario");
      if (name === "word") {
        const modelRoot = resolve(
            runsRootFor(PROJECT_ROOT),
            r.manifest.runId,
            "model",
          ),
          feedbackRequests: string[] = [];
        for (const requestId of await readdir(modelRoot)) {
          const request = JSON.parse(
            await readFile(
              resolve(modelRoot, requestId, "request.json"),
              "utf8",
            ),
          );
          if (
            request.payload.messages?.some(
              (message: { role: string; content?: unknown }) =>
                message.role === "tool" &&
                typeof message.content === "string" &&
                message.content.includes("checkedRuleIds"),
            )
          )
            feedbackRequests.push(requestId);
        }
        if (!feedbackRequests.length)
          throw new Error(
            "Direct narrative feedback never reached a real subsequent model request",
          );
        results[name].details = {
          ...(results[name].details as object),
          feedbackRequests,
        };
      }
      if (["repair", "switch"].includes(name) && r.manifest.attempts.length < 2)
        throw new Error("Required live second attempt absent");
      if (
        name === "image" &&
        !r.controller.ledger
          .list(r.manifest.runId)
          .some(
            (a) =>
              a.operation === "view_source_image" && a.status === "COMPLETED",
          )
      )
        throw new Error("Real image view evidence absent");
      if (name === "reuse") {
        const plan = JSON.parse(
          (await r.store.read(r.attempt.plan)).toString(),
        );
        if (
          !plan.reference ||
          plan.reference.sha256 === r.attempt.parser.sha256
        )
          throw new Error("Reference copy/edit evidence absent");
      }
      await archiveDiffs(r);
    } finally {
      r.close();
    }
    return;
  }
  const r = new ClosureRuntime({
    ...config,
    sourcePath: resolve(root, file),
    pythonBin: PYTHON,
    requirementsPath: resolve(
      PROJECT_ROOT,
      "fixtures/controlled-requirements.txt",
    ),
    templateName:
      name === "repair" || name === "reuse" ? template : `pilot-${name}`,
  });
  try {
    await r.bootstrap();
    if (setup) await setup(r);
    await runPi(r, prompt);
    if (!r.attempt?.validation)
      throw new Error("Required live extraction/validation missing");
    const report = JSON.parse(
      (await r.store.read(r.attempt.validation)).toString(),
    ) as ValidationReport;
    if (
      report.issues.length ||
      report.status === "BLOCKED" ||
      report.status === "FAIL"
    )
      throw new Error(
        `Live scenario has ${report.issues.length} unresolved issues`,
      );
    if (name === "repair" && r.manifest.attempts.length < 2)
      throw new Error("Model repair did not create new attempt");
    if (name === "reuse") {
      const plan = JSON.parse((await r.store.read(r.attempt.plan)).toString());
      if (!plan.reference)
        throw new Error("Model did not bind copied reference");
      if (r.attempt.parser.sha256 === plan.reference.sha256)
        throw new Error("Required local edit did not occur");
    }
    results[name] = {
      runId: r.manifest.runId,
      status: "PASS",
      report: r.attempt.validation.relativePath,
      details: {
        attempts: r.manifest.attempts,
        route: r.attempt.route,
        businessDecision: r.manifest.decision,
      },
    };
    if (name === "repair") {
      const requirements = r.manifest.refs!.requirements;
      const version: TemplateVersion = {
        template,
        version: "v001",
        requirements,
        parser: r.attempt.parser,
        verification: r.attempt.validation,
        signature: new TemplateRegistry(store).signature(r.inventory),
        status: "pilot_candidate",
        postprocessVersion: "fields-v002",
        checkerVersion: "independent-v002",
        fieldRules: [
          {
            id: "routeSplit",
            quote: "Split Route at first hyphen or equals",
            dependencies: [],
          },
          {
            id: "containerFields",
            quote: "Map matching container prices; preserve negatives",
            dependencies: [],
          },
          {
            id: "validity",
            quote: "start frozen date, end ETD",
            dependencies: ["containerFields"],
          },
        ],
      };
      await new TemplateRegistry(store).register(version, report);
    }
  } catch (error) {
    results[name] = {
      runId: r.manifest?.runId ?? "not-started",
      status: "FAIL",
      details: String(error),
    };
    throw error;
  } finally {
    await save();
    r.close();
  }
}
await mkdir(root, { recursive: true });
await runProcess(PYTHON, [
  resolve(PROJECT_ROOT, "src/workers/fixtures.py"),
  root,
]);
const requested = process.argv[2] ?? "all";
if (requested === "all")
  await store.snapshot("live-acceptance", "verification.json", {
    status: "RUNNING",
    startedAt: new Date().toISOString(),
  });
if (requested === "repair" || requested === "all")
  await scenario(
    "repair",
    "small.xlsx",
    "This controlled initial parser omitted the last source quote. Read outputs/attempt-001/parser.py and validation/attempt-001/report.json. Generate attempt-002 that repairs the actual script, retaining original correct records. Use excel_script, execute, post_process, validate; repair any remaining issues.",
    async (r) => {
      await r.inspect(0, 12);
      const parser = await readFile(
        resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
        "utf8",
      );
      await r.prepare(
        parser.replace("json.dump(result,", "json.dump(result[:-1],"),
        {
          route: "excel_script",
          reason: "synthetic controlled one-row omission",
        },
      );
      await r.execute();
      await r.postprocess();
      await r.validate();
    },
  );
if (requested === "reuse" || requested === "all")
  await scenario(
    "reuse",
    "reordered.xlsx",
    "Inspect the new source, then find_solutions and read_solution v001. Copy and edit that pilot parser for reordered columns and the 20′GP prime header; provide referenceVersion v001. Preserve field semantics. Execute, post_process and validate. The original parser must remain unchanged.",
  );
if (requested === "pdf" || requested === "all")
  await scenario(
    "pdf",
    "table.pdf",
    "Inspect this real synthetic two-page PDF, read outputs/original-document.json for its original tables and note. Convert with convert_source, generate a Python parser for the mapped workbook using converted_excel_script, execute, post_process and validate. Preserve both pages and source note in 运价备注.",
  );
if (requested === "word" || requested === "all")
  await scenario(
    "word",
    "narrative.docx",
    "Inspect original DOCX paragraphs and read outputs/original-document.json. Use direct_llm: provide a JSON array of quotes extracted from the actual original text in parser parameter. Raw source IDs and field conventions are in inventory. Empty remarks are empty strings; other missing fields null. Execute direct response, post_process and validate.",
  );
if (requested === "image" || requested === "all")
  await scenario(
    "image",
    "quote.png",
    "Inspect the image, call view_source_image and extract from actual original pixels. Use direct_llm with parser parameter containing your JSON array of raw quote records. Source identities follow Image!R2C1. Missing remarks empty string; transit/code/time null. Execute, post_process and independently validate against original-image OCR.",
  );
if (requested === "switch" || requested === "all")
  await scenario(
    "switch",
    "table.pdf",
    "The actual converted workbook lost Page2 row 2. The independent report locates a CONVERSION error, so editing extraction values cannot repair that workbook. Read outputs/original-document.json and validation/attempt-001/report.json; switch to direct_llm in attempt-002, extracting both actual original PDF pages and source note. Raw IDs Page1!R2C1 and Page2!R2C1. Execute, post_process and validate again. Missing transit/code/time null. Preserve source note in 运价备注.",
    async (r) => {
      await r.inspect(0, 12);
      await r.convert();
      await injectConversionLoss(r);
      await r.prepare(
        await readFile(
          resolve(PROJECT_ROOT, "fixtures/reference_parser.py"),
          "utf8",
        ),
        {
          route: "converted_excel_script",
          reason: "synthetic physical conversion loss",
        },
      );
      await r.execute();
      await r.postprocess();
      const report = await r.validate();
      if (!report.issues.some((i) => i.stage === "conversion"))
        throw new Error(
          "Injected conversion loss was not independently detected",
        );
    },
  );
if (requested === "all") {
  const required = ["repair", "reuse", "pdf", "word", "image", "switch"];
  if (required.some((k) => results[k]?.status !== "PASS"))
    throw new Error(
      "Live acceptance incomplete; required scenarios absent or failed",
    );
  const db = new DatabaseSync(
    resolve(runsRootFor(PROJECT_ROOT), "live-budget.sqlite"),
    { readOnly: true },
  );
  const actions = (
    db.prepare("SELECT data FROM actions").all() as { data: string }[]
  ).map((row) => JSON.parse(row.data));
  db.close();
  const budget = {
    topRuns: actions.filter((a) => a.operation === "top_level_run").length,
    inputTokens: actions.reduce(
      (n, a) => n + (a.actual?.inputTokens ?? a.reserved.inputTokens ?? 0),
      0,
    ),
    outputTokens: actions.reduce(
      (n, a) => n + (a.actual?.outputTokens ?? a.reserved.outputTokens ?? 0),
      0,
    ),
    uncertain: actions.filter(
      (a) => a.status === "UNCERTAIN" || a.status === "STARTED",
    ).length,
    cost: null,
    sdkRetries: 0,
    providerInternalRetries: "unknown",
  };
  if (
    budget.topRuns > 10 ||
    budget.inputTokens > 1000000 ||
    budget.outputTokens > 300000 ||
    budget.uncertain
  )
    throw new Error("Live budget or receipt gate failed");
  const ledger = new DatabaseSync(
    resolve(runsRootFor(PROJECT_ROOT), "closure.sqlite"),
    { readOnly: true },
  );
  const candidates = (
    ledger
      .prepare(
        "SELECT state FROM runs WHERE json_extract(state,'$.sourcePath') LIKE '%上海宁波深圳运价表.xlsx' ORDER BY rowid DESC",
      )
      .all() as { state: string }[]
  ).map((row) => JSON.parse(row.state));
  ledger.close();
  const real = candidates.find(
    (m) =>
      m.attempts.length >= 2 &&
      m.attemptStates[m.currentAttemptId]?.validation &&
      m.decision === "REVIEW",
  );
  if (!real)
    throw new Error(
      "Required real Yi Sheng Chang generation/repair evidence absent",
    );
  const realReport = JSON.parse(
    (
      await store.read(real.attemptStates[real.currentAttemptId].validation)
    ).toString(),
  );
  const realRuntime = new ClosureRuntime(config);
  try {
    await realRuntime.bootstrap(real.runId);
    await archiveDiffs(realRuntime);
  } finally {
    realRuntime.close();
  }
  const input = await readFile(
    resolve(
      PROJECT_ROOT,
      "../autotariffextract/data/20260811-识别文件/怡升昌/上海宁波深圳运价表.xlsx",
    ),
  );
  if (digest(input) !== real.sourceSha256)
    throw new Error("Real input digest mismatch");
  const current = await new TemplateRegistry(store).current(template);
  if (!current) throw new Error("Verified pilot binding missing");
  const requirements = (await store.read(current.requirements)).toString();
  if (current.fieldRules.some((field) => !requirements.includes(field.quote)))
    throw new Error(
      "Pilot requirement quote is not from its bound original text",
    );
  const regression = JSON.parse(
    await readFile(
      resolve(
        runsRootFor(PROJECT_ROOT),
        "live-acceptance/reuse-regression.json",
      ),
      "utf8",
    ),
  );
  const reused = JSON.parse(
    await readFile(
      resolve(
        runsRootFor(PROJECT_ROOT),
        results.reuse.runId,
        "run_manifest.json",
      ),
      "utf8",
    ),
  );
  if (
    regression.status !== "PASS" ||
    regression.sourceParser.sha256 !==
      reused.attemptStates[reused.currentAttemptId].parser.sha256
  )
    throw new Error(
      "Actual live adapted-parser regression proof missing or stale",
    );
  const regressionReport = JSON.parse(
    (await store.read(regression.report)).toString(),
  );
  if (regressionReport.issues.length)
    throw new Error("Original pilot regression failed");
  await store.snapshot("live-acceptance", "verification.json", {
    status: "PASS",
    required,
    scenarios: results,
    realInput: {
      runId: real.runId,
      engineeringFlow:
        "generated, executed, feedback, repaired, independently checked",
      businessDecision: real.decision,
      issues: realReport.issues.length,
      accuracy: null,
    },
    budget,
    cachedEvidenceRechecked: true,
  });
}
console.log(JSON.stringify(results, null, 2));
