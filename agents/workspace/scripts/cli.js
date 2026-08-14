#!/usr/bin/env node
/**
 * xxsx — Multi-provider API proxy with auto-failover
 *
 *   xxsx serve [port] [--tunnel cloudflare|ngrok]  Start proxy
 *   xxsx keys                List providers & keys
 *   xxsx keys add <key> [provider]  Add key
 *   xxsx keys remove <idx>   Remove key
 *   xxsx status              Proxy status
 *   xxsx test                Connectivity test
 *   xxsx config              Show/set config
 *   xxsx tunnel cloudflare   Start Cloudflare tunnel
 *   xxsx tunnel ngrok        Start ngrok tunnel
 *   xxsx tunnel stop         Stop tunnel
 *   xxsx tunnel status       Tunnel status
 *   xxsx doctor              Run diagnostics
 *   xxsx snapshot [path]     Export workspace snapshot
 *   xxsx mcp [--workspace <dir>]  Start MCP stdio server
 */
const https = require('https');
const path = require('path');

const cfg = require('./lib/config');
const logger = require('./lib/logger');

const BASE_DIR = __dirname;

// ---- Dispatch ----
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'serve' || cmd === 'start') {
  cmdServe(args[1]);
} else if (cmd === 'keys') {
  cmdKeys(args.slice(1));
} else if (cmd === 'test') {
  cmdTest();
} else if (cmd === 'status') {
  cmdStatus();
} else if (cmd === 'config') {
  cmdConfig(args.slice(1));
} else if (cmd === 'tunnel') {
  cmdTunnel(args.slice(1));
} else if (cmd === 'doctor') {
  cmdDoctor();
} else if (cmd === 'snapshot') {
  cmdSnapshot(args.slice(1));
} else if (cmd === 'mcp') {
  cmdMcp(args.slice(1));
} else {
  console.log('xxsx — Multi-provider API proxy');
  console.log('');
  console.log('  xxsx serve [port] [--tunnel <type>]   Start the proxy + web console');
  console.log('  xxsx keys                  List providers & keys');
  console.log('  xxsx keys add <key>        Add key to default provider');
  console.log('  xxsx keys remove <idx>     Remove key');
  console.log('  xxsx status                Proxy status');
  console.log('  xxsx test                  Connectivity test');
  console.log('  xxsx config                Show/set config');
  console.log('  xxsx tunnel cloudflare     Start Cloudflare quick tunnel');
  console.log('  xxsx tunnel ngrok          Start ngrok tunnel');
  console.log('  xxsx tunnel stop           Stop tunnel');
  console.log('  xxsx tunnel status         Show tunnel status');
  console.log('  xxsx doctor                Run diagnostics');
  console.log('  xxsx snapshot [path]       Export workspace snapshot');
  console.log('  xxsx mcp [--workspace <d>] Start MCP stdio server');
}

// ---- serve ----
function cmdServe(portArg) {
  logger.init(path.join(BASE_DIR, 'proxy.log'));

  // Migrate old keys.json → providers.json (one-time)
  cfg.migrateIfNeeded();
  const providers = cfg.loadProviders() || {};
  const providerCount = Object.keys(providers).length;

  // Start server
  const { createServer } = require('./lib/routes');
  const { server, PORT, LOCAL_KEY } = createServer(portArg);

  server.listen(PORT, () => {
    const ds = providers['deepseek-web'];
    const dsOk = ds && ds.keys.length > 0;
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════════════════╗');
    console.log('  ║              🚀  xxsx 本地中转已启动                   ║');
    console.log('  ╠═══════════════════════════════════════════════════════════╣');
    console.log('  ║                                                         ║');
    console.log(`  ║  OpenAI    http://localhost:${PORT}/v1/chat/completions     ║`);
    console.log(`  ║  Claude    http://localhost:${PORT}/v1/messages             ║`);
    console.log(`  ║  Web 控制台 http://localhost:${PORT}/web                    ║`);
    console.log(`  ║  接口密钥  ${LOCAL_KEY}                   ║`);
    console.log(`  ║  Provider  ${providerCount} 个${dsOk ? '  |  DS: ✅' : '  |  DS: ⚠️'}                                 ║`);
    console.log('  ║                                                         ║');
    console.log('  ║  Ctrl+C 停止服务                                        ║');
    console.log('  ╚═══════════════════════════════════════════════════════════╝');
    console.log('');

    // Auto-open browser
    const { exec } = require('child_process');
    const url = `http://localhost:${PORT}/web`;
    const plat = process.platform;
    if (plat === 'win32') exec(`start ${url}`);
    else if (plat === 'darwin') exec(`open ${url}`);
    else exec(`xdg-open ${url}`);

    // Auto-start tunnel if --tunnel flag present
    const tunnelIdx = process.argv.indexOf('--tunnel');
    if (tunnelIdx >= 0) {
      const tunnelType = process.argv[tunnelIdx + 1] || 'cloudflare';
      const tunnel = require('./lib/tunnel');
      (async () => {
        try {
          let tunnelUrl;
          if (tunnelType === 'ngrok') tunnelUrl = await tunnel.startNgrok(PORT);
          else tunnelUrl = await tunnel.startCloudflare(PORT);
          console.log(`  🌐 公网地址: ${tunnelUrl}`);
          tunnel.copyToClipboard(tunnelUrl);
          console.log('  📋 已复制到剪贴板');
        } catch (e) {
          console.log(`  ⚠️  隧道启动失败: ${e.message}`);
        }
      })();
    }
  });
}

