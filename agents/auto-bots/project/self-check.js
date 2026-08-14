/**
 * 自动化系统自检脚本（无副作用版）
 * 验证: 关键路径 / 模块文件存在 / 语法正确 / 依赖可用
 * 用法: node self-check.js
 * 注意: 不 require 立即执行型脚本（start/schedule/deploy/generate/uploaders/bots），
 *       避免触发真实部署/创建定时任务/启动浏览器等副作用。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT = __dirname;

const MODULES = [
  'start.js',
  'schedule-tasks.js',
  'deploy-portfolio.js',
  'generate-and-publish.js',
  'generate-and-publish-safe.js',
  'trackers/cost-tracker.js',
  'uploaders/index.js',
  'uploaders/douyin.js',
  'uploaders/bilibili.js',
  'uploaders/xiaohongshu.js',
  'bots/xianyu-bot.js'
];

const KEY_PATHS = [
  'logs', 'deploy', 'pending',
  'bots/xianyu-bot.js',
  'trackers/cost-tracker.js',
  'uploaders/index.js',
  'portfolio.html',
  'deploy/index.html',
  'SAFE-MODE.md',
  'tasks.xml'
];

let ok = 0, warn = 0, fail = 0;
const lines = [];

function report(status, msg) {
  if (status === 'OK') ok++;
  else if (status === 'WARN') warn++;
  else fail++;
  lines.push(`[${status}] ${msg}`);
}

// 1. BASE_DIR 路径有效性
if (!fs.existsSync(PROJECT)) {
  report('FAIL', `项目根不存在: ${PROJECT}`);
} else {
  report('OK', `项目根存在: ${PROJECT}`);
  if (PROJECT.includes('WorkBuddy/agnes')) {
    report('FAIL', '项目仍指向失效路径 WorkBuddy/agnes');
  } else {
    report('OK', 'BASE_DIR 已指向实际 project 目录');
  }
}

// 2. 模块文件存在 + 语法检查（node --check，无副作用）
for (const m of MODULES) {
  const full = path.join(PROJECT, m);
  if (!fs.existsSync(full)) { report('FAIL', `模块缺失: ${m}`); continue; }
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    report('OK', `语法正确: ${m}`);
  } catch (e) {
    report('FAIL', `语法错误: ${m}`);
  }
}

// 3. 关键路径存在
for (const p of KEY_PATHS) {
  report(fs.existsSync(path.join(PROJECT, p)) ? 'OK' : 'WARN', `关键路径: ${p}`);
}

// 4. 依赖检查
const dep = path.join(PROJECT, 'node_modules');
const playwright = path.join(dep, 'playwright');
report(fs.existsSync(playwright) ? 'OK' : 'FAIL', `playwright 依赖`);
report(fs.existsSync(dep) ? 'OK' : 'WARN', `node_modules 存在`);

// 5. pending 队列
const pending = fs.existsSync(path.join(PROJECT, 'pending'))
  ? fs.readdirSync(path.join(PROJECT, 'pending')).filter(f => f.endsWith('.json')).length
  : 0;
report(pending > 0 ? 'OK' : 'WARN', `pending 队列: ${pending} 条待处理`);

// 输出
console.log('\n========== 自动化系统自检报告 ==========');
lines.forEach(l => console.log(l));
console.log('\n========== 汇总 ==========');
console.log(`OK: ${ok}  WARN: ${warn}  FAIL: ${fail}`);

// 写报告
const reportPath = path.join(PROJECT, '..', 'artifacts', 'self-check-report.md');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const md = [
  '# 自动化系统自检报告',
  `时间: ${new Date().toISOString()}`,
  `结果: OK ${ok} / WARN ${warn} / FAIL ${fail}`,
  '',
  '```',
  ...lines,
  '```',
  ''
].join('\n');
fs.writeFileSync(reportPath, md);
console.log(`\n报告已写入: ${reportPath}`);
