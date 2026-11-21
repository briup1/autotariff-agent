# 第一批隔离原型执行清单

## Architect phases

- [x] Ground. Read the existing Pi scaffold, the legacy execution boundaries, and the approved Yi Sheng Chang sample.
- [x] Sketch. Compare two controller and artifact designs.
- [x] Agree. Select controller-owned state with immutable artifacts and adopt the stronger oracle binding from the artifact-first candidate.
- [x] Implement. Build the smallest inspect, prepare, execute, validate, and review path.
- [ ] Scrap. Skip unless verification shows the chosen shape cannot represent the required run.

## Feature throughput checkpoint

- [x] Blocking first steps. Freeze `WorkingInterpretation v001`, the run states, the budget defaults, and the subprocess boundary before Pi tools.
- [x] Independent workstreams. The source worker, artifact store, state model, parser executor, validator, and Pi gateway have separate files and contracts.
- [x] Shared mutable state. Serialize manifest writes per run and keep each attempt in its own output directory. SQLite remains Pi session storage only in this batch.
- [x] Smallest safe decomposition. Use one local controller because the batch has one sample and no safe parallel business actions.

## Batch checks

- [x] TypeScript typecheck.
- [x] Unit tests for path ownership, state transitions, and issue localization.
- [x] Deterministic run against the real Yi Sheng Chang workbook.
- [x] Real Pi run through the four closure tools.
- [ ] Controlled crash and resume test. Deferred to the next batch because the current manifest store is a file snapshot, not a durable action database.
- [ ] Independent business oracle. Deferred by the approved scope. The working interpretation fixture is self-consistency only.
