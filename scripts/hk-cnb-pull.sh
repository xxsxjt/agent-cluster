#!/usr/bin/env bash
# hk-cnb-pull.sh — HK 端部署：从 cnb.cool 私有仓库 pull 最新 org + 启动 CNB 保活
#
# 背景（2026-08-11 cnb-sync-p0）：智能体集群三端通过 cnb.cool 私有仓库 Git 通道同步。
# 本机为编排主端（commit+push），HK 为第二节点（pull 模型拉取任务/状态/知识）。
# HK 需部署：①git pull 同步脚本 + cron ②CNB 保活（24/7，本机休眠时兜底防回收）。
#
# 实际架构（2026-08-12 修正）：/data/agent-cluster 是 HK 运行目录（butler/twin/inbox 等），
# 并非 git clone——org 数据同步走【本机 dual-sync.js (ssh/scp 双向) 主通道】。
# 本脚本的 git pull 仅适用于独立的 git-clone 部署目录；对运行目录自动跳过（见 step1 守卫），
# org-git-sync cron 亦加 .git 守卫，避免每 10min 对非 git 运行目录白跑失败的 git fetch。
#
# 用法（HK 上以 root 运行）：
#   bash hk-cnb-pull.sh <cnb_git_token>
#
# 注意：token 由本机解密后传入，存 root 600 文件（不落 git）。SSH key id_rsa_cnb 需先从本机 scp 到 HK。
set -euo pipefail

CNB_TOKEN="${1:-}"
if [ -z "$CNB_TOKEN" ]; then echo "用法: $0 <cnb_git_token>"; exit 1; fi
ORG=/data/agent-cluster
SECRETS=$ORG/secrets
mkdir -p "$SECRETS"
echo -n "$CNB_TOKEN" > "$SECRETS/cnb-token"
chmod 600 "$SECRETS/cnb-token"

echo "=== [1] 配置 cnb remote + 首次 pull（git 通道，守卫：仅当运行目录为 git 仓库） ==="
cd "$ORG" || exit 1
if [ ! -d "$ORG/.git" ]; then
  echo "(跳过 git 同步：$ORG 是运行目录非 git 仓库；org 数据由本机 dual-sync.js ssh/scp 主通道同步)"
else
  git remote remove cnb 2>/dev/null || true
  git remote add cnb "https://cnb:${CNB_TOKEN}@cnb.cool/xxssxx.top/1" 2>/dev/null || true
  git fetch cnb main 2>&1 | tail -3 || echo "(fetch 失败/无远端)"
  git rebase cnb/main 2>&1 | tail -3 || git merge --no-edit cnb/main 2>&1 | tail -3 || true
fi

echo "=== [2] 写 git 同步 cron（每 10 分钟 pull）==="
cat > /etc/cron.d/org-git-sync <<'CRON'
# 每 10 分钟从 cnb.cool 私有仓库拉取 org 更新（仅当 /data/agent-cluster 为 git 仓库时执行；
# 运行目录由本机 dual-sync.js ssh/scp 主通道同步，git 通道为可选独立克隆部署保留）
*/10 * * * * root [ -d /data/agent-cluster/.git ] && cd /data/agent-cluster && git fetch cnb main 2>/dev/null && git rebase cnb/main 2>/dev/null >> /data/agent-cluster/logs/git-sync-hk.log 2>&1 || true
CRON
chmod 600 /etc/cron.d/org-git-sync
echo "cron 已写（/etc/cron.d/org-git-sync）"

echo "=== [3] 部署 CNB 保活（HK 24/7 兜底）==="
cat > /usr/local/bin/cnb-keepalive-hk.sh <<'HB'
#!/usr/bin/env bash
# CNB 三空间保活+自动重启（HK 24/7；本机 keepalive 的远端兜底）
set -uo pipefail
TOKEN=$(cat /data/agent-cluster/secrets/cnb-token)
API=https://api.cnb.cool
LOG=/data/agent-cluster/logs/cnb-keepalive.log
KEY=/root/.ssh/id_rsa_cnb
SPACES="xxssxx.top/1 xxssxx.top/2 xxssxx.top/3"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
nowh() { date '+%H'; }

for slug in $SPACES; do
  # 查状态
  st=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/workspace/list" 2>/dev/null)
  sn=$(echo "$st" | python3 -c "import sys,json;d=json.load(sys.stdin);l=[w for w in d['list'] if w['slug']=='$slug'];print((sorted(l,key=lambda x:x['create_time'] or '',reverse=True) or [{}])[0].get('sn',''))" 2>/dev/null)
  status=$(echo "$st" | python3 -c "import sys,json;d=json.load(sys.stdin);l=[w for w in d['list'] if w['slug']=='$slug'];print((sorted(l,key=lambda x:x['create_time'] or '',reverse=True) or [{}])[0].get('status',''))" 2>/dev/null)
  [ -z "$sn" ] && continue
  if [ "$status" = "running" ]; then
    # 心跳
    host=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/$slug/-/workspace/detail/$sn" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('sshHost') or d.get('ssh') or '')[:400])" 2>/dev/null | sed 's/^ssh //')
    if [ -n "$host" ]; then
      timeout 15 ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -4 "$host" 'touch /tmp/hk-cnb-hb' >/dev/null 2>&1 \
        && echo "$(ts) $slug heartbeat ok" >> "$LOG"
    fi
  else
    # closed → 启动（避开凌晨 4-6 强制回收窗口，失败限次）
    h=$(nowh)
    if [ "$h" -ge 4 ] && [ "$h" -lt 6 ]; then
      echo "$(ts) $slug closed 凌晨窗口跳过" >> "$LOG"
      continue
    fi
    curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"branch":"main"}' "$API/$slug/-/workspace/start" >> "$LOG" 2>&1
    echo " $(ts) $slug start 已提交" >> "$LOG"
  fi
done
HB
chmod +x /usr/local/bin/cnb-keepalive-hk.sh
# cron：心跳 5 分钟 + 重启检查 10 分钟（错开）
cat > /etc/cron.d/org-cnb-keepalive <<'CRON'
# CNB 保活（HK 24/7）
*/5 * * * * root /usr/local/bin/cnb-keepalive-hk.sh >> /data/agent-cluster/logs/cnb-keepalive-hk-cron.log 2>&1
CRON
chmod 600 /etc/cron.d/org-cnb-keepalive
echo "HK CNB 保活已部署"

echo "=== [4] 确保 SSH key 就位 ==="
mkdir -p /root/.ssh
if [ ! -f /root/.ssh/id_rsa_cnb ]; then
  echo "⚠️ 需先 scp 本机 ~/.ssh/id_rsa_cnb 到 HK /root/.ssh/"
  echo "   scp -P 43891 ~/.ssh/id_rsa_cnb root@100.97.18.59:/root/.ssh/"
fi
chmod 600 /root/.ssh/id_rsa_cnb 2>/dev/null || true

echo "=== HK 部署完成 ==="
echo "  · git pull cron: /etc/cron.d/org-git-sync (每10min)"
echo "  · CNB 保活 cron: /etc/cron.d/org-cnb-keepalive (每5min)"
echo "  · token: $SECRETS/cnb-token (600)"