// ---- tunnel ----
function cmdTunnel(sub) {
  const tunnel = require('./lib/tunnel');
  const port = (cfg.loadCfg()).port || 3457;

  if (sub[0] === 'cloudflare') {
    console.log('Starting Cloudflare tunnel...');
    tunnel.startCloudflare(port).then(url => {
      console.log(`🌐 ${url}`);
      tunnel.copyToClipboard(url);
      console.log('📋 URL copied to clipboard');
    }).catch(e => console.log(`❌ ${e.message}`));
  } else if (sub[0] === 'ngrok') {
    const token = sub[1]; // optional auth token
    console.log('Starting ngrok tunnel...');
    tunnel.startNgrok(port, token).then(url => {
      console.log(`🌐 ${url}`);
      tunnel.copyToClipboard(url);
      console.log('📋 URL copied to clipboard');
    }).catch(e => console.log(`❌ ${e.message}`));
  } else if (sub[0] === 'stop') {
    tunnel.stopTunnel();
    console.log('Tunnel stopped');
  } else if (sub[0] === 'status') {
    const s = tunnel.getStatus();
    if (s.active) console.log(`🌐 Active: ${s.url} (${s.type})`);
    else console.log('No tunnel active');
  } else {
    console.log('Usage: xxsx tunnel [cloudflare|ngrok|stop|status]');
  }
}

// ---- doctor ----
async function cmdDoctor() {
  const doctor = require('./lib/doctor');
  console.log('🔍 Running diagnostics...\n');
  const result = await doctor.runDiagnostics();
  console.log(result.report);
}

// ---- snapshot ----
function cmdSnapshot(sub) {
  const snapshot = require('./lib/snapshot');
  const wsPath = sub[0] || process.cwd();
  const includeFiles = [];
  // Parse --files=... flag
  const filesIdx = process.argv.indexOf('--files');
  if (filesIdx >= 0 && process.argv[filesIdx + 1]) {
    includeFiles.push(...process.argv[filesIdx + 1].split(','));
  }
  console.log(`📦 Creating snapshot of: ${wsPath}`);
  snapshot.createSnapshot({ workspacePath: wsPath, includeFiles, includeGit: true }).then(r => {
    console.log(`✅ Saved to ${r.filePath}`);
    console.log(`📄 ${r.fileSize} bytes`);
  }).catch(e => console.log(`❌ ${e.message}`));
}

// ---- mcp ----
function cmdMcp(sub) {
  // Parse --workspace flag
  const wsIdx = process.argv.indexOf('--workspace');
  if (wsIdx >= 0 && process.argv[wsIdx + 1]) {
    const tools = require('./lib/tools');
    tools.setWorkspace(process.argv[wsIdx + 1]);
  }
  const mcp = require('./lib/mcp');
  console.error('xxsx MCP stdio server starting...');
  mcp.startStdio();
}

