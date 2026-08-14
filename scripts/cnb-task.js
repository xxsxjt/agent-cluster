#!/usr/bin/env node
/**
 * cnb-task.js — 本机 → CNB 云开发空间 任务分发桥（分担本机开发/构建负载）
 *
 * 仿 scripts/hk-task.js（HK 桥）改写：CNB 是云开发环境（可能休眠），
 * butler 通过 SSH 投递任务 → CNB 端 pi CLI / cnb-exec 执行 → 轮询 .DONE 拉回。
 *
 * 用法：
 *   node scripts/cnb-task.js <taskfile.md> [--wait|--no-wait] [--timeout <秒>] [--poll <秒>]
 *   [--space <1|2|3>]  指定 CNB 空间（默认 1；2/3 待用户启动后填 CNB_HOST 映射）
 *
 *   <taskfile.md>   本地任务文件（绝对/相对路径，如 inbox/xxx.md）
 *   --wait          等待完成并拉回结果（默认开启；--no-wait 只投递）
 *   --timeout <秒>  最大等待秒数（默认 7200）
 *   --poll <秒>     轮询间隔（默认 5）
 *
 * 行为：
 *   1. 包装任务内容（追加执行要求，CNB 端 exec 需提取 .DONE 路径）
 *   2. scp 到 CNB /data/cnb-org/inbox/<name>.md（幂等：已有 .DONE 则直接拉回）
 *   3. 轮询 CNB .DONE/.FAILED → scp 回本地 org/inbox/<name>.DONE
 *   4. 尽力拉回 CNB logs/<name>.log → 本地 org/logs/<name>.cnb.log
 *   5. 超时/失败：写本地 .DONE 为 .FAILED: <原因>，退出码非 0
 *
 * ⚠️ CNB 是云开发环境，空间可能休眠（闲置回收）：SSH 失败会快速报"CNB 不可达/空间休眠"，
 *    提示用户到 CNB 控制台启动空间后重跑（幂等，可安全重试）。
 *
 * SSH 凭据不落代码明文之外（key 路径来自 ~/.ssh，主机为 CNB 空间1）。
 */
'use strict';
// Windows 下 ssh/scp 弹窗闪现修复：走 win-spawn 兜底（windowsHide:true），见 lib/win-spawn.js
const { execFile, execFileSync } = require('../lib/win-spawn');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 软超时（2026-08-11 soft-timeout）：到期先询问不杀，复用 task-watchdog 询问机制
const soft = require('../lib/soft-timeout');
const SOFT_AGENT = 'cnb-dev';          // CNB 任务对应的本地看护智能体（管 CNB 节点）
const SOFT_GRACE_SEC = 10 * 60;        // 软超时宽限期（超时后最多再等 10min 判定真卡死）

const ORG_ROOT = path.resolve(__dirname, '..');
const INBOX    = path.join(ORG_ROOT, 'inbox');
const LOGS     = path.join(ORG_ROOT, 'logs');

// ── CNB 空间映射（slug，host 不再硬编码——实例重启地址会变，从 cnb-ctl.js ssh 动态拿最新）──
// 空间 1 = 开发主力节点；空间 2 = 构建机；空间 3 = 测试沙箱。
const CNB_SPACES = {
  '1': { slug: 'xxssxx.top/1', note: '开发主力', key: 'id_rsa_cnb' },
  '2': { slug: 'xxssxx.top/2', note: '构建机',   key: 'id_rsa_cnb' },
  '3': { slug: 'xxssxx.top/3', note: '测试沙箱', key: 'id_rsa_cnb' },
};
const CNB_CTL = path.join(ORG_ROOT, 'scripts', 'cnb-ctl.js');

// 从 cnb-ctl.js 动态获取指定空间最新 SSH 主机（user@host）；失败则回退空间默认映射
function resolveHost(space) {
  try {
    const out = execFileSync('node', [CNB_CTL, 'ssh', String(space || '1')], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const host = (out || '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (host && host.includes('@') && host.includes('cnb.space')) {
      return host;
    }
  } catch (e) { /* 回退 */ }
  // 回退：从 cnb_ssh_host 类已知默认（不用于运行，仅提示）
  return null;
}
const CNB_ORG   = '/data/cnb-org';
const CNB_INBOX = `${CNB_ORG}/inbox`;
const CNB_LOGS  = `${CNB_ORG}/logs`;

/* ── 小工具 ─────────────────────────────────────────────── */
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [cnb-task] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOGS, 'cnb-task.log'), line + '\n', 'utf8'); } catch (e) {}
}

