#!/usr/bin/env node
/**
 * hk-alert.js — 智能体集群任务完成/失败 → HK new-api 告警注入（2026-08-08）
 *
 * 职责：butler 在任务 .DONE/.FAILED 时调用本脚本，经 SSH 在 HK 上 curl
 *   new-api 的 POST /api/mobile/admin/cluster/notify（x-cluster-token 鉴权）
 *   → 写入 admin_mobile_alerts 表（kind=task_done / task_failed）
 *   → APP 现有 SSE/轮询自动弹系统通知（AlertNotifier 复用，零新增通知代码）。
 *
 * 用法：
 *   任务事件:      node scripts/hk-alert.js <任务名> <done|failed> [智能体名] [完成摘要]
 *   渠道额度通知:  node scripts/hk-alert.js --quota <渠道名> <额度错误信息>
 *
 * 标题人话格式（2026-08-11 app-notify-detail-fix）：`<任务名> · <智能体名> <状态>`
 *   （如 "cnb-sync-p0 · cnb-dev 已完成"），技术细节放在 message 正文（APP 端折叠）。
 *                （403/402/insufficient balance/quota exceeded → kind=channel_quota，
 *                  含「重置卡」提示；fingerprint 按渠道去重，防刷屏）
 *
 * 配置（org/config/cluster-notify.json，不存在则自动生成默认）：
 *   { "enabled": true, "notifyDone": true,
 *     "newApiUrl": "http://127.0.0.1:3461/api/mobile/admin/cluster/notify",
 *     "hkHost":"100.97.18.59","hkPort":"43891","hkUser":"root","hkKey":"~/.ssh/id_ed25519_xxsx_hk" }
 *   集群 token 自动从 web/remote-config.json 读取（与 HK new-api MobileAlertClusterToken 一致）。
 *
 * 防刷屏：按任务唯一 fingerprint（cluster:task:<name>）在 new-api 侧去重；且只在任务
 *   完成/失败时触发一次（离散事件），不会每轮巡查刷屏。
 */
'use strict';
// Windows 下 ssh 弹窗闪现修复：改走 win-spawn 兜底（默认 windowsHide:true），见 lib/win-spawn.js
const { execFile } = require('../lib/win-spawn');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORG_ROOT = path.resolve(__dirname, '..');
const LOGS     = path.join(ORG_ROOT, 'logs');
const CONFIG_DIR = path.join(ORG_ROOT, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'cluster-notify.json');

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [hk-alert] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOGS, 'hk-alert.log'), line + '\n', 'utf8'); } catch (e) {}
}

function loadConfig() {
  const defaults = {
    enabled: true,
    notifyDone: true,          // 完成也通知（可选）；失败始终通知
    notifyAnomalyAutoRecovered: false,  // 异常自动恢复成功（重跑完成）不通知用户（默认 false，显式可配）
    newApiUrl: 'http://127.0.0.1:3461/api/mobile/admin/cluster/notify',
    hkHost: '103.100.159.111',  // 2026-08-11 改：公网 IP（Tailscale 链路曾挂导致通知全断）
    hkPort: '43891',
    hkUser: 'root',
    hkKey: path.join(os.homedir(), '.ssh', 'id_ed25519_xxsx_hk'),
  };
  let cfg = {};
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const raw = readIf(CONFIG_FILE);
    if (raw) cfg = JSON.parse(raw) || {};
    else fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf8');
  } catch (e) { log('读取配置失败:', e.message); }
  const merged = { ...defaults, ...cfg };
  // 空字符串视为未配置（避免 cfg 里的空值覆盖默认 URL/Host），回退默认——曾因 newApiUrl:'' 覆盖导致通知全发不出去
  for (const k of ['newApiUrl', 'hkHost', 'hkPort', 'hkUser', 'hkKey']) {
    if (!merged[k]) merged[k] = defaults[k];
  }
  return merged;
}

/** 集群 token：org x-pi-token（与 HK new-api MobileAlertClusterToken 一致） */
function clusterToken() {
  try {
    const rc = JSON.parse(readIf(path.join(ORG_ROOT, 'web', 'remote-config.json')) || '{}');
    if (rc && rc.token) return rc.token;
  } catch (e) {}
  return process.env.PI_CLUSTER_TOKEN || '';
}

/**
 * 构建 HK 端 curl 命令（中文安全，2026-08-12 notify-encoding-fix）
 *
 * 背景：Windows 下 ssh.exe 把参数拼进远程命令时按本机 ANSI 代码页（GBK）编码，
 *   HK（UTF-8 locale）收到 GBK 字节 → admin_mobile_alerts.message 乱码
 *   （如 "? CNB �����������֤ͨ��..."，id=306）。
 * 方案：payload 先 base64（纯 ASCII，任何编码链路无损）→ ssh 命令只含 ASCII →
 *   HK 端 base64 -d 还原 UTF-8 字节 → curl --data-binary @- 原样提交。
 */
function buildCurlCmd(url, token, payload) {
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return `echo '${b64}' | base64 -d | curl -s -X POST '${url}' -H 'x-cluster-token: ${token}' -H 'Content-Type: application/json' --data-binary @-`;
}

