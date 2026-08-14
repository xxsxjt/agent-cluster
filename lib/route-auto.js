/**
 * lib/route-auto.js — auto 侧路由：任务该跑本机（Windows）还是 HK（Linux）？
 *
 * 背景（用户 2026-08-08 双集群 + 2026-08-09 CNB 接入）：任务自动路由到能跑的一端——
 *   - 服务/重活（ssh/服务器操作/大计算/部署）→ HK（沿用 hk-task 桥）
 *   - 构建类（gradle/maven/npm build/Android/跨平台编译）→ CNB 开发节点（8核16G Debian 13）
 *   - Windows 专属（msvc/msbuild/visual studio/dotnet/.exe/win构建）→ 本机 Windows
 *   - 其余 → local（维持现有默认行为，安全不惊扰）
 *
 * 用法：butler.js 在 target 未显式指定（auto 默认）且未显式绑定 agent/group 时调用
 *   const { pickSide } = require('./lib/route-auto');
 *   const side = pickSide(task);   // 'local' | 'hk' | 'cnb' | 'remote'
 *
 * 判定规则（关键词 + 能力表，纯规则兜底；不替代模型智能判断）：
 *   0. side: local|remote|auto 显式标记优先（2026-08-11 并发路由）
 *   1. 服务器/重活标记 → hk
 *   2. Windows 专属构建 → local
 *   3. 跨平台构建标记 → cnb
 *   4. 汇报/推理/信息收集类（intel-collect/review/复盘/巡检/daily-meeting）→ remote（CNB 优先，CNB 不可用→HK→本机兜底）
 *   5. 其余 → local（安全默认）
 */
'use strict';

/** Windows 专属构建/打包任务 → 本机（CNB/HK 是 Linux，跑不了） */
const WINDOWS_MARKERS = [
  'msvc', 'msbuild', 'visual studio', 'dotnet', '.csproj',
  '.exe', 'exe打包', '打包exe', 'win构建', 'windows构建', 'win 构建', 'windows 构建',
  'powershell', 'schtasks', 'regedit', 'taskkill'
];

/** 跨平台构建任务 → CNB 开发节点（8核16G Debian 13，装好 openjdk-21 + gradle） */
const CNB_MARKERS = [
  'gradle', 'maven', 'gradlew', 'gradle构建', 'maven构建',
  'npm run build', 'npm build', 'npm run', 'yarn build', 'yarn run',
  'webpack build', 'vite build',
  'compile', '编译', '编 译',
  'android', 'apk', 'sdk',
  'make build', 'go build', 'tsc -b', 'java', 'jar'
];

/** 服务器/重活任务 → HK */
const HK_MARKERS = [
  'ssh', 'scp', 'rsync',
  '服务器', 'server ', 'server\n', '服务器操作',
  'systemctl', 'service ', 'systemd',
  'docker ', 'docker-compose', 'docker compose',
  '部署', 'deployment', 'nginx', 'nginx.conf',
  '大计算', 'cpu计算', 'cpu 计算', '批量计算', '重活', 'heavy',
  '爬取', 'crawl', '100.97.', '/data/', 'new-api', 'xxsx'
];

/** 纯推理/信息收集/汇报/复盘/巡检类 → 远程（CNB 优先，远端有 pi+渠道+8 核） */
const REMOTE_MARKERS = [
  'intel-collect', '信息收集', '情报收集', '情报', '渠道情报',
  'review', '复盘', '巡检', '周报', '日报', '汇总',
  'daily-meeting', '例会', '汇报', '调研', 'research',
  '纯推理', '推理', '分析报告', '生成报告', '报告',
  '市场调研', '行业', '竞品', '舆情'
];

/**
 * 判定任务应跑哪一端。
 * 返回：'local' | 'hk' | 'cnb' | 'remote'
 *   - 'remote' = 应远程执行（CNB 优先→HK→本机兜底），由调用方做降级链。
 * @param {object} task  { name, content, keywords, target, side }
 * @returns {'local'|'hk'|'cnb'|'remote'}
 */
function pickSide(task) {
  const text = String(task && (task.content || task.name || '')).toLowerCase();
  const kws = Array.isArray(task.keywords) ? task.keywords : [];
  const hay = text + '\n' + kws.join(' ');

  // 0. side 显式标记优先（2026-08-11 并发路由）
  const side = task && task.side;
  if (side === 'local') return 'local';
  if (side === 'remote') return 'remote';
  // side: auto 或缺省 → 走下方关键词规则

  // 1. 服务器/重活 → HK（ssh/scp/部署/systemctl/docker/大计算 等）
  if (HK_MARKERS.some(m => hay.includes(m))) return 'hk';
  // 2. Windows 专属构建 → 本机（CNB/HK 是 Linux 跑不了）
  if (WINDOWS_MARKERS.some(m => hay.includes(m))) return 'local';
  // 3. 跨平台构建 → CNB 开发节点（gradle/maven/npm build/android/go/tsc）
  if (CNB_MARKERS.some(m => hay.includes(m))) return 'cnb';
  // 4. 汇报/推理/信息收集/复盘/巡检 → remote（CNB 优先）
  if (REMOTE_MARKERS.some(m => hay.includes(m))) return 'remote';
  // 5. 默认本机（安全不惊扰）
  return 'local';
}

module.exports = { pickSide, HK_MARKERS, WINDOWS_MARKERS, CNB_MARKERS, REMOTE_MARKERS };
