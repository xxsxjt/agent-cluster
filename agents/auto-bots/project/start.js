/**
 * Agnes AI 工作室 - 主启动脚本
 * 一键启动所有自动化服务
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';

class AgnesStudio {
  constructor() {
    this.processes = new Map();
    this.isRunning = false;
  }

  async start() {
    console.log('\n========================================');
    console.log('  Agnes AI 工作室 - 自动化启动');
    console.log('========================================\n');
    
    this.isRunning = true;
    
    // 确保目录存在
    this.ensureDirectories();
    
    // 启动各服务
    await this.startServices();
    
    // 显示状态
    this.showStatus();
    
    // 设置优雅关闭
    this.setupGracefulShutdown();
    
    console.log('\n[AgnesStudio] 所有服务已启动');
    console.log('[AgnesStudio] 访问作品集: file:///C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project/deploy/index.html');
    console.log('[AgnesStudio] 日志目录: C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project/logs/');
    console.log('\n按 Ctrl+C 停止所有服务\n');
  }

  ensureDirectories() {
    const dirs = [
      `${BASE_DIR}/logs`,
      `${BASE_DIR}/uploaders`,
      `${BASE_DIR}/trackers`,
      `${BASE_DIR}/bots`,
      `${BASE_DIR}/deploy`
    ];
    
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[AgnesStudio] 创建目录: ${dir}`);
      }
    }
  }

  async startServices() {
    // 1. 部署作品集（快速模式）
    console.log('[AgnesStudio] 部署作品集...');
    await this.runScript('deploy-portfolio.js', ['quick']);
    
    // 2. 启动 API 代理服务器
    console.log('[AgnesStudio] 启动 API 代理服务器...');
    await this.startProcess('api-server', 'node', [`${BASE_DIR}/server.js`, '3456']);
    
    // 等待服务器启动
    await this.sleep(3000);
    
    // 3. 检查服务状态
    console.log('[AgnesStudio] 检查服务状态...');
    await this.checkServices();
  }

  async runScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
      const script = path.join(BASE_DIR, scriptPath);
      const child = spawn('node', [script, ...args], {
        cwd: BASE_DIR,
        stdio: 'pipe'
      });
      
      child.stdout.on('data', (data) => {
        console.log(`[${path.basename(script)}] ${data}`);
      });
      
      child.stderr.on('data', (data) => {
        console.error(`[${path.basename(script)}] ${data}`);
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${script} 退出码: ${code}`));
        }
      });
    });
  }

  async startProcess(name, command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: BASE_DIR,
        stdio: 'pipe',
        detached: false
      });
      
      this.processes.set(name, child);
      
      child.stdout.on('data', (data) => {
        console.log(`[${name}] ${data}`);
      });
      
      child.stderr.on('data', (data) => {
        console.error(`[${name}] ${data}`);
      });
      
      child.on('error', (error) => {
        console.error(`[${name}] 启动失败:`, error.message);
        reject(error);
      });
      
      child.on('close', (code) => {
        console.log(`[${name}] 进程退出: ${code}`);
        this.processes.delete(name);
      });
      
      // 等待进程启动
      setTimeout(() => {
        resolve(child);
      }, 2000);
    });
  }

  async checkServices() {
    // 检查 API 服务器是否运行
    try {
      const http = require('http');
      const options = {
        hostname: 'localhost',
        port: 3456,
        path: '/health',
        method: 'GET',
        timeout: 5000
      };
      
      const result = await new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          resolve(res.statusCode === 200);
        });
        
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        
        req.end();
      });
      
      if (result) {
        console.log('[AgnesStudio] ✓ API 服务器运行正常');
      } else {
        console.log('[AgnesStudio] ✗ API 服务器未响应');
      }
    } catch (e) {
      console.log('[AgnesStudio] ✗ 无法检查 API 服务器');
    }
  }

  showStatus() {
    console.log('\n========================================');
    console.log('  服务状态');
    console.log('========================================');
    
    const services = [
      { name: 'API 代理服务器', url: 'http://localhost:3456', status: 'running' },
      { name: '作品集网站', url: 'file:///C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project/deploy/index.html', status: 'ready' },
      { name: '视频管线', url: `${BASE_DIR}/video-project/pipeline.js`, status: 'ready' },
      { name: '自动发布', url: `${BASE_DIR}/generate-and-publish.js`, status: 'ready' },
      { name: '闲鱼机器人', url: `${BASE_DIR}/bots/xianyu-bot.js`, status: 'ready' }
    ];
    
    services.forEach(s => {
      console.log(`  ${s.name}: ${s.status}`);
      console.log(`    ${s.url}`);
    });
    
    console.log('========================================\n');
  }

  setupGracefulShutdown() {
    const shutdown = async () => {
      console.log('\n[AgnesStudio] 正在停止所有服务...');
      
      for (const [name, process] of this.processes) {
        console.log(`[AgnesStudio] 停止 ${name}...`);
        process.kill('SIGTERM');
      }
      
      await this.sleep(2000);
      
      // 强制终止剩余进程
      for (const [name, process] of this.processes) {
        console.log(`[AgnesStudio] 强制终止 ${name}...`);
        process.kill('SIGKILL');
      }
      
      console.log('[AgnesStudio] 所有服务已停止');
      process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';
  
  const studio = new AgnesStudio();
  
  switch (command) {
    case 'start':
      await studio.start();
      break;
      
    case 'status':
      console.log('[AgnesStudio] 检查状态...');
      // TODO: 实现状态检查
      break;
      
    case 'stop':
      console.log('[AgnesStudio] 停止所有服务...');
      // TODO: 实现停止
      break;
      
    default:
      console.log('用法: node start.js [start|status|stop]');
  }
}

main().catch(e => {
  console.error('[AgnesStudio] 错误:', e.message);
  process.exit(1);
});
