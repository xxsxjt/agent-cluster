#!/usr/bin/env bash
# XuWu (虚无) Framework Installer for Linux/macOS
# 用法:
#   bash scripts/install.sh
#   bash scripts/install.sh --uninstall
#
# 依赖: Node.js >= 18
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.js"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }

if [[ "${1:-}" == "--uninstall" ]]; then
    step "卸载中..."
    node "$BOOTSTRAP" uninstall | while read -r line; do info "$line"; done
    echo ""
    echo "✅ 卸载完成"
    exit 0
fi

# 1. 环境检查
step "检查环境..."
if ! command -v node >/dev/null 2>&1; then
    echo "  ❌ 需要 Node.js >= 18，请先安装"
    exit 1
fi
NODE_VER=$(node --version)
info "✅ Node.js $NODE_VER"

# 2. 目录检查
step "检查目录..."
if [[ ! -f "$BOOTSTRAP" ]]; then
    echo "  ❌ 找不到 scripts/bootstrap.js"
    exit 1
fi
info "✅ 仓库结构完整"

# 3. 注册自启（systemd user）
step "注册开机自启..."
node "$BOOTSTRAP" install | while read -r line; do info "$line"; done

# 4. 启动管家
step "启动管家..."
node "$BOOTSTRAP" start | while read -r line; do info "$line"; done

echo ""
echo "  ────────────────────────────────────────────"
echo "  ✅ 虚无框架已就绪"
echo "     · 管家: node scripts/bootstrap.js status"
echo "     · 投递任务: 放文件进 inbox/ 目录"
echo "     · 卸载: bash scripts/install.sh --uninstall"
echo ""