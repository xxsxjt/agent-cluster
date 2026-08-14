/**
 * Agnes AI → Local API Proxy
 * ==========================
 * Exposes an OpenAI-compatible /v1/* endpoint with a unified local API key.
 * Internally round-robins through all upstream Agnes keys.
 *
 * Import this as a custom provider in any AI agent tool:
 *   Base URL: http://localhost:3457/v1
 *   API Key:  (whatever you set in proxy-config.json → local_key)
 *
 * Usage:
 *   node server-proxy.js
 *   node server-proxy.js 3457           # custom port
 *   node server-proxy.js 3457 sk-mylocal # custom port + key
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
// Config
// ============================================================
const CONFIG_FILE = path.join(__dirname, 'proxy-config.json');
const KEYS_FILE = path.join(__dirname, 'keys.json');

let LOCAL_KEY = 'sk-agnes-local-proxy-v1';
let PORT = 3457;
let upstreamKeys = [];
let keyIndex = 0;

function loadConfig() {
  // Load proxy config
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    LOCAL_KEY = cfg.local_key || LOCAL_KEY;
    PORT = cfg.port || PORT;
  } catch { /* use defaults */ }

  // CLI args override
  if (process.argv[2]) PORT = parseInt(process.argv[2]) || PORT;
  if (process.argv[3]) LOCAL_KEY = process.argv[3];

  // Load upstream keys
  try {
    upstreamKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')).filter(Boolean);
  } catch {
    console.error('ERROR: keys.json not found or invalid');
    process.exit(1);
  }
  if (!upstreamKeys.length) {
    console.error('ERROR: No upstream keys in keys.json');
    process.exit(1);
  }
}
loadConfig();

function nextUpstreamKey() {
  const key = upstreamKeys[keyIndex % upstreamKeys.length];
  keyIndex++;
  return key;
}

// ============================================================
// DeepSeek Web API (free & unlimited)
// ============================================================
const DEEPSEEK_WEB_HOST = 'chat.deepseek.com';
const DEEPSEEK_COMPLETION_PATH = '/api/v0/chat/completion';
const DEEPSEEK_POW_CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge';
const DEEPSEEK_SESSION_CREATE_PATH = '/api/v0/chat_session/create';
const DEEPSEEK_WASM_PATH = path.join(__dirname, 'sha3_wasm_bg.wasm');

let deepseekUserToken = null;
let deepseekChatSessionId = null;
let deepseekParentMessageId = null;
let deepseekPowWasm = null;

function loadDeepSeekToken() {
  for (const key of upstreamKeys) {
    if (key && !key.startsWith('sk-') && !key.startsWith('cpk-')) {
      deepseekUserToken = key;
      console.log('  🔑 DeepSeek web token loaded');
      return;
    }
  }
  console.warn('  ⚠️  No DeepSeek web token in keys.json');
}
loadDeepSeekToken();

// --- PoW WASM Solver ---
async function loadDeepSeekPowWasm() {
  if (deepseekPowWasm) return deepseekPowWasm;
  const wasmBytes = fs.readFileSync(DEEPSEEK_WASM_PATH);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  deepseekPowWasm = instance.exports;
  return deepseekPowWasm;
}