// ---- keys ----
function cmdKeys(sub) {
  cfg.migrateIfNeeded();
  const providers = cfg.loadProviders() || {};

  if (sub[0] === 'add' && sub[1]) {
    // Add to default OpenAI text provider by default
    const target = cfg.getDefaultProvider({ capability: 'text', type: 'openai' });
    if (!target || !providers[target.id]) return console.log('❌ No OpenAI provider found. Add via Web console first.');
    providers[target.id].keys.push(sub[1]);
    cfg.saveProviders(providers);
    return console.log(`✅ Added to ${target.name}. Total: ${providers[target.id].keys.length} keys`);
  }

  if (sub[0] === 'remove' && sub[1]) {
    const idx = parseInt(sub[1]);
    const target = cfg.getDefaultProvider({ capability: 'text', type: 'openai' });
    if (target && providers[target.id] && idx >= 0 && idx < providers[target.id].keys.length) {
      const removed = providers[target.id].keys.splice(idx, 1)[0];
      cfg.saveProviders(providers);
      return console.log(`🗑️ Removed from ${target.name}: ${removed.slice(0, 16)}...`);
    }
    return console.log('❌ Index out of range');
  }

  // List
  console.log('');
  for (const [id, p] of Object.entries(providers)) {
    console.log(`🏢 ${p.name} (${id})  →  ${p.host}${p.basePath}  |  ${p.keys.length} keys  |  ${(p.models||[]).map(m => typeof m === 'string' ? m : m.id).join(', ')}`);
  }
  if (!Object.keys(providers).length) console.log('No providers yet. Keys will auto-migrate on first serve.');
}

// ---- test ----
function cmdTest() {
  const target = cfg.getDefaultProvider({ capability: 'text', type: 'openai' });
  if (!target || !target.keys.length) return console.log('❌ No provider with keys');

  const key = target.keys[0];
  const modelPath = target.basePath ? `${target.basePath}/models` : '/v1/models';
  const req = https.request({
    hostname: target.host, port: 443, path: modelPath, method: 'GET',
    headers: { Authorization: `Bearer ${key}` }, timeout: 10000,
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      console.log(`Upstream (${target.name}): ${res.statusCode === 200 ? '✅ connected' : '❌ ' + res.statusCode}`);
      if (res.statusCode === 200) {
        const models = JSON.parse(d).data?.map(m => m.id) || [];
        console.log('Models:', models.join(', '));
      }
    });
  });
  req.on('error', () => console.log('❌ Cannot reach', target.host));
  req.end();
}

// ---- status ----
function cmdStatus() {
  const providers = cfg.loadProviders() || {};
  const cfgData = cfg.loadCfg();
  const defaultText = cfg.getDefaultProvider({ capability: 'text', type: 'openai' });
  const defaultTool = cfg.getDefaultProvider({ capability: 'tool', type: 'openai' });
  console.log(`Config: port=${cfgData.port}, local_key=${cfgData.local_key}`);
  console.log(`Providers: ${Object.keys(providers).length}`);
  console.log(`Default text provider: ${defaultText ? `${defaultText.name} (${defaultText.id})` : '(none)'}`);
  console.log(`Default tool provider: ${defaultTool ? `${defaultTool.name} (${defaultTool.id})` : '(none)'}`);
  for (const [id, p] of Object.entries(providers)) {
    const toolProtocol = p.toolProtocol || (p.type === 'deepseek-web' ? 'deepseek-tag' : p.type === 'anthropic' ? 'anthropic' : 'openai');
    console.log(`  ${p.name} (${id}): ${p.keys.length} keys, ${(p.models||[]).length} models, type=${p.type}, toolProtocol=${toolProtocol}, priority=${p.priority ?? '(none)'}`);
  }
}

// ---- config ----
function cmdConfig(sub) {
  const c = cfg.loadCfg();
  if (sub[0] === 'local_key' && sub[1]) { c.local_key = sub[1]; cfg.saveCfg(c); console.log('✅ local_key updated'); }
  else if (sub[0] === 'port' && sub[1]) { c.port = parseInt(sub[1]); cfg.saveCfg(c); console.log('✅ port updated'); }
  else console.log(JSON.stringify(c, null, 2));
}
