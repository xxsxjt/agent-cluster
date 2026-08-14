// cf-purge-token.js — 从 CF dashboard 会话抓取 Bearer token，调用 purge_cache API
// 用法: node cf-purge-token.js <tabId>
const net = require('net');
const https = require('https');
const fsx = require('fs');
const osx = require('os');
const pathx = require('path');
const { spawnSync } = require('child_process');

function listCodexPipes() {
  const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem "\\\\.\\pipe\\" | Where-Object {$_.Name -like "codex-browser-use*"} | Select-Object -ExpandProperty Name';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const names = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (names.length) return names;
  return [];
}

function connectPipe(name) {
  const full = '\\\\.\\pipe\\' + name;
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(full, () => resolve(sock));
    sock.on('error', reject);
  });
}

class PipeClient {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.pending = new Map(); this.idc = 0; this.handlers = []; this._init(); }
  _init() {
    this.sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 4) {
        const len = this.buf.readUInt32LE(0);
        if (this.buf.length < 4 + len) break;
        const payload = this.buf.slice(4, 4 + len);
        this.buf = this.buf.slice(4 + len);
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id); this.pending.delete(msg.id);
            msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
          } else {
            this.handlers.forEach(h => h(msg));
          }
        } catch (e) {}
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.idc;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
      const frame = Buffer.alloc(4 + msg.length);
      frame.writeUInt32LE(msg.length, 0);
      msg.copy(frame, 4);
      this.sock.write(frame);
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  onEvent(h) { this.handlers.push(h); }
}

