# Candidate B. A chat workbench with an isolated Pi worker

This is a design sketch. It changes no runtime code and performs no model calls.

The user opens one conversation, selects a source and its own requirements, and asks for extraction. The page keeps their messages, shows the actual tools and attempts, and opens the resulting records beside the conversation. A child process runs the existing Pi loop. A separate local server owns the conversation history and a recoverable projection of execution evidence.

```text
Browser conversation and selected inputs
  → Local HTTP server commits a command to workbench.sqlite
  → Worker child bootstraps ClosureRuntime and invokes runPi
  → Pi transcript, closure.sqlite, and immutable artifacts commit evidence
  → Server projects committed evidence into workbench.sqlite
  → Browser receives changes and opens results or differences
```

## Existing behavior constrains the design

The repository already owns the difficult extraction loop. `runPi` installs the closure extension, opens the run's `pi.sqlite`, submits input, waits, and closes the Harness. `createClosureExtension` serializes the real tools. `ClosureController.action` reserves an action before execution and commits its result afterward. Reuse these mechanisms instead of replacing them with web-specific tools.

`runPi` returns immediately for a `TERMINAL` run. `createConfiguredModels` also rejects dispatch after `TERMINAL`. `resumeForRepair` accepts decisions `NONE` and `BLOCKED`, rejects `UNCERTAIN` actions, and preserves the original budget. Therefore a terminal follow-up must create a linked run. The conversation can continue while the old execution remains immutable.

`Ledger.acquire` uses an owner UUID and an operating-system PID. It rejects another live writer. A web server must never instantiate `ClosureRuntime` merely to display a run because `bootstrap(runId)` acquires this lease. Read-only views use committed ledger state and Pi's read-only observation API.

`ArtifactStore.read` checks the digest and rejects path traversal and symlinks. The existing script difference is a contiguous text hunk. Validation reports already contain expected values, actual values, source coordinates, and result IDs. The browser should show those facts rather than generate its own success assessment.

These facts come from the files read for this sketch. The exact APIs to reuse are `src/index.ts`, `src/closure/runtime.ts`, `src/closure/controller.ts`, `src/closure/ledger.ts`, `src/closure/live-budget.ts`, `src/closure/artifacts.ts`, `src/config.ts`, and the installed Pi Durable README.

## Start from the caller

The browser imports two files or chooses two previously imported files. A source is required. A requirement document is explicit. The browser sends IDs rather than host paths.

```ts
const source = await api.importFile(file, "source");
const requirements = await api.importFile(textFile, "requirements");
const conversation = await api.createConversation({ source: source.id, requirements: requirements.id });
const job = await api.send(conversation.id, {
	commandId: crypto.randomUUID(),
	mode: "start",
	text: "抽取运价，并根据独立检查修复差异。",
	budgetAuthorizationId,
});
api.observe(conversation.id, savedCursor, renderCommittedUpdate);
```

Sending commits the user message and the command in one SQLite transaction before the server acknowledges it. Repeating the same `commandId` returns the same job. There is one admitted command per conversation at a time. A message typed during execution remains a local draft until the user sends it after settlement. This avoids silently steering a live run.

## Types encode the execution choices

Reuse `ArtifactRef`, `Attempt`, `Budget`, `RunManifest`, and `ValidationReport` from the existing domain model. The following types are additions, not alternate copies of those models.

```ts
type ConversationId = string;
type CommandId = string;
type ImportedFileId = string;
type JobId = string;
type InputSelection = { source: ImportedFileId; requirements: ImportedFileId };

type ExecuteCommand = {
	commandId: CommandId;
	conversationId: ConversationId;
	text: string;
	budgetAuthorizationId: string;
} & (
	| { mode: "start"; inputs: InputSelection }
	| { mode: "resume"; runId: string }
	| { mode: "followup"; parentRunId: string; inputs: InputSelection }
);

type JobState =
	| { status: "QUEUED" }
	| { status: "RUNNING"; runId: string; workerPid: number }
	| { status: "INTERRUPTED"; runId: string; reason: string }
	| { status: "SETTLED"; runId: string; decision: string }
	| { status: "REJECTED"; reason: string };

type ConversationEntry =
	| { id: string; kind: "user"; commandId: CommandId; text: string }
	| { id: string; kind: "assistant"; runId: string; piEntryId: string; text: string }
	| { id: string; kind: "execution"; runId: string; state: JobState };

type ProjectionUpdate = {
	cursor: number;
	conversationId: ConversationId;
	entry?: ConversationEntry;
	run?: { runId: string; revision: number; manifest: RunManifest };
};

type WorkerRequest = { jobId: JobId; command: ExecuteCommand; resolvedInputs?: InputSelection };
type WorkerNotice =
	| { type: "bound"; jobId: JobId; runId: string }
	| { type: "evidence-ready"; runId: string }
	| { type: "settled"; jobId: JobId; runId: string };

interface Jobs {
	admit(command: ExecuteCommand): Promise<{ jobId: JobId; state: JobState }>;
	reconcile(jobId: JobId): Promise<JobState>;
}
interface Evidence {
	refresh(runId: string): Promise<ProjectionUpdate[]>;
	artifact(runId: string, artifactId: string): Promise<Buffer>;
}
```

