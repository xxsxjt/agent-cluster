// memtab-ui-check.js — headless Edge + 标准 CDP 验证"记忆"tab 真实渲染
// 用法: node memtab-ui-check.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const DBG_PORT = 9333;
const URL = 'http://127.0.0.1:8787/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path: p, timeout: 3000 }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-memtab-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${DBG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });

  // 等 CDP 就绪
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await httpJson('/json/list');
      target = list.find(t => t.type === 'page');
    } catch (e) {}
  }
  if (!target) { console.error('✗ CDP 未就绪'); edge.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let idSeq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise(r => ws.onopen = r);
  const cdp = (method, params) => new Promise(res => {
    const id = ++idSeq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evalJs = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };

  await cdp('Page.enable');
  await cdp('Page.navigate', { url: URL });
  await sleep(4500);   // Vue 挂载 + /api/state + loadDetail

  // 1) 点选 takina 节点
  const picked = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.pane.left .row, li.node .row')];
    const row = rows.find(r => (r.querySelector('.lab') || {}).textContent && /takina/i.test(r.querySelector('.lab').textContent));
    if (!row) return 'not-found:' + rows.length;
    row.click(); return 'clicked';
  })()`);
  console.log('选中 takina:', picked);
  await sleep(1500);

  // 2) 检查 subtabs 里是否出现"记忆"
  const tabs = await evalJs(`JSON.stringify([...document.querySelectorAll('.subtabs button')].map(b => b.textContent.trim()))`);
  console.log('subtabs:', tabs);

  // 3) 点"记忆" tab
  const memClicked = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.subtabs button')].find(x => x.textContent.includes('记忆'));
    if (!b) return 'no-mem-tab'; b.click(); return 'clicked';
  })()`);
  console.log('点记忆tab:', memClicked);
  await sleep(2000);   // loadMemory fetch

  // 4) 读取记忆面板渲染结果
  const report = await evalJs(`(() => {
    const panes = [...document.querySelectorAll('.pane.mid .scroll')];
    const vis = panes.find(p => p.offsetParent !== null);
    const q = s => document.querySelectorAll(s).length;
    return JSON.stringify({
      visiblePaneHasMent: vis ? vis.querySelectorAll('.ment').length : -1,
      memday: q('.memday'), memitem: q('.memitem'), ment: q('.ment'), memkw: q('.memkw'),
      pendingChips: [...document.querySelectorAll('.ment.es-pending')].map(e => e.textContent.trim()),
      sample: vis ? vis.innerText.slice(0, 400) : '(无可见面板)'
    }, null, 1);
  })()`);
  console.log('渲染结果:\n' + report);

  // 5) 关键词过滤交互
  const kwTest = await evalJs(`(() => {
    const inp = document.querySelector('.memkw');
    if (!inp) return 'no-input';
    inp.value = 'Takina'; inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await sleep(600);
  const kwCount = await evalJs(`document.querySelectorAll('.memitem').length`);
  console.log('关键词过滤:', kwTest, '→ 剩', kwCount, '条');

  // 6) 截图留档
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const out = 'C:/Users/du_ji/pi_workspace/org/agents/night-worker/scratch/memtab-shot.png';
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', out);

  ws.close();
  edge.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