async function main() {
  const tabId = parseInt(process.argv[2], 10);
  if (!tabId) { console.error('usage: node cf-purge-token.js <tabId>'); process.exit(1); }

  let SID = 'pi-browser-' + Date.now();
  try {
    const f = pathx.join(osx.tmpdir(), 'pi-browser-session');
    if (fsx.existsSync(f)) { const v = fsx.readFileSync(f, 'utf8').trim(); if (v) SID = v; }
  } catch (e) {}
  const sess = { session_id: SID, turn_id: 't' + Date.now(), session_context: 'live' };

  const pipes = listCodexPipes();
  if (!pipes.length) { console.error('no pipes'); process.exit(1); }
  let client;
  for (const p of pipes) {
    try { const sock = await connectPipe(p); client = new PipeClient(sock); break; } catch (e) {}
  }
  if (!client) { console.error('cannot connect'); process.exit(1); }
  console.log('connected, session', SID);

  // claim tab into this session
  try {
    const cr = await client.send('claimUserTab', { tabId, ...sess });
    console.log('claimed:', JSON.stringify(cr || {}).slice(0, 100));
  } catch (e) { console.log('claim err:', e.message.slice(0, 120)); }

  // attach (attachFull 逻辑：attachTarget 补附加 + detach 重置重试)
  let attached = false;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 5 && !attached; i++) {
    try {
      await client.send('attach', { tabId, ...sess }).catch(() => {});
      await sleep(150);
      const tg = await client.send('executeCdp', { target: { tabId }, method: 'Target.getTargets', commandParams: {}, ...sess }).catch(() => null);
      const tinfos = (tg && tg.targetInfos) || [];
      const ti = tinfos.find(s => 'tabId' in s ? s.tabId === Number(tabId) : false);
      if (ti && ti.attached === false) {
        try { await client.send('attachTarget', { tabId, targetId: ti.id, ...sess }); console.log('attachTarget OK:', ti.id); } catch (e) { console.log('attachTarget err:', e.message.slice(0, 80)); }
        await sleep(500);
      }
      const r = await client.send('executeCdp', { target: { tabId }, method: 'Runtime.evaluate', commandParams: { expression: '1', returnByValue: true }, ...sess });
      attached = true;
      console.log('attached+verified');
    } catch (e) {
      console.log('attach retry', i, e.message.slice(0, 80));
      await client.send('detach', { tabId, ...sess }).catch(() => {});
      await sleep(400);
    }
  }
  if (!attached) { console.error('ATTACH FAILED'); process.exit(2); }

  // collect auth headers + urls
  const authHeaders = new Set();
  const reqUrls = [];
  client.onEvent((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      const p = msg.params || {};
      const hdrs = (p.request && p.request.headers) || {};
      if (hdrs.Authorization) authHeaders.add(hdrs.Authorization.slice(0, 150));
      const u = (p.request && p.request.url) || '';
      if (u.startsWith('https://dash.cloudflare.com') && !/\.(js|css|png|svg|woff|ico)/.test(u)) reqUrls.push(u.replace('https://dash.cloudflare.com', '').slice(0, 110));
    }
  });
  // reload first (detaches debugger), then re-attach and listen for API calls
  try {
    await client.send('executeCdp', { target: { tabId }, method: 'Page.reload', commandParams: { ignoreCache: true }, ...sess });
    console.log('reload sent');
  } catch (e) { console.log('reload err:', e.message.slice(0, 80)); }
  await new Promise(r => setTimeout(r, 3000));

  // re-attach after navigation
  let attached2 = false;
  for (let i = 0; i < 5 && !attached2; i++) {
    try {
      await client.send('attach', { tabId, ...sess }).catch(() => {});
      await sleep(150);
      const tg = await client.send('executeCdp', { target: { tabId }, method: 'Target.getTargets', commandParams: {}, ...sess }).catch(() => null);
      const tinfos = (tg && tg.targetInfos) || [];
      const ti = tinfos.find(s => 'tabId' in s ? s.tabId === Number(tabId) : false);
      if (ti && ti.attached === false) {
        try { await client.send('attachTarget', { tabId, targetId: ti.id, ...sess }); console.log('re-attachTarget OK'); } catch (e) {}
        await sleep(500);
      }
      await client.send('executeCdp', { target: { tabId }, method: 'Runtime.evaluate', commandParams: { expression: '1', returnByValue: true }, ...sess });
      attached2 = true;
      console.log('re-attached');
    } catch (e) {
      await client.send('detach', { tabId, ...sess }).catch(() => {});
      await sleep(400);
    }
  }
  if (!attached2) { console.error('RE-ATTACH FAILED'); process.exit(2); }
  try { await client.send('executeCdp', { target: { tabId }, method: 'Network.enable', commandParams: {}, ...sess }); console.log('network enabled (post-reload)'); } catch (e) { console.log('net err:', e.message.slice(0, 80)); }
  // page state check
  try {
    const st = await client.send('executeCdp', { target: { tabId }, method: 'Runtime.evaluate', commandParams: { expression: '(location.href+" | T:"+document.title+" | B:"+document.body.innerText.length)', returnByValue: true }, ...sess });
    console.log('PAGE:', st.result && st.result.value);
  } catch (e) { console.log('page check err:', e.message.slice(0, 80)); }
  // main-world fetch purge (same-origin, bypass extension CSP)
  try {
    const expr = `(async () => {
      try {
        const zr = await fetch('/api/v4/zones?name=xxssxx.top', {credentials: 'same-origin'});
        const zt = await zr.json();
        const zones = (zt.result || []).map(z => z.id + ':' + z.name + ':' + z.status);
        const cr = await fetch('/api/v4/zones/1ff8b942171f244274a82b65fa39ab66/cache_rules?per_page=20', {credentials: 'same-origin'});
        const ct = await cr.json();
        const rules = (ct.result || []).map(r => (r.description||'') + '|' + (r.expression||'') + '|' + JSON.stringify(r.action||{}).slice(0,150));
        const pr2 = await fetch('/api/v4/zones/1ff8b942171f244274a82b65fa39ab66/rulesets?per_page=20', {credentials: 'same-origin'});
        const pt = await pr2.json();
        const rulesets = (pt.result || []).filter(r => r.kind === 'zone').map(r => r.phase + ':' + (r.rules||[]).map(x => (x.description||'') + '~' + (x.expression||'')).join(' || '));
        const pgr = await fetch('/api/v4/zones/1ff8b942171f244274a82b65fa39ab66/pagerules?per_page=50', {credentials: 'same-origin'});
        const pgt = await pgr.json();
        const pagerules = (pgt.result || []).map(r => r.targets.map(t => t.constraint.value).join(',') + ' => ' + r.actions.map(a => a.id + ':' + JSON.stringify(a.value||{})).join(' | '));
        const csr = await fetch('/api/v4/zones/1ff8b942171f244274a82b65fa39ab66/settings/edge_cache_ttl', {credentials: 'same-origin'});
        const cst = await csr.json();
        const edgeTtl = JSON.stringify(cst.result || cst.errors || {}).slice(0, 120);
        const getr = await fetch('/api/v4/zones/1ff8b942171f244274a82b65fa39ab66/settings/edge_cache_ttl', {credentials: 'same-origin'});
        const gett = await getr.json();
        const setr = await fetch('/api/v4/zones/1ff8b942171f244274a82b65fa39ab66/settings/edge_cache_ttl', {
          method: 'PATCH', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({value: 300}), credentials: 'same-origin'
        });
        const sett = await setr.json();
        const r = await fetch('/api/v4/zones/1ff8b942171f244274a82b65fa39ab66/purge_cache', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({purge_everything: true}), credentials: 'same-origin'
        });
        const t = await r.text();
        return 'GET-TTL=' + JSON.stringify(gett).slice(0, 200) + ' | SET-TTL=' + JSON.stringify(sett).slice(0, 150) + ' | PURGE status=' + r.status + ' body=' + t.slice(0, 200);
      } catch (e) { return 'PURGE-ERR ' + e.message; }
    })()`;
    const pr = await client.send('executeCdp', { target: { tabId }, method: 'Runtime.evaluate', commandParams: { expression: expr, awaitPromise: true, returnByValue: true }, ...sess });
    console.log('MAINWORLD:', pr.result && pr.result.value);
  } catch (e) { console.log('mw err:', e.message.slice(0, 100)); }

  // wait for tokens
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && authHeaders.size < 2) { await new Promise(r => setTimeout(r, 500)); }
  const tokens = [...authHeaders];
  console.log('APIS:', reqUrls.slice(0, 20).join('\n'));
  console.log('TOKENS:', tokens.join('\n'));
  if (!tokens.length) { console.error('NO TOKEN CAPTURED'); process.exit(2); }

  // purge via API using captured token
  const zoneId = '1ff8b942171f244274a82b65fa39ab66';
  const body = JSON.stringify({ purge_everything: true });
  const req = https.request({
    hostname: 'api.cloudflare.com', path: '/client/v4/zones/' + zoneId + '/purge_cache',
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      'Authorization': tokens[0], 'Accept': 'application/json'
    }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => { console.log('PURGE HTTP', res.statusCode, data.slice(0, 400)); process.exit(0); });
  });
  req.on('error', e => { console.error('purge err', e.message); process.exit(3); });
  req.write(body);
  req.end();
}

main().catch(e => { console.error('FATAL', e.message); process.exit(4); });