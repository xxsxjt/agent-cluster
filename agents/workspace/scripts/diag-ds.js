#!/usr/bin/env node
// diag-ds.js — Direct DeepSeek API diagnostic: sends one request per model and logs raw SSE
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---- Config ----
const DS_HOST = 'chat.deepseek.com';
const DS_COMPLETION = '/api/v0/chat/completion';
const DS_SESSION = '/api/v0/chat_session/create';
const DS_POW = '/api/v0/chat/create_pow_challenge';
const DS_WASM = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'agnes-proxy', 'sha3_wasm_bg.wasm');

// ---- Load token from keys.json ----
function loadToken() {
  const keysPath = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'agnes-proxy', 'keys.json');
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  for (const k of keys) { if (k && !k.startsWith('sk-') && !k.startsWith('cpk-')) return k; }
  throw new Error('No DeepSeek token found');
}
const dsToken = loadToken();

const dsHeaders = () => ({
  'content-type': 'application/json; charset=utf-8',
  'Authorization': `Bearer ${dsToken}`,
  'X-App-Version': '2.0.0', 'x-client-platform': 'web', 'x-client-version': '2.0.0',
  'x-client-locale': 'zh-CN',
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
});

function dsReq(path, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: DS_HOST, port: 443, path, method: 'POST', headers: dsHeaders(), timeout: 30000 }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { try { resolve({ ok: res.statusCode === 200, s: res.statusCode, j: JSON.parse(Buffer.concat(c).toString()) }); } catch { resolve({ ok: false, s: res.statusCode }); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.write(JSON.stringify(body)); r.end();
  });
}

// ---- WASM PoW ----
async function loadWasm() {
  const buf = fs.readFileSync(DS_WASM);
  const { instance } = await WebAssembly.instantiate(buf, {});
  return instance.exports;
}

function solvePow(wasm, hex, prefix, diff) {
  const enc = new TextEncoder();
  const w = v => { const b = enc.encode(v), p = wasm.__wbindgen_export_0(b.length, 1); new Uint8Array(wasm.memory.buffer).set(b, p); return { ptr: p, len: b.length }; };
  const rp = wasm.__wbindgen_add_to_stack_pointer(-16);
  const ca = w(hex.toLowerCase()), pa = w(prefix);
  try {
    wasm.wasm_solve(rp, ca.ptr, ca.len, pa.ptr, pa.len, diff);
    const v = new DataView(wasm.memory.buffer);
    if (v.getInt32(rp, true) !== 1) throw new Error('PoW failed');
    return v.getFloat64(rp + 8, true);
  } finally { wasm.__wbindgen_add_to_stack_pointer(16); }
}

async function initSession() {
  const r = await dsReq(DS_SESSION, {});
  const id = r.j?.data?.biz_data?.chat_session?.id;
  if (!id) throw new Error('Session failed: ' + JSON.stringify(r.j).slice(0, 200));
  return id;
}

async function getPowHeaders() {
  const cr = await dsReq(DS_POW, { target_path: DS_COMPLETION });
  const ch = cr.j?.data?.biz_data?.challenge;
  if (!ch) throw new Error('PoW challenge failed: ' + JSON.stringify(cr.j).slice(0, 200));
  const wasm = await loadWasm();
  const prefix = `${ch.salt}_${ch.expire_at ?? ch.expireAt}_`;
  const answer = solvePow(wasm, ch.challenge, prefix, Number(ch.difficulty));
  const powResp = JSON.stringify({ algorithm: String(ch.algorithm), challenge: String(ch.challenge), salt: String(ch.salt), answer, signature: String(ch.signature), target_path: DS_COMPLETION });
  return { 'X-DS-PoW-Response': Buffer.from(powResp, 'utf8').toString('base64') };
}

// ---- Test one model ----
async function testModel(name, mt, think, prompt) {
  console.log(`\n========== Testing: ${name} | model_type="${mt}" | think=${think} ==========`);

  const sessionId = await initSession();
  console.log(`Session: ${sessionId}`);

  const powHeaders = await getPowHeaders();
  console.log(`PoW header: present`);

  const dsBody = JSON.stringify({
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: mt,
    prompt,
    ref_file_ids: [],
    thinking_enabled: think,
    search_enabled: false,
    action: null,
    preempt: false,
  });

  console.log(`Request body:`, dsBody.slice(0, 300));

  return new Promise((resolve, reject) => {
    const dr = https.request({
      hostname: DS_HOST, port: 443, path: DS_COMPLETION, method: 'POST',
      headers: { ...dsHeaders(), ...powHeaders, 'X-DPP-Bypass-Hook': '1' },
      timeout: 120000,
    }, dsRes => {
      console.log(`Response status: ${dsRes.statusCode}`);

      let buf = '', fullText = '';
      dsRes.on('data', c => {
        buf += c.toString();
        const parts = buf.split('\n'); buf = parts.pop() || '';
        for (const l of parts) {
          if (l.startsWith('data: ') && l.slice(6) !== '[DONE]') {
            try {
              const p = JSON.parse(l.slice(6));
              const ds = JSON.stringify(p);
              // Log events with model/status info
              if (ds.includes('model_type') || ds.includes('ready') || ds.includes('message_id') || ds.includes('response/status') || ds.includes('quasi_status') || ds.includes('FINISHED') || ds.includes('DONE')) {
                console.log(`[SSE EVENT] ${ds.slice(0, 250)}`);
              }
              // Extract text
              if (typeof p.v === 'string' && p.o === undefined && p.p === undefined) fullText += p.v;
              else if (p.o === 'APPEND' && typeof p.v === 'string') fullText += p.v;
            } catch {}
          }
        }
      });
      dsRes.on('end', () => {
        console.log(`--- Response text (first 200 chars) ---`);
        console.log(fullText.slice(0, 200));
        console.log(`========== END ${name} ==========`);
        resolve(fullText);
      });
    });

    dr.on('error', reject);
    dr.on('timeout', () => { dr.destroy(); reject(new Error('timeout')); });
    dr.write(dsBody);
    dr.end();
  });
}

// ---- Main ----
(async () => {
  try {
    console.log('DS Token:', dsToken.slice(0, 20) + '...');

    // Test 1: chat (default)
    await testModel('CHAT', 'default', true, 'Say hello in one sentence.');

    // Test 2: expert/reasoner
    await testModel('EXPERT', 'expert', true, 'What is 2+2? Short answer.');

    // Test 3: vision
    await testModel('VISION', 'vision', false, 'Say hi in one word.');

  } catch(e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
})();