function getCtx(space) {
  const sp = CNB_SPACES[String(space || '1')];
  if (!sp) throw new Error(`未知 CNB 空间: ${space}`);
  const key = path.join(os.homedir(), '.ssh', sp.key);
  // 动态解析最新 SSH host（实例重启地址会变，从 cnb-ctl ssh 拿）
  const dynHost = resolveHost(space);
  if (dynHost) log(`空间${space} 动态 SSH 主机: ${dynHost}`);
  const SSH_BASE = ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                    '-o', 'ServerAliveInterval=15', '-o', 'StrictHostKeyChecking=accept-new', '-4'];
  const SSH_DEST = dynHost;
  const ssh = (cmd, timeoutMs) => new Promise(resolve => {
    execFile('ssh', [...SSH_BASE, SSH_DEST, cmd], { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs || 60000 },
      (err, stdout, stderr) => {
        // CNB sshd 打 post-quantum 警告到 stderr（无害），过滤；远端 exit code≠0 不一定 ssh 失败——以 stdout 为准
        const cleanErr = String(stderr || '').split('\n').filter(l => !l.includes('post-quantum') && !l.includes('store now') && !l.includes('upgraded')).join('\n').trim();
        resolve({ ok: !err || !!cleanErr, code: err ? err.code : 0, out: (stdout || '').trim(), err: cleanErr });
      });
  });
  const scp = (from, to) => new Promise(resolve => {
    // Windows scp 无 -p（ssh 才用）；CNB 无自定义端口 → 不需 -P
    const scpBase = ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                     '-o', 'StrictHostKeyChecking=accept-new', '-4'];
    execFile('scp', [...scpBase, from, to], { maxBuffer: 32 * 1024 * 1024, timeout: 120000 },
      (err) => resolve({ ok: !err, code: err ? err.code : 0, err: err ? String(err.message || err) : '' }));
  });
  return { SSH_BASE, SSH_DEST, ssh, scp };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { file: null, wait: true, timeout: 7200, poll: 5, space: '1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait') args.wait = true;
    else if (a === '--no-wait') args.wait = false;
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10) || args.timeout;
    else if (a === '--poll') args.poll = Math.max(2, parseInt(argv[++i], 10) || 5);
    else if (a === '--space') args.space = argv[++i] || '1';
    else if (a === '--no-auto-start') args.autoStart = false;  // 关闭自动启动空间
    else if (!a.startsWith('-') && !args.file) args.file = a;
  }
  return args;
}

function headerTimeout(filePath, fallback) {
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 800);
    const m = head.match(/^timeout\s*:\s*(\d+)/im);
    if (m) return Math.max(30, parseInt(m[1], 10));
  } catch (e) {}
  return fallback;
}

