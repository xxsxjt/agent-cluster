/* 单元测试：auto-rerun-strengthen 失败自动重跑强化
 * require butler.js 不触发 main（require.main !== butler.js）→ 只测导出函数 */
'use strict';
const path = require('path');
const fs = require('fs');
const butler = require('../butler.js');
const { isAnomalyFailure, isFailMarker, appendFailureChain, failureChainText } = butler;

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); } };

console.log('== isAnomalyFailure 判别 ==');
const anomalyCases = [
  '进程退出 code=1',
  '进程异常中断（pid 已死）',
  '疑似卡死（日志 20 分钟未更新）',
  '渠道全部不稳定（重试 8 次仍失败，未判定限额）',
  '渠道疑似限额（opencode-go连续5次）已通知用户可重置',
  'HK 不可达（ssh fail xxx）',
  'CNB 不可达（空间休眠/重建：ssh fail）',
  '孤儿残留（并发名额释放）',
  'HK 桥进程退出 code=1',
  'CNB 桥进程退出 code=1',
  '渠道空回复',
  'CNB 任务超时（7200s）且软超时宽限后远端仍无活动',
  'scp 投递失败 xxx',
  'CNB 执行器拉起失败 ssh fail',
];
for (const c of anomalyCases) t(`异常→重跑: ${c.slice(0, 24)}`, isAnomalyFailure(c) === true);

const bizCases = ['任务文件未包含代码块', '需求已变更，任务作废', '目标环境不存在，无法执行', '该功能已在其他任务完成', '缺乏必要权限，无法继续'];
for (const c of bizCases) t(`业务→不重跑: ${c.slice(0, 24)}`, isAnomalyFailure(c) === false);
t('空标记→按异常处理', isAnomalyFailure('') === true);
t('null→按异常处理', isAnomalyFailure(null) === true);

console.log('== isFailMarker 失败标记判别（防成功文章误扫）==');
t('.FAILED 前缀 → 失败标记', isFailMarker('.FAILED: 孤儿残留（并发名额释放）') === true);
t('.FAILED 前缀（空回复）', isFailMarker('.FAILED: 渠道空回复') === true);
t('系统级失败标记（无前缀）', isFailMarker('进程异常中断（pid 已死）') === true);
t('系统级（疑似卡死）', isFailMarker('疑似卡死（日志 20 分钟未更新）') === true);
t('短摘要失败（≤80字明确声明）', isFailMarker('任务失败：无法完成') === true);
t('短摘要含失败词但非声明开头不误判', isFailMarker('渠道管理智能体完成：channel-fallback 加恢复探测，失败延长冷却，新增恢复探测') === false);
t('成功摘要（以完成开头含失败词）不误判', isFailMarker('渠道链路健康持续巡检完成：四渠道(opencode-go/aliyun-tokenplan/xxsx/deepseek)全部健康') === false);
t('成功文章不误判', isFailMarker('# 每日例会汇报\n正文提到 .FAILED 字样和卡死修复内容。'.repeat(12)) === false);
t('成功摘要长文不误判', isFailMarker('DONE: 完善 xxx 完成。失败根因=源任务首次运行进程48912卡死无DONE，分身基于旧失败状态误判需重派，但实际已成功重跑并写入准确DONE。补验确认无误。'.repeat(3)) === false);
t('成功汇报（含空回复词）不误判', isFailMarker('## 1. 今日做了什么\n- 空回复 fallback 增强（fallback-empty-reply）：完成 lib/channel-fallback.js 增强——新增 dete'.repeat(8)) === false);
t('空内容 → 不是失败标记', isFailMarker('') === false);

console.log('== 失败原因链 ==');
appendFailureChain('__unit-test-fc', '第一次：进程退出 code=1');
appendFailureChain('__unit-test-fc', '第二次：渠道全部不稳定');
const chain = failureChainText('__unit-test-fc');
t('链含两次原因', chain.includes('第一次') && chain.includes('第二次'));
t('链格式 #1:#2', /#1:/.test(chain) && /#2:/.test(chain));
try { fs.unlinkSync(path.join(__dirname, '..', 'logs', 'failure-chain', '__unit-test-fc.jsonl')); } catch (e) {}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
