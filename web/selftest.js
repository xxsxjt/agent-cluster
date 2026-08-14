#!/usr/bin/env node
/**
 * web/selftest.js — 前端 + 接口自检（不需要浏览器）
 *
 *   node selftest.js            # 编译模板 + 起临时服务打一遍所有接口
 *   node selftest.js --port 0   # 端口自动分配（默认 0）
 *
 * 退出码 0 = 全通过；非 0 = 有失败项。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DIR = __dirname;
let pass = 0, fail = 0;
const ok = (m) => { console.log('  \x1b[32m✓\x1b[0m ' + m); pass++; };
const no = (m) => { console.log('  \x1b[31m✗\x1b[0m ' + m); fail++; };
const chk = (cond, m) => cond ? ok(m) : no(m);

/* ── 1. 用 Vue 编译器验证模板 ─────────────────────────── */
function checkTemplates() {
  console.log('\n[1] Vue 模板编译');
  const vuePath = path.join(DIR, 'vendor', 'vue.global.prod.js');
  if (!fs.existsSync(vuePath)) return no('缺少 vendor/vue.global.prod.js（页面会回退 CDN，离线不可用）');

  // Vue 的实体解码器依赖 document，给最小桩
  const decode = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  global.document = {
    createElement: () => ({
      _h: '',
      set innerHTML(v) { this._h = String(v); },
      get innerHTML() { return this._h; },
      get textContent() { return decode(this._h); },
      get children() {
        const m = /^<div\s+foo="([\s\S]*)">$/.exec(this._h);
        return [{ getAttribute: () => m ? decode(m[1]) : decode(this._h) }];
      }
    })
  };
  const V = new Function(fs.readFileSync(vuePath, 'utf8') + '\nreturn Vue;')();
  global.Vue = V;   // 编译产物里会引用全局 Vue

  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const tpl = html.match(/<script type="text\/x-template" id="tpl-tree-node">([\s\S]*?)<\/script>/);
  const a = html.indexOf('<div id="app" v-cloak>');
  const b = html.indexOf('<!-- 递归树节点组件 -->');
  const appTpl = a >= 0 && b > a ? html.slice(html.indexOf('>', a) + 1, b).replace(/<\/div>\s*$/, '') : null;

  for (const [name, src] of [['#app', appTpl], ['tpl-tree-node', tpl && tpl[1]]]) {
    if (!src) { no(`${name}: 模板没提取到`); continue; }
    const errs = [];
    try { V.compile(src, { onError: e => errs.push(e.message) }); }
    catch (e) { errs.push(e.message); }
    errs.length ? no(`${name}: ${errs.slice(0, 5).join(' | ')}`)
                : ok(`${name} 编译通过（${src.length} 字符）`);
  }
  console.log(`  Vue ${V.version}`);
}
/* ── 2. 起服务打接口 ──────────────────────────────────── */
function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 20000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ code: res.statusCode, body: buf, type: res.headers['content-type'] || '' }));
    });
    req.on('timeout', () => { req.destroy(new Error('超时 ' + p)); });
    req.on('error', reject);
  });
}
function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', timeout: 20000,
      headers: { 'content-type': 'application/json', 'content-length': data.length }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ code: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(new Error('POST 超时 ' + p)); });
    req.on('error', reject);
    req.end(data);
  });
}
async function getJson(port, p) {
  const r = await get(port, p);
  try { return { code: r.code, json: JSON.parse(r.body) }; }
  catch (e) { return { code: r.code, json: null, raw: r.body.slice(0, 200) }; }
}
async function postJson(port, p, body) {
  const r = await post(port, p, body);
  try { return { code: r.code, json: JSON.parse(r.body) }; }
  catch (e) { return { code: r.code, json: null, raw: r.body.slice(0, 200) }; }
}

