#!/usr/bin/env node
/**
 * browser-ext：pi 版「真实浏览器接管」工具
 * 不关闭用户正在运行的 Edge，通过已安装的 ChatGPT 扩展 (hehggadaopoacecdllhhajmbjkdcmajg)
 * + extension-host.exe 的命名管道直接控制用户真实浏览器（保留完整登录态）。
 *
 * 原理：
 *   - ChatGPT 扩展的 extension-host.exe 监听命名管道 `\\.\pipe\codex-browser-use\<uuid>`
 *   - 直接连接该管道，走 native messaging 协议（4字节小端长度前缀 + JSON）
 *   - 发送扩展支持的原生方法（createTab / attach / executeCdp / ...）控制标签页
 *
 * 用法（与 browser-ctl.py 一致，但不关浏览器、保留登录态）：
 *   node browser-ext.mjs get <url>    # 打开页面并读取标题+正文（一步到位）
 *   node browser-ext.mjs open <url>
 *   node browser-ext.mjs text
 *   node browser-ext.mjs dom <selector>
 *   node browser-ext.mjs click <selector>
 *   node browser-ext.mjs type <selector> <text>
 *   node browser-ext.mjs shot <out.png>
 *   node browser-ext.mjs js <expression>
 *   node browser-ext.mjs tabs
 *   node browser-ext.mjs list          # 列出真实用户标签页
 */
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_ID = 'pi-browser-' + Date.now();
const TURN_ID = 'turn-' + Math.random().toString(36).slice(2, 10);

// ---------- 命名管道发现 ----------
function listCodexPipes() {
  const script = [`
import ctypes
from ctypes import wintypes as wt
class F(ctypes.Structure):
    _fields_=[("a",wt.DWORD),("b",wt.FILETIME),("c",wt.FILETIME),("d",wt.FILETIME),("e",wt.DWORD),("f",wt.DWORD),("g",wt.DWORD),("h",wt.DWORD),("n",wt.WCHAR*260),("x",wt.WCHAR*14)]
k=ctypes.windll.kernel32
k.FindFirstFileW.restype=ctypes.c_void_p
k.FindFirstFileW.argtypes=[ctypes.c_wchar_p,ctypes.POINTER(F)]
k.FindNextFileW.restype=wt.BOOL
k.FindNextFileW.argtypes=[ctypes.c_void_p,ctypes.POINTER(F)]
k.FindClose.argtypes=[ctypes.c_void_p]
INVALID=ctypes.c_void_p(-1).value
fd=F(); h=k.FindFirstFileW(r"\\\\.\\pipe\\*",ctypes.byref(fd))
names=[]
if h!=INVALID:
    names.append(fd.n)
    while True:
        if not k.FindNextFileW(h,ctypes.byref(fd)): break
        names.append(fd.n)
    k.FindClose(h)
for n in names:
    if n.startswith("codex-browser-use"): print(n)
`].join('\n');
  try {
    const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) {
    // fallback: powershell
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem "\\\\.\\pipe\\" | Where-Object {$_.Name -like "codex-browser-use*"} | Select-Object -ExpandProperty Name'], { encoding: 'utf8' });
      return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  }
}

function connectPipe(uuid) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: '\\\\.\\pipe\\codex-browser-use\\' + uuid });
    sock.on('connect', () => resolve(sock));
    sock.on('error', reject);
    setTimeout(() => reject(new Error('pipe connect timeout')), 5000);
  });
}

class Browser {
  constructor(sock) { this.sock = sock; this.seq = 0; }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const msg = JSON.stringify({ id, jsonrpc: '2.0', method, params });
      const len = Buffer.alloc(4); len.writeUInt32LE(Buffer.byteLength(msg), 0);
      const buf = Buffer.concat([len, Buffer.from(msg)]);
      let resp = Buffer.alloc(0);
      const onData = (d) => { resp = Buffer.concat([resp, d]); pump(); };
      const pump = () => {
        while (resp.length >= 4) {
          const l = resp.readUInt32LE(0);
          if (resp.length < 4 + l) break;
          let payload;
          try { payload = JSON.parse(resp.slice(4, 4 + l).toString('utf8')); }
          catch { resp = resp.slice(4 + l); continue; }
          resp = resp.slice(4 + l);
          if (payload.id === id) {
            this.sock.removeListener('data', onData);
            if (payload.error) reject(new Error(payload.error.message || JSON.stringify(payload.error)));
            else resolve(payload.result);
          }
        }
      };
      this.sock.on('data', onData);
      this.sock.write(buf);
      setTimeout(() => { this.sock.removeListener('data', onData); reject(new Error('timeout ' + method)); }, 30000);
    });
  }
  // 会话参数（扩展要求 session_id/turn_id）
  sess() { return { session_id: SESSION_ID, turn_id: TURN_ID, session_context: 'live' }; }

  async createTab() {
    const r = await this.send('createTab', this.sess());
    return r;
  }
  async attach(tabId, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try { await this.send('attach', { tabId, ...this.sess() }); return; }
      catch (e) { if (i === retries - 1) throw e; await sleep(400); }
    }
  }
  async cdp(tabId, method, commandParams = {}) {
    return await this.send('executeCdp', { target: { tabId }, method, commandParams, ...this.sess() });
  }
  async getTabs() { return await this.send('getTabs', this.sess()); }
  async getUserTabs() { return await this.send('getUserTabs', this.sess()); }
  async closeTab(tabId) { await this.cdp(tabId, 'Page.close'); }
  // 打开页面（新建一个标签页并导航，新建的 tab 自动加入 session）
  async open(url) {
    const t = await this.createTab();
    const tabId = t.id;
    await sleep(300);
    await this.attach(tabId);
    await this.cdp(tabId, 'Page.navigate', { url });
    await sleep(2500);
    return { tabId };
  }
  // 获取一个可操作的会话标签页：优先当前会话已有的，否则新建
  async ensureTab(preferId) {
    if (preferId) {
      try { await this.attach(preferId); return preferId; } catch {}
    }
    const tabs = await this.getTabs();
    if (tabs && tabs.length) {
      const tid = tabs[0].id;
      try { await this.attach(tid); return tid; } catch {}
    }
    const t = await this.createTab();
    await this.attach(t.id);
    await sleep(300);
    return t.id;
  }
  async evalExpr(tabId, expression) {
    const r = await this.cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }
  async screenshot(tabId, out) {
    const r = await this.cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
    if (r?.data) { fs.writeFileSync(out, Buffer.from(r.data, 'base64')); return out; }
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


async function run() {
  const pipes = listCodexPipes();
  if (!pipes.length) { console.error('未找到管道'); process.exit(1); }
  let sock, browser;
  for (const p of pipes) {
    const uuid = p.replace(/^codex-browser-use\\/, '');
    try { sock = await connectPipe(uuid); browser = new Browser(sock); break; }
    catch { continue; }
  }
  if (!browser) { console.error('无法连接'); process.exit(1); }
  const t = await browser.createTab();
  const tabId = t.id;
  await sleep(400);
  await browser.attach(tabId);
  await browser.cdp(tabId, 'Page.navigate', { url: process.argv[2] || 'http://127.0.0.1:8787/' });
  await sleep(3500);
  const stepsJson = process.argv[3];
  const steps = JSON.parse(stepsJson); // [{expr, wait}]
  for (const st of steps) {
    const r = await browser.evalExpr(tabId, st.expr);
    if (st.print !== false) console.log(String(r));
    if (st.wait) await sleep(st.wait);
  }
  await browser.closeTab(tabId).catch(() => {});
  sock.end();
}
run().catch(e => { console.error('失败:', e.message); process.exit(1); });
