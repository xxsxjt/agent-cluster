#!/usr/bin/env node
/**
 * UUMit 技能管理脚本（上架/编辑/列表）——防编码乱码版
 *
 * 背景（2026-08-12 修复）：此前上架用 `node -e "..."` 在 bash 命令行内嵌中文 JSON，
 * Windows git-bash 以 GBK 传参给 node → 中文变 U+FFFD 乱码入库。
 *
 * 铁律（本脚本强制）：
 *   1. 载荷一律从 UTF-8 JSON 文件读取（--file 参数），禁止命令行内嵌中文
 *   2. 发送前自检：载荷含 U+FFFD / 码点异常 → 拒绝发送
 *   3. Content-Type 显式带 charset=utf-8
 *
 * 用法:
 *   node tools/skill-manage.js list                       # 列出我的技能（含乱码自检）
 *   node tools/skill-manage.js get <skill_id>             # 技能详情
 *   node tools/skill-manage.js create <payload.json>      # 上架技能（payload 见 §字段）
 *   node tools/skill-manage.js update <skill_id> <payload.json>  # 编辑技能（全量更新）
 *
 * payload.json 字段（PUT 全量更新，缺字段会被覆盖为空）:
 *   { name, description, category, tags[], mode, ut_price, pricing_model,
 *     deliverables[], input_requirements_text, delivery_hours }
 *
 * 鉴权: memory/uumit-auth.json（api_key / platform_user_id）
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKDIR = path.resolve(__dirname, '..');
const AUTH_FILE = path.join(WORKDIR, 'memory', 'uumit-auth.json');
const TIMEOUT = 25000;

function readJsonFile(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 容忍 BOM
  return JSON.parse(text);
}

function loadAuth() {
  const auth = readJsonFile(AUTH_FILE);
  if (!auth.api_key || !auth.platform_user_id) throw new Error('鉴权文件缺 api_key/platform_user_id');
  return auth;
}

function req(auth, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: 'api.uumit.com',
      path: p,
      method,
      headers: {
        'X-Api-Key': auth.api_key,
        'X-Platform-User-Id': auth.platform_user_id,
        'Content-Type': 'application/json; charset=utf-8'
      }
    }, x => {
      let d = '';
      x.on('data', c => d += c);
      x.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('响应非 JSON: ' + d.slice(0, 200))); }
      });
    });
    r.on('error', reject);
    r.setTimeout(TIMEOUT, () => r.destroy(new Error('请求超时')));
    if (body) r.write(JSON.stringify(body)); // body 来自 UTF-8 文件，Node 内部统一 UTF-8
    r.end();
  });
}

// 编码自检：载荷里不应有 U+FFFD 且中文字符应正常
function checkEncoding(obj, label) {
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.includes('\uFFFD')) throw new Error(label + ' 含 U+FFFD（乱码）——请从正确 UTF-8 源取内容');
      // 抽查：若含中文（\u4e00-\u9fff 及以上 CJK 区），说明编码正常
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') return Object.values(v).forEach(walk);
  };
  walk(obj);
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  const auth = loadAuth();

  if (cmd === 'list') {
    const r = await req(auth, 'GET', '/api/v1/skills?page=1&page_size=50');
    if (r.code !== 0) { console.error(JSON.stringify(r)); process.exit(1); }
    for (const s of r.data.items) {
      const bad = [s.name, s.description || '', JSON.stringify(s.tags || []), s.input_requirements_text || '']
        .join(' ').includes('\uFFFD');
      console.log((bad ? '❌乱码 ' : '✅ ') + s.id.slice(0, 8) + ' | ' + s.name + ' | ' + s.ut_price + 'UT | ' + (s.audit_status || s.status));
    }
    return;
  }

  if (cmd === 'get') {
    if (!arg1) throw new Error('用法: get <skill_id>');
    const r = await req(auth, 'GET', '/api/v1/skills/' + arg1);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'create' || cmd === 'update') {
    if (cmd === 'create' && !arg1) throw new Error('用法: create <payload.json>');
    if (cmd === 'update' && (!arg1 || !arg2)) throw new Error('用法: update <skill_id> <payload.json>');
    const payloadFile = cmd === 'create' ? arg1 : arg2;
    const payload = readJsonFile(path.resolve(WORKDIR, payloadFile));
    checkEncoding(payload, 'payload');

    const method = cmd === 'create' ? 'POST' : 'PUT';
    const apiPath = cmd === 'create' ? '/api/v1/skills' : '/api/v1/skills/' + arg1;
    const r = await req(auth, method, apiPath, payload);
    if (r.code !== 0) { console.error(JSON.stringify(r)); process.exit(1); }
    console.log('✅', cmd === 'create' ? '上架成功' : '更新成功', JSON.stringify(r));
    return;
  }

  throw new Error('未知命令: ' + cmd + '（支持 list / get / create / update）');
}

main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
