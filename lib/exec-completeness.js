/**
 * lib/exec-completeness.js — 执行完整性审计（2026-08-12 用户+魇. 共识落地）
 * ---------------------------------------------------------------------------
 * 背景：AI 通病「只追目标不看过程」——连不上就换下一个、问题不记录不沉淀、用户纠正不落地。
 * conventions 第 11 条（执行完整性规范）已有，本模块把它变成机制强制（不靠自觉）：
 *
 * 审计对象：inbox/ 下已完成的 .DONE 标记 + 对应任务文件 .md
 * 判定规则：
 *   任务内容含「异常特征词」（连不上/失败/超时/报错/绕行/error/refused…）
 *   → 若 DONE 无「过程记录特征」（过程异常/修复/绕行/沉淀/问用户…）= 违规（静默绕过）
 *     → 记 logs/exec-completeness-violations.jsonl + 控制台告警
 *   → 若 DONE 有过程记录 = 合规 → 自动捕获为沉淀候选（knowledge/pitfalls-inbox.md，
 *     待 learning-officer 审核合并进 pitfalls.md）
 * 幂等：cursor 记录已审计文件名+mtimeMs（同 cleanupMisjudged 机制），不重复处理。
 * 安全：.FAILED 跳过（失败原因本身就是异常记录）；任务文件已归档的跳过（无法对照）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** 任务内容中的异常特征词（命中 = 该任务大概率经历过异常/失败/绕行） */
const ANOMALY_PATTERNS = [
  /连不上|连接失败|连接超时|连接被拒|无法连接|拒绝连接/,
  /失败|超时|报错|出错|异常|崩溃|不可用|打不开|无法|拒绝|断连|中断/,
  /error|refused|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timeout|5\d\d|404|429/gi,
  /绕行|绕道|绕过|降级|fallback|failover|换一个|换方案|备用通道|重试后/gi,
];

/** DONE 中的过程记录特征（命中 = 该任务记录了过程异常与处理，非静默绕过） */
const RECORD_PATTERNS = [
  /过程异常/,
  /修复|已修|修了|修不了|修不好|未修|已解决|解决掉|处理掉/,
  /绕行|绕道|绕过|降级|备用|fallback|failover/gi,
  /沉淀|踩坑|pitfall/gi,
  /问用户|需用户|待用户|待确认|升级|上报/,
];

/** 沉淀候选捕获特征（严格：DONE 明确写了过程异常/沉淀才算，避免“修复 bug”类任务误捕） */
const CAPTURE_PATTERNS = [
  /过程异常/, /沉淀|踩坑|pitfall|值得记/gi,
];

/** 单个任务审计：返回 { anomaly, recorded, violation, hitWords } */
function audit(name, taskContent, doneContent) {
  const task = String(taskContent || '');
  const done = String(doneContent || '');
  const anomaly = ANOMALY_PATTERNS.some(re => re.test(task));
  const recorded = RECORD_PATTERNS.some(re => re.test(done));
  return { anomaly, recorded, violation: anomaly && !recorded };
}

/** 提取任务内容里命中的异常特征词（供告警/沉淀描述用，最多 3 个） */
function hitWords(taskContent) {
  const out = [];
  for (const re of ANOMALY_PATTERNS) {
    const m = String(taskContent || '').match(re);
    if (m) { const w = String(m[0] || '').trim(); if (w && !out.includes(w)) out.push(w); }
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 扫描并审计 inbox 中新增完成的标记。
 * @param {string} inboxDir inbox 目录
 * @param {string} logsDir logs 目录
 * @param {string} knowledgeDir knowledge 目录
 * @returns {{violations:number, pitfallCandidates:number, audited:number}}
 */
function scanAndAudit(inboxDir, logsDir, knowledgeDir) {
  const CURSOR_FILE = path.join(logsDir, 'exec-completeness-cursor.json');
  const VIOLATIONS_FILE = path.join(logsDir, 'exec-completeness-violations.jsonl');
  const PITFALL_INBOX = path.join(knowledgeDir, 'pitfalls-inbox.md');

  const cursor = readJson(CURSOR_FILE) || {};
  let files = [];
  try { files = fs.readdirSync(inboxDir); } catch (e) { return { violations: 0, pitfallCandidates: 0, audited: 0 }; }

  const statOf = p => { try { return fs.statSync(p); } catch (e) { return null; } };
  const append = (p, s) => { try { fs.appendFileSync(p, s, 'utf8'); } catch (e) {} };

  let violations = 0;
  let pitfallCandidates = 0;
  let audited = 0;
  let cursorDirty = false;

  for (const f of files) {
    if (!/\.DONE$/.test(f)) continue;            // 只审 .DONE（.FAILED 自身即失败记录）
    const name = f.slice(0, -'.DONE'.length);
    const donePath = path.join(inboxDir, f);
    const mdPath = path.join(inboxDir, name + '.md');
    const doneStat = statOf(donePath);
    if (!doneStat) continue;

    // 幂等游标：已审计且文件未变化 → 跳过
    if (cursor[f] === doneStat.mtimeMs) continue;

    // 任务文件已被归档/不存在 → 无法对照，跳过（保持游标更新防止反复扫）
    const taskContent = readIf(mdPath);
    const doneContent = readIf(donePath);
    const r = audit(name, taskContent, doneContent);
    cursor[f] = doneStat.mtimeMs;
    cursorDirty = true;

    if (!taskContent) continue;                  // 无任务文件对照，不判定
    if (!r.anomaly) continue;                    // 任务内容无异常特征 → 不打扰

    audited++;
    if (r.violation) {
      // 违规：任务内容有明显异常特征（连不上/失败/绕行…）但 DONE 无过程记录
      violations++;
      const rec = JSON.stringify({
        ts: tsISO(), name, hitWords: hitWords(taskContent),
        doneSnippet: String(doneContent).trim().slice(0, 200),
        hint: '任务内容含异常特征词但 DONE 无过程异常记录——疑似静默绕过；请补记录或联系执行者'
      }) + '\n';
      append(VIOLATIONS_FILE, rec);
    } else if (CAPTURE_PATTERNS.some(re => re.test(String(doneContent || '')))) {
      // 合规且有明确的“过程异常/沉淀”表述 → 自动捕获为沉淀候选（去重：标题含任务名则跳过）
      pitfallCandidates++;
      const tag = `## ${tsISO().slice(0, 10)} ${name}（执行完整性自动捕获）`;
      const existing = readIf(PITFALL_INBOX) || '';
      if (!existing.includes(tag)) {
        const block = [
          '',
          tag,
          `- 异常特征：${hitWords(taskContent).join(' / ') || '（见任务文件）'}`,
          `- 任务文件：${mdPath}`,
          `- DONE：${String(doneContent).trim().slice(0, 300)}`,
          '- 状态：待 learning-officer 审核合并进 pitfalls.md',
          '',
        ].join('\n');
        append(PITFALL_INBOX, block);
      }
    }
  }

  if (cursorDirty) {
    try { fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2), 'utf8'); } catch (e) {}
  }
  return { violations, pitfallCandidates, audited };
}

/* ---- 小工具 ---- */
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function tsISO() { return new Date().toISOString(); }

module.exports = { audit, hitWords, scanAndAudit, ANOMALY_PATTERNS, RECORD_PATTERNS, CAPTURE_PATTERNS };
