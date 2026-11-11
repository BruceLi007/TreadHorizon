#!/bin/bash
# Tread Horizon · macOS 启动器（双击运行）
# 2026-11-11 D-385：与 Windows 的 TreadHorizon-Start.bat 一一对应。
# 如果双击没反应：先「右键 → 打开」一次；或在终端执行
#   chmod +x TreadHorizon-Start.command TreadHorizon-Stop.command
#
# 说明：启动脚本会在后台运行服务并打开浏览器，关掉终端窗口不影响服务；
#       停止请双击 TreadHorizon-Stop.command。

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没有找到 Node.js，无法启动 Tread Horizon。"
  echo "   请先安装 Node.js 24 LTS： https://nodejs.org/"
  echo "   安装完成后重新双击本文件。"
  echo ""
  read -n 1 -s -r -p "按任意键关闭窗口…"
  exit 1
fi

node scripts/launch.mjs "$@"
status=$?

echo ""
if [ "$status" -ne 0 ]; then
  echo "❌ 启动失败，请查看上面的提示。"
else
  echo "✅ 启动完成（服务在后台运行，可以关闭这个窗口）。"
fi
read -n 1 -s -r -p "按任意键关闭窗口…"
exit "$status"
