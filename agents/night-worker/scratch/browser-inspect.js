// 临时浏览器检查脚本：复用 browser-ext.mjs 的连接逻辑，单会话内完成打开+检查
const { execSync } = require('child_process');
// 直接把 browser-ext.mjs 的类加载进来
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync('C:/Users/du_ji/.agents/skills/browser-control/scripts/browser-ext.mjs', 'utf8');
// 提取核心函数定义（listCodexPipes / connectPipe / Browser / sleep）
const parts = src.split('async function main()')[0];
const vm = require('vm');
const sandbox = { require, console, process, Buffer, fs, path, __dirname: 'C:/Users/du_ji/.agents/skills/browser-control/scripts' };
vm.createContext(sandbox);
vm.runInContext(parts, sandbox);
const { listCodexPipes, connectPipe, sleep } = sandbox;
const BrowserImpl = sandbox.Browser;

async function main() {
  const pipes = listCodexPipes();
  if (!pipes.length) { console.error('未找到管道'); process.exit(1); }
  let sock, browser;
  for (const p of pipes) {
    const uuid = p.replace(/^codex-browser-use\\/, '');
    try { sock = await connectPipe(uuid); browser = new BrowserImpl(sock); break; }
    catch { continue; }
  }
  if (!browser) { console.error('无法连接'); process.exit(1); }
  const t = await browser.createTab();
  const tabId = t.id;
  await sleep(400);
  await browser.attach(tabId);
  await browser.cdp(tabId, 'Page.navigate', { url: 'http://127.0.0.1:8787/' });
  await sleep(3500); // 等 Vue 渲染 + 数据加载

  const expr = `(() => {
    const q = s => document.querySelector(s);
    const names = ['#app','.grid','.pane.left','.pane.mid','.pane.mid .ph.col','.pane.mid .scroll.out','.pane.mid .events','.pane.right','.pane.right .scroll'];
    const out = names.map(n => {
      const el = q(n);
      if (!el) return n + ': MISSING';
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return n + ' | h=' + Math.round(rect.height) + ' w=' + Math.round(rect.width) +
        ' sh=' + el.scrollHeight + ' ch=' + el.clientHeight +
        ' | ofy=' + cs.overflowY + ' minh=' + cs.minHeight + ' flex=' + cs.flex + ' display=' + cs.display;
    });
    return out.join('\\n');
  })()`;
  const r = await browser.evalExpr(tabId, expr);
  console.log(String(r));
  await browser.closeTab(tabId).catch(() => {});
  sock.end();
}
main().catch(e => { console.error('失败:', e.message); process.exit(1); });