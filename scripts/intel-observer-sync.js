#!/usr/bin/env node
/**
 * intel-observer-sync.js — 观察员信息 → 共享数据库 同步器（intel-gatherer 核心链路扩展）
 *
 * 背景（2026-08-12 observer-intel-db）：聊天室各频道观察员（微博/抖音/B站等 16 个
 * topic agent）实时收集的情报/讨论/发现存于 HK new-api DB `chat_room_messages`
 * （原始讨论）+ `chat_room_topic_memories`（频道记忆）+ `chat_room_common_knowledges`
 * （跨频道公共知识）。此前 intel-collect 只把后两表整理成文档型 channel-intelligence.md，
 * **chat_room_messages 原始讨论从未入库**——本脚本补上结构化入库链路：
 *
 *   HK new-api DB 3 表增量 → org/knowledge/observer-intel/entries/<date>.jsonl
 *                             （结构化条目，所有智能体可查）
 *                           + org/knowledge/observer-intel/index.json（游标/统计）
 *                           + 摘要追加 org/knowledge/channel-intelligence.md（文档型，保持既有档案）
 *
 * 增量游标：index.json 中 cursor（= chat_room_messages.created_time 最大已入库值）
 * 幂等：增量拉取，游标推进，重复运行不产生重复条目。
 *
 * 用法：
 *   node scripts/intel-observer-sync.js            # 同步（默认）
 *   node scripts/intel-observer-sync.js --dry-run  # 只打印将入库的条数，不写文件
 *   node scripts/intel-observer-sync.js --quiet    # 仅错误时输出（供定时调度）
 *
 * 依赖：ssh/scp 直连 HK（key ~/.ssh/id_ed25519_xxsx_hk，主机 103.100.159.111:43891），
 * HK 侧需 sqlite3 CLI（new-api DB）。
 */
'use strict';
const { execFile } = require('../lib/win-spawn');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORG_ROOT   = path.resolve(__dirname, '..');
const LIB_DIR    = path.join(ORG_ROOT, 'knowledge', 'observer-intel');
const ENTRIES    = path.join(LIB_DIR, 'entries');
const INDEX_FILE = path.join(LIB_DIR, 'index.json');
const DOC_FILE   = path.join(ORG_ROOT, 'knowledge', 'channel-intelligence.md');
const LOG_FILE   = path.join(ORG_ROOT, 'logs', 'intel-observer-sync.log');

const HK_HOST = process.env.HK_HOST || '103.100.159.111';
const HK_PORT = process.env.HK_PORT || '43891';
const HK_USER = 'root';
const HK_KEY  = path.join(os.homedir(), '.ssh', 'id_ed25519_xxsx_hk');
const HK_DB   = '/data/xxsx-api/new-api-data/xxsx-new-api.db';

const SSH_BASE = ['-p', HK_PORT, '-i', HK_KEY, '-o', 'BatchMode=yes',
                  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
                  '-o', 'StrictHostKeyChecking=accept-new'];
const SSH_DEST = `${HK_USER}@${HK_HOST}`;

const ARGS = { dryRun: process.argv.includes('--dry-run'), quiet: process.argv.includes('--quiet') };

