#!/usr/bin/env node
/**
 * recall.js — 回忆官检索核心（learning-officer，2026-08-11）
 *
 * 多库检索工具：被动回忆（用户问"上次那个XXX"）+ 主动回忆素材（每日/每周回顾）。
 * 设计要点：
 *  - 多库：knowledge/*（meetings/reviews/corrections/artifacts）+ work_record.md
 *          + chat-signals.jsonl + pi 会话（~/.pi/agent/sessions/ 最新相关）+ user-profile
 *  - 限量检索（铁律）：grep 定位命中文件 → 每文件只取命中行片段（head/context），
 *    绝不 cat 全文 / 全盘 find。会话文件巨大必须 grep -l 先定位再取片段。
 *  - 输出结构化：事件/时间/来源引用/关联（可 JSON 或 markdown）。
 *
 * 用法：
 *   node recall.js search --q "terraria" [--days 7] [--max 20] [--json]
 *   node recall.js search --q "cnb" "回收" --days 30 --source sessions  # 多关键词任一命中
 *   node recall.js reflect --date 2026-08-11        # 每日轻回顾（读当天素材 → 提炼）
 *   node recall.js week --date 2026-08-11           # 每周深回顾（拉 7-14 天前关键决策）
 *   node recall.js argue --topic "8/9 的 xx 决策" --days 30 --json  # 多角色论证素材
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ORG_ROOT = path.join(HOME, 'pi_workspace', 'org');
const HUB = path.join(HOME, 'pi_workspace', 'hub');
const EVO_PENDING = path.join(HOME, 'pi_workspace', 'evolution-drafts', 'pending');
const SESSION_ROOT = path.join(HOME, '.pi', 'agent', 'sessions');

/* ── 数据源定义 ───────────────────────────────────── */
const SOURCES = {
  knowledge: {
    label: '知识库 knowledge/',
    dirs: () => [path.join(ORG_ROOT, 'knowledge')],
    ext: ['md'],
    note: 'meetings/reviews/corrections/assets/conventions/pitfalls/changelog'
  },
  work: {
    label: '工作记录 work_record.md',
    files: () => [path.join(HOME, 'Desktop', 'work_record.md')],
    ext: ['md'],
    note: '机器状态+历史操作流水'
  },
  chat: {
    label: '对话信号 chat-signals',
    files: () => [path.join(HUB, 'chat-signals.jsonl')],
    ext: ['jsonl'],
    note: 'correction/preference/decision-pattern 信号'
  },
  sessions: {
    label: 'pi 会话记录',
    dirs: () => sessionDirs(),
    ext: ['jsonl'],
    note: '主会话 jsonl（cwd 目录）限量 grep'
  },
  profile: {
    label: '用户档案 user-profile',
    dirs: () => [path.join(HOME, '.agents', 'skills', 'user-profile', 'references')],
    ext: ['md'],
    note: '用户身份/项目/渠道/资源画像'
  }
};

/* 列出 pi 会话目录（主会话在 --C--Users-du_ji--，还有 org/hub 等） */
function sessionDirs() {
  if (!fs.existsSync(SESSION_ROOT)) return [];
  try { return fs.readdirSync(SESSION_ROOT).map(d => path.join(SESSION_ROOT, d)); }
  catch (e) { return []; }
}

/* ── 工具函数 ─────────────────────────────────────── */
function log(...a) { console.log(...a); }

