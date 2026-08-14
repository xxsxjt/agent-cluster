#!/usr/bin/env node
/**
 * org.js - v5 组织树 CLI 工具
 * 用法：
 *   node org.js tree               # 显示嵌套树
 *   node org.js list               # 平铺列表
 *   node org.js status             # 状态板
 *   node org.js add-group <id> <label> [--parent <id>] [--main-agent <id>]
 *   node org.js add-agent <id> <label> [--parent <id>] [--role <role>]
 */
'use strict';
const registry = require('./lib/registry');
const fs = require('fs');
const path = require('path');

const ORG_ROOT = __dirname;

function showTree() {
  console.log('\n=== 组织树 ===');
  registry.traverse('root', (node, depth) => {
    const indent = '  '.repeat(depth);
    const icon = node.type === 'root' ? '🏢' : node.type === 'group' ? '📁' : '🤖';
    const status = node.status ? `[${node.status}]` : '';
    console.log(`${indent}${icon} ${node.label} (${node.id}) ${status}`);
  });
  console.log('');
}

function showList() {
  console.log('\n=== 节点列表 ===');
  const data = registry.load();
  console.log(`root: ${data.root.label}`);
  for (const [id, node] of Object.entries(data.nodes)) {
    const status = node.status || '?';
    const type = node.type === 'group' ? 'GROUP' : 'AGENT';
    console.log(`  ${type} ${id}: ${node.label} [${status}] parent=${node.parent}`);
  }
  console.log('');
}

function showStatus() {
  console.log('\n=== 状态板 ===');
  const data = registry.load();
  const counts = { active: 0, sleeping: 0, retired: 0 };
  registry.traverse('root', (node) => {
    if (node.status) counts[node.status] = (counts[node.status] || 0) + 1;
  });
  console.log(`总节点: ${Object.keys(data.nodes).length + 1}`);
  console.log(`激活: ${counts.active || 0} | 休眠: ${counts.sleeping || 0} | 退役: ${counts.retired || 0}`);
  console.log(`更新时间: ${data.updatedAt || '(未知)'}`);
  console.log('');
}

function addGroup(args) {
  const id = args[0];
  const label = args[1];
  if (!id || !label) {
    console.error('用法: org.js add-group <id> <label> [--parent <id>] [--main-agent <id>]');
    process.exit(1);
  }
  const parentIdx = args.indexOf('--parent');
  const parent = parentIdx >= 0 ? args[parentIdx + 1] : 'coo';
  const mainAgentIdx = args.indexOf('--main-agent');
  const mainAgent = mainAgentIdx >= 0 ? args[mainAgentIdx + 1] : null;

  const groupDir = `groups/${id}`;
  fs.mkdirSync(path.join(ORG_ROOT, groupDir), { recursive: true });

  const node = {
    id, type: 'group', label, status: 'active', parent, mainAgent,
    groupDir, keywords: [], children: []
  };
  registry.setNode(id, node);
  registry.addChild(parent, id);
  console.log(`✓ 创建组: ${id} (${label})`);
}

function addAgent(args) {
  const id = args[0];
  const label = args[1];
  if (!id || !label) {
    console.error('用法: org.js add-agent <id> <label> [--parent <id>] [--role <role>]');
    process.exit(1);
  }
  const parentIdx = args.indexOf('--parent');
  const parent = parentIdx >= 0 ? args[parentIdx + 1] : 'coo';
  const roleIdx = args.indexOf('--role');
  const role = roleIdx >= 0 ? args[roleIdx + 1] : 'worker';

  const agentDir = `agents/${id}`;
  const fullDir = path.join(ORG_ROOT, agentDir);
  fs.mkdirSync(path.join(fullDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(fullDir, 'tasks'), { recursive: true });

  const identity = {
    id, label, role, status: 'sleeping', onlinePolicy: 'lazy', parent,
    createdAt: new Date().toISOString(),
    persona: `你是智能体 ${label}，角色: ${role}`,
    permissions: [], capabilities: [], notes: ''
  };
  fs.writeFileSync(path.join(fullDir, 'identity.json'), JSON.stringify(identity, null, 2), 'utf8');

  const node = {
    id, type: 'agent', label, role, status: 'sleeping', onlinePolicy: 'lazy',
    parent, agentDir, spawnType: 'claude', children: []
  };
  registry.setNode(id, node);
  registry.addChild(parent, id);
  console.log(`✓ 创建智能体: ${id} (${label})`);
}

function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  switch (cmd) {
    case 'tree': showTree(); break;
    case 'list': showList(); break;
    case 'status': showStatus(); break;
    case 'add-group': addGroup(args); break;
    case 'add-agent': addAgent(args); break;
    default:
      console.log('用法: node org.js <tree|list|status|add-group|add-agent>');
      process.exit(1);
  }
}

if (require.main === module) main();