async function checkApi() {
  console.log('\n[2] 启动服务 + 接口自检');
  // 预置一个幽灵任务进快照，验证“最近删除”列表（不碰真实 inbox，避免 butler 捡走）
  const seenFile = path.join(DIR, '..', 'logs', 'tasks-seen.json');
  let seenBackup = null;
  try { seenBackup = fs.readFileSync(seenFile, 'utf8'); } catch (e) {}
  const ghost = '__ghost_selftest__';
  const seen = seenBackup ? JSON.parse(seenBackup) : {};
  seen[ghost] = { firstSeen: Date.now() - 3600e3, lastSeenAt: Date.now() - 1800e3,
                  lastStatus: 'done', agentId: 'coo', deletedAt: Date.now() - 600e3 };
  fs.writeFileSync(seenFile, JSON.stringify(seen), 'utf8');

  const child = spawn(process.execPath, [path.join(DIR, 'server.js'), '--port', '0'],
                      { cwd: DIR, windowsHide: true });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('启动超时，输出：' + out)), 15000);
    child.stdout.on('data', d => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(t); resolve(parseInt(m[1], 10)); }
    });
    child.stderr.on('data', d => out += d.toString());
    child.on('exit', c => { clearTimeout(t); reject(new Error('服务退出 code=' + c + '\n' + out)); });
  });
  ok(`服务已起在 :${port}`);

  try {
    // 静态资源
    for (const [p, type] of [['/', 'text/html'], ['/app.js', 'javascript'],
                             ['/style.css', 'text/css'], ['/vendor/vue.global.prod.js', 'javascript']]) {
      const r = await get(port, p);
      chk(r.code === 200 && r.type.includes(type) && r.body.length > 100,
          `静态 ${p} → ${r.code} ${r.body.length}B`);
    }
    chk((await get(port, '/nope')).code === 404, '未知路径 → 404');

    // 目录穿越必须被拦
    const trav = await getJson(port, '/api/file?p=' + encodeURIComponent('../../.claude/CLAUDE.md'));
    chk(trav.json && trav.json.ok === false, '穿越 ../../ 被拒绝');
    chk((await get(port, '/server.js')).code === 404, '后端源码不对外暴露');
    for (const p of ['/%2e%2e%2forg.json', '/..%5cbutler.js', '/%2e%2e/org.json']) {
      chk((await get(port, p)).code !== 200, `穿越 ${p} 被拒绝`);
    }

    // /api/state
    const st = await getJson(port, '/api/state');
    const s = st.json;
    chk(s && s.ok === true, '/api/state ok');
    chk(s && s.org && s.org.root && Object.keys(s.org.nodes).length > 0,
        `org 树: root + ${s ? Object.keys(s.org.nodes).length : 0} 节点`);
    chk(s && Array.isArray(s.tasks), `任务 ${s ? s.tasks.length : '?'} 条`);
    chk(s && s.summary && typeof s.summary.text === 'string' && s.summary.text.includes('管家小结'),
        '管家小结（计算版）有内容');
    chk(s && s.summary.counts && s.summary.counts.agents > 0,
        `统计: ${s ? s.summary.counts.agents : 0} 智能体 / ${s ? s.summary.counts.groups : 0} 组`);
    chk(s && Array.isArray(s.recentDeleted) && s.recentDeleted.length <= 20,
        `/api/state 带 recentDeleted（${s ? s.recentDeleted.length : '?'} 条）`);
    chk(s && s.recentDeleted.some(t => t.name === '__ghost_selftest__' && t.lastStatus === 'done'),
        '预置幽灵任务出现在最近删除列表');
    // 树里每个 children 引用都要能在 nodes 里找到
    if (s && s.org) {
      const miss = [];
      const walk = n => (n.children || []).forEach(c => {
        s.org.nodes[c] ? walk(s.org.nodes[c]) : miss.push(c);
      });
      walk(s.org.root);
      chk(miss.length === 0, miss.length ? `org.json 有悬空引用: ${miss.join(',')}` : '树引用完整');
    }

    // /api/agent 每个 agent 节点都要能取到详情
    const ids = s ? Object.keys(s.org.nodes) : [];
    let agentOk = 0, withLog = 0, streamJsonWithEvents = 0;
    for (const id of ids) {
      const d = await getJson(port, '/api/agent?id=' + encodeURIComponent(id));
      if (d.json && d.json.ok && d.json.node) agentOk++;
      if (d.json && d.json.log) {
        withLog++;
        const L = d.json.log;
        if (!Array.isArray(L.events)) no(`${id} 日志 events 不是数组`);
        if (L.format === 'stream-json' && !L.meta.model) no(`${id} stream-json 日志缺 meta.model`);
        if (L.format === 'stream-json' && L.events.length > 0) streamJsonWithEvents++;
      }
    }
    chk(agentOk === ids.length, `/api/agent 覆盖 ${agentOk}/${ids.length} 个节点`);
    chk(withLog > 0, `其中 ${withLog} 个能读到任务日志`);

    // 回归：pi stream-json 日志必须解析出事件（之前 message_update 格式完全不认，显示“日志为空”）
    const distill = await getJson(port, '/api/agent?id=night-worker&task=agent-sessions-distill&events=60');
    if (distill.json && distill.json.ok && distill.json.log) {
      const L = distill.json.log;
      const kinds = new Set(L.events.map(e => e.kind));
      chk(L.format === 'stream-json' && L.events.length > 0,
          `pi 格式日志解析出 ${L.events.length} 条事件（kinds: ${[...kinds].join('/')}）`);
      chk(kinds.has('text') || kinds.has('tool') || kinds.has('thinking') || kinds.has('final'),
          'pi 日志事件类型含 text/tool/thinking/final 之一');
    } else {
      no('取不到 night-worker 的 agent-sessions-distill 日志（回归测跳过）');
    }
    chk(streamJsonWithEvents > 0, `至少 ${streamJsonWithEvents} 个 stream-json 日志解析出事件`);

    const bad = await getJson(port, '/api/agent?id=__nope__');
    chk(bad.code === 404 && bad.json && bad.json.ok === false, '未知 id → 404');

    // 其余接口
    const sum = await getJson(port, '/api/summary');
    chk(sum.json && sum.json.ok && sum.json.source === 'computed', '/api/summary（计算版）');
    const bl = await getJson(port, '/api/butlerlog?lines=20');
    chk(bl.json && bl.json.ok && typeof bl.json.text === 'string', '/api/butlerlog');
    const f = await getJson(port, '/api/file?p=org.json');
    chk(f.json && f.json.ok && f.json.text.includes('"nodes"'), '/api/file org.json');

    // ── memory 接口（lib/memory.js：时间线 + 检索 + 实体图谱） ──
    const mem = await getJson(port, '/api/memory/takina');
    chk(mem.json && mem.json.ok === true && Array.isArray(mem.json.timeline) &&
        Array.isArray(mem.json.search) && Array.isArray(mem.json.entities),
        '/api/memory/takina 返回 timeline+search+entities');
    chk(mem.json && mem.json.search.length > 0 && mem.json.entities.length > 0,
        `takina 记忆有内容（检索 ${mem.json ? mem.json.search.length : '?'} 条 / 实体 ${mem.json ? mem.json.entities.length : '?'} 个）`);
    chk(mem.json && mem.json.index && mem.json.index.count > 0, 'index.json 元信息随带返回');
    chk((await getJson(port, '/api/memory/__nope__')).code === 404, '未知智能体记忆 → 404');

    // ── chat 接口（不真实发消息，避免 selftest 消耗 token） ──
    const ca = await getJson(port, '/api/chat/agents');
    chk(ca.json && ca.json.ok && Array.isArray(ca.json.agents), '/api/chat/agents ok');
    const caIds = ca.json ? ca.json.agents.map(a => a.id) : [];
    chk(caIds.includes('twin') && caIds.includes('coo'), `可对话列表含 twin+coo（实际: ${caIds.join(',') || '空'}）`);

    for (const id of caIds.slice(0, 2)) {
      const h = await getJson(port, `/api/chat/${id}/history`);
      chk(h.json && h.json.ok && Array.isArray(h.json.messages), `/api/chat/${id}/history 可读`);
    }
    chk((await getJson(port, '/api/chat/__nope__/history')).code === 404, '未知智能体 history → 404');
    chk((await postJson(port, '/api/chat/__nope__', { message: 'hi' })).code === 404, 'POST 未知智能体 → 404');
    chk((await postJson(port, '/api/chat/twin', {})).code === 400, 'POST 缺 message → 400');
    chk((await postJson(port, '/api/chat/twin', { message: '   ' })).code === 400, 'POST 空 message → 400');
    chk((await postJson(port, '/api/state', {})).code === 404, 'POST 非 chat 接口 → 404');

    // ── v5.1：chat 多开并行（两个会话接口同时可用，互不阻塞） ──
    console.log('\n[2.3] v5.1 twin-daemon 新增接口');
    const st5 = await getJson(port, '/api/state');
    chk(st5.json && st5.json.twin && typeof st5.json.twin.running === 'boolean',
        `/api/state 带 twin 状态（running=${st5.json && st5.json.twin ? st5.json.twin.running : '?'}）`);
    chk(st5.json && st5.json.twin && (st5.json.twin.lastActivity === null || st5.json.twin.lastActivity.text),
        'twin.lastActivity 可读');
    const ts = await getJson(port, '/api/twin/status');
    chk(ts.json && ts.json.ok && typeof ts.json.running === 'boolean' &&
        (ts.json.running ? ts.json.pid > 0 : true), '/api/twin/status ok');
    const ta = await getJson(port, '/api/twin/activity?lines=20');
    chk(ta.json && ta.json.ok && Array.isArray(ta.json.lines) && typeof ta.json.text === 'string',
        '/api/twin/activity 足迹可读');
    chk(ta.json && ta.json.lines.length > 0 && ta.json.lines[0].ts && ta.json.lines[0].tag,
        `足迹行带 ts/tag（${ta.json ? ta.json.lines.length : '?'} 行）`);
    const tr = await getJson(port, '/api/trace?task=paid-model-price-compare-v2');
    chk(tr.json && tr.json.ok && Array.isArray(tr.json.events) && tr.json.events.length > 0,
        `/api/trace 链路有 ${tr.json ? tr.json.events.length : '?'} 个事件`);
    const stages = tr.json ? new Set(tr.json.events.map(e => e.stage)) : new Set();
    chk(stages.has('twin-order') && stages.has('done'),
        '链路含 分身指示(twin-order) → … → 完成(done)');
    chk((await getJson(port, '/api/trace?task=__nope__')).json.ok === true, '/api/trace 未知任务返回 ok（空链路）');
    // 多开并行：两个不同智能体的 history 同时可读（会话互不干扰）
    const [hA, hB] = await Promise.all([
      getJson(port, '/api/chat/twin/history'),
      getJson(port, '/api/chat/coo/history')
    ]);
    chk(hA.json && hA.json.ok && hB.json && hB.json.ok,
        '并发读 twin + coo 两个会话 history 均 ok（多开并行）');

    // ── 睡前模式：shutdown 守护 API 实测（临时 inbox + 假关机命令，不碰真机） ──
    console.log('\n[2.4] shutdown 守护 API（arm/status/disarm）');
    const os2 = require('os');
    const tmpInbox = fs.mkdtempSync(path.join(os2.tmpdir(), 'xuwu-shutdown-inbox-'));
    const tmpLogs  = fs.mkdtempSync(path.join(os2.tmpdir(), 'xuwu-shutdown-logs-'));
    fs.writeFileSync(path.join(tmpInbox, 'fake-task.md'), '# 假任务\n');
    fs.writeFileSync(path.join(tmpLogs, 'fake-task.log'), 'keep alive\n');   // 有新日志 → 不触发卡死关机

    const st0 = await getJson(port, '/api/shutdown/status');
    chk(st0.json && st0.json.ok === true && st0.json.armed === false, 'status 初始 armed=false');

    const arm = await postJson(port, '/api/shutdown/arm',
      { testInbox: tmpInbox, testLogs: tmpLogs, testCmd: 'echo FAKE_SHUTDOWN', graceMs: 5000 });
    chk(arm.json && arm.json.ok === true && arm.json.armed === true && arm.json.pid > 0,
        `arm → armed=true pid=${arm.json ? arm.json.pid : '?'}（测试模式：假 inbox + echo 关机）`);
    await new Promise(r => setTimeout(r, 1500));   // 等守护进程起来并完成首轮检查

    const st1 = await getJson(port, '/api/shutdown/status');
    chk(st1.json && st1.json.armed === true && st1.json.pid === (arm.json && arm.json.pid),
        'arm 后 status armed=true 且 PID 一致（守护存活，未被假 inbox 误触发退出）');
    chk(st1.json && Array.isArray(st1.json.pending) && typeof st1.json.done === 'number',
        `status 带剩余任务清单（pending=${st1.json ? st1.json.pending.length : '?'}）`);

    const arm2 = await postJson(port, '/api/shutdown/arm', {});
    chk(arm2.json && arm2.json.ok === true && arm2.json.already === true, '重复 arm → already=true 不双开');

    const dis = await postJson(port, '/api/shutdown/disarm', {});
    chk(dis.json && dis.json.ok === true && dis.json.armed === false, 'disarm → armed=false');
    await new Promise(r => setTimeout(r, 800));
    const st2 = await getJson(port, '/api/shutdown/status');
    chk(st2.json && st2.json.armed === false, 'disarm 后 status armed=false（守护已死）');
    try { fs.rmSync(tmpInbox, { recursive: true, force: true }); fs.rmSync(tmpLogs, { recursive: true, force: true }); } catch (e) {}

    // --chat-e2e：可选的真实对话测试（会 spawn pi 子进程、消耗夜间窗口额度）
    if (process.argv.includes('--chat-e2e')) {
      console.log('\n[2.5] chat 真实对话 e2e（--chat-e2e）');
      const r = await postJson(port, '/api/chat/coo', { message: '现在有几个活动任务？只回数字和任务名。' });
      chk(r.json && r.json.ok === true && typeof r.json.reply === 'string' && r.json.reply.length > 0,
          `POST coo 收到回复（${r.json ? r.json.tookMs : '?'}ms）: ` +
          (r.json && r.json.reply ? r.json.reply.slice(0, 120).replace(/\n/g, ' ') : (r.json && r.json.error) || r.raw || '?'));
    }
  } finally {
    try { child.kill(); } catch (e) {}
    // 还原快照文件（去掉幽灵条目）
    try {
      const cur = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
      delete cur[ghost];
      fs.writeFileSync(seenFile, JSON.stringify(cur), 'utf8');
    } catch (e) {
      if (seenBackup != null) try { fs.writeFileSync(seenFile, seenBackup, 'utf8'); } catch (_) {}
    }
  }
}

