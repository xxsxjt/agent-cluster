#!/usr/bin/env bash
# v5 组织总览 — 启动脚本（bash / Git Bash / WSL / Linux / macOS）
#   ./start-web.sh                  仅本机 127.0.0.1:8787
#   ./start-web.sh 9000             指定端口
#   ./start-web.sh 8787 lan         监听 0.0.0.0，手机/局域网可访问
#   ./start-web.sh 8787 lan mytok   局域网 + token 鉴权
set -e
cd "$(dirname "$0")"

PORT="${1:-8787}"
HOST="127.0.0.1"
[ "${2:-}" = "lan" ] && HOST="0.0.0.0"

ARGS=(--port "$PORT" --host "$HOST")
[ -n "${3:-}" ] && ARGS+=(--token "$3")

command -v node >/dev/null 2>&1 || { echo "[x] 找不到 node，请先安装 Node.js"; exit 1; }

echo "启动 v5 组织总览  http://127.0.0.1:${PORT}/"
echo "按 Ctrl+C 停止"
exec node server.js "${ARGS[@]}"