function solvePowWithWasm(wasm, challengeHex, prefix, difficulty) {
  const encoder = new TextEncoder();
  function writeWasmString(value) {
    const bytes = encoder.encode(value);
    const ptr = wasm.__wbindgen_export_0(bytes.length, 1);
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  }
  const retPtr = wasm.__wbindgen_add_to_stack_pointer(-16);
  const cA = writeWasmString(challengeHex.toLowerCase());
  const pA = writeWasmString(prefix);
  try {
    wasm.wasm_solve(retPtr, cA.ptr, cA.len, pA.ptr, pA.len, difficulty);
    const view = new DataView(wasm.memory.buffer);
    const status = view.getInt32(retPtr, true);
    const answer = view.getFloat64(retPtr + 8, true);
    if (status !== 1 || !Number.isSafeInteger(answer) || answer < 0) {
      throw new Error('PoW solve failed');
    }
    return answer;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

// --- DeepSeek Helpers ---
function getDeepSeekClientHeaders() {
  return {
    'content-type': 'application/json',
    'Authorization': `Bearer ${deepseekUserToken}`,
    'X-App-Version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-client-locale': 'zh-CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

function httpsJsonRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw), raw });
        } catch {
          resolve({ status: res.statusCode, json: null, raw });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function createDeepSeekChatSession() {
  const result = await httpsJsonRequest({
    hostname: DEEPSEEK_WEB_HOST, port: 443,
    path: DEEPSEEK_SESSION_CREATE_PATH, method: 'POST',
    headers: getDeepSeekClientHeaders(), timeout: 30000,
  }, {});
  const data = result.json?.data;
  const sessionId = data?.biz_data?.chat_session?.id;
  if (data?.biz_code === 40002 || data?.biz_code === 40003) {
    throw new Error('DeepSeek auth token rejected. Refresh your token.');
  }
  if (!sessionId || data?.biz_code !== 0) {
    throw new Error(`Failed to create DeepSeek session: ${JSON.stringify(data || result.json)}`);
  }
  return sessionId;
}

async function createDeepSeekPowHeaders(targetPath) {
  const headers = getDeepSeekClientHeaders();
  const cRes = await httpsJsonRequest({
    hostname: DEEPSEEK_WEB_HOST, port: 443,
    path: DEEPSEEK_POW_CHALLENGE_PATH, method: 'POST',
    headers, timeout: 15000,
  }, { target_path: targetPath });
  const data = cRes.json?.data;
  const challenge = data?.biz_data?.challenge;
  if (!challenge || data?.biz_code !== 0) {
    throw new Error(`PoW challenge failed: ${JSON.stringify(data || cRes.json)}`);
  }
  const wasm = await loadDeepSeekPowWasm();
  const prefix = `${challenge.salt}_${challenge.expire_at ?? challenge.expireAt}_`;
  const answer = solvePowWithWasm(wasm, challenge.challenge, prefix, Number(challenge.difficulty));
  const powResp = JSON.stringify({
    algorithm: String(challenge.algorithm), challenge: String(challenge.challenge),
    salt: String(challenge.salt), answer, signature: String(challenge.signature),
    target_path: targetPath,
  });
  return { 'X-DS-PoW-Response': Buffer.from(powResp, 'utf8').toString('base64') };
}

// --- Model Mapping ---
function mapModelToDeepSeek(bodyObj) {
  const model = (bodyObj.model || '').toLowerCase();
  if (/expert|reasoner|r1|pro|v3/.test(model)) return { model_type: 'expert', thinking_enabled: true };
  if (/vision/.test(model)) return { model_type: 'vision', thinking_enabled: false };
  return { model_type: 'default', thinking_enabled: bodyObj.thinking_enabled !== false };
}

// --- SSE Parsing Helpers ---
function extractDeltaText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) return parsed.v.map(extractDeltaText).join('');
  if (parsed.o === 'APPEND' && typeof parsed.v === 'string') return parsed.v;
  if (Array.isArray(parsed.choices)) {
    return parsed.choices.map(c => typeof c?.delta?.content === 'string' ? c.delta.content : '').join('');
  }
  return '';
}

function extractMessageIds(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  let ri = null, qi = null;
  if (typeof parsed.response_message_id === 'number') ri = parsed.response_message_id;
  if (typeof parsed.request_message_id === 'number') qi = parsed.request_message_id;
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    for (const item of parsed.v) { const ids = extractMessageIds(item); if (ids.ri) ri = ids.ri; if (ids.qi) qi = ids.qi; }
  }
  return { ri, qi };
}

function isStreamFinished(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.o === 'DONE') return true;
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) return parsed.v.some(isStreamFinished);
  return Array.isArray(parsed.choices) && parsed.choices.some(c => typeof c?.finish_reason === 'string');
}

