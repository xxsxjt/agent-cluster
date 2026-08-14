/* test/related-agents.spec.js — 相关智能体检索单测（2026-08-12 agent-collab） */
'use strict';
const ra = require('../lib/related-agents');
const assert = require('assert');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('✅', name); } catch (e) { fail++; console.log('❌', name, '→', e.message); } };

/* 用例1：服务器运维任务 → 领域相关应命中 server-admin / xxsx-gateway 等（grp-cloud 组关键词+identity） */
const t1 = { name: 'hk-server-health-check', agentId: 'coo', keywords: 'hk 服务器 健康 检查 节点 ssh 保活'.split(' '), content: '' };
const r1 = ra.findRelated(t1, 'coo');
t('用例1 服务器检查命中 server-admin', () => {
  assert.ok(r1.related.some(r => r.id === 'server-admin'), '应含 server-admin，实际: ' + JSON.stringify(r1.related));
  const sa = r1.related.find(r => r.id === 'server-admin');
  assert.ok(sa.reason.includes('领域相关'), 'server-admin 应有领域相关 reason: ' + JSON.stringify(sa.reason));
});

/* 用例2：内容写作任务 → 应命中 copywriting / novel */
const t2 = { name: 'gzh-article-write', agentId: 'coo', keywords: '公众号 文案 写作 内容 爆款 标题'.split(' '), content: '' };
const r2 = ra.findRelated(t2, 'coo');
t('用例2 内容写作命中 copywriting', () => {
  assert.ok(r2.related.some(r => r.id === 'copywriting'), '应含 copywriting，实际: ' + JSON.stringify(r2.related));
});

/* 用例3：安全渗透任务 → 应命中 security */
const t3 = { name: 'src-vuln-scan', agentId: 'coo', keywords: '安全 渗透 漏洞 扫描 测试'.split(' '), content: '' };
const r3 = ra.findRelated(t3, 'coo');
t('用例3 安全渗透命中 security', () => {
  assert.ok(r3.related.some(r => r.id === 'security'), '应含 security，实际: ' + JSON.stringify(r3.related));
});

/* 用例4：排除自身 */
const r4 = ra.findRelated(t1, 'server-admin');
t('用例4 排除自身 server-admin', () => {
  assert.ok(!r4.related.some(r => r.id === 'server-admin'), '不应含自己');
});

/* 用例5：MC 模组开发 → 应命中 mc-dev */
const t5 = { name: 'temple-mod-build', agentId: 'coo', keywords: 'mod minecraft 模组 构建 gradle java 开发'.split(' '), content: '' };
const r5 = ra.findRelated(t5, 'coo');
t('用例5 MC 开发命中 mc-dev 系', () => {
  assert.ok(r5.related.some(r => r.id === 'mc-dev' || r.id === 'mc-dev-temple' || r.id === 'mc-dev-earth'), '应含 mc-dev 系，实际: ' + JSON.stringify(r5.related));
});

/* 用例6：无关任务（纯框架词）→ 领域不命中但可接受历史命中，验证不崩 */
const t6 = { name: 'zebra-qqq-xyz', agentId: 'coo', keywords: '斑马 无意义 占位词'.split(' '), content: '' };
const r6 = ra.findRelated(t6, 'coo');
t('用例6 无关任务不崩', () => { assert.ok(Array.isArray(r6.related)); });

/* 用例7：显式相关格式 */
const fmt = ra.formatRelated('coo', { related: [{ id: 'server-admin', reason: ['领域相关'] }], conflicts: [] });
t('用例7 formatRelated 输出含提示', () => { assert.ok(fmt.includes('server-admin')); });

/* 用例8：冲突检测（模拟活跃写集） */
const rlMock = {
  parseDeclarations: c => { const m = (c.match(/writes:\s*(.+)/) || [])[1] || ''; return { writes: m.split(/[,，\s]+/).filter(Boolean) }; },
  checkConflict: (tn, writes) => {
    const conflicts = [];
    for (const w of writes) { if (w === 'org.json') conflicts.push({ resource: w, by: ['other-task-123'] }); }
    return { conflicts };
  },
};
const t8 = { name: 'org-structure-change', agentId: 'coo', keywords: '组织树 调整'.split(' '), content: 'writes: org.json' };
const tmpAct = require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'ra-test-' + Date.now()), { recursive: true });
require('fs').writeFileSync(require('path').join(tmpAct, 'active-tasks.json'), JSON.stringify({ 'other-task-123': { agentId: 'night-worker' } }), 'utf8');
const r8 = ra.findRelated(t8, 'coo', { rl: rlMock, activeTable: require('path').join(tmpAct, 'active-tasks.json') });
t('用例8 冲突标记', () => {
  assert.ok(r8.conflicts.length >= 1, '应有冲突，实际: ' + JSON.stringify(r8.conflicts));
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
