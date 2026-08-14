#!/usr/bin/env bash
# XuWu (虚无) 快捷命令
#   bash xuwu.sh status          查看管家状态
#   bash xuwu.sh start/stop/restart  管家启停
#   bash xuwu.sh web              启动 web 控制台（后台，自动开浏览器）
#   bash xuwu.sh web stop         停止 web 控制台
#   bash xuwu.sh web status       查看 web 状态
#   bash xuwu.sh web lan          局域网模式（手机可访问）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CMD="${1:-status}"
SUB="${2:-}"

if [[ "$CMD" == "web" ]]; then
  node "$ROOT/scripts/bootstrap.js" web "$SUB"
  exit $?
fi

node "$ROOT/scripts/bootstrap.js" "$CMD"