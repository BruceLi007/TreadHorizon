#!/bin/bash
# Tread Horizon · macOS 停止器（双击运行）
# 2026-11-11 D-385：与 Windows 的 TreadHorizon-Stop.bat 一一对应。
# 如果双击没反应：先「右键 → 打开」一次；或在终端执行
#   chmod +x TreadHorizon-Start.command TreadHorizon-Stop.command

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没有找到 Node.js，无法停止 Tread Horizon。"
  echo "   请先安装 Node.js 24 LTS： https://nodejs.org/"
  echo ""
  read -n 1 -s -r -p "按任意键关闭窗口…"
  exit 1
fi

node scripts/stop.mjs "$@"
status=$?

echo ""
if [ "$status" -ne 0 ]; then
  echo "❌ 停止失败，请查看上面的提示。"
fi
read -n 1 -s -r -p "按任意键关闭窗口…"
exit "$status"