// --- DeepSeek Completion Proxy ---
async function proxyDeepSeekCompletion(req, res, bodyObj) {
  if (!deepseekUserToken) {
    return jsonResponse(res, 500, { error: { message: 'No DeepSeek web token. Add token to keys.json' } });
  }
  try {
    if (!deepseekChatSessionId) {
      deepseekChatSessionId = await createDeepSeekChatSession();
    }
    const powHeaders = await createDeepSeekPowHeaders(DEEPSEEK_COMPLETION_PATH);

    const messages = bodyObj.messages || [];
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const prompt = lastUserMsg ? lastUserMsg.content : '';
    const { model_type, thinking_enabled } = mapModelToDeepSeek(bodyObj);

    const dsReq = https.request({
      hostname: DEEPSEEK_WEB_HOST, port: 443,
      path: DEEPSEEK_COMPLETION_PATH, method: 'POST',
      headers: { ...getDeepSeekClientHeaders(), ...powHeaders, 'X-DPP-Bypass-Hook': '1' },
      timeout: 600000,
    }, (dsRes) => {
      if (dsRes.statusCode !== 200) {
        const chunks = []; dsRes.on('data', c => chunks.push(c));
        dsRes.on('end', () => {
          if (dsRes.statusCode === 401 || dsRes.statusCode === 403) {
            deepseekChatSessionId = null; deepseekParentMessageId = null;
          }
          jsonResponse(res, dsRes.statusCode, { error: { message: `DeepSeek error: ${Buffer.concat(chunks).toString().slice(0, 300)}` } });
        });
        return;
      }

      const isStream = bodyObj.stream !== false;
      res.writeHead(200, {
        'Content-Type': isStream ? 'text/event-stream' : 'application/json',
        'Access-Control-Allow-Origin': '*',
      });

      if (!isStream) {
        const chunks = []; dsRes.on('data', c => chunks.push(c));
        dsRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let fullText = '';
          raw.split('\n').forEach(line => {
            if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
              try { fullText += extractDeltaText(JSON.parse(line.slice(6))); } catch {}
            }
          });
          res.end(JSON.stringify({
            id: 'chatcmpl-' + Date.now(), object: 'chat.completion',
            created: Math.floor(Date.now() / 1000), model: bodyObj.model || 'deepseek-chat',
            choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
          }));
        });
        return;
      }

      // Streaming
      let buffer = '', fullText = '', messageId = null, doneSent = false;
      dsRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const line of parts) {
          if (doneSent) continue;
          if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const text = extractDeltaText(parsed);
              if (text) {
                fullText += text;
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`);
              }
              const ids = extractMessageIds(parsed);
              if (ids.ri) messageId = ids.ri;
              if (ids.qi) deepseekParentMessageId = ids.qi;
              if (isStreamFinished(parsed) && !doneSent) {
                doneSent = true;
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`);
                res.write('data: [DONE]\n\n');
              }
            } catch {}
          }
        }
      });
      dsRes.on('end', () => { if (!doneSent) { res.write('data: [DONE]\n\n'); } res.end(); });
      dsRes.on('error', () => { if (!res.writableEnded) res.end(); });
    });

    dsReq.on('error', () => { if (!res.headersSent) jsonResponse(res, 502, { error: { message: 'DeepSeek proxy error' } }); });
    dsReq.on('timeout', () => { dsReq.destroy(); if (!res.headersSent) jsonResponse(res, 504, { error: { message: 'DeepSeek timeout' } }); });
    dsReq.write(JSON.stringify({
      chat_session_id: deepseekChatSessionId, parent_message_id: deepseekParentMessageId,
      model_type, prompt: typeof prompt === 'string' ? prompt : String(prompt),
      ref_file_ids: [], thinking_enabled, search_enabled: bodyObj.search_enabled === true,
      action: null, preempt: false,
    }));
    dsReq.end();
  } catch (e) {
    jsonResponse(res, 502, { error: { message: `DeepSeek proxy error: ${e.message}` } });
  }
}

function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(upstreamKeys, null, 2), 'utf8');
}

// ============================================================
// Auth middleware
// ============================================================
function checkAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token !== LOCAL_KEY) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      error: { message: 'Invalid API key. Use the local key configured in proxy-config.json', type: 'authentication_error' }
    }));
    return false;
  }
  return true;
}

// ============================================================
// Helpers
// ============================================================
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

