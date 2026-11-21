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

## Software factory

In Claude Code, `/factory run` processes open GitHub issues labeled `factory` through intake, spec, build, gate, review and approval. Jobs can push branches and open PRs; merges require a human and automatic merging is disabled. Do not run jobs without explicit authorization. Runtime state is in ignored `factory/jobs/`; `factory/bin/job` is its only writer. The dashboard can be served locally with `cd factory && python3 -m http.server --bind 127.0.0.1`, then opened at http://localhost:8000/dashboard.html.

Jobs use isolated checkouts under ignored `.worktrees/<job-id>/`. Exclude `.worktrees/` when a tool does not honor `.gitignore`. Factory files are GPLv3; see `factory/LICENSE`.
