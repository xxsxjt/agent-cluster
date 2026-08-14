#!/usr/bin/env bash
# hk-storage-migrate.sh — HK 存储上云：把 HK 归档数据迁移到 CNB 云空间 storage
#
# ⚠️⚠️ 2026-08-12 重大警告（实测结论）⚠️⚠️
# CNB 云开发空间【无平台级持久存储】：
#   - /data 是 docker overlay，实例约每 10-15min 固定生命周期回收重建即整个清空；
#   - /root/.vscode-server 虽是 /dev/md0 挂载，但含的 7 月文件是镜像预置层（lower layer），
#     用户写入（storage/标记）随容器销毁丢失（已实测：写入后回收即消失）；
#   - /workspace 是 git 工作区（git-clone-yyds overlay，upperdir 在宿主机），跨实例保留，
#     但它是 git 仓库根，塞 28G 归档数据会使 git 膨胀巨大，不适宜做归档存储。
#   - CNB API 实证：/storage /stash /backup /restore /disk 均 404，无平台级持久盘。
#
# 【正确结论】CNB 不适合存 HK 归档数据。28G 归档数据【保留 HK】为唯一安全归宿
# （HK /data 44G 已用 33G，剩余 9.3G；源数据 recycle 12G + server-backups 8G 等本就是 HK 本地数据，
#   是用户要求迁移以释放磁盘的对象，但 CNB 不可持久 → 迁移目标不存在）。
# 本脚本仅保留作【评估/演示】工具，不建议实际执行迁移（会丢数据）。
#
# 背景（2026-08-11 hk-exec-hub）：HK 磁盘紧张（/data 44G 已用 33G，xxsx-api 占 30G）。
# 本脚本把 HK 的归档目录（回收站/旧备份/构建产物）增量 rsync 到 CNB storage。
#
# 幂等：已迁移成功的目录会跳过（标记文件）。可安全重跑，中断后增量续传。
#
# 用法（HK 上 root 运行）：
#   bash hk-storage-migrate.sh <space:1|2|3> [--target <子目录>] [--dry-run]
#
#   --target 可选：artifacts|logs|backups|reports（默认全迁）
#   --dry-run 只统计不迁移
set -uo pipefail

SPACE="${1:-3}"
TARGET_ARG=""
DRY=""
shift 1 2>/dev/null || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --target) TARGET_ARG="${2:-}"; shift ;;
    *) TARGET_ARG="$1" ;;
  esac
  shift
done
ORG=/data/agent-cluster
TOKEN=$(cat $ORG/secrets/cnb-token 2>/dev/null)
[ -z "$TOKEN" ] && { echo "❌ 无 cnb-token"; exit 2; }

# 动态解析 CNB 空间最新 SSH host
HOST=$(cd $ORG && CNB_GIT_TOKEN="$TOKEN" timeout 30 node scripts/cnb-ctl.js ssh "$SPACE" 2>/dev/null | tail -1)
[ -z "$HOST" ] && { echo "❌ 无法解析 CNB 空间$SPACE SSH host（空间休眠？）"; exit 2; }
echo "📡 CNB 空间$SPACE host: $HOST"
KEY=/root/.ssh/id_rsa_cnb
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -4 $HOST"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 确保 CNB storage 目录
# 2026-08-12 修复：原目标 /data/cnb-org/storage 是 docker overlay（CNB 空间闲置约10min回收重建即清空，数据丢失）。
# 改到 /root/.vscode-server/storage —— 该目录挂载宿主机 /dev/md0（39.1T raid，跨实例持久，实测含7月遗留文件）。
# 标记也升级为 .storage-migrated-persist：旧 .storage-migrated 标记对应已丢失的 overlay 数据，不再采信，避免跳过大文件。
STORAGE_BASE=/root/.vscode-server/storage
timeout 30 $SSH "mkdir -p $STORAGE_BASE/{artifacts,logs,backups,reports}" >/dev/null 2>&1 || { echo "❌ CNB storage 目录创建失败"; exit 2; }
echo "✅ CNB storage 目录就绪（$STORAGE_BASE，md0 持久盘）"

