// 隔离验证 on-demand 豁免逻辑（不污染真实 state/inbox）
const path = require('path');
const fs = require('fs');
const ORG = path.resolve(__dirname, '..');
const insp = require(path.join(ORG, 'lib/twin-duty-inspector.js'));
const INBOX = path.join(ORG, 'inbox');

// 用真实 takina backlog（全 on-demand）跑 scanBacklog，隔离 state
const cfg = insp.__getCfg ? insp.__getCfg() : null;
// scanBacklog 内部 readJsonSafe 读真实 config/agent-backlog.json + org.json
function run(targets, onDemandExempt) {
  const c = { enabled: true, backlogScan: { enabled: true, staleDays: 0.0001, throttleDays: 0.0001, maxDispatchPerScan: 1, onDemandExempt: onDemandExempt, targets } };
  const before = fs.readdirSync(INBOX);
  const state = { throttle: {} };
  const changed = [];
  insp.scanBacklog(c, state, changed);
  const newF = fs.readdirSync(INBOX).filter(f => !before.includes(f) && f.endsWith('.md'));
  return { changed, newF };
}

// 测试1: 开豁免 → takina 全部 on-demand → 不派活，只记豁免
const r1 = run({ takina: { privateData: false } }, true);
console.log('豁免开启: 豁免记录=', r1.changed.some(l=>l.includes('豁免')), '| 派活记录=', r1.changed.some(l=>l.includes('派活')), '| 新inbox文件=', r1.newF.length);
for (const f of r1.newF) try { fs.unlinkSync(path.join(INBOX, f)); } catch(e) {}

// 测试2: 关豁免 → 期望恢复派活
const r2 = run({ takina: { privateData: false } }, false);
console.log('豁免关闭: 豁免记录=', r2.changed.some(l=>l.includes('豁免')), '| 派活记录=', r2.changed.some(l=>l.includes('派活')), '| 新inbox文件=', r2.newF.length);
for (const f of r2.newF) try { fs.unlinkSync(path.join(INBOX, f)); } catch(e) {}
console.log('DONE');
