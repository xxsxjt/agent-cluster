#!/usr/bin/env node
/**
 * lib/registry.js - org.json 读写工具（v5 组织树注册表）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_JSON = path.join(__dirname, '..', 'org.json');

/** 读 org.json */
function load() {
  try {
    return JSON.parse(fs.readFileSync(ORG_JSON, 'utf8'));
  } catch (e) {
    throw new Error(`读 org.json 失败: ${e.message}`);
  }
}

/** 写 org.json（带时间戳更新） */
function save(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(ORG_JSON, JSON.stringify(data, null, 2), 'utf8');
}

/** 按 ID 查节点 */
function getNode(id) {
  const data = load();
  if (id === 'root') return data.root;
  return data.nodes[id] || null;
}

/** 添加/更新节点 */
function setNode(id, node) {
  const data = load();
  if (id === 'root') data.root = node;
  else data.nodes[id] = node;
  save(data);
}

/** 递归获取所有子节点 ID */
function getDescendants(id) {
  const node = getNode(id);
  if (!node || !node.children || !node.children.length) return [];
  const result = [];
  for (const childId of node.children) {
    result.push(childId);
    result.push(...getDescendants(childId));
  }
  return result;
}

/** 树形遍历（深度优先），回调 fn(node, depth) */
function traverse(id, fn, depth = 0) {
  const node = getNode(id);
  if (!node) return;
  fn(node, depth);
  if (node.children) {
    for (const childId of node.children) traverse(childId, fn, depth + 1);
  }
}

/** 添加子节点到父节点的 children */
function addChild(parentId, childId) {
  const parent = getNode(parentId);
  if (!parent) throw new Error(`父节点 ${parentId} 不存在`);
  if (!parent.children) parent.children = [];
  if (!parent.children.includes(childId)) parent.children.push(childId);
  setNode(parentId, parent);
}

/** 按关键词匹配组（用于任务路由） */
function matchGroup(keywords) {
  const data = load();
  for (const [id, node] of Object.entries(data.nodes)) {
    if (node.type === 'group' && node.keywords) {
      for (const kw of node.keywords) {
        if (keywords.some(k => k.includes(kw) || kw.includes(k))) return id;
      }
    }
  }
  return null;
}

module.exports = { load, save, getNode, setNode, getDescendants, traverse, addChild, matchGroup };
