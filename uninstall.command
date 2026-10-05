#!/bin/zsh
set -u

task_root="${0:A:h}"
cd "$task_root"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "正在移除求职助手的应用入口和登录启动项…"
./stop.command >/dev/null 2>&1 || true
node scripts/macos-app.mjs uninstall
echo "卸载完成。求职数据和项目源文件均已保留。"
