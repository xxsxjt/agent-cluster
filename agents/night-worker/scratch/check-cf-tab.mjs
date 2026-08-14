import net from 'node:net';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const TARGET_URL = process.argv[2] || 'https://api.xxssxx.top/login';
const pipes = execFileSync('python3', [path.join(import.meta.dirname, 'list_pipes.py')], { encoding: 'utf8' }).split(',').map(s => s.trim()).filter(Boolean);
?
/).map(s => s.trim()).filter(Boolean);
if (!pipes.length) { console.log('NO_PIPE'); process.exit(1); }
const pipePath = '\\.\pipe\' + pipes[0];
function send(pipe, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj));
    const len = Buffer.alloc(4); len.writeUInt32LE(data.length);
    pipe.write(Buffer.concat([len, data]));
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const sz = buf.readUInt32LE(0);
        if (buf.length < 4 + sz) break;
        const msg = JSON.parse(buf.slice(4, 4 + sz).toString());
        buf = buf.slice(4 + sz);
        pipe.removeListener('data', onData);
        resolve(msg);
      }
    };
    pipe.on('data', onData);
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
}
const pipe = net.createConnection(pipePath);
pipe.on('error', (e) => { console.log('PIPE_ERR', e.message); process.exit(1); });
const sess = { session_id: 'diag-' + Date.now(), turn_id: 't1', session_context: 'diag' };
const q = (method, params) => send(pipe, { id: Math.floor(Math.random() * 1e9), jsonrpc: '2.0', method, params: { ...params, ...sess } });
pipe.on('connect', async () => {
  try {
    const ct = await q('createTab', {});
    const tabId = Number(ct.result?.tab?.id || ct.result?.id);
    console.log('NEW_TAB:', tabId);
    await q('executeCdp', { target: { tabId }, method: 'Page.navigate', commandParams: { url: TARGET_URL } });
    await new Promise(r => setTimeout(r, 15000));
    const st = await q('executeCdp', { target: { tabId }, method: 'Runtime.evaluate', commandParams: { expression: 'JSON.stringify({title:document.title,url:location.href,ready:document.readyState,body:(document.body?document.body.innerText.slice(0,200):"none")})', returnByValue: true } });
    console.log('PAGE:', st.result?.result?.result?.value || JSON.stringify(st).slice(0,300));
    const ck = await q('executeCdp', { target: { tabId }, method: 'Network.getAllCookies', commandParams: {} });
    const cookies = ck.result?.result?.cookies || [];
    const cf = cookies.filter(c => c.name.includes('cf_') || c.domain.includes('xxssxx'));
    console.log('COOKIES:', JSON.stringify(cf.map(c => ({ name: c.name, domain: c.domain }))));
    process.exit(0);
  } catch (e) { console.log('ERR', e.message); process.exit(1); }
});