`WorkerNotice` is a wake-up hint. It never proves that a tool succeeded. The projection reads the authority and upserts by stable run, action, attempt, and Pi entry IDs. A monotonic workbench cursor identifies committed projection changes for reconnects. A browser reconnect receives a current snapshot and then updates after its cursor. Large result records use paginated queries rather than repeated full manifests.

The worker receives only an admitted job ID. It reads the committed command and resolves imported IDs through the server-owned input registry. A private IPC pipe carries notices. It never accepts a CLI string or an arbitrary file path from the browser. Launch it with `spawn(process.execPath, fixedArgs, { shell: false })` through the existing temporary-runtime wrapper. No user text enters a shell command.

## Resume is separate from a new question

| User action | Worker behavior | Preserved evidence |
| --- | --- | --- |
| Start extraction | Resolve imported copies, bootstrap a new runtime, then call `runPi`. | The command records the input digests, selected template, run date, and authorization. |
| Resume interrupted execution | Acquire the existing lease, bootstrap the run, call `resumeForRepair`, complete missing local stages, then continue the same Pi root. | The source, requirements, attempts, usage, wall-time origin, and budget stay unchanged. |
| Ask after a terminal result | Create a new run linked to the parent in the same conversation. Pass the visible conversation context and selected prior evidence to the real Pi submission. | The parent stays terminal. The new run snapshots its inputs and requirements. |
| Change source or requirements | Require an explicit new run using the changed selection. | The old contract and artifacts stay immutable. Unsupported requirements still block before model dispatch. |

The installed Pi Durable README says `root()` returns the same root when storage is reopened and `requestId` deduplicates submissions. Extend the current submission to use the durable `commandId` as `requestId`. For recovery, the worker must inspect the Pi submission and continue the pending submission instead of always submitting a new prompt. This requires a small adapter around `runPi`; invoking the current CLI blindly is insufficient.

The server stores the job-to-run binding before model dispatch. If a crash occurs between creating the runtime and persisting that binding, a worker-specific launch receipt identifies the newly created run. Recovery reconciles that receipt before creating anything else. No automatic child restart is allowed when binding is ambiguous or a paid receipt is incomplete. A live CLI lease produces a conflict response and a read-only view, not a competing worker.

A server restart does not kill an already running child. The server reattaches observation by the committed binding. A lost worker marks the job interrupted only after checking both the process and the authoritative run. A user's stop request first asks the worker to abort and close cleanly. A forced kill leaves an interrupted job and can produce `UNCERTAIN`; it does not imply a free retry.

## New authorization has its own call budget

The old `all-batches-2026-11-03` policy and its 10 used top-level runs remain historical evidence. The workbench must not reset that row or overwrite its limit. Add an explicit authorization ID to new jobs and let `LiveAudit` select a stored policy by that ID. Keep the old constructor behavior for old CLI runs.

The new authorization allows at most 1000 actual model dispatches. This is a dispatch counter, separate from top-level runs, tool calls, and per-run agent turns. Reserve one unit atomically before dispatch. Completed receipts consume one unit. Incomplete receipts keep the unit reserved and block automatic retry. Cache replay and preflight rejection consume no dispatched unit. Rejected reservations are released only when the code proves no request was sent. All worker children share the same atomic budget record.

The UI shows completed dispatches, uncertain dispatches, and remaining reservable calls separately. It shows actual input and output usage when receipts contain it. Money stays unknown because the configured provider price is unknown. Per-run limits remain effective, and resuming a run does not extend its wall-time limit. Implementing the workbench must make zero paid calls until the new authorization is present.

## Keep the page centered on the conversation

Use a narrow conversation list on the left and a wide chat column. A compact header shows the selected source, requirements, execution state, and call budget. The bottom composer holds the draft and its input chips. Each assistant answer carries a link to its run and artifacts.

During execution, one expandable activity card appears in the conversation. It lists actual tool names, action state, time, and the attempt they belong to. It uses ledger reservations and completed receipts. It never substitutes a timer or an animated checklist for execution evidence. A compact status remains visible when the user scrolls away.

Selecting a result opens a side panel with records and validation differences. Selecting an attempt opens its plan, parser, raw output, final output, and report. Script differences use the stored `diff.json`. Validation differences use the stored report and comparison artifact. A record difference between arbitrary attempts is explicitly a derived local view, uses stable record keys, and labels missing or duplicate keys as alignment problems. It does not assign rows by array position.