/** grep 单个文件，限量返回匹配片段 */
function grepFile(file, keywords, maxLines, context) {
  const kw = Array.isArray(keywords) ? keywords : [keywords];
  // 多关键词任一命中：构造 grep -E
  const pattern = kw.map(k => escapeRegExp(k)).join('|');
  const ctx = context || 0;
  // 用 -n -i -E 输出整行（带行号），node 端限量截断，避免 -o 只给匹配词缺上下文
  const args = ['-n', '-i', '-E', pattern, '--', file];
  const r = spawnSync('grep', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const lines = r.stdout.split('\n').filter(Boolean);
  return lines.slice(0, maxLines).map(l => {
    const m = l.match(/^(\d+):(.*)$/);
    let text = m ? m[2] : l;
    // 超长行（如 jsonl 会话）截断到 220 字符，保留前后
    if (text.length > 220) text = text.slice(0, 220);
    return { line: m ? +m[1] : null, text };
  });
}

/** 递归收集目录下文件（限量，防止全盘 find 爆炸） */
function collectFiles(dir, ext, depth, max) {
  const out = [];
  const stack = [[dir, 0]];
  while (stack.length && out.length < max) {
    const [d, dep] = stack.pop();
    if (dep > (depth || 4)) continue;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (out.length >= max) break;
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push([full, dep + 1]);
      else if (e.isFile() && ext.includes(path.extname(e.name).slice(1))) out.push(full);
    }
  }
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

/* ── 主检索逻辑 ───────────────────────────────────── */
function search(opts) {
  const { keywords, days, max, sources, json } = opts;
  const kw = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).map(String);
  if (!kw.length) { log('错误: 缺少 --q 关键词'); process.exit(1); }
  const maxPer = max || 20;
  const daysN = days || 3650;
  const cutoff = Date.now() - daysN * 24 * 3600 * 1000;
  const want = (sources || 'all').split(',').map(s => s.trim());
  const results = []; // {source, file, line, text}

  const checkSource = (name, files) => {
    if (!want.includes('all') && !want.includes(name)) return;
    const label = SOURCES[name] ? SOURCES[name].label : name;
    let n = 0;
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      // 时间过滤：按文件 mtime
      try { if (fs.statSync(f).mtimeMs < cutoff) continue; } catch (e) {}
      const hits = grepFile(f, kw, maxPer, 0);
      for (const h of hits) {
        if (n >= maxPer) break;
        results.push({ source: label, file: f, line: h.line, text: h.text });
        n++;
      }
      if (n >= maxPer) break;
    }
  };

  // knowledge / sessions / profile 走目录收集
  if (want.includes('all') || want.includes('knowledge')) {
    const files = collectFiles(SOURCES.knowledge.dirs()[0], SOURCES.knowledge.ext, 5, 200);
    checkSource('knowledge', files);
  }
  if (want.includes('all') || want.includes('sessions')) {
    // 会话文件巨大：按目录内最新文件 mtime 选活跃目录（优先主会话 cwd），每目录只取最新若干 jsonl
    const dirs = SOURCES.sessions.dirs()
      .map(d => {
        let latest = 0;
        try { const f = fs.readdirSync(d).filter(x => x.endsWith('.jsonl')).map(x => fs.statSync(path.join(d, x)).mtimeMs).sort((a, b) => b - a);
          latest = f[0] || 0; } catch (e) {}
        return { d, latest };
      })
      .filter(x => x.latest)
      .sort((a, b) => b.latest - a.latest)
      .slice(0, 3)
      .map(x => x.d);
    let sess = [];
    for (const d of dirs) {
      const files = collectFiles(d, ['jsonl'], 1, 40)
        .sort((a, b) => b.localeCompare(a)).slice(0, 15); // 每目录最新 15 个
      sess = sess.concat(files);
    }
    checkSource('sessions', sess);
  }
  if (want.includes('all') || want.includes('profile')) {
    const files = collectFiles(SOURCES.profile.dirs()[0], SOURCES.profile.ext, 3, 50);
    checkSource('profile', files);
  }
  if (want.includes('all') || want.includes('work')) {
    checkSource('work', SOURCES.work.files());
  }
  if (want.includes('all') || want.includes('chat')) {
    checkSource('chat', SOURCES.chat.files());
  }

  // 去重（同文件同行）
  const seen = new Set();
  const uniq = results.filter(r => {
    const k = r.file + ':' + r.line;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  if (json) {
    log(JSON.stringify(uniq, null, 2));
    return;
  }
  if (!uniq.length) {
    log(`未检索到与 [${kw.join(' ')}] 相关的内容（近 ${daysN} 天，${maxPer} 条上限）`);
    return;
  }
  log(`=== 回忆检索: [${kw.join(' ')}]  命中 ${uniq.length} 条（近 ${daysN} 天，上限 ${maxPer}） ===`);
  uniq.forEach((r, i) => {
    log(`\n[${i + 1}] (${r.source})`);
    log(`  来源: ${shorten(r.file, 90)}`);
    log(`  行号: ${r.line ?? '-'}`);
    log(`  内容: ${r.text}`);
  });
  log(`\n=== 完 ===`);
}

function shorten(s, n) {
  return s.length > n ? '...' + s.slice(-n) : s;
}

/* ── 每日轻回顾 ───────────────────────────────────── */
/**
 * 读当天素材（chat-signals + work_record 当天段 + knowledge 当天 meetings + 会话）
 * → 提炼 1-3 条"当时没注意/现在值得记" → 写 memory/reflections/<date>.md
 * 只提炼"收获"不流水账。素材限量读取。
 */
function reflect(opts) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const reflectDir = path.join(__dirname, '..', 'memory', 'reflections');
  fs.mkdirSync(reflectDir, { recursive: true });
  const outFile = path.join(reflectDir, `${date}.md`);
  const md = [];
  md.push(`# 每日轻回顾：${date}`);
  md.push(`> 由 recall-officer 主动回忆生成（learning-officer）。原则：像人翻旧日记重新收获——新视角/遗漏/关联/改进启发，非流水账。`);
  md.push(``);

  // 1. 当天 chat-signals
  const chat = readSafe(path.join(HUB, 'chat-signals.jsonl'));
  const dayChat = chat.split('\n').filter(l => l.includes(date));
  md.push(`## 一、当天对话信号（chat-signals）`);
  if (!dayChat.length) md.push(`- （当天无新增 chat-signals 信号）`);
  else dayChat.slice(0, 10).forEach(l => {
    try {
      const o = JSON.parse(l);
      md.push(`- **${o.type}** (${o.ts})：${(o.content || '').slice(0, 120)}`);
    } catch (e) {}
  });

  // 2. 当天 knowledge meetings（重读 1 篇，联想）
  const mtgDir = path.join(ORG_ROOT, 'knowledge', 'meetings');
  const dayMtg = fs.existsSync(mtgDir) ? fs.readdirSync(mtgDir).filter(f => f.startsWith(date)) : [];
  md.push(``);
  md.push(`## 二、当天知识沉淀（meetings）`);
  if (!dayMtg.length) md.push(`- （当天无新 meeting 沉淀）`);
  else dayMtg.slice(0, 8).forEach(f => md.push(`- ${f.replace(/\.md$/, '')}`));

  // 3. 当天 inbox DONE 任务
  const inboxDir = path.join(ORG_ROOT, 'inbox');
  const dayDone = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter(f => {
    if (!/^\.DONE$/.test(f) && !f.endsWith('.DONE')) return false; // 只认 .DONE 文件
    try { return new Date(fs.statSync(path.join(inboxDir, f)).mtime).toISOString().slice(0, 10) === date; }
    catch (e) { return false; }
  }) : [];
  md.push(``);
  md.push(`## 三、当天完成任务（inbox .DONE）`);
  if (!dayDone.length) md.push(`- （当天无新任务完成标记）`);
  else dayDone.slice(0, 15).forEach(f => {
    const txt = (readSafe(path.join(inboxDir, f)) || '').trim().slice(0, 100);
    md.push(`- ${f.replace(/\.DONE$/, '')}：${txt}`);
  });

  // 4. 重读 1-2 天前某篇会议，做"重新收获"
  md.push(``);
  md.push(`## 四、重新收获（对近 1-2 天决策/事件的复读）`);
  md.push(`- _（此处由执行智能体基于上面素材提炼 1-3 条"当时没注意/现在值得记"的收获）_`);

  md.push(``);
  md.push(`---
  > 检索说明：本回顾素材限量抓取（chat-signals 当天 + meetings 当天 + inbox 当天），未全量读，防上下文爆炸。`);
  fs.writeFileSync(outFile, md.join('\n'), 'utf8');
  log(`每日轻回顾草稿已生成: ${outFile}`);
  return outFile;
}

