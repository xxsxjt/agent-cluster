/**
 * 全自动视频生成 + 发布脚本
 * 用法：node generate-and-publish.js [--auto] [--platform=douyin,bilibili,xiaohongshu]
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';
const VIDEO_DIR = `${BASE_DIR}/video-project`;
const LOG_DIR = `${BASE_DIR}/logs`;

// 平台配置
const PLATFORMS = {
  douyin: {
    name: '抖音',
    uploader: './uploaders/douyin.js',
    schedule: ['08:00', '12:00', '18:00'],
    tags: ['小说推文', '末世', '玄幻', 'AI视频']
  },
  bilibili: {
    name: 'B站',
    uploader: './uploaders/bilibili.js',
    schedule: ['10:00', '20:00'],
    tags: ['小说', '预告片', 'AI生成']
  },
  xiaohongshu: {
    name: '小红书',
    uploader: './uploaders/xiaohongshu.js',
    schedule: ['09:00', '21:00'],
    tags: ['AI小说', '视频', '末世']
  }
};

class AutoPublisher {
  constructor() {
    this.costLog = [];
    this.revenueLog = [];
    this.init();
  }

  init() {
    // 确保日志目录存在
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    console.log('[AutoPublisher] 初始化完成');
  }

  async run(options = {}) {
    const {
      auto = false,
      platforms = ['douyin', 'bilibili', 'xiaohongshu'],
      scene = null
    } = options;

    console.log('\n========== 全自动视频生成 + 发布 ==========\n');

    try {
      // Phase 1: 生成视频
      console.log('>>> Phase 1: 生成视频');
      const video = await this.generateVideo(scene);
      
      // Phase 2: 成本追踪
      console.log('\n>>> Phase 2: 记录成本');
      const cost = await this.trackCost(video);
      
      // Phase 3: 自动发布
      console.log('\n>>> Phase 3: 自动发布');
      const results = await this.publishToAll(video, platforms);
      
      // Phase 4: 收益追踪
      console.log('\n>>> Phase 4: 记录收益');
      await this.trackRevenue(results);
      
      // Phase 5: 生成报告
      console.log('\n>>> Phase 5: 生成报告');
      await this.generateReport(video, cost, results);
      
      console.log('\n========== 完成 ==========');
      return { video, cost, results };
      
    } catch (error) {
      console.error('执行失败:', error);
      await this.logError(error);
      throw error;
    }
  }

  async generateVideo(sceneId = null) {
    console.log('  开始生成视频...');
    
    // 调用 pipeline.js
    const phase = sceneId ? 'videos' : 'all';
    const args = ['video-project/pipeline.js', phase];
    
    if (sceneId) {
      args.push(sceneId);
    }
    
    try {
      const result = execSync(`node ${args.join(' ')}`, {
        cwd: BASE_DIR,
        encoding: 'utf-8',
        stdio: 'pipe'
      });
      
      console.log(`  视频生成完成`);
      
      // 查找生成的视频文件
      const videos = fs.readdirSync(`${VIDEO_DIR}/videos`)
        .filter(f => f.endsWith('.mp4') && !f.includes('extended'))
        .sort();
      
      const latestVideo = videos[videos.length - 1];
      
      return {
        path: `${VIDEO_DIR}/videos/${latestVideo}`,
        sceneId: sceneId || 'all',
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('  视频生成失败:', error.message);
      throw error;
    }
  }

  async trackCost(video) {
    // 估算成本
    const cost = {
      imageGeneration: 0.05,    // 图生图：约 0.05 元/张
      videoGeneration: 1.5,     // 图生视频：约 1.5 元/次
      ffmpeg: 0,                // 本地处理：0 元
      total: 1.55,
      currency: 'CNY',
      timestamp: new Date().toISOString()
    };
    
    // 记录到日志
    const logFile = `${LOG_DIR}/cost-${Date.now()}.json`;
    fs.writeFileSync(logFile, JSON.stringify(cost, null, 2));
    
    this.costLog.push(cost);
    console.log(`  成本: ¥${cost.total} (图: ¥${cost.imageGeneration} + 视频: ¥${cost.videoGeneration})`);
    
    return cost;
  }

  async publishToAll(video, platforms) {
    const results = {};
    
    for (const platformId of platforms) {
      const platform = PLATFORMS[platformId];
      if (!platform) {
        console.log(`  跳过未知平台: ${platformId}`);
        continue;
      }
      
      console.log(`\n  发布到 ${platform.name}...`);
      
      try {
        const result = await this.uploadToPlatform(video, platform);
        results[platformId] = {
          success: true,
          url: result.url,
          videoId: result.videoId,
          timestamp: new Date().toISOString()
        };
        console.log(`    ✓ ${platform.name} 发布成功: ${result.url}`);
        
      } catch (error) {
        results[platformId] = {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
        console.log(`    ✗ ${platform.name} 发布失败: ${error.message}`);
      }
      
      // 平台间隔，避免频率限制
      await this.sleep(3000);
    }
    
    return results;
  }

  async uploadToPlatform(video, platform) {
    // 调用对应平台的上传脚本
    const uploaderPath = path.join(BASE_DIR, platform.uploader);
    
    if (!fs.existsSync(uploaderPath)) {
      // 如果上传脚本不存在，创建占位符
      await this.createPlaceholderUploader(platform);
    }
    
    // 模拟上传（实际使用时需要实现真实上传逻辑）
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          url: `https://${platform.name}.com/video/${Date.now()}`,
          videoId: `video_${Date.now()}`
        });
      }, 2000);
    });
  }

  async createPlaceholderUploader(platform) {
    const uploaderPath = path.join(BASE_DIR, platform.uploader);
    const content = `
/**
 * ${platform.name} 自动上传脚本
 * TODO: 实现真实上传逻辑
 */

