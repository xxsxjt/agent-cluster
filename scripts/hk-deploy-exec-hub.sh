#!/usr/bin/env bash
# hk-deploy-exec-hub.sh — HK 执行中枢管家 部署/自愈脚本（幂等，可重跑）
#
# 背景（2026-08-11 hk-exec-hub）：HK = 24/7 执行中枢管家 → 调用 CNB 云空间执行任务 + 存储。
# 本机 = 指挥中枢（local 任务）；HK 管家扫描 HK inbox → remote 任务派发 CNB → 结果回传。
#
# 本脚本在 HK 上 root 运行，确保执行中枢管家所需的一切就位：
#   1. org 目录结构 + 代码（butler.js/lib/scripts/config）
#   2. secrets/cnb-token（org-runner 可读 640）
#   3. ~/.ssh/id_rsa_cnb（org-runner home 下 600，HK 调 CNB 用）
#   4. org-runner 属主（agents/inbox/logs/config/knowledge/web 可写）
#   5. systemd org-butler 服务 active + 保活
#   6. 存储上云脚本就位
#   7. HK 管家模型渠道 key（opencode-go 单独配，见 [7/7]）
#
# 用法（HK 上 root）：
#   bash hk-deploy-exec-hub.sh [--no-restart]
set -uo pipefail

ORG=/data/agent-cluster
RUN_USER=org-runner
ts() { date '+%Y-%m-%d %H:%M:%S'; }
RESTART=1
[ "${1:-}" = "--no-restart" ] && RESTART=0

echo "=== HK 执行中枢管家部署 $(ts) ==="
[ -d "$ORG" ] || { echo "❌ $ORG 不存在，先部署 org"; exit 2; }

echo "[1/6] 代码完整性（butler + lib + scripts + config）"
cd "$ORG"
node --check butler.js >/dev/null 2>&1 && echo "  ✅ butler.js 语法OK" || { echo "  ❌ butler.js 语法错误"; exit 2; }
ls lib/spawn.js lib/route-auto.js lib/node-load.js scripts/cnb-task.js scripts/cnb-ctl.js >/dev/null 2>&1 && echo "  ✅ 关键 lib/scripts 就位" || { echo "  ❌ 缺关键文件"; exit 2; }
[ -f config/butler.json ] && echo "  ✅ config 就位" || echo "  ⚠️ 无 config/butler.json"

echo "[2/6] cnb-token 权限（org-runner 需读）"
TOK=$ORG/secrets/cnb-token
if [ -f "$TOK" ]; then
  chgrp $RUN_USER "$TOK" 2>/dev/null; chmod 640 "$TOK" 2>/dev/null
  sudo -u $RUN_USER cat "$TOK" >/dev/null 2>&1 && echo "  ✅ org-runner 可读 cnb-token" || { echo "  ❌ org-runner 读不了 token"; exit 2; }
else
  echo "  ⚠️ 无 cnb-token（HK 无法调 CNB）"; exit 2
fi

echo "[3/6] CNB SSH key（org-runner home 下）"
# cnb-task/cnb-ctl 用 os.homedir()/.ssh/id_rsa_cnb；HK 的 org-runner home = /data/agent-cluster
RUN_HOME=$(getent passwd $RUN_USER | cut -d: -f6)
if [ ! -f "$RUN_HOME/.ssh/id_rsa_cnb" ] && [ -f /root/.ssh/id_rsa_cnb ]; then
  mkdir -p "$RUN_HOME/.ssh"
  cp /root/.ssh/id_rsa_cnb "$RUN_HOME/.ssh/id_rsa_cnb"
  chown $RUN_USER:$RUN_USER "$RUN_HOME/.ssh/id_rsa_cnb"; chmod 600 "$RUN_HOME/.ssh/id_rsa_cnb"
  echo "  ✅ 已复制 id_rsa_cnb → $RUN_HOME/.ssh/"
else
  echo "  ✅ CNB key 就位 ($RUN_HOME/.ssh/id_rsa_cnb)"
fi

echo "[4/6] org 目录属主（org-runner 可写）"
chown -R $RUN_USER:$RUN_USER "$ORG/agents" "$ORG/inbox" "$ORG/logs" "$ORG/config" "$ORG/knowledge" "$ORG/web" 2>/dev/null
chown $RUN_USER:$RUN_USER "$ORG/butler.js" "$ORG/org.js" 2>/dev/null
echo "  ✅ 属主已设置"

echo "[5/6] systemd org-butler"
if ! systemctl is-active org-butler >/dev/null 2>&1; then
  systemctl daemon-reload; systemctl enable org-butler >/dev/null 2>&1
  systemctl restart org-butler
  echo "  ✅ 已启动 org-butler"
elif [ "$RESTART" = "1" ]; then
  systemctl restart org-butler
  echo "  ✅ 已重启 org-butler（加载最新代码）"
else
  echo "  ✅ org-butler 已在运行（--no-restart 跳过重启）"
fi
sleep 3
systemctl is-active org-butler >/dev/null 2>&1 && echo "  ✅ org-butler active" || { echo "  ❌ org-butler 未起来"; exit 1; }

echo "[6/6] 保活 cron + 存储脚本"
[ -f /etc/cron.d/org-cnb-keepalive ] && echo "  ✅ CNB 保活 cron 就位" || echo "  ⚠️ 无 CNB 保活 cron（跑 hk-cnb-pull.sh）"
[ -f "$ORG/scripts/hk-storage-migrate.sh" ] && echo "  ✅ 存储迁移脚本就位" || echo "  ⚠️ 无存储迁移脚本"

echo "[7/7] HK 管家模型渠道 key（opencode-go，2026-08-11 mgmt-pm improve）"
# HK 管家 spawn pi --provider opencode-go 时读 org-runner home 下 .pi/agent/models.json。
# .pi 不在 git/scp 同步范围（含 key，OPSEC 不进仓库），故 HK 须单独配 key。
# 本步幂等：校验 + 提示，不把 key 明文写进脚本（key 由本机分发 scp，非仓库）
PI_JSON="$RUN_HOME/.pi/agent/models.json"
if [ -f "$PI_JSON" ]; then
  if grep -q '\"opencode-go\"' "$PI_JSON"; then
    chown -R $RUN_USER:$RUN_USER "$RUN_HOME/.pi" 2>/dev/null
    echo "  ✅ HK opencode-go key 已配置（$PI_JSON 含 opencode-go provider）"
  else
    echo "  ⚠️ $PI_JSON 存在但缺 opencode-go provider → HK 管家 opencode-go 无 key"
    echo "     修复：在本机执行 scp ~/.pi/agent/models.json root@<hk>:$PI_JSON 后重跑本脚本"
  fi
else
  echo "  ⚠️ HK 无 .pi/agent/models.json → HK 管家 opencode-go 无 key"
  echo "     修复：在本机执行 scp ~/.pi/agent/models.json root@<hk>:$PI_JSON 后重跑本脚本"
fi

echo "=== HK 执行中枢管家部署完成 $(ts) ==="
echo "  管家: systemd org-butler ($(systemctl is-active org-butler))"
echo "  HK→CNB: cnb-task + cnb-ctl（org-runner）"
echo "  存储: CNB /data/cnb-org/storage + hk-storage-migrate.sh"