/* ── 每周深回顾 ───────────────────────────────────── */
/**
 * 拉 7-14 天前关键决策/失败/对话（recall.js 检索）→ 产出"重新收获"草稿 → 进化草稿
 */
function week(opts) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const evoDir = path.join(HOME, 'pi_workspace', 'evolution-drafts', 'pending');
  fs.mkdirSync(evoDir, { recursive: true });
  const outFile = path.join(evoDir, `week-recall-${date}.md`);
  const md = [];
  md.push(`# 每周深回顾：${date}`);
  md.push(`> 由 recall-officer 主动回忆生成。重读 1-2 周前关键决策/失败/对话 → 重新收获（新视角/遗漏/关联/改进启发）→ 走进化流程。`);
  md.push(``);
  md.push(`## 待重读主题（建议）`);
  md.push(`- _（执行时用 recall.js search --q <关键词> --days 14 拉 7-14 天前的关键决策/失败）_`);
  md.push(`- _主题候选：重大成功任务、用户纠正、踩坑、渠道变动、组织重构_`);
  md.push(``);
  md.push(`## 重新收获（由执行智能体填写）`);
  md.push(`- `);
  md.push(`---`);
  md.push(`> 本文件位于 evolution-drafts/pending/，按进化流程审批后落地。`);
  fs.writeFileSync(outFile, md.join('\n'), 'utf8');
  log(`每周深回顾草稿已生成（进化草稿待填）: ${outFile}`);
  return outFile;
}

/* ── 多角色论证素材 ───────────────────────────────── */
/**
 * 主动回忆时召集群分身（精神分裂式多角色）：为每个角色拉相关记忆，生成工作单。
 * 角色：执行者 / 现在的我 / 用户视角 / 批评者 / 关联者
 * 每个角色独立用 recall.js 检索各自相关记忆 → 各写各的回忆陈述 → 交叉论证。
 */