function ssh(cmd, timeoutMs) {
  return new Promise(resolve => {
    const key = path.join(os.homedir(), '.ssh', 'id_ed25519_xxsx_hk');
    const base = ['-p', '43891', '-i', key, '-o', 'BatchMode=yes',
                  '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
    execFile('ssh', [...base, 'root@103.100.159.111', cmd], { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs || 30000 },
      (err, stdout, stderr) => {
        const cleanErr = String(stderr || '').split('\n')
          .filter(l => !l.includes('post-quantum') && !l.includes('store now') && !l.includes('upgraded')).join('\n').trim();
        resolve({ ok: !err || !!cleanErr, out: (stdout || '').trim(), err: cleanErr });
      });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  // ── 渠道额度通知（重置卡机制，2026-08-11）──
  // node scripts/hk-alert.js --quota <provider> <额度错误信息>
  if (argv[0] === '--quota') {
    const provider = argv[1] || '渠道';
    const errText = (argv.slice(2).join(' ') || '额度用尽（403）').trim().slice(0, 200);
    const cfg = loadConfig();
    const token = clusterToken();
    if (!cfg.enabled) { log(`跳过（通知未启用）: quota ${provider}`); return; }
    if (!token) { log(`跳过（未取得集群 token）: quota ${provider}`); return; }
    const payload = JSON.stringify({
      kind: 'channel_quota',
      severity: 'warning',
      title: `渠道限额（403 额度不足）：${provider}——你有重置卡，是否重置？`,
      message: `${provider} 渠道额度用尽：${errText}`,
      fingerprint: 'cluster:channel-quota:' + String(provider).replace(/[\s\/\\]+/g, '-'),
      dedup_min: 30,
    });
    const cmd = buildCurlCmd(cfg.newApiUrl, token, payload);
    const r = await ssh(cmd, 30000);
    log(`💳 渠道额度通知 [${provider}] → ${r.out || ('错误:' + r.err)}`);
    return;
  }
  // ── 监督者升级通知（backup-supervisor 用：处理失败才通知用户——通知分流，2026-08-12）──
  // node scripts/hk-alert.js --supervisor <标题> <消息>
  if (argv[0] === '--supervisor') {
    const title = (argv[1] || '集群监督告警').trim().slice(0, 60);
    const msg = (argv.slice(2).join(' ') || '监督者处理失败，需人工介入').trim().slice(0, 200);
    const cfg = loadConfig();
    const token = clusterToken();
    if (!cfg.enabled) { log(`跳过（通知未启用）: supervisor ${title}`); return; }
    if (!token) { log(`跳过（未取得集群 token）: supervisor ${title}`); return; }
    const payload = JSON.stringify({
      kind: 'supervisor_alert',
      severity: 'critical',
      title,
      message: msg,
      fingerprint: 'cluster:supervisor:' + title.replace(/[\s\/\\]+/g, '-'),
      dedup_min: 30,
    });
    const cmd = buildCurlCmd(cfg.newApiUrl, token, payload);
    const r = await ssh(cmd, 30000);
    log(`🛡 监督者通知 [${title}] → ${r.out || ('错误:' + r.err)}`);
    return;
  }
  if (argv.length < 2) {
    console.error('用法: node scripts/hk-alert.js <任务名> <done|failed> [智能体名] [完成摘要] | --quota ... | --supervisor <标题> <消息>');
    process.exit(2);
  }
  const name = argv[0];
  const status = argv[1].toLowerCase();
  const agent = argv[2] ? String(argv[2]).trim().slice(0, 30) : '';
  const summary = (argv.slice(3).join(' ') || '').trim().slice(0, 200);
  const cfg = loadConfig();
  const token = clusterToken();

  if (!cfg.enabled) { log(`跳过（通知未启用）: ${name}`); return; }
  if (status === 'done' && !cfg.notifyDone) { log(`跳过（完成不通知）: ${name}`); return; }
  if (!token) { log(`跳过（未取得集群 token）: ${name}`); return; }

  const failed = status === 'failed';
  const kind = failed ? 'task_failed' : 'task_done';
  const severity = failed ? 'warning' : 'info';
  // 人话标题：`<任务名> · <智能体名> <状态>`（2026-08-11 app-notify-detail-fix）
  const agentLabel = agent ? ` · ${agent}` : '';
  const title = failed
    ? `${name}${agentLabel} 失败`
    : `${name}${agentLabel} 已完成`;
  const message = summary || (failed ? `${name} 执行失败` : `${name} 已完成`);
  const payload = JSON.stringify({
    kind, severity, title, message,
    // 详情页明确化：单独暴露 task/agent 字段，APP 详情页可一眼看出「哪个任务/哪个智能体」（2026-08-11）
    task: name,
    agent: agent || undefined,
    fingerprint: 'cluster:task:' + name.replace(/[\s\/\\]+/g, '-'),
    dedup_min: 10,
  });

  // 在 HK 上 curl new-api（new-api 仅绑定 127.0.0.1:3461，需在 HK 本机发）
  // base64 传参：中文经 ssh 不乱码（见 buildCurlCmd 注释）
  const cmd = buildCurlCmd(cfg.newApiUrl, token, payload);
  const r = await ssh(cmd, 30000);
  log(`${failed ? '❌' : '✅'} 通知 [${name}] ${failed ? '失败' : '完成'} → ${r.out || ('错误:' + r.err)}`);
}

main().catch(e => { log('异常:', e.message); process.exit(1); });
