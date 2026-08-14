// 测试 hk-alert.js base64 链路（文件方式传参，绕开 bash→node 编码损坏）
'use strict';
const cp = require('child_process');
const r = cp.spawnSync(process.execPath, [
  'scripts/hk-alert.js',
  'notify-encoding-fix-验证3',
  'done',
  'night-worker',
  '文件方式传参验证：中文消息应完整无乱码',
], { encoding: 'utf8' });
console.log('exit:', r.status);
console.log((r.stdout || '').trim());
