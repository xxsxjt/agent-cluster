#!/usr/bin/env node
/**
 * uumit-cli.js — UUMit API 工具封装（集群智能体用 bash/node 调，替代标准 MCP 客户端）
 *
 * 端点：
 *   - MCP 发现代理（SSE，2.x，6 个稳定工具）：GET /mcp/discovery/sse
 *   - A2A JSON-RPC：POST /a2a
 *   - Agent Card：GET /.well-known/agent.json
 *
 * 用法：
 *   node tools/uumit-cli.js discover                      # 发现可用工具（6 个）+ Agent Card + server 信息
 *   node tools/uumit-cli.js call <tool> '<json-args>'     # 调用 MCP 工具（如 capability_search）
 *   node tools/uumit-cli.js a2a <method> '<json-params>'  # A2A JSON-RPC（写操作自动带 Idempotency-Key）
 *
 * 输出：统一 JSON 到 stdout（供智能体解析）。错误：{ok:false, error}
 * 鉴权：key 从 memory/uumit-mcp-auth.json（MCP key）优先读取，失败回退 memory/uumit-auth.json；
 *       环境变量 UUMIT_API_KEY / UUMIT_USER_ID 可覆盖。脚本本身不含明文 key。
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKDIR = path.resolve(__dirname, '..');
const MEM = path.join(WORKDIR, 'memory');
const HOST = 'api.uumit.com';
const DISCOVERY_SSE = '/mcp/discovery/sse';
const A2A_PATH = '/a2a';
const AGENT_CARD_PATH = '/.well-known/agent.json';
const PROTOCOL_VERSION = '2025-06-18';

function mask(k){ return k ? k.slice(0,4) + '…' + k.slice(-4) : '(none)'; }

function loadAuth() {
  if (process.env.UUMIT_API_KEY && process.env.UUMIT_USER_ID) {
    return { api_key: process.env.UUMIT_API_KEY, platform_user_id: process.env.UUMIT_USER_ID, source: 'env' };
  }
  const mcpFile = path.join(MEM, 'uumit-mcp-auth.json');
  const authFile = path.join(MEM, 'uumit-auth.json');
  for (const [file, source] of [[mcpFile,'mcp'],[authFile,'auth']]) {
    if (fs.existsSync(file)) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j.api_key && j.platform_user_id) return { api_key: j.api_key, platform_user_id: j.platform_user_id, source };
      } catch(e) { /* 跳过损坏文件 */ }
    }
  }
  throw new Error('未找到有效鉴权文件（memory/uumit-mcp-auth.json 或 memory/uumit-auth.json），或设置环境变量 UUMIT_API_KEY/UUMIT_USER_ID');
}

function httpReq(method, urlPath, { headers={}, body=null, agent=null } = {}) {
  return new Promise((resolve, reject) => {
    const opt = { host: HOST, path: urlPath, method, headers };
    if (agent) opt.agent = agent;
    const r = https.request(opt, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

/* ---------- MCP 发现代理客户端（SSE + 会话负载均衡重试） ---------- */
class MCPDiscovery {
  constructor(auth) {
    this.auth = auth;
    this.endpoint = null;
    this.events = [];
    this.pending = {};   // id -> {resolve, reject, timer}
    this.sseReq = null;
    this.hdr = {
      'X-Api-Key': auth.api_key,
      'X-Platform-User-Id': auth.platform_user_id,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const opt = { host: HOST, path: DISCOVERY_SSE, method: 'GET', headers: {
        'X-Api-Key': this.auth.api_key, 'X-Platform-User-Id': this.auth.platform_user_id,
        'Accept': 'text/event-stream', 'Content-Type': 'application/json' } };
      const r = https.request(opt, res => {
        let buf = '';
        res.on('data', c => {
          buf += c.toString('utf8').replace(/\r/g, '');
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const lines = evt.split('\n'); const ev = { event: '', data: '' };
            for (const l of lines) {
              if (l.startsWith('event:')) ev.event = l.slice(6).trim();
              else if (l.startsWith('data:')) ev.data = l.slice(5).trim();
            }
            this._handleEvent(ev);
          }
        });
      });
      r.on('error', reject);
      this.sseReq = r;
      r.end();
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.endpoint) { clearInterval(iv); resolve(); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); r.destroy(); reject(new Error('MCP SSE 连接超时，未拿到 endpoint')); }
      }, 200);
    });
  }

  _handleEvent(ev) {
    this.events.push(ev);
    if (ev.event === 'endpoint' && !this.endpoint) { this.endpoint = ev.data; return; }
    if (ev.event === 'message' && ev.data) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch(e) { return; }
      if (msg && typeof msg.id !== 'undefined' && this.pending[msg.id]) {
        const p = this.pending[msg.id];
        delete this.pending[msg.id];
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error('MCP RPC 错误: ' + JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  async _postUntilAccepted(body, label, maxAttempts = 24) {
    for (let a = 1; a <= maxAttempts; a++) {
      const r = await httpReq('POST', this.endpoint, { headers: this.hdr, body: JSON.stringify(body) });
      if (r.status === 200 || r.status === 202) return r;
      if (a === maxAttempts) throw new Error(`${label}: 会话不可达（负载均衡重试 ${maxAttempts} 次仍失败，最后 ${r.status} ${r.body.trim() || ''}` );
      await new Promise(x => setTimeout(x, 250));
    }
  }

  rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { delete this.pending[id]; reject(new Error(`等待 ${method} 响应超时`)); }, 20000);
      this.pending[id] = { resolve, reject, timer };
      this._postUntilAccepted({ jsonrpc: '2.0', id, method, params }, method)
        .catch(err => { clearTimeout(timer); delete this.pending[id]; reject(err); });
    });
  }

  async init(retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.connect();
        const res = await this.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'uumit-cli', version: '1.0.0' } }, 1);
        // fire-and-forget initialized 通知（无 id）
        this._postUntilAccepted({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 'initialized').catch(()=>{});
        return res;
      } catch (e) {
        this.close();
        if (attempt < retries) { await new Promise(x => setTimeout(x, 400)); continue; }  // 换新会话（新后端）重试
        throw e;
      }
    }
  }

  close() { if (this.sseReq) { try { this.sseReq.destroy(); } catch(e){} } }
}

