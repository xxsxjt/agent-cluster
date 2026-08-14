/**
 * 知识注入（2026-08-12 乱码根治：智能体知识同步）
 * --------------------------------------------------
 * butler 派发任务时调用 buildKnowledgeBlock()，把 knowledge/task-inject.md
 * 的最新内容注入任务 prompt——执行智能体自动获得最新规范（实时读取，
 * 每次派发都读最新文件，无缓存；文件缺失时回退内置核心规则）。
 *
 * 这样解决"规范写了但执行智能体不知道"：
 *  - 规范只维护在 task-inject.md / conventions.md 一处
 *  - 每次任务派发自动携带，智能体无需主动查找
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT = path.join(__dirname, '..');
const INJECT_FILE = path.join(ORG_ROOT, 'knowledge', 'task-inject.md');

/** 内置回退块（task-inject.md 缺失/损坏时用，保证核心规则永不缺失） */
function fallbackBlock() {
  return [
    '【全局规范速查（自动注入）】',
    '- 编码铁律：所有文件读写必须 UTF-8；python 写文件必须 open(path, "w", encoding="utf-8")（Windows 默认 GBK 会乱码）；写 DONE 用 node C:\\Users\\du_ji\\pi_workspace\\org\\scripts\\write-done.js',
    '- 知识库：C:\\Users\\du_ji\\pi_workspace\\org\\knowledge\\conventions.md（必读）；pitfalls.md / PRODUCT-VISION.md 按需',
    '- 完成任务写 inbox/<任务名>.DONE 一行摘要；失败 .FAILED: <原因>',
    '- 执行完整性：遇异常/失败/绕行必须记录（遇到什么/怎么绕的/能不能修/修了没/需不需要问用户）——不许静默绕过；完成前自查有无该沉淀的坑',
    '- 上下文铁律：禁止全量 cat 大文件（jsonl/日志/导出）；grep/head/tail/wc 精准取片段',
    '- 禁止全盘 find / 全盘 grep；进程拉起必须隐藏；桌面重操作先问用户',
  ].join('\n');
}

/** 读取注入源（实时），失败回退内置 */
function loadInjectSource() {
  try {
    const raw = fs.readFileSync(INJECT_FILE, 'utf8');
    if (raw.includes('\uFFFD')) return null;   // 内容损坏 → 回退
    return raw.trim();
  } catch (e) {
    return null;
  }
}

/**
 * 构建知识注入块。
 * @param {string} agentId 目标智能体 id（可空）
 * @returns {string} 注入文本（多行，无则返回空串）
 */
function buildKnowledgeBlock(agentId) {
  const src = loadInjectSource();
  const body = src || fallbackBlock();
  const parts = [
    '【任务必读 · 全局规范自动注入（实时最新版）】',
    '```',
    body,
    '```',
  ];
  if (agentId) {
    parts.push(`- 本任务执行者: ${agentId}。先读必读规范再动手；规范与任务文件冲突时以用户最新指令/任务文件为准，并在 DONE 摘要注明。`);
  }
  return '\n' + parts.join('\n');
}

module.exports = { buildKnowledgeBlock, INJECT_FILE };