// ============================================================
// Proxy request to upstream (Agnes)
// ============================================================
function proxyUpstream(req, res, upstreamPath, upstreamMethod, bodyBuf) {
  const key = nextUpstreamKey();
  const bodyStr = bodyBuf ? bodyBuf.toString() : '';
  const isStream = bodyStr.includes('"stream":true') || bodyStr.includes('"stream": true');

  const options = {
    hostname: 'apihub.agnes-ai.com',
    port: 443,
    path: upstreamPath,
    method: upstreamMethod || 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    timeout: 600000,
  };

  if (isStream) {
    options.headers['Accept'] = 'text/event-stream';
  }

  const proxyReq = https.request(options, (proxyRes) => {
    const headers = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    // Don't leak upstream key info
    delete headers['authorization'];

    res.writeHead(proxyRes.statusCode, headers);

    if (isStream && proxyRes.statusCode === 200) {
      proxyRes.pipe(res);
    } else {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => res.end(Buffer.concat(chunks)));
    }

    proxyRes.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 502, { error: { message: 'Upstream error' } });
    });
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) jsonResponse(res, 502, { error: { message: 'Cannot reach upstream API' } });
  });

  if (bodyBuf && bodyBuf.length) proxyReq.write(bodyBuf);
  proxyReq.end();
}