function argue(opts) {
  const topic = opts.topic || '未指定主题';
  const days = opts.days || 30;
  const max = opts.max || 12;
  const outDir = path.join(__dirname, '..', 'memory', 'argue');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `argue-${Date.now()}.md`);
  // 主题拆关键词（去语气词/标点，留实体词）供检索
  const kws = topic.split(/[\s的与及了：:，,。.\/\\-]+/).filter(w => w && w.length >= 2);
  const md = [];
  md.push(`# 多角色论证回忆工作单`);
  md.push(`> 主题：${topic}`);
  md.push(`> 关键词：${kws.join(' | ')}`);
  md.push(`> 生成：${new Date().toISOString()}`);
  md.push(`> 机制：精神分裂式多角色——各自独立回顾同一主题，交叉验证，发现矛盾标"存疑"（不强行统一）。复用服务器聊天室多频道论证模式。`);
  md.push(``);
  md.push(`## 检索建议（每个角色独立用 recall.js 拉各自相关记忆）`);
  const roles = [
    { key: 'executor', name: '当时的执行者', prompt: '当时怎么想/为什么那么做', q: kws.join(' ') },
    { key: 'now', name: '现在的我', prompt: '新视角/后来学到什么', q: kws.join(' ') },
    { key: 'user', name: '用户视角', prompt: '用户会怎么评价/他当时的意图', q: kws.join(' ') },
    { key: 'critic', name: '批评者', prompt: '找当时决策的漏洞/更好的做法', q: kws.join(' ') },
    { key: 'linker', name: '关联者', prompt: '这件事和别的什么事有关联/后续线索', q: kws.join(' ') },
  ];
  md.push(``);
  md.push(`| 角色 | 视角 | 检索建议 |`);
  md.push(`|---|---|---|`);
  roles.forEach(r => md.push(`| **${r.name}** | ${r.prompt} | \`node recall.js search --q ${kws.map(k => `"${k}"`).join(' ')} --days ${days} --max ${max}\` |`));
  md.push(``);
  md.push(`## 各角色回忆陈述（由执行智能体分别填写）`);
  roles.forEach(r => {
    md.push(`### ${r.name}`);
    md.push(`- **回忆陈述**：_（独立检索后填写）_`);
    md.push(`- **依据来源**：_（recall.js 命中条目，列出 file:行号）_`);
    md.push(``);
  });
  md.push(`## 交叉论证`);
  md.push(`- **A 的回忆 B 补充/纠错**：_（角色间交叉验证）_`);
  md.push(`- **矛盾与存疑标记**：_（发现矛盾标"存疑"，不强行统一）_`);
  md.push(``);
  md.push(`## 综合产出（共识/分歧/新收获）`);
  md.push(`- **共识**：`);
  md.push(`- **分歧**：`);
  md.push(`- **新收获**：`);
  md.push(`- **去向**：进 memory/reflections + 进化草稿`);
  fs.writeFileSync(outFile, md.join('\n'), 'utf8');
  log(`多角色论证工作单已生成: ${outFile}`);
  // 顺带跑一次主题检索做示例
  log(`\n--- 主题示例检索（${topic}，近 ${days} 天，${max} 条） ---`);
  search({ keywords: kws, days, max, sources: 'all', json: false });
  return outFile;
}

/* ── CLI ─────────────────────────────────────────── */
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const getOpt = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? (args[i + 1] || def) : def;
  };
  const hasFlag = flag => args.includes(flag);

  if (cmd === 'search') {
    // 收集所有 --q 后到下一个 flag 之间的词
    const qIdx = args.indexOf('--q');
    const keywords = [];
    if (qIdx >= 0) {
      for (let i = qIdx + 1; i < args.length; i++) {
        if (args[i].startsWith('--')) break;
        keywords.push(args[i]);
      }
    }
    search({
      keywords,
      days: +getOpt('--days', 3650),
      max: +getOpt('--max', 20),
      sources: getOpt('--sources', 'all'),
      json: hasFlag('--json')
    });
  } else if (cmd === 'reflect') {
    reflect({ date: getOpt('--date', new Date().toISOString().slice(0, 10)) });
  } else if (cmd === 'week') {
    week({ date: getOpt('--date', new Date().toISOString().slice(0, 10)) });
  } else if (cmd === 'argue') {
    argue({ topic: getOpt('--topic', ''), days: +getOpt('--days', 30), max: +getOpt('--max', 12) });
  } else {
    log(`用法:
  node recall.js search --q 关键词 [关键词2...] [--days N] [--max N] [--sources all|knowledge,work,chat,sessions,profile] [--json]
  node recall.js reflect [--date YYYY-MM-DD]        # 每日轻回顾 → memory/reflections/<date>.md
  node recall.js week [--date YYYY-MM-DD]           # 每周深回顾 → evolution-drafts/pending/
  node recall.js argue --topic "主题" [--days N] [--max N]  # 多角色论证工作单`);
  }
}

main();