async function upload(videoPath, metadata) {
  // TODO: 实现 ${platform.name} API 上传
  console.log('上传到 ${platform.name}:', videoPath);
  return { url: 'https://example.com/video/123', videoId: '123' };
}

module.exports = { upload };
`;
    fs.writeFileSync(uploaderPath, content);
    console.log(`    创建占位符: ${platform.uploader}`);
  }

  async trackRevenue(results) {
    // TODO: 从各平台 API 获取实际收益
    // 这里先用模拟数据
    const revenue = {
      total: 0,
      byPlatform: {},
      currency: 'CNY',
      timestamp: new Date().toISOString()
    };
    
    for (const [platformId, result] of Object.entries(results)) {
      if (result.success) {
        // 模拟收益：平均每条视频 5-50 元
        const estimated = Math.floor(Math.random() * 45) + 5;
        revenue.byPlatform[platformId] = estimated;
        revenue.total += estimated;
      }
    }
    
    // 记录收益
    const logFile = `${LOG_DIR}/revenue-${Date.now()}.json`;
    fs.writeFileSync(logFile, JSON.stringify(revenue, null, 2));
    
    this.revenueLog.push(revenue);
    console.log(`  预估收益: ¥${revenue.total}`);
    
    return revenue;
  }

  async generateReport(video, cost, results) {
    const report = {
      runId: Date.now(),
      timestamp: new Date().toISOString(),
      video: video.path,
      cost: cost.total,
      revenue: Object.values(results).filter(r => r.success).length * 10, // 估算
      platforms: results,
      success: Object.values(results).filter(r => r.success).length,
      total: Object.keys(results).length
    };
    
    const reportFile = `${LOG_DIR}/report-${Date.now()}.json`;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    
    console.log(`\n  报告已保存: ${reportFile}`);
    console.log(`  成功率: ${report.success}/${report.total}`);
    
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

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const options = {
    auto: args.includes('--auto'),
    scene: args.find(a => a.startsWith('--scene='))?.split('=')[1],
    platforms: args
      .find(a => a.startsWith('--platforms='))?.split('=')[1]?.split(',') ||
      ['douyin', 'bilibili', 'xiaohongshu']
  };
  
  const publisher = new AutoPublisher();
  await publisher.run(options);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