/* ── 3. 静态 class 是否都有 CSS（笔误检查） ───────────── */
function checkClasses() {
  console.log('\n[3] class / CSS 一致性');
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');
  const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]));
  const IGNORE = new Set(['bt', 'root']);   // 纯结构容器，无需样式
  const used = new Set();
  for (const m of html.matchAll(/\sclass="([^"{}]*)"/g)) {
    m[1].trim().split(/\s+/).filter(Boolean).forEach(c => used.add(c));
  }
  // 动态 class 里的字面量前缀（'d-'+status / 'k-'+kind / 'st-'+status / 'tab-'+name）
  const dyn = ['d-running', 'd-done', 'd-failed', 'd-pending', 'd-stale',
               'd-active', 'd-sleeping', 'd-retired', 'd-unknown',
               'k-text', 'k-thinking', 'k-tool', 'k-result', 'k-system', 'k-final', 'k-raw', 'k-user',
               'tab-tree', 'tab-out', 'tab-sum', 'tab-chat'];
  const missing = [...used].filter(c => !defined.has(c) && !IGNORE.has(c));
  const dynMissing = dyn.filter(c => !defined.has(c));
  chk(missing.length === 0, missing.length ? `静态 class 缺 CSS: ${missing.join(', ')}` : '静态 class 全有 CSS');
  chk(dynMissing.length === 0, dynMissing.length ? `动态 class 缺 CSS: ${dynMissing.join(', ')}` : '动态 class 全有 CSS');
  chk(/@media[^{]*max-width:\s*900px/.test(css), '有移动端断点（响应式）');
}

