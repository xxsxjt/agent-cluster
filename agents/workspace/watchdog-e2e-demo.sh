#!/usr/bin/env bash
# 模拟数据批量处理长任务: 6个批次, 每批 sleep 20秒, 总耗时约120秒
echo "[watchdog-e2e-demo] 模拟数据批量处理任务开始"
echo "目标: 处理 6 个批次, 每批 sleep 20 秒, 运行时长 >1 分钟"
echo ""
for i in 1 2 3 4 5 6; do
  echo "[阶段 $i/6] 开始处理批次 $i..."
  sleep 20
  echo "[阶段 $i/6] 完成 - 处理 1000 条记录, 输出 done"
  echo ""
done
echo "[watchdog-e2e-demo] 全部 6 个批次处理完成, 共 6000 条记录"
echo "[watchdog-e2e-demo] 总耗时约 120 秒"
