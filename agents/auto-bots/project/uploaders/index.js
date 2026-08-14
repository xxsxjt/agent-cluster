/**
 * 上传管理器（带人工审核）
 * 避免自动化检测，增加安全层
 */

const { DouyinUploader, testMode: douyinTest } = require('./douyin');
const { BilibiliUploader, testMode: bilibiliTest } = require('./bilibili');
const { XiaohongshuUploader, testMode: xiaohongshuTest } = require('./xiaohongshu');
const fs = require('fs');
const path = require('path');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';
const PENDING_DIR = `${BASE_DIR}/pending`;

class UploadManager {
  constructor() {
    this.uploaders = {
      douyin: new DouyinUploader(),
      bilibili: new BilibiliUploader(),
      xiaohongshu: new XiaohongshuUploader()
    };
    
    this.pendingQueue = [];
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(PENDING_DIR)) {
      fs.mkdirSync(PENDING_DIR, { recursive: true });
    }
  }

  /**
   * 安全上传流程（带人工审核）
   * 1. 生成视频
   * 2. 保存到待审核目录
   * 3. 人工确认后发布
   */
  async safeUpload(videoPath, metadata = {}) {
    console.log('\n========== 安全上传流程 ==========\n');
    
    // 1. 保存到待审核目录
    const pendingId = `pending_${Date.now()}`;
    const pendingPath = path.join(PENDING_DIR, `${pendingId}.mp4`);
    
    fs.copyFileSync(videoPath, pendingPath);
    
    // 保存元数据
    const metaPath = path.join(PENDING_DIR, `${pendingId}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      id: pendingId,
      videoPath: pendingPath,
      metadata: metadata,
      createdAt: new Date().toISOString(),
      status: 'pending'
    }, null, 2));
    
    console.log(`[UploadManager] 视频已保存到待审核目录:`);
    console.log(`  路径: ${pendingPath}`);
    console.log(`  元数据: ${metaPath}`);
    console.log(`\n[UploadManager] 请人工审核后运行:`);
    console.log(`  node uploaders/index.js approve ${pendingId}`);
    console.log(`\n或批量审核:`);
    console.log(`  node uploaders/index.js approve-all`);
    
    return {
      pendingId: pendingId,
      status: 'pending',
      path: pendingPath
    };
  }

  /**
   * 人工审核后发布
   */
  async approveAndUpload(pendingId, platforms = ['douyin', 'bilibili', 'xiaohongshu']) {
    const metaPath = path.join(PENDING_DIR, `${pendingId}.json`);
    
    if (!fs.existsSync(metaPath)) {
      throw new Error(`待审核记录不存在: ${pendingId}`);
    }
    
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const videoPath = meta.videoPath;
    const metadata = meta.metadata;
    
    console.log(`[UploadManager] 审核通过，开始发布: ${pendingId}`);
    
    const results = {};
    
    for (const platformId of platforms) {
      const uploader = this.uploaders[platformId];
      if (!uploader) {
        console.log(`[UploadManager] 跳过未知平台: ${platformId}`);
        continue;
      }
      
      try {
        console.log(`\n[UploadManager] 发布到 ${platformId}...`);
        const result = await uploader.upload(videoPath, metadata);
        results[platformId] = result;
        console.log(`[UploadManager] ✓ ${platformId} 发布成功`);
        
        // 平台间隔，避免频率限制
        await this.randomDelay(5000, 10000);
        
      } catch (error) {
        results[platformId] = {
          success: false,
          error: error.message
        };
        console.log(`[UploadManager] ✗ ${platformId} 发布失败: ${error.message}`);
      }
    }
    
    // 更新状态
    meta.status = 'uploaded';
    meta.uploadedAt = new Date().toISOString();
    meta.results = results;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    
    // 移动到已完成目录
    const doneDir = `${BASE_DIR}/done`;
    if (!fs.existsSync(doneDir)) {
      fs.mkdirSync(doneDir, { recursive: true });
    }
    
    fs.renameSync(metaPath, path.join(doneDir, `${pendingId}.json`));
    fs.renameSync(videoPath, path.join(doneDir, `${pendingId}.mp4`));
    
    console.log(`\n[UploadManager] 发布完成！`);
    console.log(`[UploadManager] 结果: ${JSON.stringify(results, null, 2)}`);
    
    return results;
  }

  /**
   * 列出所有待审核视频
   */
  listPending() {
    const files = fs.readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
    
    console.log('\n========== 待审核视频 ==========\n');
    
    if (files.length === 0) {
      console.log('暂无待审核视频');
      return [];
    }
    
    for (const file of files) {
      const meta = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, file), 'utf8'));
      console.log(`ID: ${meta.id}`);
      console.log(`  创建时间: ${meta.createdAt || meta.timestamp || '未知'}`);
      console.log(`  状态: ${meta.status}`);
      console.log(`  路径: ${meta.videoPath}`);
      if (meta.metadata && meta.metadata.title) {
        console.log(`  标题: ${meta.metadata.title}`);
      } else if (meta.sceneId) {
        console.log(`  场景: ${meta.sceneId}`);
      }
      console.log('');
    }
    
    return files.map(f => JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')));
  }

  /**
   * 批量审核并发布
   */
  async approveAll(platforms = ['douyin', 'bilibili', 'xiaohongshu']) {
    const pending = this.listPending();
    
    if (pending.length === 0) {
      console.log('[UploadManager] 没有待审核视频');
      return;
    }
    
    console.log(`[UploadManager] 开始批量审核 ${pending.length} 个视频...`);
    
    for (const item of pending) {
      if (item.status === 'pending') {
        try {
          await this.approveAndUpload(item.id, platforms);
          await this.randomDelay(10000, 30000); // 视频间隔
        } catch (error) {
          console.error(`[UploadManager] 审核失败 ${item.id}:`, error.message);
        }
      }
    }
  }

  async randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const pendingId = args[1];
  
  const manager = new UploadManager();
  
  switch (command) {
    case 'list':
      manager.listPending();
      break;
      
    case 'approve':
      if (!pendingId) {
        console.log('用法: node index.js approve <pendingId> [platforms]');
        return;
      }
      const platforms = args[2] ? args[2].split(',') : ['douyin', 'bilibili', 'xiaohongshu'];
      await manager.approveAndUpload(pendingId, platforms);
      break;
      
    case 'approve-all':
      const allPlatforms = args[1] ? args[1].split(',') : ['douyin', 'bilibili', 'xiaohongshu'];
      await manager.approveAll(allPlatforms);
      break;
      
    case 'test':
      // 测试模式：模拟操作
      await douyinTest();
      await bilibiliTest();
      await xiaohongshuTest();
      break;
      
    default:
      console.log('用法:');
      console.log('  node index.js list                    - 列出待审核视频');
      console.log('  node index.js approve <id> [platforms] - 审核并发布');
      console.log('  node index.js approve-all [platforms]  - 批量审核');
      console.log('  node index.js test                     - 测试模式');
  }
}

main().catch(e => {
  console.error('[UploadManager] 错误:', e.message);
  process.exit(1);
});
