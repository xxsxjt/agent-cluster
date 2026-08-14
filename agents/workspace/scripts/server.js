// Deprecated: Please use 'node cli.js serve' instead. This file remains for historical reference.
/**
 * Agnes AI Playground — Local API Proxy Server
 *
 * Architecture:
 *   Browser ──→ localhost:PORT/api/* ──→ apihub.agnes-ai.com/v1/*
 *                                          (round-robin key rotation)
 *   Browser ──→ localhost:PORT/api/deepseek/* ──→ chat.deepseek.com/api/v0/*
 *                                                    (web API, free & unlimited)
 *
 * Usage: node server.js [port]
 * Default port: 3456
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2]) || 3456;
const ROOT = path.join(__dirname, 'playground');
const KEYS_FILE = path.join(__dirname, 'keys.json');
const AGNES_HOST = 'apihub.agnes-ai.com';

// ============================================================
// Key Management
// ============================================================
let apiKeys = [];
let keyIndex = 0;

function loadKeys() {
  try {
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    apiKeys = JSON.parse(raw).filter(Boolean);
  } catch {
    apiKeys = [];
  }
  if (!apiKeys.length) {
    console.warn('⚠️  No API keys found — please add keys to keys.json');
  }
}
loadKeys();

function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2), 'utf8');
}

function nextKey() {
  if (!apiKeys.length) return null;
  const key = apiKeys[keyIndex % apiKeys.length];
  keyIndex++;
  return key;
}

// ============================================================
// DeepSeek Web API State
// ============================================================
const DEEPSEEK_WEB_HOST = 'chat.deepseek.com';
const DEEPSEEK_COMPLETION_PATH = '/api/v0/chat/completion';
const DEEPSEEK_POW_CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge';
const DEEPSEEK_SESSION_CREATE_PATH = '/api/v0/chat_session/create';
const DEEPSEEK_WASM_PATH = path.join(__dirname, 'sha3_wasm_bg.wasm');

let deepseekUserToken = null;
let deepseekChatSessionId = null;
let deepseekParentMessageId = null;
let deepseekPowWasm = null; // cached WASM exports

// Load DeepSeek user token from keys.json (first key that doesn't start with sk-)
function loadDeepSeekToken() {
  for (const key of apiKeys) {
    if (key && !key.startsWith('sk-')) {
      deepseekUserToken = key;
      console.log('🔑 DeepSeek web token loaded from keys.json');
      return;
    }
  }
  console.warn('⚠️  No DeepSeek web token found. Add your chat.deepseek.com userToken to keys.json');
}
loadDeepSeekToken();

// ============================================================
// DeepSeek PoW (Proof-of-Work) — WASM-based solver
// ============================================================
async function loadDeepSeekPowWasm() {
  if (deepseekPowWasm) return deepseekPowWasm;

  const wasmBytes = fs.readFileSync(DEEPSEEK_WASM_PATH);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  deepseekPowWasm = instance.exports;
  console.log('🧩 DeepSeek PoW WASM loaded');
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
  const challengeAlloc = writeWasmString(challengeHex.toLowerCase());
  const prefixAlloc = writeWasmString(prefix);

  try {
    wasm.wasm_solve(
      retPtr,
      challengeAlloc.ptr,
      challengeAlloc.len,
      prefixAlloc.ptr,
      prefixAlloc.len,
      difficulty,
    );

    const view = new DataView(wasm.memory.buffer);
    const status = view.getInt32(retPtr, true);
    const answer = view.getFloat64(retPtr + 8, true);
    if (status !== 1 || !Number.isSafeInteger(answer) || answer < 0) {
      throw new Error(`PoW solve failed: no solution found before difficulty ${difficulty}`);
    }
    return answer;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

// ============================================================
// DeepSeek Web API Helpers
// ============================================================
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

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, headers: res.headers, data, json: JSON.parse(data.toString()) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data });
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
  const headers = getDeepSeekClientHeaders();
  const result = await httpsRequest({
    hostname: DEEPSEEK_WEB_HOST,
    port: 443,
    path: DEEPSEEK_SESSION_CREATE_PATH,
    method: 'POST',
    headers,
    timeout: 30000,
  }, {});

  const data = result.json?.data;
  const sessionId = data?.biz_data?.chat_session?.id;

  if (result.json?.data?.biz_code === 40002 || result.json?.data?.biz_code === 40003) {
    throw new Error('DeepSeek auth token rejected. Please update your userToken in keys.json');
  }

  if (!result.json || result.json.data?.biz_code !== 0 || !sessionId) {
    throw new Error(`Failed to create DeepSeek chat session: ${JSON.stringify(data || result.json)}`);
  }

  return sessionId;
}

async function createDeepSeekPowHeaders(targetPath) {
  const headers = getDeepSeekClientHeaders();

  // 1. Get PoW challenge
  const challengeResult = await httpsRequest({
    hostname: DEEPSEEK_WEB_HOST,
    port: 443,
    path: DEEPSEEK_POW_CHALLENGE_PATH,
    method: 'POST',
    headers,
    timeout: 15000,
  }, { target_path: targetPath });

  const data = challengeResult.json?.data;
  const challenge = data?.biz_data?.challenge;

  if (!challengeResult.json || data?.biz_code !== 0 || !challenge) {
    throw new Error(`Failed to create PoW challenge: ${JSON.stringify(data || challengeResult.json)}`);
  }

  // 2. Solve PoW with WASM
  const wasm = await loadDeepSeekPowWasm();
  const prefix = `${challenge.salt}_${challenge.expire_at ?? challenge.expireAt}_`;
  const answer = solvePowWithWasm(
    wasm,
    challenge.challenge,
    prefix,
    Number(challenge.difficulty),
  );

  // 3. Build PoW response header
  const powResponse = JSON.stringify({
    algorithm: String(challenge.algorithm),
    challenge: String(challenge.challenge),
    salt: String(challenge.salt),
    answer: answer,
    signature: String(challenge.signature),
    target_path: targetPath,
  });

  return {
    'X-DS-PoW-Response': Buffer.from(powResponse, 'utf8').toString('base64'),
  };
}

// ============================================================
// DeepSeek Model Mapping
// ============================================================
// Web API model_type values: default (快速), expert (专家/深度思考), vision (识图)
function mapModelToDeepSeek(bodyObj) {
  const model = (bodyObj.model || '').toLowerCase();

  // Expert / Reasoner → 深度思考模式
  if (/expert|reasoner|r1|pro|deepseek-v4-pro|deepseek-v3/.test(model)) {
    return { model_type: 'expert', thinking_enabled: true };
  }
  // Vision → 识图模式（需要文件上传，暂不支持）
  if (/vision/.test(model)) {
    return { model_type: 'vision', thinking_enabled: false };
  }
  // Default → 快速模式
  return { model_type: 'default', thinking_enabled: bodyObj.thinking_enabled !== false };
}

// ============================================================
// DeepSeek Completion Proxy (streaming)
// ============================================================
async function proxyDeepSeekCompletion(req, res, bodyObj) {
  if (!deepseekUserToken) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No DeepSeek web token configured. Add your chat.deepseek.com userToken to keys.json' }));
    return;
  }

  try {
    // Ensure chat session exists
    if (!deepseekChatSessionId) {
      console.log('📝 Creating DeepSeek chat session...');
      deepseekChatSessionId = await createDeepSeekChatSession();
      console.log(`✅ Chat session: ${deepseekChatSessionId}`);
    }

    // Get PoW headers
    console.log('🔐 Solving PoW challenge...');
    const powHeaders = await createDeepSeekPowHeaders(DEEPSEEK_COMPLETION_PATH);
    console.log('✅ PoW solved');

    // Build DeepSeek-format request body from OpenAI-format messages
    const messages = bodyObj.messages || [];
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const prompt = lastUserMsg ? lastUserMsg.content : '';

    // Collect conversation history for context (excluding the last user message)
    const historyMessages = messages.slice(0, -1).filter(m => m.role === 'user' || m.role === 'assistant');

    const { model_type, thinking_enabled } = mapModelToDeepSeek(bodyObj);

    const deepseekBody = {
      chat_session_id: deepseekChatSessionId,
      parent_message_id: deepseekParentMessageId,
      model_type,
      prompt: typeof prompt === 'string' ? prompt : (Array.isArray(prompt) ? prompt.map(p => p.text || '').join('\n') : String(prompt)),
      ref_file_ids: [],
      thinking_enabled,
      search_enabled: bodyObj.search_enabled === true,
      action: null,
      preempt: false,
    };

    console.log(`📤 Sending to DeepSeek: ${deepseekBody.prompt.slice(0, 80)}...`);

    const headers = {
      ...getDeepSeekClientHeaders(),
      ...powHeaders,
      'X-DPP-Bypass-Hook': '1',
    };

    const isStreaming = bodyObj.stream !== false;

    const dsReq = https.request({
      hostname: DEEPSEEK_WEB_HOST,
      port: 443,
      path: DEEPSEEK_COMPLETION_PATH,
      method: 'POST',
      headers,
      timeout: 600000,
    }, (dsRes) => {
      if (dsRes.statusCode !== 200) {
        // Read error body
        const chunks = [];
        dsRes.on('data', c => chunks.push(c));
        dsRes.on('end', () => {
          const errBody = Buffer.concat(chunks).toString();
          console.error(`❌ DeepSeek API error ${dsRes.statusCode}: ${errBody.slice(0, 200)}`);

          // If session expired, reset and let next request retry
          if (dsRes.statusCode === 401 || dsRes.statusCode === 403) {
            deepseekChatSessionId = null;
            deepseekParentMessageId = null;
          }

          if (!res.headersSent) {
            res.writeHead(dsRes.statusCode, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
          }
          res.end(JSON.stringify({ error: `DeepSeek API error: ${errBody.slice(0, 500)}` }));
        });
        return;
      }

      // Forward response
      if (!res.headersSent) {
        const respHeaders = {
          ...dsRes.headers,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Stream',
          'Content-Type': isStreaming ? 'text/event-stream' : (dsRes.headers['content-type'] || 'application/json'),
        };
        res.writeHead(200, respHeaders);
      }

      if (isStreaming) {
        // Stream: parse DeepSeek SSE and convert to OpenAI-compatible SSE
        let buffer = '';
        let fullText = '';
        let messageId = null;

        dsRes.on('data', (chunk) => {
          buffer += chunk.toString();

          // Process complete SSE events
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const text = extractDeltaText(parsed);
                if (text) {
                  fullText += text;
                  // Emit OpenAI-compatible delta
                  const delta = { choices: [{ delta: { content: text }, index: 0 }] };
                  res.write(`data: ${JSON.stringify(delta)}\n\n`);
                }
                // Track message IDs
                const ids = extractMessageIds(parsed);
                if (ids.responseId) messageId = ids.responseId;
                if (ids.requestId) deepseekParentMessageId = ids.requestId;
                if (isStreamFinished(parsed)) {
                  const finishDelta = {
                    choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
                    ...(messageId ? { id: String(messageId) } : {}),
                  };
                  res.write(`data: ${JSON.stringify(finishDelta)}\n\n`);
                  res.write('data: [DONE]\n\n');
                }
              } catch {
                // Pass through unparseable lines
                res.write(line + '\n');
              }
            } else if (line.trim()) {
              res.write(line + '\n');
            }
          }
        });

        dsRes.on('end', () => {
          // Process remaining buffer
          if (buffer.trim()) {
            try {
              if (buffer.startsWith('data: ')) {
                const parsed = JSON.parse(buffer.slice(6));
                const text = extractDeltaText(parsed);
                if (text) {
                  fullText += text;
                  const delta = { choices: [{ delta: { content: text }, index: 0 }] };
                  res.write(`data: ${JSON.stringify(delta)}\n\n`);
                }
              }
            } catch {}
          }
          console.log(`✅ DeepSeek response complete: ${fullText.length} chars`);
          res.end();
        });

        dsRes.on('error', (e) => {
          console.error(`❌ DeepSeek stream error: ${e.message}`);
          if (!res.writableEnded) res.end();
        });
      } else {
        // Non-streaming: buffer and convert
        const chunks = [];
        dsRes.on('data', c => chunks.push(c));
        dsRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            // Parse DeepSeek SSE stream and extract full text
            const text = extractFullTextFromSSE(raw);
            const response = {
              id: 'deepseek-' + Date.now(),
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'deepseek-web',
              choices: [{
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop',
              }],
            };
            res.end(JSON.stringify(response));
          } catch {
            res.end(raw);
          }
        });
      }
    });

    dsReq.on('error', (e) => {
      console.error(`❌ DeepSeek request error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      }
      res.end(JSON.stringify({ error: `DeepSeek proxy error: ${e.message}` }));
    });

    dsReq.on('timeout', () => {
      dsReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      }
      res.end(JSON.stringify({ error: 'DeepSeek upstream timeout' }));
    });

    dsReq.write(JSON.stringify(deepseekBody));
    dsReq.end();

  } catch (e) {
    console.error(`❌ DeepSeek proxy error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    }
    res.end(JSON.stringify({ error: `DeepSeek proxy error: ${e.message}` }));
  }
}

// --- DeepSeek SSE parsing helpers ---
function extractDeltaText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  // Handle batch format: { o: "BATCH", v: [...] }
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    return parsed.v.map(v => extractDeltaText(v)).join('');
  }
  // Handle single delta: { o: "APPEND", v: "text" } or { o: "APPEND", p: "...", v: "text" }
  if (parsed.o === 'APPEND' && typeof parsed.v === 'string') {
    return parsed.v;
  }
  // Handle choices format (OpenAI-compatible)
  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    return choices.map(c => {
      const delta = c?.delta;
      return typeof delta?.content === 'string' ? delta.content : '';
    }).join('');
  }
  return '';
}

function extractMessageIds(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  let responseId = null, requestId = null;

  // Direct fields
  if (typeof parsed.response_message_id === 'number') responseId = parsed.response_message_id;
  if (typeof parsed.request_message_id === 'number') requestId = parsed.request_message_id;

  // Batch format
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    for (const item of parsed.v) {
      const ids = extractMessageIds(item);
      if (ids.responseId) responseId = ids.responseId;
      if (ids.requestId) requestId = ids.requestId;
    }
  }

  return { responseId, requestId };
}

function isStreamFinished(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.o === 'DONE') return true;
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    return parsed.v.some(v => isStreamFinished(v));
  }
  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    return choices.some(c => typeof c?.finish_reason === 'string');
  }
  return false;
}

function extractFullTextFromSSE(raw) {
  const lines = raw.split('\n');
  let fullText = '';
  for (const line of lines) {
    if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
      try {
        const parsed = JSON.parse(line.slice(6));
        fullText += extractDeltaText(parsed);
      } catch {}
    }
  }
  return fullText;
}

// ============================================================
// MIME types for static files
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// ============================================================
// Request body parser
// ============================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(Buffer.concat(chunks));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ============================================================
// API Proxy (Agnes)
// ============================================================
function proxyToAgnes(req, res, targetPath, method) {
  const key = nextKey();
  if (!key) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No API keys configured. Add keys to keys.json' }));
    return;
  }

  const isStreaming = req.headers['x-stream'] === 'true' ||
    (req._bodyStr && req._bodyStr.includes('"stream":true'));

  const options = {
    hostname: AGNES_HOST,
    port: 443,
    path: targetPath,
    method: method || req.method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': isStreaming ? 'text/event-stream' : 'application/json',
    },
    timeout: 600000, // 10 min timeout for video generation
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Forward status and headers
    const respHeaders = { ...proxyRes.headers };
    // Allow CORS from localhost
    respHeaders['Access-Control-Allow-Origin'] = '*';
    respHeaders['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    respHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Stream';
    // Add key index header for debugging
    respHeaders['X-Key-Index'] = String(keyIndex % apiKeys.length);

    res.writeHead(proxyRes.statusCode, respHeaders);

    if (isStreaming) {
      // Pipe SSE stream directly — no buffering
      proxyRes.pipe(res);
    } else {
      // Buffer and forward
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        res.end(Buffer.concat(chunks));
      });
    }

    proxyRes.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: `Upstream error: ${e.message}` }));
    });
  });

  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: `Proxy error: ${e.message}` }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Upstream timeout' }));
  });

  // Write request body
  if (req._bodyBuf && req._bodyBuf.length > 0) {
    proxyReq.write(req._bodyBuf);
  }
  proxyReq.end();
}

// ============================================================
// Route mapping: /api/* → Agnes API
// ============================================================
const ROUTES = [
  // Chat completions (including streaming)
  { match: '/api/chat/completions', target: '/v1/chat/completions' },
  // Image generation
  { match: '/api/images/generations', target: '/v1/images/generations' },
  // Video generation
  { match: '/api/videos', target: '/v1/videos' },
  // Models list
  { match: '/api/models', target: '/v1/models' },
];

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // --- CORS Preflight ---
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Stream',
    });
    res.end();
    return;
  }

  // --- Video status polling ---
  if (pathname === '/api/video-status') {
    const videoId = url.searchParams.get('video_id');
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing video_id parameter' }));
      return;
    }
    req._bodyBuf = Buffer.alloc(0);
    proxyToAgnes(req, res, `/agnesapi?video_id=${encodeURIComponent(videoId)}`, 'GET');
    return;
  }

  // --- DeepSeek Chat Completions ---
  if (pathname === '/api/deepseek/chat/completions') {
    const bodyBuf = await readBody(req);
    let bodyObj;
    try {
      bodyObj = JSON.parse(bodyBuf.toString());
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    proxyDeepSeekCompletion(req, res, bodyObj);
    return;
  }

  // --- DeepSeek Models List ---
  if (pathname === '/api/deepseek/models') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek-web', type: 'default' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek-web', type: 'expert' },
        { id: 'deepseek-vision', object: 'model', owned_by: 'deepseek-web', type: 'vision' },
      ],
    }));
    return;
  }

  // --- DeepSeek Session Reset ---
  if (pathname === '/api/deepseek/reset') {
    deepseekChatSessionId = null;
    deepseekParentMessageId = null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, message: 'DeepSeek session reset' }));
    return;
  }

  // --- Key management ---
  if (pathname === '/api/keys') {
    if (req.method === 'GET') {
      // Return key count only (don't leak keys to browser)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: apiKeys.length }));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { key } = JSON.parse(body.toString());
        if (key && !apiKeys.includes(key)) {
          apiKeys.push(key);
          saveKeys();
          // Reload DeepSeek token if this looks like one
          if (!key.startsWith('sk-')) {
            deepseekUserToken = key;
            deepseekChatSessionId = null;
            deepseekParentMessageId = null;
            console.log('🔑 DeepSeek web token updated');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: apiKeys.length }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or duplicate key' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON. Send: {"key":"sk-..."}' }));
      }
      return;
    }
    if (req.method === 'DELETE') {
      const idx = parseInt(url.searchParams.get('index') || '-1');
      if (idx >= 0 && idx < apiKeys.length) {
        const removed = apiKeys[idx];
        apiKeys.splice(idx, 1);
        saveKeys();
        // Clear DeepSeek token if we removed it
        if (removed === deepseekUserToken) {
          deepseekUserToken = null;
          deepseekChatSessionId = null;
          deepseekParentMessageId = null;
          loadDeepSeekToken(); // try to load another
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: apiKeys.length }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid index' }));
      }
      return;
    }
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  // --- API Proxy Routes ---
  for (const route of ROUTES) {
    if (pathname === route.match) {
      const bodyBuf = await readBody(req);
      req._bodyBuf = bodyBuf;
      req._bodyStr = bodyBuf.toString();
      proxyToAgnes(req, res, route.target, req.method);
      return;
    }
  }

  // --- Static File Serving ---
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // SPA fallback: return index.html for unknown paths
      try {
        const fallback = fs.readFileSync(path.join(ROOT, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallback);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    } else {
      res.writeHead(500);
      res.end('Server error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║       🚀  Agnes AI Playground              ║
  ╠══════════════════════════════════════════════╣
  ║  Local:    http://localhost:${PORT}             ║
  ║  Agnes:    /api/* → apihub.agnes-ai.com     ║
  ║  DeepSeek: /api/deepseek/* → chat.deepseek  ║
  ║  Keys:     ${String(apiKeys.length).padEnd(32)}║
  ║  Mode:     round-robin rotation              ║
  ╚══════════════════════════════════════════════╝
  `);
  console.log(`  Press Ctrl+C to stop\n`);
});