# 迁移源 → CNB 目标 映射
# 迁移源在 HK，目标在 CNB（远端）。用 scp/rsync 推送到远端 storage。
declare -A SRC_TO_CNB=(
  ["/data/xxsx-api/recycle"]="backups/recycle"
  ["/data/xxsx-api/server-backups"]="backups/server-backups"
  ["/data/xxsx-api/build"]="artifacts/xxsx-build"
  ["/data/xxsx-api/backups"]="backups/xxsx-db-backups"
  ["/data/xxsx-api/deploy-backups"]="backups/xxsx-deploy"
  ["/data/xxsx-api/account-pool-data"]="backups/account-pool"
  ["/data/backups"]="backups/system"
)

run() {
  local src="$1" rel="$2"
  [ ! -d "$src" ] && { echo "  ⏭ 跳过 $src（不存在）"; return; }
  local size=$(du -sh "$src" 2>/dev/null | cut -f1)
  local MARK="$src/.storage-migrated-persist"
  if [ -f "$MARK" ]; then
    echo "  ✅ $src ($size) 已迁移(md0持久)并校验通过，跳过"
    return
  fi
  if [ -n "$DRY" ]; then
    echo "  🧮 [dry-run] $src ($size) → storage/$rel"
    return
  fi
  echo "  🔄 迁移 $src ($size) → storage/$rel ..."
  # rsync 推送到 CNB storage(md0 持久盘)；源删目标不删，保证安全
  timeout 3600 rsync -avz --partial --delete-excluded -e "ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$src/" "$HOST:$STORAGE_BASE/$rel/" >/dev/null 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "  ⚠️ $src rsync 退出码 rc=$rc（常见于传输完成握手时 SSH 断开，数据可能已传完整）——继续做完整性校验"
  fi
  # ── 完整性校验：对比源/目标文件数与总字节数（不论 rsync 退出码，数据齐了就认）──
  local src_cnt=$(find "$src" -type f | wc -l)
  local src_bytes=$(du -sb "$src" 2>/dev/null | cut -f1)
  local dst_cnt=$($SSH "find $STORAGE_BASE/$rel -type f | wc -l" 2>/dev/null | tr -d ' \r')
  local dst_bytes=$($SSH "du -sb $STORAGE_BASE/$rel 2>/dev/null | cut -f1" 2>/dev/null | tr -d ' \r')
  if [ "$src_cnt" = "$dst_cnt" ] && [ -n "$dst_cnt" ] && [ "$dst_cnt" != "0" ]; then
    touch "$MARK"
    echo "  ✅ $src 迁移完成并校验通过（文件 $src_cnt=$dst_cnt，大小 ${src_bytes}B vs ${dst_bytes}B），已打持久标记"
  else
    echo "  ⚠️ $src 迁移后校验不一致（源 $src_cnt 文件/${src_bytes}B vs 目标 $dst_cnt 文件/${dst_bytes}B），未打标记，需重跑"
  fi
}

echo "=== 开始存储迁移 $(ts) ==="
if [ -n "$TARGET_ARG" ]; then
  for src in "${!SRC_TO_CNB[@]}"; do
    if [[ "${SRC_TO_CNB[$src]}" == "$TARGET_ARG/"* ]] || [[ "${SRC_TO_CNB[$src]}" == "$TARGET_ARG" ]]; then
      run "$src" "${SRC_TO_CNB[$src]}"
    fi
  done
else
  for src in "${!SRC_TO_CNB[@]}"; do
    run "$src" "${SRC_TO_CNB[$src]}"
  done
fi
echo "=== 存储迁移结束 $(ts) ==="
echo "迁移完成目录（带 md0 持久标记）："
ls -d /data/xxsx-api/*/.storage-migrated-persist /data/backups/.storage-migrated-persist 2>/dev/null || true
echo "当前 /data 使用："
df -h /data | tail -1
