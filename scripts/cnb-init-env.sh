#!/usr/bin/env bash
# cnb-init-env.sh — CNB 云开发空间环境初始化（新实例回收重建后一键恢复）
# 在 CNB 端以 root 运行。幂等：已装则跳过。
# 用法（本机）：ssh -i ~/.ssh/id_rsa_cnb <host> 'bash -s' < scripts/cnb-init-env.sh
set -e

echo "=== [1/5] 系统基础 ==="
export DEBIAN_FRONTEND=noninteractive
# 2026-08-12 修复：apt update 无条件先跑（原来依赖 curl 短路，curl 存在时跳过 update，
#   导致后续装 java 用过期缓存失败；另补重试，apt 偶发网络抖动可自愈）
for i in 1 2 3; do
  apt-get update -qq >/dev/null 2>&1 && break
  echo "  - apt update 第 ${i} 次失败，重试…"
  sleep 3
done
command -v curl >/dev/null || apt-get install -y -qq curl wget unzip >/dev/null 2>&1

echo "=== [2/5] OpenJDK 21 ==="
if ! command -v java >/dev/null; then
  apt-get install -y -qq openjdk-21-jdk-headless >/dev/null 2>&1
fi
java -version 2>&1 | head -1

echo "=== [3/5] Gradle 8.14.3 ==="
if ! command -v gradle >/dev/null; then
  if [ ! -d /opt/gradle-8.14.3 ]; then
    curl -sL -o /opt/gradle.zip https://services.gradle.org/distributions/gradle-8.14.3-bin.zip
    (cd /opt && unzip -q gradle.zip && rm -f gradle.zip)
  fi
  ln -sf /opt/gradle-8.14.3/bin/gradle /usr/local/bin/gradle
fi
gradle -v 2>&1 | grep -E '^Gradle' | head -1

echo "=== [4/5] pi CLI 0.83.0 ==="
if ! command -v pi >/dev/null; then
  npm install -g @earendil-works/pi-coding-agent@0.83.0 >/dev/null 2>&1
fi
pi --version 2>&1 | head -1

echo "=== [5/5] 目录 + 配置占位（models/auth 由本机 scp 注入）==="
mkdir -p /data/cnb-org/{inbox,logs,tasks}
chmod -R 755 /data/cnb-org
touch /data/cnb-org/.env-init-ok
echo "CNB_ENV_INIT_OK"