async function pullBack(ctx, localDone, cnbDone, cnbFail, name) {
  const { scp, SSH_DEST } = ctx;
  const dl = await scp(`${SSH_DEST}:${cnbDone}`, localDone);
  if (!dl.ok) {
    const dl2 = await scp(`${SSH_DEST}:${cnbFail}`, localDone);
    if (!dl2.ok) {
      log(`⚠️ 拉回完成标记失败: ${dl.err.slice(0, 120)}`);
      fs.writeFileSync(localDone, '.FAILED: 拉回 CNB 完成标记失败\n', 'utf8');
      return;
    }
  }
  const localLog = path.join(LOGS, `${name}.cnb.log`);
  const ll = await scp(`${SSH_DEST}:${CNB_LOGS}/${name}.log`, localLog);
  if (ll.ok) log(`📄 已拉回 CNB 日志 → ${path.relative(ORG_ROOT, localLog)}`);
  const localResult = path.join(LOGS, `${name}.cnb.result`);
  const lr = await scp(`${SSH_DEST}:${CNB_LOGS}/${name}.result`, localResult);
  if (lr.ok) log(`📄 已拉回 CNB 结果 → ${path.relative(ORG_ROOT, localResult)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('用法: node scripts/cnb-task.js <taskfile.md> [--wait|--no-wait] [--timeout <秒>] [--poll <秒>] [--space 1|2|3]');
    process.exit(2);
  }
  const ctx = getCtx(args.space);
  const { ssh, scp, SSH_DEST } = ctx;

  const taskFile = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(taskFile)) { console.error('任务文件不存在:', taskFile); process.exit(2); }

  const name = path.basename(taskFile, '.md');
  const cnbDone  = `${CNB_INBOX}/${name}.DONE`;
  const cnbFail  = `${CNB_INBOX}/${name}.FAILED`;
  const localDone = path.join(INBOX, `${name}.DONE`);
  const timeoutSec = headerTimeout(taskFile, args.timeout);
  const baseDeadline = Date.now() + timeoutSec * 1000; // 原始超时点（软超时续期时重置）
  let deadline = baseDeadline;
  let softEnteredAt = null;   // null=未进入软超时；进入后=首次到期时刻(ms)
  let softDeadline = 0;       // 软超时宽限截止

  log(`任务 [${name}] 空间=${args.space} 文件=${taskFile} 超时=${timeoutSec}s 轮询=${args.poll}s`);

  // 0) 可达性检查（快速失败——CNB 空间可能休眠；2026-08-12 按需激活：不可达且允许自动启动 → 启动空间并等待 running）
  let ping = await ssh(`echo __CNB_OK__ && hostname`);
  if (!ping.out.includes('__CNB_OK__') && args.autoStart !== false) {
    log(`⏳ CNB 不可达——按需激活空间 ${args.space}（正常使用方式：要干活再启动）`);
    try {
      execFileSync('node', [CNB_CTL, 'start', String(args.space)], { stdio: 'pipe', timeout: 60000, windowsHide: true });
      execFileSync('node', [CNB_CTL, 'wait', String(args.space), '--timeout', '240'], { stdio: 'pipe', timeout: 260000, windowsHide: true });
      log('✅ 空间已激活（running），重试连接…');
      ping = await ssh(`echo __CNB_OK__ && hostname`);
    } catch (e) {
      log(`❌ 自动激活失败: ${String(e.message).slice(0, 150)}`);
    }
  }
  if (!ping.out.includes('__CNB_OK__')) {
    log(`❌ CNB 不可达: ${ping.err || ping.out || 'ssh 失败'}（空间可能休眠/重建中——可重试自动激活）`);
    fs.writeFileSync(localDone, `.FAILED: CNB 不可达（空间休眠/重建：${(ping.err || 'ssh fail').slice(0, 120)}）\n`, 'utf8');
    process.exit(1);
  }
  log(`✅ CNB 可达 → ${ping.out.replace('__CNB_OK__', '').trim()}`);

  // 1) CNB 是否已有完成标记（幂等）
  const has = await ssh(`test -f ${cnbDone} && echo DONE; test -f ${cnbFail} && echo FAILED`);
  if (has.out.includes('DONE') || has.out.includes('FAILED')) {
    log('ℹ️ CNB 已有完成标记，直接拉回（幂等跳过投递）');
    await pullBack(ctx, localDone, cnbDone, cnbFail, name);
    process.exit(fs.readFileSync(localDone, 'utf8').includes('.FAILED') ? 1 : 0);
  }

  // 2) 包装任务内容
  const wrapped = [
    fs.readFileSync(taskFile, 'utf8').trimEnd(),
    '',
    '---',
    '执行要求（CNB 桥自动追加）：',
    '1. 独立完成，不等待外部指令',
    `2. 完成后创建标记文件（一行摘要）：${cnbDone}`,
    `3. 若无法完成，写 ${cnbDone} 内容为 .FAILED: <原因>`,
    ''
  ].join('\n');
  const staging = path.join(LOGS, `.cnb-staging-${name}.md`);
  fs.writeFileSync(staging, wrapped, 'utf8');

  // 3) 自愈：确保 CNB 端目录结构 + cnb-exec.js + 构建环境存在（新实例回收重建后 /data/cnb-org 被清空）
  //    缺失 cnb-exec.js 即判定为新实例（回收重建）→ 目录+exec 重建，并顺带检查 java/gradle/pi，
  //    缺失则自动跑 cnb-init-env.sh 恢复环境（2026-08-11 improve 补验发现：自愈原只补 exec 不补环境，
  //    新实例 java/gradle/pi 全缺，分流/构建失败）。
  // 2026-08-11 版本校验：不只查缺失，还查是否含 findDonePath 的 /cnb-org/ 修复标记（旧版会误写 /data/agent-cluster 路径导致 ENOENT）
  // 2026-08-12 升级：需同时含 runPiMode（pi 智能体模式）——旧版含 /cnb-org/ 但无 pi 模式 → 强制上传新版
  const ensureExec = await ssh(`mkdir -p /data/cnb-org/inbox /data/cnb-org/logs /data/cnb-org/tasks; test -f /data/cnb-org/cnb-exec.js && grep -q 'cnb-org/' /data/cnb-org/cnb-exec.js && grep -q 'runPiMode' /data/cnb-org/cnb-exec.js && echo __EXEC_OK__ || echo __EXEC_MISSING__`);
  if (!ensureExec.out.includes('__EXEC_OK__')) {
    log('⚠️ CNB 端 cnb-exec.js 缺失或旧版（回收重建/缺 /cnb-org/ 修复），本机自动上传 + 环境自检…');
    const execSrc = path.join(ORG_ROOT, 'scripts', 'cnb-exec.js');
    const upExec = await scp(execSrc, `${SSH_DEST}:/data/cnb-org/cnb-exec.js`);
    if (!upExec.ok) { log(`❌ cnb-exec.js 上传失败: ${upExec.err.slice(0, 120)}`); }
  }
  // 新实例环境自愈（2026-08-12 加固：独立于 exec 缺失，总是执行——空间3 曾出现 exec 在而环境缺失）：
  //   java/gradle/pi 缺失则优先用「环境镜像」秒级恢复，无镜像回退 cnb-init-env.sh
    //（2026-08-12 加固：镜像=gradle+pi 由本机 logs/cnb-env/env-image.tar.gz 提供，restore 秒级；
    //    java 走 apt，由 init-env 兜底补装——restore 后再自检，仍缺才跑 init-env）
    const envCheck = await ssh(`command -v java && command -v gradle && command -v pi && echo __ENV_OK__ || echo __ENV_MISSING__`);
    if (!envCheck.out.includes('__ENV_OK__')) {
      const envImage = path.join(ORG_ROOT, 'logs', 'cnb-env', 'env-image.tar.gz');
      if (fs.existsSync(envImage)) {
        log('⚠️ CNB 端构建环境缺失 → 用环境镜像快恢复（logs/cnb-env/env-image.tar.gz）…');
        const upImg = await scp(envImage, `${SSH_DEST}:/data/cnb-org/env-image.tar.gz`);
        if (upImg.ok) {
          const upSh = await scp(path.join(ORG_ROOT, 'scripts', 'cnb-env-image.sh'), `${SSH_DEST}:/data/cnb-org/cnb-env-image.sh`);
          if (upSh.ok) {
            const rst = await ssh(`bash /data/cnb-org/cnb-env-image.sh restore /data/cnb-org/env-image.tar.gz`, 180000);
            const okLines = (rst.out || rst.err || '').split('\n').filter(l => /gradle|pi|❌|RESTORE_OK/.test(l)).join(' | ');
            log(`镜像恢复输出: ${okLines.slice(0, 160)}`);
          }
        } else { log(`❌ 环境镜像 scp 失败: ${upImg.err.slice(0, 80)}`); }
      }
      // 恢复后自检；仍缺（尤其 java 走 apt）→ 补跑 cnb-init-env.sh（幂等只装缺失项）
      let envOk = await ssh(`command -v java && command -v gradle && command -v pi && echo __ENV_OK__ || echo __ENV_MISSING__`);
      if (!envOk.out.includes('__ENV_OK__')) {
        log('⚠️ 镜像恢复后仍缺项（多为 java，走 apt）→ 补跑 cnb-init-env.sh …');
        const initSh = path.join(ORG_ROOT, 'scripts', 'cnb-init-env.sh');
        const upInit = await scp(initSh, `${SSH_DEST}:/data/cnb-org/cnb-init-env.sh`);
        let initResult = { out: '', err: '' };
        if (upInit.ok) initResult = await ssh(`bash /data/cnb-org/cnb-init-env.sh`, 600000);
        else initResult.err = `scp init-env 失败: ${upInit.err.slice(0, 80)}`;
        envOk = await ssh(`command -v java && command -v gradle && command -v pi && echo __ENV_OK__ || echo __ENV_MISSING__`);
        if (!envOk.out.includes('__ENV_OK__')) log(`❌ CNB 环境自愈失败: ${(initResult.err || initResult.out || 'init fail').slice(0, 120)}`);
        else log('✅ CNB 环境自愈完成（java/gradle/pi 就绪）');
      } else { log('✅ CNB 环境镜像恢复完成（java/gradle/pi 就绪）'); }
    }

  // 3.3) pi 可信渠道注入（2026-08-12 智能体执行器）：CNB 端 pi 执行需要 auth.json/models.json
  //      （可信渠道：deepseek 官方/opencode-go 订阅池等，本机 ~/.pi/agent 已配置）——
  //      实例回收重建后 /root/.pi/agent 只剩 skills，渠道配置全丢；缺失则从本机 scp 注入。
    const piConfDir = path.join(os.homedir(), '.pi', 'agent');
    const piAuthOk = await ssh(`test -f /root/.pi/agent/auth.json && echo __AUTH_OK__ || echo __AUTH_MISSING__`);
    if (!piAuthOk.out.includes('__AUTH_OK__')) {
      log('⚠️ CNB pi 可信渠道缺失 → 从本机注入 auth.json/models.json/settings.json …');
      for (const cfgFile of ['auth.json', 'models.json', 'settings.json']) {
        const src = path.join(piConfDir, cfgFile);
        if (!fs.existsSync(src)) { log(`  ⚠️ 本机缺 ${cfgFile}，跳过`); continue; }
        // settings.json 过滤 Windows 专用 shellPath（2026-08-12 教训：注入后 CNB pi 的 bash 工具
        //   指向 hidden-bash.exe 失效，pi 自己修复成 /bin/bash——本机直接剥离更干净）
        if (cfgFile === 'settings.json') {
          try {
            const st = JSON.parse(fs.readFileSync(src, 'utf8'));
            delete st.shellPath;
            fs.writeFileSync(path.join(LOGS, '.cnb-settings.inject.json'), JSON.stringify(st, null, 2), 'utf8');
            const upS = await scp(path.join(LOGS, '.cnb-settings.inject.json'), `${SSH_DEST}:/root/.pi/agent/settings.json`);
            if (upS.ok) { log('  ✅ settings.json 注入完成（已剥离 Windows shellPath）'); fs.unlinkSync(path.join(LOGS, '.cnb-settings.inject.json')); }
            else log(`  ❌ settings.json 注入失败: ${upS.err.slice(0, 80)}`);
            continue;
          } catch (e) { log(`  ⚠️ settings.json 解析失败（${e.message}），按原样注入`); }
        }
        const up = await scp(src, `${SSH_DEST}:/root/.pi/agent/${cfgFile}`);
        if (up.ok) log(`  ✅ ${cfgFile} 注入完成`);
        else log(`  ❌ ${cfgFile} 注入失败: ${up.err.slice(0, 80)}`);
      }
      const verify = await ssh(`test -f /root/.pi/agent/auth.json && test -f /root/.pi/agent/models.json && echo __PI_CONF_OK__ || echo __PI_CONF_MISSING__`);
      if (verify.out.includes('__PI_CONF_OK__')) log('✅ CNB pi 可信渠道就绪（auth/models/settings）');
      else log(`❌ CNB pi 渠道注入未完全成功: ${verify.out || 'verify fail'}`);
    } else { log('✅ CNB pi 可信渠道已在（auth.json 存在）'); }

  // 3.5) scp 投递到 CNB inbox
  const up = await scp(staging, `${SSH_DEST}:${CNB_INBOX}/${name}.md`);
  try { fs.unlinkSync(staging); } catch (e) {}
  if (!up.ok) {
    log(`❌ scp 投递失败: ${up.err.slice(0, 200)}`);
    fs.writeFileSync(localDone, `.FAILED: scp 投递失败 ${up.err.slice(0, 120)}\n`, 'utf8');
    process.exit(1);
  }
  log(`🚀 已投递 → ${CNB_INBOX}/${name}.md，拉起 CNB 执行器…`);

  // 3.5) 拉起 CNB 端执行器（nohup 分离，单次执行本任务；写独立 exec 日志）
  const launch = await ssh(`cd /data/cnb-org && nohup node /data/cnb-org/cnb-exec.js ${CNB_INBOX}/${name}.md > ${CNB_LOGS}/${name}.exec.log 2>&1 & echo __CNB_LAUNCHED__`);
  if (!launch.out.includes('__CNB_LAUNCHED__')) {
    log(`❌ CNB 执行器拉起失败: ${launch.err || launch.out || 'ssh fail'}（可能空间休眠）`);
    fs.writeFileSync(localDone, `.FAILED: CNB 执行器拉起失败 ${(launch.err || 'ssh fail').slice(0, 120)}\n`, 'utf8');
    process.exit(1);
  }
  log('✅ 已拉起 CNB 执行器，开始轮询结果…');

  if (!args.wait) {
    log('ℹ️ --no-wait 模式，投递完成即退出（结果稍后可重跑 --wait 拉取）');
    process.exit(0);
  }

  // 4) 轮询 CNB .DONE/.FAILED（软超时：到期先询问不杀，远端仍活跃则续期）
  while (true) {
    await sleep(args.poll * 1000);
    const r = await ssh(`test -f ${cnbDone} && echo DONE; test -f ${cnbFail} && echo FAILED`);
    if (r.out.includes('DONE') || r.out.includes('FAILED')) {
      await pullBack(ctx, localDone, cnbDone, cnbFail, name);
      const content = fs.readFileSync(localDone, 'utf8').trim();
      log(content.startsWith('.FAILED')
        ? `❌ CNB 任务 [${name}] 失败 → ${content.slice(0, 160)}`
        : `✅ CNB 任务 [${name}] 完成 → ${content.slice(0, 160)}`);
      process.exit(content.startsWith('.FAILED') ? 1 : 0);
    }

    // ── 到期后的软超时处理：首次到期 → 投 checkpoint 询问；随后查远端活跃 → 续期 / 宽限到 → 卡死 ──
    if (Date.now() >= deadline) {
      if (softEnteredAt === null) {
        softEnteredAt = Date.now();
        softDeadline = softEnteredAt + SOFT_GRACE_SEC * 1000;
        const q = soft.askSoftTimeout(name, SOFT_AGENT,
          `CNB 任务超时（${timeoutSec}s）但可能仍在跑，请确认远端是否继续`);
        log(`⏰ [${name}] 超时 ${timeoutSec}s 未完成 → 软超时：已投 checkpoint 询问（${q || '已在队列'}），宽限 ${SOFT_GRACE_SEC / 60}min 观察远端活动`);
      }
      // 查远端任务日志 mtime：活跃窗口内仍有输出 = 还在跑 → 续期（不杀）
      // cnb-exec.js 的 nohup 输出重定向到 <name>.exec.log；任务脚本可能另写 <name>.log → 两者取较新
      const la = await ssh(`f=${CNB_LOGS}/${name}.exec.log; g=${CNB_LOGS}/${name}.log; a=$(test -f $f && stat -c %Y $f || echo 0); b=$(test -f $g && stat -c %Y $g || echo 0); echo $((a>b?a:b))`);
      const logMtime = parseInt(la.out, 10) || 0;
      if (soft.isRemoteActive(logMtime)) {
        deadline = Date.now() + timeoutSec * 1000;
        softEnteredAt = null;
        log(`♻️ [${name}] 远端日志仍活跃（mtime=${logMtime}）→ 软超时续期，再等 ${timeoutSec}s`);
        continue;
      }
      if (Date.now() >= softDeadline) {
        log(`❌ [${name}] 软超时宽限 ${SOFT_GRACE_SEC / 60}min 已过且远端日志停滞（mtime=${logMtime}）→ 判定真卡死，结束`);
        fs.writeFileSync(localDone, `.FAILED: CNB 任务超时（${timeoutSec}s）且软超时宽限后远端仍无活动，判定卡死\n`, 'utf8');
        process.exit(1);
      }
    }

    const elapsed = Math.round((Date.now() - (deadline - timeoutSec * 1000)) / 1000);
    if (elapsed % 60 < args.poll) log(`⏳ [${name}] CNB 执行中… ${elapsed}s/${timeoutSec}s`);
  }
}

main().catch(e => {
  console.error('cnb-task.js 异常:', e);
  try {
    fs.writeFileSync(path.join(INBOX, 'cnb-task-fatal.DONE'), '.FAILED: ' + String(e.message).slice(0, 200) + '\n', 'utf8');
  } catch (_) {}
  process.exit(1);
});
