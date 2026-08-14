/**
 * 抖音自动上传脚本（反检测优化版）
 * 模拟真人操作，避免被平台检测为机器人
 */

const { chromium } = require('playwright');
const fs = require('fs');

class DouyinUploader {
  constructor() {
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.userDataDir = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project/.browsers/douyin';
  }

  async init() {
    console.log('[Douyin] 初始化浏览器（反检测模式）...');
    
    // 使用持久化上下文，保存登录态
    const context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    this.page = await context.newPage();
    
    // 注入反检测脚本
    await this.injectAntiDetection();
    
    // 检查登录状态
    await this.checkLoginStatus();
  }

  async injectAntiDetection() {
    // 移除 webdriver 标记
    await this.page.addInitScript(() => {
      // 覆盖 navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });
      
      // 覆盖 chrome 对象
      window.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {}
      };
      
      // 覆盖 permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
      
      // 覆盖 plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      
      // 覆盖 languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en']
      });
    });
    
    console.log('[Douyin] 反检测脚本已注入');
  }

  async checkLoginStatus() {
    try {
      await this.page.goto('https://creator.douyin.com', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      
      await this.randomDelay(3000, 5000);
      
      // 检查是否需要登录
      const loginBtn = await this.page.$('text=登录');
      if (loginBtn) {
        console.log('[Douyin] 需要登录，请手动扫码...');
        await this.waitForLogin();
      } else {
        console.log('[Douyin] 已登录');
        this.loggedIn = true;
      }
    } catch (error) {
      console.log('[Douyin] 登录检查失败，尝试等待...');
      await this.waitForLogin();
    }
  }

  async waitForLogin() {
    // 等待用户手动登录（最多 10 分钟）
    console.log('[Douyin] 请在浏览器中扫码登录...');
    
    for (let i = 0; i < 120; i++) {
      await this.randomDelay(5000, 8000);
      
      try {
        // 检查是否进入创作者中心
        const dashboard = await this.page.$('.dashboard, .home, [data-testid="dashboard"], .upload-container');
        if (dashboard) {
          console.log('[Douyin] 登录成功');
          this.loggedIn = true;
          return true;
        }
        
        // 检查 URL 是否跳转
        const url = this.page.url();
        if (url.includes('creator.douyin.com') && !url.includes('login')) {
          console.log('[Douyin] 登录成功');
          this.loggedIn = true;
          return true;
        }
      } catch (e) {
        // 继续等待
      }
    }
    
    throw new Error('登录超时，请重试');
  }

  async upload(videoPath, metadata = {}) {
    if (!this.loggedIn) {
      await this.init();
    }

    console.log(`[Douyin] 开始上传: ${videoPath}`);
    
    try {
      // 1. 进入上传页面（模拟真人点击）
      await this.page.goto('https://creator.douyin.com/creator-micro/content/upload');
      await this.randomDelay(3000, 5000);
      
      // 2. 随机移动鼠标（模拟真人）
      await this.randomMouseMove();
      
      // 3. 选择文件
      const fileInput = await this.page.$('input[type="file"]');
      if (!fileInput) {
        throw new Error('找不到文件上传按钮');
      }
      
      // 模拟点击上传区域
      await this.randomDelay(1000, 2000);
      await fileInput.setInputFiles(videoPath);
      console.log('[Douyin] 文件已选择');
      
      // 4. 等待上传完成（模拟真人等待）
      console.log('[Douyin] 等待上传...');
      await this.randomDelay(30000, 60000);
      
      // 5. 填写标题和描述（随机延迟）
      const title = metadata.title || 'AI 生成视频';
      const desc = metadata.description || '使用 AI 技术生成的视频内容';
      
      // 模拟打字效果
      await this.humanType('textarea[placeholder*="标题"]', title);
      await this.randomDelay(2000, 3000);
      await this.humanType('textarea[placeholder*="描述"]', desc);
      
      // 6. 添加标签
      if (metadata.tags && metadata.tags.length > 0) {
        await this.randomDelay(1000, 2000);
        const tagsInput = await this.page.$('input[placeholder*="标签"], input[placeholder*="话题"]');
        if (tagsInput) {
          for (const tag of metadata.tags) {
            await this.humanType(tagsInput, tag);
            await this.page.keyboard.press('Enter');
            await this.randomDelay(500, 1000);
          }
        }
      }
      
      // 7. 随机滚动页面（模拟真人浏览）
      await this.randomScroll();
      
      // 8. 点击发布（模拟点击）
      console.log('[Douyin] 点击发布...');
      const publishBtn = await this.page.$('button:has-text("发布"), button:has-text("上传")');
      if (publishBtn) {
        await this.randomDelay(1000, 3000);
        await publishBtn.click();
      } else {
        throw new Error('找不到发布按钮');
      }
      
      // 9. 等待发布完成
      await this.randomDelay(10000, 15000);
      
      // 10. 获取视频链接
      const url = await this.page.url();
      console.log(`[Douyin] 发布成功: ${url}`);
      
      return {
        url: url,
        videoId: this.extractVideoId(url),
        platform: 'douyin'
      };
      
    } catch (error) {
      console.error('[Douyin] 上传失败:', error.message);
      throw error;
    }
  }

  // 模拟真人打字
  async humanType(selector, text) {
    const element = await this.page.$(selector);
    if (!element) return;
    
    await element.click();
    await this.randomDelay(500, 1000);
    
    for (const char of text) {
      await element.type(char);
      await this.randomDelay(50, 150); // 随机打字速度
    }
  }

  // 随机鼠标移动
  async randomMouseMove() {
    const x = Math.random() * 500 + 100;
    const y = Math.random() * 300 + 100;
    await this.page.mouse.move(x, y);
    await this.randomDelay(500, 1000);
  }

  // 随机滚动页面
  async randomScroll() {
    const scrollAmount = Math.random() * 300 + 100;
    await this.page.evaluate(`window.scrollBy(0, ${scrollAmount})`);
    await this.randomDelay(1000, 2000);
    await this.page.evaluate('window.scrollTo(0, 0)');
    await this.randomDelay(500, 1000);
  }

  // 随机延迟（模拟真人操作间隔）
  async randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  extractVideoId(url) {
    const match = url.match(/video\/(\d+)/);
    return match ? match[1] : Date.now().toString();
  }

  async close() {
    if (this.page) {
      await this.page.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// 测试模式：只模拟操作，不实际上传
async function testMode() {
  console.log('[Douyin] 测试模式（模拟操作）');
  
  const uploader = new DouyinUploader();
  await uploader.init();
  
  console.log('[Douyin] 模拟上传操作完成');
  await uploader.close();
}

module.exports = { DouyinUploader, testMode };
