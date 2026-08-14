/**
 * 小红书自动上传脚本（反检测优化版）
 */

const { chromium } = require('playwright');

class XiaohongshuUploader {
  constructor() {
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.userDataDir = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project/.browsers/xiaohongshu';
  }

  async init() {
    console.log('[Xiaohongshu] 初始化浏览器（反检测模式）...');
    
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
      await this.page.goto('https://creator.xiaohongshu.com/publish/publish', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      
      await this.randomDelay(3000, 5000);
      
      const loginBtn = await this.page.$('text=登录');
      if (loginBtn) {
        console.log('[Xiaohongshu] 需要登录');
        await this.waitForLogin();
      } else {
        console.log('[Xiaohongshu] 已登录');
        this.loggedIn = true;
      }
    } catch (error) {
      await this.waitForLogin();
    }
  }

  async waitForLogin() {
    console.log('[Xiaohongshu] 请在浏览器中登录...');
    
    for (let i = 0; i < 120; i++) {
      await this.randomDelay(5000, 8000);
      
      try {
        const publishArea = await this.page.$('.publish-area, .upload-area, .publish-container');
        if (publishArea) {
          console.log('[Xiaohongshu] 登录成功');
          this.loggedIn = true;
          return true;
        }
        
        const url = this.page.url();
        if (url.includes('creator.xiaohongshu.com') && !url.includes('login')) {
          console.log('[Xiaohongshu] 登录成功');
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

    console.log(`[Xiaohongshu] 开始上传: ${videoPath}`);
    
    try {
      await this.page.goto('https://creator.xiaohongshu.com/publish/publish');
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
      console.log('[Xiaohongshu] 文件已选择');
      
      console.log('[Xiaohongshu] 等待上传...');
      await this.randomDelay(30000, 60000);
      
      // 填写标题
      const title = metadata.title || 'AI 生成视频';
      await this.humanType('input[placeholder*="标题"]', title);
      await this.randomDelay(2000, 3000);
      
      // 填写内容
      const content = metadata.content || '使用 AI 技术生成的视频内容';
      await this.humanType('textarea[placeholder*="内容"]', content);
      
      // 添加话题
      if (metadata.tags && metadata.tags.length > 0) {
        await this.randomDelay(1000, 2000);
        for (const tag of metadata.tags) {
          const tagInput = await this.page.$('input[placeholder*="话题"]');
          if (tagInput) {
            await this.humanType(tagInput, `#${tag}`);
            await this.page.keyboard.press('Enter');
            await this.randomDelay(500, 1000);
          }
        }
      }
      
      // 随机滚动
      await this.randomScroll();
      
      // 发布
      console.log('[Xiaohongshu] 点击发布...');
      const publishBtn = await this.page.$('button:has-text("发布")');
      if (publishBtn) {
        await this.randomDelay(1000, 3000);
        await publishBtn.click();
      } else {
        throw new Error('找不到发布按钮');
      }
      
      await this.randomDelay(10000, 15000);
      
      const url = await this.page.url();
      console.log(`[Xiaohongshu] 发布成功: ${url}`);
      
      return {
        url: url,
        videoId: `xhs_${Date.now()}`,
        platform: 'xiaohongshu'
      };
      
    } catch (error) {
      console.error('[Xiaohongshu] 上传失败:', error.message);
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
  console.log('[Xiaohongshu] 测试模式（模拟操作）');
  
  const uploader = new XiaohongshuUploader();
  await uploader.init();
  
  console.log('[Xiaohongshu] 模拟上传操作完成');
  await uploader.close();
}

module.exports = { XiaohongshuUploader, testMode };
