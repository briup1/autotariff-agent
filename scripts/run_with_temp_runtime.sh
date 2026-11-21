#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$project_root/.tmp/runtime"
task_runtime="$(mktemp -d "$project_root/.tmp/runtime/run.XXXXXXXX")"
trap 'rm -rf "$task_runtime"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
export TMPDIR="$task_runtime" UV_CACHE_DIR="$task_runtime/uv-cache" PYTHONPYCACHEPREFIX="$task_runtime/pycache"
export PYTHONDONTWRITEBYTECODE=1
export npm_config_cache="$task_runtime/npm-cache"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
cd "$project_root"
"$@"