/* ── 4. app.js 引用检查（未定义函数 / 模板用到但没实现） ── */
function stripJs(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/([^:\w])\/\/[^\n]*/g, '$1 ')
            .replace(/'(?:\\.|[^'\\])*'/g, "''")
            .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function checkAppRefs() {
  console.log('\n[4] app.js 引用检查');
  const raw = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
  const src = stripJs(raw);

  // app.js 里声明过的名字
  const declared = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*function/g)) declared.add(m[1]);
  for (const m of src.matchAll(/function\s*\(([^)]*)\)/g)) {
    m[1].split(',').forEach(p => { p = p.trim(); if (p) declared.add(p); });
  }

  const GLOBALS = new Set(['fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
    'require', 'alert', 'confirm', 'escape', 'unescape']);
  const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
    'do', 'else', 'in', 'of', 'delete', 'void', 'await', 'throw', 'yield', 'case', 'instanceof']);

  // 裸函数调用 foo(...)（前面没有 . 的），必须在 app.js 里声明过
  const undef = new Set();
  for (const m of src.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) {
    const id = m[1];
    if (KW.has(id) || GLOBALS.has(id) || declared.has(id)) continue;
    undef.add(id);
  }
  chk(undef.size === 0, undef.size ? `调用了未定义的函数: ${[...undef].join(', ')}`
                                   : '无未定义的函数调用');

  // 模板里用到的标识符必须在 app.js 有对应 data/computed/method
  const keys = new Set(declared);
  for (const m of src.matchAll(/^\s{4,8}([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(m[1]);
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const tpl = html.match(/<script type="text\/x-template" id="tpl-tree-node">([\s\S]*?)<\/script>/);
  const a = html.indexOf('<div id="app" v-cloak>');
  const b = html.indexOf('<!-- 递归树节点组件 -->');
  const parts = [['#app', a >= 0 && b > a ? html.slice(html.indexOf('>', a) + 1, b) : null],
                 ['tpl-tree-node', tpl && tpl[1]]];
  const VUE_BUILTIN = new Set(['emit', 'event', 'nextTick', 'refs', 'true', 'false', 'null',
    'undefined', 'typeof', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Date', 'in', 'of']);

  for (const [name, t] of parts) {
    if (!t) { no(`${name} 模板没提取到`); continue; }
    const locals = new Set();
    for (const m of t.matchAll(/v-for="\(?([^)"]*?)\)?\s+(?:in|of)\s/g)) {
      m[1].split(',').forEach(x => locals.add(x.trim()));
    }
    const exprs = [];
    for (const m of t.matchAll(/(?::|@|v-[a-z-]+)[\w.:-]*="([^"]*)"/g)) exprs.push(m[1]);
    for (const m of t.matchAll(/\{\{([^}]*)\}\}/g)) exprs.push(m[1]);
    const missing = new Set();
    for (let e of exprs) {
      e = e.replace(/'[^']*'/g, ' ')                 // 字符串字面量
           .replace(/\$?\.\s*[A-Za-z_$][\w$]*/g, ' ') // 属性访问
           .replace(/\b[A-Za-z_$][\w$]*\s*:/g, ' ');  // 对象字面量的键
      for (const m of e.matchAll(/\$?\b([A-Za-z_$][\w$]*)\b/g)) {
        const id = m[1].replace(/^\$/, '');
        if (VUE_BUILTIN.has(id) || locals.has(id) || keys.has(id)) continue;
        missing.add(id);
      }
    }
    chk(missing.size === 0, missing.size ? `${name} 用到但 app.js 没有: ${[...missing].join(', ')}`
                                        : `${name} 标识符齐全`);
  }
}

/* ── 6. model-router 定时路由单元测 ─────────────── */
function checkModelRouter() {
  console.log('\n[6] model-router 定时路由（两个时段输出）');
  const mr = require(path.join(DIR, '..', 'lib', 'model-router.js'));
  const at = h => new Date(2026, 7, 5, h, 30);   // 2026-08-05 h:30 本机时间
  const night = mr.defaultRoute(at(23));
  chk(night.window === 'night' && night.model === 'qwen3.8-max-preview' && night.thinking === 'max',
      `23:30 → 夜间档 ${night.provider}/${night.model}·${night.thinking}`);
  chk(mr.defaultRoute(at(0)).window === 'night' && mr.defaultRoute(at(7)).window === 'night',
      '00:30 / 07:30 → 同属夜间窗口');
  const day = mr.defaultRoute(at(12));
  chk(day.window === 'day' && day.model === 'deepseek-v4-flash' && day.thinking === 'max',
      `12:30 → 白天档 ${day.provider}/${day.model}·${day.thinking}`);
  chk(mr.defaultRoute(at(22)).window === 'night', '22:00 边界 → 夜间（含）');
  chk(mr.defaultRoute(at(8)).window === 'day', '08:00 边界 → 白天（不含）');
  chk(night.provider === 'aliyun-tokenplan' && day.provider === 'opencode-go',
      '夜间=aliyun-tokenplan，白天=opencode-go（用户 8/5 路由规则）');
}

/* ── 5. 日志解析单元测（pi / claude 两种 stream-json） ─── */
function checkLogParser() {
  console.log('\n[5] 日志解析单元测');
  const os = require('os');
  const srv = require(path.join(DIR, 'server.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'org-web-test-'));

  try {
    // pi 格式：message_update *_end + tool_execution_end + agent_settled，混入半行和 delta 噪音
    const piFile = path.join(tmp, 'pi.log');
    fs.writeFileSync(piFile, [
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'noisy', partial: {} } }),
      JSON.stringify({ type: 'message_update', message: { timestamp: 1785858356151, model: 'test-model' },
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '思考内容ABC' } }),
      JSON.stringify({ type: 'message_update', message: { timestamp: 1785858356200 },
        assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: '回复文本XYZ' } }),
      JSON.stringify({ type: 'message_update', message: { timestamp: 1785858356300 },
        assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2,
          toolCall: { id: 'call_1', name: 'bash', arguments: { command: 'ls -la /tmp' } } } }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash',
        result: { content: [{ type: 'text', text: 'total 8\\ndrwxr' }] }, isError: false }),
      JSON.stringify({ type: 'auto_retry_start', attempt: 1, delayMs: 2000, errorMessage: 'overloaded' }),
      JSON.stringify({ type: 'agent_end', messages: [], willRetry: false }),
      JSON.stringify({ type: 'agent_settled' }),
      '{"type":"message_update","broken": '   // 写入中的半行，必须静默丢弃
    ].join('\n'));
    const pr = srv.parseLogTail(piFile, 100);
    chk(pr && pr.format === 'stream-json', 'pi: 识别为 stream-json');
    const pk = pr.events.map(e => e.kind);
    chk(pr.events.some(e => e.kind === 'thinking' && e.text.includes('思考内容ABC')), 'pi: thinking_end → thinking 事件');
    chk(pr.events.some(e => e.kind === 'text' && e.text.includes('回复文本XYZ')), 'pi: text_end → text 事件');
    chk(pr.events.some(e => e.kind === 'tool' && e.tool === 'bash' && String(e.text).includes('ls -la')), 'pi: toolcall_end → tool 事件（含参数）');
    chk(pr.events.some(e => e.kind === 'result' && !e.error), 'pi: tool_execution_end → result 事件');
    chk(pr.events.some(e => e.kind === 'system' && e.error), 'pi: auto_retry_start → 系统错误事件');
    chk(pr.events.some(e => e.kind === 'final'), 'pi: agent_settled → final 事件');
    chk(!pk.includes('raw'), 'pi: 半行/噪音不泄露为 raw');
    chk(pr.meta.model === 'test-model', `pi: meta.model 从尾部事件提取（${pr.meta.model}）`);

    // claude 格式：system/init + assistant(text+tool_use) + user(tool_result) + result
    const ccFile = path.join(tmp, 'cc.log');
    fs.writeFileSync(ccFile, [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-test', cwd: '/w' }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: '思考中' },
        { type: 'text', text: '你好' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.txt' } }
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '文件内容' }] }
      ] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 2, result: '完成' })
    ].join('\n'));
    const cr = srv.parseLogTail(ccFile, 100);
    chk(cr && cr.format === 'stream-json', 'claude: 识别为 stream-json');
    chk(cr.meta.model === 'claude-test' && cr.meta.sessionId === 's1', 'claude: init 元信息');
    chk(cr.events.some(e => e.kind === 'text' && e.text.includes('你好')), 'claude: assistant text');
    chk(cr.events.some(e => e.kind === 'tool' && e.tool === 'Read' && String(e.text).includes('b.txt')), 'claude: tool_use');
    chk(cr.events.some(e => e.kind === 'result' && String(e.text).includes('文件内容')), 'claude: tool_result');
    chk(cr.events.some(e => e.kind === 'final'), 'claude: result → final');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

(async () => {
  console.log('=== web/ 自检 ===');
  checkTemplates();
  checkClasses();
  checkAppRefs();
  checkLogParser();
  checkModelRouter();
  try { await checkApi(); } catch (e) { no('接口自检异常: ' + e.message); }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