/* ---------- Agent Card ---------- */
async function fetchAgentCard(auth) {
  const r = await httpReq('GET', AGENT_CARD_PATH, { headers: { 'X-Api-Key': auth.api_key, 'X-Platform-User-Id': auth.platform_user_id, 'Accept': 'application/json' } });
  if (r.status === 200) { try { return JSON.parse(r.body); } catch(e) { return { raw: r.body.slice(0, 1000) }; } }
  return { error: `${r.status} ${r.body.trim() || ''}` };
}

/* ---------- A2A ---------- */
async function a2aCall(auth, method, params, idempotencyKey) {
  const body = { jsonrpc: '2.0', id: Date.now().toString(36) + Math.random().toString(36).slice(2,8), method, params: params || {} };
  const hdr = {
    'X-Api-Key': auth.api_key, 'X-Platform-User-Id': auth.platform_user_id,
    'Content-Type': 'application/json', 'Accept': 'application/json'
  };
  if (idempotencyKey) hdr['Idempotency-Key'] = idempotencyKey;   // 写操作幂等键
  const r = await httpReq('POST', A2A_PATH, { headers: hdr, body: JSON.stringify(body) });
  let parsed = r.body;
  try { parsed = JSON.parse(r.body); } catch(e) {}
  if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, result: parsed };
  return { ok: false, status: r.status, error: parsed };
}

/* ---------- 主入口 ---------- */
async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.log(JSON.stringify({ ok: false, error: '用法: node tools/uumit-cli.js discover | call <tool> <json> | a2a <method> <json>', help: true }, null, 2));
    process.exit(0);
  }
  const auth = loadAuth();

  if (cmd === 'discover') {
    const client = new MCPDiscovery(auth);
    try {
      const serverInfo = await client.init();
      const toolsRes = await client.rpc('tools/list', {}, 2);
      const tools = (toolsRes && toolsRes.tools || []).map(t => ({ name: t.name, description: (t.description || '').split('\n')[0], inputSchema: t.inputSchema }));
      const card = await fetchAgentCard(auth);
      client.close();
      console.log(JSON.stringify({
        ok: true, source: auth.source, keyMasked: mask(auth.api_key), platformUserId: auth.platform_user_id,
        protocol: 'MCP 2.x discovery proxy (SSE)',
        server: serverInfo,
        tools: tools.map(t => t.name),
        toolCount: tools.length,
        toolsDetail: tools,
        agentCard: card
      }, null, 2));
    } catch (e) {
      client.close();
      console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (cmd === 'call') {
    const tool = process.argv[3];
    const argsRaw = process.argv[4] || '{}';
    if (!tool) { console.log(JSON.stringify({ ok:false, error:'call 需提供工具名: call <tool> <json-args>' })); process.exit(1); }
    let args;
    try { args = JSON.parse(argsRaw); }
    catch(e) { console.log(JSON.stringify({ ok:false, error:'参数必须是 JSON 字符串: ' + argsRaw })); process.exit(1); }
    const client = new MCPDiscovery(auth);
    try {
      await client.init();
      const result = await client.rpc('tools/call', { name: tool, arguments: args }, 3);
      client.close();
      console.log(JSON.stringify({ ok: true, tool, args, result }, null, 2));
    } catch (e) {
      client.close();
      console.log(JSON.stringify({ ok: false, tool, error: e.message }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (cmd === 'a2a') {
    const method = process.argv[3];
    const paramsRaw = process.argv[4] || '{}';
    const idemKey = process.argv[5] || undefined;   // 可选第三个参数作为幂等键
    if (!method) { console.log(JSON.stringify({ ok:false, error:'a2a 需提供方法名: a2a <method> <json-params> [idempotencyKey]' })); process.exit(1); }
    let params;
    try { params = JSON.parse(paramsRaw); }
    catch(e) { console.log(JSON.stringify({ ok:false, error:'params 必须是 JSON 字符串: ' + paramsRaw })); process.exit(1); }
    try {
      const out = await a2aCall(auth, method, params, idemKey);
      out.source = auth.source; out.keyMasked = mask(auth.api_key);
      if (out.ok) out.idempotencyKey = idemKey || '(写操作建议传幂等键)';
      console.log(JSON.stringify(out, null, 2));
      if (!out.ok) process.exit(1);
    } catch (e) {
      console.log(JSON.stringify({ ok:false, error: e.message }, null, 2));
      process.exit(1);
    }
    return;
  }

  console.log(JSON.stringify({ ok:false, error:'未知命令: ' + cmd }));
  process.exit(1);
}

main().catch(e => { console.log(JSON.stringify({ ok:false, error: e.message }, null, 2)); process.exit(1); });
