/* 集成验证：auto-rerun-strengthen 失败自动重跑强化
 * 场景 A：误杀标记（外部脚本写 .FAILED: 孤儿残留（并发名额释放））→ sweepSilentFailures 自动重跑
 * 场景 B：明确业务失败 → 不盲跑（DONE 保留）+ business-failures.jsonl 记录
 * 场景 C：节点不可达（HK）→ recoverFromFailure 降级转本机（target 改 local + 重派）
 * 完成后清理全部测试痕迹。 */
'use strict';
const path = require('path');
const fs = require('fs');
const ORG = path.join(__dirname, '..');
process.chdir(ORG);
const butler = require('../butler.js');
const INBOX = path.join(ORG, 'inbox');
const LOGS = path.join(ORG, 'logs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); } };

const recCount = () => { try { return JSON.parse(fs.readFileSync(path.join(LOGS, 'recovery-count.json'), 'utf8')); } catch (e) { return {}; } };
const markCount = name => { const c = recCount(); delete c[name]; fs.writeFileSync(path.join(LOGS, 'recovery-count.json'), JSON.stringify(c, null, 2), 'utf8'); };
const cleanup = (name) => {
  for (const ext of ['.md', '.DONE', '.FAILED', '.PID']) { try { fs.unlinkSync(path.join(INBOX, name + ext)); } catch (e) {} }
  for (const ext of ['.log', '.hk.log', '.cnb.log']) { try { fs.unlinkSync(path.join(LOGS, name + ext)); } catch (e) {} }
  try { fs.unlinkSync(path.join(LOGS, 'failure-chain', name + '.jsonl')); } catch (e) {}
  markCount(name);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { try { if (fn()) return true; } catch (e) {} await wait(2000); }
  console.log(`  ⏳ 等待超时: ${label}`);
  return false;
};
const safeRead = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
// 极简任务：立即写 DONE，不做事（验证用）
const makeTask = (name, extraHead) => {
  const head = extraHead ? extraHead + '\n' : '';
  fs.writeFileSync(path.join(INBOX, `${name}.md`),
    `agent: night-worker\nprovider: opencode-go\nmodel: deepseek-v4-flash\nthinking: off\n${head}# 任务：${name}（自动恢复机制验证）\n\n立即创建标记文件，内容为 ok。不要做任何其他事情，不要读任何文件。\n${INBOX}/${name}.DONE`, 'utf8');
};

(async () => {
  console.log('== 场景 A：误杀标记 → 自动重跑 ==');
  const A = '__sim-orphan-kill';
  cleanup(A);
  makeTask(A);
  // 模拟外部清理脚本误杀：杀进程 + 写 .FAILED 标记（管家重启/active 丢失场景：任务不在 active）
  fs.writeFileSync(path.join(INBOX, `${A}.DONE`), '.FAILED: 孤儿残留（并发名额释放）', 'utf8');
  const before = recCount()[A] || 0;
  const n = butler.sweepSilentFailures();
  t('sweepSilentFailures 触发重跑（返回值≥1）', n >= 1);
  t('失败标记 .DONE 被清除（重跑接管）', !fs.existsSync(path.join(INBOX, `${A}.DONE`)));
  t('任务文件保留（重派依据）', fs.existsSync(path.join(INBOX, `${A}.md`)));
  t('恢复计数 +1', (recCount()[A] || 0) === before + 1);
  t('重跑已派发（PID 文件出现）', fs.existsSync(path.join(INBOX, `${A}.PID`)));
  // 等重跑完成（agent 极简任务应 1-3 分钟内完成）
  const doneA = await waitFor(() => { const d = safeRead(path.join(INBOX, `${A}.DONE`)); return d && !d.includes('.FAILED'); }, 240000, `场景A 重跑完成`);
  t('重跑后任务成功完成（DONE=ok）', doneA);
  cleanup(A);

  console.log('== 场景 B：明确业务失败 → 不盲跑 + 记录 ==');
  const B = '__sim-biz-fail';
  cleanup(B);
  makeTask(B);
  fs.writeFileSync(path.join(INBOX, `${B}.DONE`), '.FAILED: 任务文件未包含代码块', 'utf8');
  const bizBefore = (() => { try { return fs.readFileSync(path.join(LOGS, 'business-failures.jsonl'), 'utf8').split('\n').filter(l => l.includes(B)).length; } catch (e) { return 0; } })();
  const n2 = butler.sweepSilentFailures();
  t('业务失败不重跑（返回 0）', n2 === 0);
  t('失败标记保留（不盲跑）', fs.existsSync(path.join(INBOX, `${B}.DONE`)));
  t('未派发（无 PID）', !fs.existsSync(path.join(INBOX, `${B}.PID`)));
  t('业务失败已记录 business-failures.jsonl', (() => { try { return fs.readFileSync(path.join(LOGS, 'business-failures.jsonl'), 'utf8').split('\n').filter(l => l.includes(B)).length > bizBefore; } catch (e) { return false; } })());
  cleanup(B);

  console.log('== 场景 C：节点不可达 → 降级转本机 ==');
  const C = '__sim-hk-down';
  cleanup(C);
  makeTask(C, 'target: hk');
  fs.writeFileSync(path.join(INBOX, `${C}.DONE`), '.FAILED: HK 不可达（Warning: Identity file xxx 无权限）', 'utf8');
  const okC = butler.recoverFromFailure(C, null, 'HK 不可达（Warning: Identity file xxx 无权限）', { agentId: 'server-admin', node: 'hk' });
  const taskContent = fs.readFileSync(path.join(INBOX, `${C}.md`), 'utf8');
  t('降级返回已接管', okC === true);
  t('任务文件 target 已改 local（不再路由 HK）', /^target\s*:\s*local/m.test(taskContent));
  t('降级记录已写入任务文件', taskContent.includes('## 降级记录'));
  t('失败标记被清除', !fs.existsSync(path.join(INBOX, `${C}.DONE`)));
  t('已重派本机（PID 出现）', fs.existsSync(path.join(INBOX, `${C}.PID`)));
  const doneC = await waitFor(() => { const d = safeRead(path.join(INBOX, `${C}.DONE`)); return d && !d.includes('.FAILED'); }, 240000, `场景C 本机执行完成`);
  t('降级后本机执行完成', doneC);
  cleanup(C);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
