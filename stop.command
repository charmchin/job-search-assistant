#!/bin/zsh
set -u
task_root="${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec /bin/zsh "$task_root/start.command" --stop
