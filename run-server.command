#!/bin/zsh
set -eu
task_root="${0:A:h}"
node_path="${1:-}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -z "$node_path" || ! -x "$node_path" ]]; then
  node_path="$(command -v node)"
fi
if [[ $# -gt 0 ]]; then shift; fi
cd "$task_root"
exec "$node_path" "$task_root/scripts/server.mjs" "$@"
