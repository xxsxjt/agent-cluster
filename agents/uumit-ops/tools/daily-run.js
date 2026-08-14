/**
 * daily-run.js — UUMit 持续运营脚本（每日定时任务调用）
 *
 * 做一轮轻量持续运营并输出摘要：
 *   1. 接入检查（wallet 探活）
 *   2. 任务市场扫描（tasks/hall）→ 输出可接候选（按能力域 + 赏金 + 竞争度评分）
 *   3. 我的申请/订单状态检查
 *   4. 已上架技能状态
 *
 * 用法：
 *   node tools/daily-run.js scan     # 扫描任务市场，输出候选（推荐）
 *   node tools/daily-run.js status   # 平台状态总览（钱包/申请/技能/订单）
 *
 * 输出：stdout JSON（供智能体解析）
 */
'use strict';
const https = require('https');
const path = require('path');

const MEM = path.join(__dirname, '..', 'memory');

function loadAuth() {
  // REST 接口需主 key（MCP key 对 REST 返回 code 1006）
  for (const f of ['uumit-auth.json', 'uumit-mcp-auth.json']) {
    try {
      const j = require(path.join(MEM, f));
      if (j.api_key && j.platform_user_id) return j;
    } catch (e) {}
  }
  throw new Error('no auth');
}

const auth = loadAuth();
const HOST = 'api.uumit.com';

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: HOST, path: p, method, headers: {
      'X-Api-Key': auth.api_key,
      'X-Platform-User-Id': auth.platform_user_id,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }}, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, raw: d.slice(0, 500) }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(25000, () => r.destroy(new Error('timeout')));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// 我们的能力域（关键词匹配任务标题/描述）
const CAP_DOMAINS = {
  '技术开发': ['函数', '代码', '开发', '脚本', '接口', 'API', 'SQL', '编程', '程序', '小程序', '自动化'],
  '数据处理': ['数据', '图表', '清洗', '分析', '统计', '表格', '速查'],
  'AI与自动化': ['AI', '自动化', '需求', '拆解', '提示词', '智能体', 'Agent'],
  '文案写作': ['写', '文案', '文章', '标题', '内容', '种草', '小说'],
  '翻译服务': ['翻译', '英文', '双语'],
  '咨询顾问': ['方案', '建议', '思路', '规划', '调研'],
};

// 我们明确不接的分类（能力外/无法保证质量）
const EXCLUDE_CATS = ['动漫绘画', '视频制作', '音频制作', '摄影摄像', '装修维修', '医疗健康', '教育培训'];

/** 扫描任务市场，输出可接候选 */
async function scanTasks() {
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const r = await req('GET', `/api/v1/tasks/hall?page_size=30&page=${page}`);
    if (r.json && r.json.code === 0 && r.json.data) all.push(...r.json.data.items);
    else break;
    if (r.json && r.json.data && all.length >= (r.json.data.total || 0)) break;
  }
  const open = all.filter(t => t.status === 'open' && !EXCLUDE_CATS.includes(t.category));
  const candidates = open
    .map(t => {
      const text = (t.title || '') + (t.description || '');
      let domain = null;
      for (const [d, kws] of Object.entries(CAP_DOMAINS)) {
        if (kws.some(k => text.includes(k))) { domain = d; break; }
      }
      // 竞争度评分：申请数越低越好；无申请记录按 0
      const apps = Number(t.application_count) || 0;
      const bounty = Number(t.bounty_amount) || 0;
      const score = domain ? (bounty > 0 ? Math.min(10, Math.round((bounty / 100) * (apps <= 5 ? 2 : apps <= 20 ? 1.2 : 0.7))) : 3) : 0;
      return { id: t.id, title: t.title, category: t.category, bounty: t.bounty_amount,
               apps, delivery_hours: t.delivery_hours, domain, score, my_app: t.my_application_status };
    })
    .filter(c => c.domain)
    .sort((a, b) => b.score - a.score);
  return { total: all.length, open: open.length, candidates: candidates.slice(0, 15) };
}

/** 平台状态总览 */
async function status() {
  const w = await req('GET', '/api/v1/wallet');
  const apps = await req('GET', '/api/v1/tasks/applications/mine');
  const skills = await req('GET', '/api/v1/skills');
  const orders = await req('GET', '/api/v1/orders');
  return {
    wallet: w.json && w.json.data ? w.json.data : null,
    applications: apps.json && apps.json.data ? apps.json.data.items : [],
    skills: skills.json && skills.json.data ? skills.json.data.items : [],
    orders: orders.json && orders.json.data ? (orders.json.data.items || []) : [],
  };
}

(async () => {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'scan') {
    const s = await scanTasks();
    console.log(JSON.stringify(s, null, 1));
  } else {
    const st = await status();
    console.log(JSON.stringify({
      wallet_ut: st.wallet && st.wallet.ut ? st.wallet.ut.balance : null,
      pending_apps: st.applications.filter(a => a.status === 'pending').map(a => ({ task: a.task_title, status: a.status })),
      skills: st.skills.map(s => ({ id: s.id, name: s.name, price: s.ut_price, audit: s.audit_status })),
      orders: st.orders.map(o => ({ id: o.id, status: o.status })).slice(0, 5),
    }, null, 1));
  }
})().catch(e => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
