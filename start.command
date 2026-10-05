#!/bin/zsh
set -u
task_root="${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  message="没有找到 Node.js 22.13 或更新版本，请安装后重试。"
  echo "$message"
  if [[ "${1:-}" == "--gui" ]]; then
    /usr/bin/osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title "求职助手启动失败" buttons {"关闭"} default button "关闭" with icon caution' -e 'end run' "$message"
  fi
  exit 1
fi
node "$task_root/scripts/launcher.mjs" "$@"
result=$?
if [[ "$result" -ne 0 && -t 0 && "${1:-}" != "--gui" ]]; then
  read -k 1 "?按任意键关闭…"
  echo ""
fi
exit "$result"