// ============================================================
// Logging
// ============================================================
function log(req, status, model) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const method = req.method.padEnd(4);
  const path = req.url.split('?')[0].padEnd(30);
  const s = String(status);
  const color = status < 300 ? '\x1b[32m' : status < 400 ? '\x1b[33m' : '\x1b[31m';
  console.log(`  ${time}  ${color}${s}\x1b[0m  ${method} ${path}  ${model || ''}`);
}

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Health check (no auth required)
  if (pathname === '/health') {
    jsonResponse(res, 200, {
      status: 'ok',
      upstream_keys: upstreamKeys.length,
      requests_served: keyIndex,
      models: ['agnes-2.0-flash', 'agnes-1.5-flash', 'agnes-image-2.1-flash', 'agnes-image-2.0-flash', 'agnes-video-v2.0', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-vision']
    });
    log(req, 200, 'health');
    return;
  }

  // === /v1/* endpoints (require local key auth) ===

  if (pathname === '/v1/models') {
    if (!checkAuth(req, res)) { log(req, 401, 'models'); return; }
    jsonResponse(res, 200, {
      object: 'list',
      data: [
        { id: 'agnes-2.0-flash', object: 'model', owned_by: 'agnes', type: 'chat' },
        { id: 'agnes-1.5-flash', object: 'model', owned_by: 'agnes', type: 'chat' },
        { id: 'agnes-image-2.1-flash', object: 'model', owned_by: 'agnes', type: 'image' },
        { id: 'agnes-image-2.0-flash', object: 'model', owned_by: 'agnes', type: 'image' },
        { id: 'agnes-video-v2.0', object: 'model', owned_by: 'agnes', type: 'video' },
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek-web', type: 'chat' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek-web', type: 'chat' },
        { id: 'deepseek-vision', object: 'model', owned_by: 'deepseek-web', type: 'chat' },
      ]
    });
    log(req, 200, 'models');
    return;
  }

  if (pathname === '/v1/chat/completions') {
    if (!checkAuth(req, res)) { log(req, 401, 'chat'); return; }
    const bodyBuf = await readBody(req);
    let model = '?';
    try { model = JSON.parse(bodyBuf.toString()).model || '?'; } catch {}
    proxyUpstream(req, res, '/v1/chat/completions', 'POST', bodyBuf);
    log(req, 200, model);
    return;
  }

  if (pathname === '/v1/images/generations') {
    if (!checkAuth(req, res)) { log(req, 401, 'image'); return; }
    const bodyBuf = await readBody(req);
    let model = '?';
    try { model = JSON.parse(bodyBuf.toString()).model || '?'; } catch {}
    proxyUpstream(req, res, '/v1/images/generations', 'POST', bodyBuf);
    log(req, 200, model);
    return;
  }

  // === Video endpoints ===
  if (pathname === '/v1/videos') {
    if (!checkAuth(req, res)) { log(req, 401, 'video'); return; }
    const bodyBuf = await readBody(req);
    proxyUpstream(req, res, '/v1/videos', 'POST', bodyBuf);
    log(req, 200, 'video');
    return;
  }

  if (pathname === '/v1/video-status') {
    if (!checkAuth(req, res)) { log(req, 401, 'video-status'); return; }
    const videoId = url.searchParams.get('video_id') || '';
    proxyUpstream(req, res, `/agnesapi?video_id=${encodeURIComponent(videoId)}`, 'GET', Buffer.alloc(0));
    log(req, 200, 'video-status');
    return;
  }

  // === Key management (for DeepSeek Bridge extension) ===
  if (pathname === '/api/keys') {
    // GET/DELETE require auth; POST from bridge extension is allowed without local key
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { key } = JSON.parse(body.toString());
        if (key && !upstreamKeys.includes(key)) {
          upstreamKeys.push(key);
          saveKeys();
          if (!key.startsWith('sk-') && !key.startsWith('cpk-')) {
            deepseekUserToken = key;
            deepseekChatSessionId = null;
            deepseekParentMessageId = null;
            console.log('  🔑 DeepSeek web token synced from bridge');
          }
          jsonResponse(res, 200, { ok: true, count: upstreamKeys.length });
        } else {
          jsonResponse(res, 200, { ok: true, count: upstreamKeys.length }); // idempotent
        }
      } catch {
        jsonResponse(res, 400, { error: { message: 'Invalid JSON' } });
      }
      log(req, 200, 'keys-sync');
      return;
    }
    if (!checkAuth(req, res)) { log(req, 401, 'keys'); return; }
    if (req.method === 'GET') {
      jsonResponse(res, 200, { count: upstreamKeys.length });
      log(req, 200, 'keys');
      return;
    }
    jsonResponse(res, 405, { error: { message: 'Method not allowed' } });
    return;
  }

  // === DeepSeek Web API routes ===
  if (pathname === '/v1/deepseek/chat/completions') {
    if (!checkAuth(req, res)) { log(req, 401, 'ds-chat'); return; }
    const bodyBuf = await readBody(req);
    let bodyObj, model = '?';
    try { bodyObj = JSON.parse(bodyBuf.toString()); model = bodyObj.model || 'deepseek-chat'; } catch {
      return jsonResponse(res, 400, { error: { message: 'Invalid JSON body' } });
    }
    proxyDeepSeekCompletion(req, res, bodyObj);
    log(req, 200, model);
    return;
  }

  if (pathname === '/v1/deepseek/models') {
    if (!checkAuth(req, res)) { log(req, 401, 'ds-models'); return; }
    jsonResponse(res, 200, {
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek-web', type: 'default' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek-web', type: 'expert' },
        { id: 'deepseek-vision', object: 'model', owned_by: 'deepseek-web', type: 'vision' },
      ]
    });
    log(req, 200, 'ds-models');
    return;
  }

  if (pathname === '/v1/deepseek/reset') {
    if (!checkAuth(req, res)) { log(req, 401, 'ds-reset'); return; }
    deepseekChatSessionId = null;
    deepseekParentMessageId = null;
    jsonResponse(res, 200, { ok: true, message: 'DeepSeek session reset' });
    log(req, 200, 'ds-reset');
    return;
  }

  // 404
  jsonResponse(res, 404, { error: { message: `Not found: ${pathname}`, type: 'not_found' } });
  log(req, 404, '');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║        🔄  Agnes AI → Local API Proxy                 ║
╠══════════════════════════════════════════════════════════╣
║                                                        ║
║  Status:   Running                                     ║
║  Port:     ${String(PORT).padEnd(45)}║
║  Upstream: ${String(upstreamKeys.length).padEnd(45)}║
║  Served:   ${String(keyIndex).padEnd(45)}║
║  DeepSeek: ${deepseekUserToken ? '✅ Web API ready'.padEnd(43) : '⚠️  No token'.padEnd(43)}║
║                                                        ║
║  ──────── Import Config for AI Agents ────────         ║
║  Base URL: http://localhost:${PORT}/v1                    ║
║  API Key:  ${LOCAL_KEY.padEnd(45)}║
║                                                        ║
║  Endpoints:                                            ║
║  • /v1/chat/completions  (Agnes)                      ║
║  • /v1/models                                          ║
║  • /v1/images/generations                              ║
║  • /v1/videos                                          ║
║  • /v1/video-status                                    ║
║  • /v1/deepseek/chat/completions  (Free Web API)      ║
║  • /v1/deepseek/models                                 ║
║  • /health                                             ║
║                                                        ║
╚══════════════════════════════════════════════════════════╝
`);
  console.log(`  Press Ctrl+C to stop\n`);
});