/* ── 工具 ─────────────────────────────────────────────── */
function log(...a) {
  if (ARGS.quiet && !a[0].startsWith('❌')) return;
  const line = `[${new Date().toLocaleTimeString()}] [observer-sync] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}

function ssh(cmd, timeoutMs) {
  return new Promise(resolve => {
    execFile('ssh', [...SSH_BASE, SSH_DEST, cmd], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs || 120000 },
      (err, stdout, stderr) => {
        const cleanErr = String(stderr || '').split('\n')
          .filter(l => !l.includes('post-quantum') && !l.includes('store now') && !l.includes('upgraded'))
          .join('\n').trim();
        resolve({ ok: !err || !!cleanErr, code: err ? err.code : 0, out: (stdout || '').trim(), err: cleanErr });
      });
  });
}

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

function loadIndex() {
  const raw = readIf(INDEX_FILE);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }
  // 初始游标对齐 channel-intelligence.md 既有游标（2026-08-12 15:41），只拉真正增量
  return { cursor: 1786519805, updatedAt: null, stats: { messages: 0, memories: 0, knowledges: 0 } };
}

function saveIndex(idx) {
  idx.updatedAt = new Date().toISOString();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8');
}

function appendEntries(rows) {
  if (!rows.length) return;
  fs.mkdirSync(ENTRIES, { recursive: true });
  // 按消息日期分文件（created_time 转本地日期）
  const byDate = {};
  for (const r of rows) {
    const ts = r.created_time || r.updated_at;
    if (!ts) continue;
    const d = new Date(ts * 1000).toISOString().slice(0, 10);
    (byDate[d] = byDate[d] || []).push(r);
  }
  for (const [date, list] of Object.entries(byDate)) {
    const file = path.join(ENTRIES, `${date}.jsonl`);
    const lines = list.map(r => JSON.stringify(r));
    fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
  }
}

/* ── 主流程 ───────────────────────────────────────────── */
async function main() {
  const idx = loadIndex();
  const cursor = idx.cursor || 0;
  log(`游标=${cursor} 模式=${ARGS.dryRun ? 'DRY-RUN' : 'SYNC'}`);

  // 0) HK 可达性
  const ping = await ssh(`echo __HK_OK__ && test -f ${HK_DB} && echo __DB_OK__`);
  if (!ping.out.includes('__HK_OK__') || !ping.out.includes('__DB_OK__')) {
    log(`❌ HK/DB 不可达: ${ping.err || ping.out || 'ssh 失败'}`);
    process.exit(1);
  }

  // 1) 拉 chat_room_messages 增量（观察员原始讨论，本脚本核心新增）
  //    用 sqlite3 -json 输出（content 含换行/引号，JSON 序列化最稳，避免制表符拆行错位）
  const msgSql = `SELECT id, room_group, username, author_type, model_name, content, created_time, source_type, reply_to_id FROM chat_room_messages WHERE created_time > ${cursor} ORDER BY id;`;
  const msgQ = `sqlite3 -json ${HK_DB} "${msgSql.replace(/"/g, '\\"')}"`;
  const msgs = await ssh(msgQ, 180000);
  if (!msgs.ok) { log(`❌ 拉 messages 失败: ${msgs.err.slice(0, 200)}`); process.exit(1); }

  let msgRows = [];
  if (msgs.out.trim()) { try { msgRows = JSON.parse(msgs.out); } catch (e) { log(`❌ messages JSON 解析失败: ${e.message.slice(0, 120)}`); process.exit(1); } }

  // 2) 拉 topic_memories 增量
  const memSql = `SELECT source, channel_key, memory_json, updated_at FROM chat_room_topic_memories WHERE updated_at > ${cursor};`;
  const memQ = `sqlite3 -json ${HK_DB} "${memSql.replace(/"/g, '\\"')}"`;
  const mems = await ssh(memQ, 60000);
  let memRows = [];
  if (mems.ok && mems.out.trim()) { try { memRows = JSON.parse(mems.out); } catch (e) { log(`⚠️ memories JSON 解析失败: ${e.message.slice(0, 80)}`); } }
  memRows = memRows.map(r => ({ ...r, kind: 'memory' }));

  // 3) 拉 common_knowledges 增量
  const knoSql = `SELECT id, topic, channels, consensus, disagreements, open_questions, status, updated_at FROM chat_room_common_knowledges WHERE updated_at > ${cursor};`;
  const knoQ = `sqlite3 -json ${HK_DB} "${knoSql.replace(/"/g, '\\"')}"`;
  const knos = await ssh(knoQ, 60000);
  let knoRows = [];
  if (knos.ok && knos.out.trim()) { try { knoRows = JSON.parse(knos.out); } catch (e) { log(`⚠️ knowledges JSON 解析失败: ${e.message.slice(0, 80)}`); } }
  knoRows = knoRows.map(r => ({ ...r, kind: 'knowledge' }));

  const total = msgRows.length + memRows.length + knoRows.length;
  log(`增量: messages=${msgRows.length} memories=${memRows.length} knowledges=${knoRows.length} 合计=${total}`);
  if (total === 0) { log('ℹ️ 无新增，结束'); return 0; }
  if (ARGS.dryRun) { log('ℹ️ DRY-RUN，不写文件'); return 0; }

  // 4) 入库（JSONL 按日）
  appendEntries(msgRows);
  appendEntries(memRows);
  appendEntries(knoRows);

  // 5) 推进游标 = 本次最大 created_time / updated_at
  const allTs = [...msgRows, ...memRows, ...knoRows].map(r => r.created_time || r.updated_at).filter(Boolean);
  const newCursor = Math.max(cursor, ...allTs);
  idx.cursor = newCursor;
  idx.stats.messages += msgRows.length;
  idx.stats.memories += memRows.length;
  idx.stats.knowledges += knoRows.length;
  saveIndex(idx);
  log(`✅ 已入库 ${total} 条 → knowledge/observer-intel/，游标 ${cursor} → ${newCursor}`);

  // 6) 摘要追加 channel-intelligence.md（文档型档案保持更新，头部插入一行）
  if (fs.existsSync(DOC_FILE)) {
    const doc = fs.readFileSync(DOC_FILE, 'utf8');
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const summary = `- **${ts}（observer-intel-sync 自动入库）**：HK 3 表增量已结构化入库 ${total} 条（messages ${msgRows.length} / memories ${memRows.length} / knowledges ${knoRows.length}），游标 ${cursor}→${newCursor}，见 \`knowledge/observer-intel/\`。核心动态：${summarize(msgRows)}。\n`;
    const marker = '## 最新收集（滚动记录）';
    if (doc.includes(marker)) {
      fs.writeFileSync(DOC_FILE, doc.replace(marker, marker + '\n' + summary), 'utf8');
    }
  }
  log('📄 channel-intelligence.md 已追加摘要');
  return 0;
}

function summarize(msgRows) {
  if (!msgRows.length) return '无新讨论';
  // 取观察员角色最多的几个频道的消息摘要（前 60 字）
  const rooms = {};
  for (const r of msgRows) { rooms[r.room_group] = (rooms[r.room_group] || 0) + 1; }
  const top = Object.entries(rooms).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => k.replace('topic:', '') + '×' + v).join('、');
  const first = (msgRows.find(r => r.content && r.content.length > 20) || {}).content || '';
  return `${top}；如「${first.slice(0, 60)}…」`;
}

main().then(c => process.exit(c)).catch(e => {
  console.error('intel-observer-sync.js 异常:', e);
  try { fs.appendFileSync(LOG_FILE, '[fatal] ' + e.message + '\n', 'utf8'); } catch (_) {}
  process.exit(1);
});
