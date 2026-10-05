#!/bin/zsh
set -u

task_root="${0:A:h}"
app_data="$HOME/Library/Application Support/ZhaopinAssistant"
install_log="$app_data/install.log"
mkdir -p "$app_data"
cd "$task_root"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec > >(tee -a "$install_log") 2>&1

fail() {
  echo ""
  echo "安装失败：$1"
  echo "诊断日志：$install_log"
  if [[ -t 0 ]]; then
    read -k 1 "?按任意键关闭…"
    echo ""
  fi
  exit 1
}

echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 正在安装求职助手…"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "没有找到 Node.js 22 或更新版本。"
fi

if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22 || major===22 && minor>=13 ? 0 : 1)'; then
  fail "当前 Node.js 版本过低，需要 22.13 或更新版本。"
fi

./stop.command || fail "服务未能安全停止，未覆盖已安装入口。"
node scripts/macos-app.mjs install || fail "无法创建 macOS 应用入口。"
./start.command || fail "应用入口已创建，但后台服务启动失败。"

echo ""
echo "安装完成。今后可从 Spotlight、应用程序或 Dock 打开“求职助手”。"
echo "应用位置：$HOME/Applications/求职助手.app"
echo "数据库不会因安装、升级或停止服务而删除。"
