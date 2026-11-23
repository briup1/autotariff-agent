## Agent skills

### Issue tracker

Issues and specs live as local Markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read the root glossary and relevant ADRs before design work. See `docs/agents/domain.md`.

## Setup and checks

Requires macOS, Node.js >= 22.19, Python >= 3.12, uv and Xcode Command Line Tools. Run `npm ci` and `uv sync --locked` in a fresh checkout. Copy `.env.local.example` to `.env.local` only if absent; never commit credentials. See `README.md` for configuration and local-only runtime details.

Start the local web server on a chosen port with `PORT=5101 scripts/run_with_temp_runtime.sh npm run web`. The server binds localhost; do not expose it or use real model calls without explicit authorization.

Run `factory/checks.sh` for the factory gate: dependency setup when absent, `npm run typecheck`, and `npm test`. Tests must not touch the delivered ledger. The full test suite may require a macOS environment that allows `sandbox-exec`.

## 历史结果 UI

修改历史结果区域前阅读 `docs/visual-center-product.md`、`docs/visual-center-design.md` 和 `docs/evidence/history-result-review/README.md`。仅无选中工作会话的历史来源结果使用加宽核价布局，记录、日期和 Excel 均保持不变。通过 `PORT=5130 scripts/run_with_temp_runtime.sh node scripts/history-result-review.mjs` 复现（只读合成 API 加真实前端，不访问账本或模型）。使用隔离浏览器会话核验 1600×760、390×844、1024×760、模式切换、轮次、分页和 Excel；除工厂门禁外运行 `npm exec vitest run tests/web-client.test.ts tests/plan-review-client.test.ts tests/web.test.ts`。

## Software factory

In Claude Code, `/factory run` processes open GitHub issues labeled `factory` through intake, spec, build, gate, review and approval. Jobs can push branches and open PRs; merges require a human and automatic merging is disabled. Do not run jobs without explicit authorization. Runtime state is in ignored `factory/jobs/`; `factory/bin/job` is its only writer. The dashboard can be served locally with `cd factory && python3 -m http.server --bind 127.0.0.1`, then opened at http://localhost:8000/dashboard.html.

Jobs use isolated checkouts under ignored `.worktrees/<job-id>/`. Exclude `.worktrees/` when a tool does not honor `.gitignore`. Factory files are GPLv3; see `factory/LICENSE`.
