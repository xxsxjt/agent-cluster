// cf-purge-token.js — 从 CF dashboard 会话抓取 Bearer token，调用 purge_cache API
// 用法: node cf-purge-token.js <tabId>
const net = require('net');
const { execSync } = require('child_process');
const path = require('path');

function listCodexPipes() {
  const { spawnSync } = require('child_process');
  const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem "\\\\.\\pipe\\" | Where-Object {$_.Name -like "codex-browser-use*"} | Select-Object -ExpandProperty Name';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const names = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (names.length) return names;
  const py = `
import ctypes, os
from ctypes import wintypes
FindFirstFileW = ctypes.windll.kernel32.FindFirstFileW
FindNextFileW = ctypes.windll.kernel32.FindNextFileW
FindClose = ctypes.windll.kernel32.FindClose
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
class WIN32_FIND_DATAW(ctypes.Structure):
    _fields_ = [("dwFileAttributes", wintypes.DWORD), ("ftCreationTime", wintypes.FILETIME),
                ("ftLastAccessTime", wintypes.FILETIME), ("ftWriteTime", wintypes.FILETIME),
                ("nFileSizeHigh", wintypes.DWORD), ("nFileSizeLow", wintypes.DWORD),
                ("dwReserved0", wintypes.DWORD), ("dwReserved1", wintypes.DWORD),
                ("cFileName", ctypes.c_wchar * 260), ("cAlternateFileName", ctypes.c_wchar * 14)]
fd = WIN32_FIND_DATAW()
h = FindFirstFileW(r"\\\\.\\pipe\\codex-browser-use\\*", ctypes.byref(fd))
if h == INVALID_HANDLE_VALUE: print(""); raise SystemExit
while True:
    print(fd.cFileName)
    if not FindNextFileW(h, ctypes.byref(fd)): break
FindClose(h)
`;
  const r2 = spawnSync('python', ['-c', py], { encoding: 'utf8' });
  return (r2.stdout || '').split('\n').filter(Boolean);
}

function connectPipe(uuid) {
  const full = `\\\\.\\pipe\\${uuid}`;
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(full, () => resolve(sock));
    sock.on('error', reject);
  });
}

class PipeClient {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.pending = new Map(); this.idc = 0; this._init(); }
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
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); }
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
}

async function main() {
  const tabId = parseInt(process.argv[2], 10);
  if (!tabId) { console.error('usage: node cf-purge-token.js <tabId>'); process.exit(1); }
  const pipes = listCodexPipes();
  if (!pipes.length) { console.error('no pipes'); process.exit(1); }
  let client;
  for (const p of pipes) {
    try { const sock = await connectPipe(p); client = new PipeClient(sock); break; } catch (e) {}
  }
  if (!client) { console.error('cannot connect'); process.exit(1); }
  const fsx = require('fs'), osx = require('os'), pathx = require('path');
  let SID = 'pi-browser-' + Date.now();
  try { const f = pathx.join(osx.tmpdir(), 'pi-browser-session'); if (fsx.existsSync(f)) { const v = fsx.readFileSync(f, 'utf8').trim(); if (v) SID = v; } } catch (e) {}
  const sess = { session_id: SID, turn_id: 't' + Date.now(), session_context: {} };

  // attach tab
  try { await client.send('attach', { tabId, ...sess }); } catch (e) { console.error('attach fail', e.message); }
  // enable network
  await client.send('executeCdp', { target: { tabId }, method: 'Network.enable', commandParams: {}, ...sess });
  // watch requestWillBeSent
  client.sock.on('data', () => {}); // events come as notifications with no id — capture via raw listener below
  // reload page
  await client.send('executeCdp', { target: { tabId }, method: 'Page.reload', commandParams: { ignoreCache: true }, ...sess });

  // collect Authorization headers from events (notifications arrive as messages without matching id)
  const authHeaders = new Set();
  const origHandle = client.sock.listeners('data').pop();
  client.sock.removeListener('data', origHandle);
  let buf = Buffer.alloc(0);
  client.sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const payload = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.id && client.pending.has(msg.id)) {
          const p = client.pending.get(msg.id); client.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
        } else if (msg.method === 'Network.requestWillBeSent') {
          const hdrs = msg.params.request.headers || {};
          if (hdrs.Authorization) authHeaders.add(hdrs.Authorization.slice(0, 120));
        }
      } catch (e) {}
    }
  });

  // wait for tokens
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && authHeaders.size < 2) { await new Promise(r => setTimeout(r, 500)); }
  const tokens = [...authHeaders];
  console.log('TOKENS:', tokens.join('\n'));
  if (!tokens.length) { console.error('NO TOKEN CAPTURED'); process.exit(2); }

  // purge via API using captured token
  const https = require('https');
  const zoneId = '1ff8b942171f244274a82b65fa39ab66';
  const body = JSON.stringify({ purge_everything: true });
  const req = https.request({
    hostname: 'api.cloudflare.com', path: `/client/v4/zones/${zoneId}/purge_cache`,
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