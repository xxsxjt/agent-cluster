/**
 * 安全的视频生成 + 审核 + 发布脚本
 * 加入人工审核环节，避免平台检测
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';
const VIDEO_DIR = `${BASE_DIR}/video-project`;
const LOG_DIR = `${BASE_DIR}/logs`;
const PENDING_DIR = `${BASE_DIR}/pending`;

class SafePublisher {
  constructor() {
    this.costLog = [];
    this.revenueLog = [];
    this.init();
  }

  init() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    if (!fs.existsSync(PENDING_DIR)) {
      fs.mkdirSync(PENDING_DIR, { recursive: true });
    }
    console.log('[SafePublisher] 初始化完成');
  }

  async run(options = {}) {
    const {
      scene = null,
      autoApprove = false,
      platforms = ['douyin', 'bilibili', 'xiaohongshu']
    } = options;

    console.log('\n========== 安全视频生成 + 审核 ==========\n');

    try {
      // Phase 1: 生成视频
      console.log('>>> Phase 1: 生成视频');
      const video = await this.generateVideo(scene);
      
      // Phase 2: 成本追踪
      console.log('\n>>> Phase 2: 记录成本');
      const cost = await this.trackCost(video);
      
      // Phase 3: 保存到待审核目录
      console.log('\n>>> Phase 3: 保存到待审核目录');
      const pending = await this.saveToPending(video, cost);
      
      // Phase 4: 生成报告
      console.log('\n>>> Phase 4: 生成报告');
      await this.generateReport(video, cost, pending);
      
      console.log('\n========== 完成 ==========');
      console.log('\n下一步操作:');
      console.log(`  1. 审核视频: ${pending.path}`);
      console.log(`  2. 确认后发布: node uploaders/index.js approve ${pending.pendingId}`);
      console.log(`  3. 或批量发布: node uploaders/index.js approve-all`);
      
      return { video, cost, pending };
      
    } catch (error) {
      console.error('执行失败:', error);
      await this.logError(error);
      throw error;
    }
  }

  async generateVideo(sceneId = null) {
    console.log('  开始生成视频...');
    
    // 检查 API 服务器是否运行
    try {
      const http = require('http');
      await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: 3456,
          path: '/health',
          method: 'GET',
          timeout: 5000
        }, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error('API 服务器未响应'));
          }
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('API 服务器连接超时'));
        });
        req.end();
      });
      console.log('  API 服务器正常');
    } catch (error) {
      throw new Error('API 服务器未运行，请先启动: node server.js');
    }
    
    const phase = sceneId ? 'videos' : 'all';
    const args = ['video-project/pipeline.js', phase];
    
    if (sceneId) {
      args.push(sceneId);
    }
    
    try {
      const result = execSync(`node ${args.join(' ')}`, {
        cwd: BASE_DIR,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 600000 // 10 分钟超时
      });
      
      console.log(`  视频生成完成`);
      
      // 查找生成的视频文件
      const videos = fs.readdirSync(`${VIDEO_DIR}/videos`)
        .filter(f => f.endsWith('.mp4') && !f.includes('extended'))
        .sort();
      
      if (videos.length === 0) {
        throw new Error('未找到生成的视频文件');
      }
      
      const latestVideo = videos[videos.length - 1];
      const videoPath = `${VIDEO_DIR}/videos/${latestVideo}`;
      
      return {
        path: videoPath,
        sceneId: sceneId || 'all',
        timestamp: new Date().toISOString(),
        size: fs.statSync(videoPath).size
      };
      
    } catch (error) {
      console.error('  视频生成失败:', error.message);
      throw error;
    }
  }

  async trackCost(video) {
    const cost = {
      imageGeneration: 0.05,
      videoGeneration: 1.5,
      total: 1.55,
      currency: 'CNY',
      videoSize: video.size,
      timestamp: new Date().toISOString()
    };
    
    const logFile = `${LOG_DIR}/cost-${Date.now()}.json`;
    fs.writeFileSync(logFile, JSON.stringify(cost, null, 2));
    
    this.costLog.push(cost);
    console.log(`  成本: ¥${cost.total}`);
    
    return cost;
  }

  async saveToPending(video, cost) {
    const pendingId = `pending_${Date.now()}`;
    const pendingPath = path.join(PENDING_DIR, `${pendingId}.mp4`);
    
    // 复制视频到待审核目录
    fs.copyFileSync(video.path, pendingPath);
    
    // 保存元数据
    const meta = {
      id: pendingId,
      videoPath: pendingPath,
      originalPath: video.path,
      cost: cost,
      sceneId: video.sceneId,
      timestamp: video.timestamp,
      status: 'pending',
      platforms: ['douyin', 'bilibili', 'xiaohongshu']
    };
    
    const metaPath = path.join(PENDING_DIR, `${pendingId}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    
    console.log(`  已保存到待审核目录: ${pendingId}`);
    
    return {
      pendingId: pendingId,
      path: pendingPath,
      metaPath: metaPath
    };
  }

  async generateReport(video, cost, pending) {
    const report = {
      runId: Date.now(),
      timestamp: new Date().toISOString(),
      video: {
        path: video.path,
        size: video.size,
        sceneId: video.sceneId
      },
      cost: cost.total,
      pending: pending.pendingId,
      status: 'pending_approval',
      nextAction: `node uploaders/index.js approve ${pending.pendingId}`
    };
    
    const reportFile = `${LOG_DIR}/report-${Date.now()}.json`;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    
    console.log(`\n  报告已保存: ${reportFile}`);
    
    return report;
  }

  async logError(error) {
    const errorLog = {
      timestamp: new Date().toISOString(),
      error: error.message,
      stack: error.stack
    };
    const logFile = `${LOG_DIR}/error-${Date.now()}.json`;
    fs.writeFileSync(logFile, JSON.stringify(errorLog, null, 2));
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const options = {
    scene: args.find(a => a.startsWith('--scene='))?.split('=')[1],
    autoApprove: args.includes('--approve'),
    platforms: args.find(a => a.startsWith('--platforms='))?.split('=')[1]?.split(',') ||
      ['douyin', 'bilibili', 'xiaohongshu']
  };
  
  const publisher = new SafePublisher();
  await publisher.run(options);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
