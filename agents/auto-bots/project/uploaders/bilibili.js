/**
 * B站自动上传脚本（反检测优化版）
 */

const { chromium } = require('playwright');

class BilibiliUploader {
  constructor() {
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.userDataDir = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project/.browsers/bilibili';
  }

  async init() {
    console.log('[Bilibili] 初始化浏览器（反检测模式）...');
    
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
    await this.injectAntiDetection();
    await this.checkLoginStatus();
  }

  async injectAntiDetection() {
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });
      
      window.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {}
      };
      
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en']
      });
    });
  }

  async checkLoginStatus() {
    try {
      await this.page.goto('https://member.bilibili.com/platform/upload/video/frame', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      
      await this.randomDelay(3000, 5000);
      
      const loginBtn = await this.page.$('text=登录');
      if (loginBtn) {
        console.log('[Bilibili] 需要登录');
        await this.waitForLogin();
      } else {
        console.log('[Bilibili] 已登录');
        this.loggedIn = true;
      }
    } catch (error) {
      await this.waitForLogin();
    }
  }

  async waitForLogin() {
    console.log('[Bilibili] 请在浏览器中登录...');
    
    for (let i = 0; i < 120; i++) {
      await this.randomDelay(5000, 8000);
      
      try {
        const uploadArea = await this.page.$('.upload-area, .video-upload, .upload-container');
        if (uploadArea) {
          console.log('[Bilibili] 登录成功');
          this.loggedIn = true;
          return true;
        }
        
        const url = this.page.url();
        if (url.includes('member.bilibili.com') && !url.includes('login')) {
          console.log('[Bilibili] 登录成功');
          this.loggedIn = true;
          return true;
        }
      } catch (e) {
        // 继续等待
      }
    }
    
    throw new Error('登录超时');
  }

  async upload(videoPath, metadata = {}) {
    if (!this.loggedIn) {
      await this.init();
    }

    console.log(`[Bilibili] 开始上传: ${videoPath}`);
    
    try {
      await this.page.goto('https://member.bilibili.com/platform/upload/video/frame');
      await this.randomDelay(3000, 5000);
      
      // 随机鼠标移动
      await this.randomMouseMove();
      
      // 选择文件
      const fileInput = await this.page.$('input[type="file"]');
      if (!fileInput) {
        throw new Error('找不到文件上传按钮');
      }
      
      await this.randomDelay(1000, 2000);
      await fileInput.setInputFiles(videoPath);
      console.log('[Bilibili] 文件已选择');
      
      console.log('[Bilibili] 等待上传...');
      await this.randomDelay(45000, 90000);
      
      // 填写标题
      const title = metadata.title || 'AI 生成视频';
      await this.humanType('input[placeholder*="标题"]', title);
      await this.randomDelay(2000, 3000);
      
      // 选择分区
      const category = metadata.category || '科技';
      try {
        await this.page.selectOption('select[name="category"]', category);
        await this.randomDelay(1000, 2000);
      } catch (e) {
        console.log('[Bilibili] 分区选择失败，使用默认');
      }
      
      // 随机滚动
      await this.randomScroll();
      
      // 发布
      console.log('[Bilibili] 点击发布...');
      const publishBtn = await this.page.$('button:has-text("立即投稿"), button:has-text("发布")');
      if (publishBtn) {
        await this.randomDelay(1000, 3000);
        await publishBtn.click();
      } else {
        throw new Error('找不到发布按钮');
      }
      
      await this.randomDelay(10000, 15000);
      
      const url = await this.page.url();
      console.log(`[Bilibili] 发布成功: ${url}`);
      
      return {
        url: url,
        videoId: `bilibili_${Date.now()}`,
        platform: 'bilibili'
      };
      
    } catch (error) {
      console.error('[Bilibili] 上传失败:', error.message);
      throw error;
    }
  }

  async humanType(selector, text) {
    const element = await this.page.$(selector);
    if (!element) return;
    
    await element.click();
    await this.randomDelay(500, 1000);
    
    for (const char of text) {
      await element.type(char);
      await this.randomDelay(50, 150);
    }
  }

  async randomMouseMove() {
    const x = Math.random() * 500 + 100;
    const y = Math.random() * 300 + 100;
    await this.page.mouse.move(x, y);
    await this.randomDelay(500, 1000);
  }

  async randomScroll() {
    const scrollAmount = Math.random() * 300 + 100;
    await this.page.evaluate(`window.scrollBy(0, ${scrollAmount})`);
    await this.randomDelay(1000, 2000);
    await this.page.evaluate('window.scrollTo(0, 0)');
    await this.randomDelay(500, 1000);
  }

  async randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
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

async function testMode() {
  console.log('[Bilibili] 测试模式（模拟操作）');
  
  const uploader = new BilibiliUploader();
  await uploader.init();
  
  console.log('[Bilibili] 模拟上传操作完成');
  await uploader.close();
}

module.exports = { BilibiliUploader, testMode };