The product starts with a useful empty state containing the two file choices and an example extraction request. It preserves draft text across reloads. Import progress, execution interruption, unsupported requirements, lease conflict, and an uncertain paid receipt each get a specific explanation and an available action. `AWAITING_HUMAN_REVIEW` remains a review outcome and never becomes a green business-accuracy badge.

## Keep local boundaries explicit

Bind to `127.0.0.1` only. Validate the Host and Origin against the selected loopback origin to reject DNS rebinding and cross-site requests. Require same-origin JSON for mutations. Use a local session cookie and a per-launch anti-CSRF value. Do not enable cross-origin access or expose a generic filesystem route.

The child loads `.env.local`. The server and browser never receive `OPENAI_API_KEY`, raw process environments, or the complete runtime config. Server errors expose a bounded code and safe message. Raw stdout and stderr remain bounded local diagnostics. They are not the activity API. Model request and response archives are private by default because they contain prompts and source material. Do not make the artifact directory a static web root.

Uploads accept one source and one requirement document per selection. Proposed limits are 25 MiB per source, 1 MiB per requirement document, and 250 MiB total stored imports. Match the supported extensions and inspect signatures before accepting the files. Stream to a private temporary name, enforce the byte limit while reading, and atomically commit a server-generated filename plus digest. Reject symlinks and traversal. Uploaded filenames are display text only. Unreferenced import cleanup is an explicit local action, never a deletion of audit artifacts.

Artifact downloads accept registered artifact IDs, verify the run and digest through `ArtifactStore`, and enforce response size limits. Serve plain text and JSON as inert content. Downloads use attachment headers and `nosniff`. Escape all rendered text. Cap record page sizes and diff sizes. Never render uploaded HTML or raw Markdown HTML.

## Modules and the alternative

| Proposed module | Responsibility |
| --- | --- |
| `src/workbench/server.ts` | Node HTTP routes, loopback protections, and static asset delivery. |
| `src/workbench/store.ts` | Conversations, commands, imports, projection cursors, and idempotent job admission in a separate SQLite file. |
| `src/workbench/jobs.ts` | Spawn one child per admitted command, persist its binding, and reconcile interrupted jobs. |
| `src/workbench/worker.ts` | Resolve the command, construct the real runtime, resume or submit Pi work, and close the lease. |
| `src/workbench/evidence.ts` | Read-only Pi and closure observation, artifact access, and derived result pages. |
| `web/index.html`, `web/app.ts`, `web/styles.css` | Conversation interface, input selection, and artifact panel. |

Node's HTTP server and a static frontend are sufficient for this sketch. The repository has no React or web framework dependency. A bundler is justified only for TypeScript browser modules and production assets; a routing framework adds no value for one workbench page.

Compared with an in-process bridge, the worker keeps a parser crash, runaway conversion, and model-worker shutdown separate from the HTTP process. A browser refresh cannot interrupt extraction. The server can display an interrupted run even when the worker exits abnormally. These are useful properties for a process that already has explicit crash tests and external sandbox execution.

The costs are real. IPC and the durable job-to-run binding add a second recovery boundary. A projection can lag committed work. Lease ownership belongs to a changing child PID. An in-process design can observe the same Harness directly and needs fewer moving pieces. Choose B if keeping the workbench available during execution faults is a product requirement. Choose the in-process design if the first local release favors fewer recovery states. Both designs retain the existing ledger and paid-action policy.

## Tests that determine whether B is acceptable

Use fake model streams for all new tests. The existing offline verification remains required.

1. Send the same command twice, including a dropped HTTP response. Exactly one message, one job, and one Pi submission exist.
2. Kill a worker before and after its run binding commits. Restart the server. No duplicate run or paid dispatch occurs.
3. Resume an interrupted local stage. The original attempts, budget, and Pi root survive. An uncertain paid action blocks dispatch.
4. Hold the run lease from the CLI. The browser reads it but cannot start a second writer.
5. Follow up after terminal review. The visible conversation continues, a new linked run appears, and the parent's terminal state and artifacts do not change.
6. Disconnect the browser and restart the server while a tool finishes. Replayed projection entries show the actual action once and recover the committed assistant response.
7. Admit concurrent fake requests near 1000 calls. The atomic authorization blocks dispatch 1001. Historical budget rows remain byte-for-byte unchanged.
8. Upload oversized files, mismatched signatures, traversal names, and symlinks. Request artifacts from other runs and send cross-origin mutations. Each request is rejected before reading a secret or running a worker.
9. Open results with duplicate keys, missing rows, large values, and HTML text. Pagination remains bounded and differences identify alignment failures without executing content.

The design uses Model the Domain for the command union and explicit resume choices. Separate Before Serializing Shared State gives the server its own conversation database and leaves each run under one existing writer. Make Operations Idempotent adds the durable command ID and reconciliation rule. Experience First chooses a chat page with contextual evidence. Laziness Protocol keeps the current Pi and controller behavior and avoids a web framework.
