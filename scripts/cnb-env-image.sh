#!/usr/bin/env bash
# cnb-env-image.sh — CNB 环境镜像打包 / 恢复（缓解实例回收后的热数据重迁）
#
# 背景（2026-08-12 保活加固）：CNB 无平台级持久盘（stash/backup/restore API 均不存在），
#   /data 属容器本地盘，实例强制回收即清空 java/gradle/pi。每次重建都要从零
#   curl gradle(90MB)+unzip + npm install pi(163M)，耗时数分钟 = "storage 热数据重迁"成本。
#
# 解法：把已初始化好的环境打包成镜像（gradle + pi 全局包），本机存档；实例回收重建后
#   用镜像秒级恢复（scp 过去解压），替代分钟级从零初始化。幂等，可安全重跑。
#
# CNB 端 root 运行。镜像 = /opt/gradle-8.14.3 + /usr/local/lib/node_modules/@earendil-works(pi)
#
# 用法（CNB 端）：
#   bash cnb-env-image.sh build                          # 打包 → /data/cnb-org/env-image.tar.gz
#   bash cnb-env-image.sh restore <tar.gz路径>           # 解压恢复 gradle+pi（幂等）
#
# 本机编排：先 scp 本脚本+执行 build 生成镜像，再 scp 镜像回本机存档（logs/cnb-env/）。
#   cnb-task.js 自愈优先用镜像恢复，无镜像回退 cnb-init-env.sh。
set -uo pipefail

MODE="${1:-build}"
IMG="${2:-/data/cnb-org/env-image.tar.gz}"
GRADLE=/opt/gradle-8.14.3
PI=/usr/local/lib/node_modules/@earendil-works

case "$MODE" in
  build)
    echo "== [build] 打包环境镜像 gradle(${GRADLE}) + pi(${PI}) → ${IMG}"
    test -d "$GRADLE" || { echo "❌ gradle 目录缺失：${GRADLE}（先跑 cnb-init-env.sh）"; exit 2; }
    test -d "$PI"    || { echo "❌ pi 目录缺失：${PI}（先跑 cnb-init-env.sh）"; exit 2; }
    tar czf "$IMG" -C /opt gradle-8.14.3 -C /usr/local/lib/node_modules @earendil-works || { echo "❌ 打包失败"; exit 2; }
    echo "✅ build 完成：$(du -h "$IMG" | cut -f1) → ${IMG}"
    ;;
  restore)
    echo "== [restore] 恢复环境镜像 ${IMG}"
    test -f "$IMG" || { echo "❌ 镜像不存在：${IMG}"; exit 2; }
    # 已有则跳过（幂等）；缺失才解压
    test -d "$GRADLE" || { echo "  - 恢复 gradle"; mkdir -p /opt; tar xzf "$IMG" -C /opt gradle-8.14.3; }
    test -d "$PI"     || { echo "  - 恢复 pi 全局包"; tar xzf "$IMG" -C /usr/local/lib/node_modules @earendil-works; }
    # 重建软链（幂等）
    ln -sf /opt/gradle-8.14.3/bin/gradle /usr/local/bin/gradle
    ln -sf ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /usr/local/bin/pi
    chmod +x /usr/local/bin/pi
    echo "== [restore] 验证 =="
    # gradle 验证看二进制存在性（gradle -v 需 java，java 走 init-env 兜底补装，避免误报）
    test -x /opt/gradle-8.14.3/bin/gradle && echo "  ✅ gradle 二进制就绪" || echo "  ❌ gradle 未就绪"
    test -x /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
      && command -v pi >/dev/null && echo "  ✅ pi 就绪" || echo "  ❌ pi 未就绪"
    echo "RESTORE_OK"
    ;;
  *)
    echo "用法: bash cnb-env-image.sh <build|restore> [镜像路径]"; exit 2 ;;
esac
