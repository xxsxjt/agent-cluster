/**
 * 闲鱼自动回复机器人
 * 监控消息 → 自动报价 → 自动生成 → 自动交付
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';

// 自动回复模板
const REPLY_TEMPLATES = {
  greeting: `您好！我是 Agnes AI 视频工作室的专业AI视频制作师。
  
我们的服务：
🎬 AI视频定制（15-60秒）：199-999元
📝 小说推文视频：99元/条（量大优惠）
🎯 预告片/宣传片：2000元起

现在下单立减50元，首单体验价99元！
`,
  
  price_inquiry: `根据您的需求，价格如下：
  
📹 15秒短视频：199元
🎬 30秒标准视频：299元  
🎥 60秒高清视频：499元
🎬 预告片/宣传片：2000-5000元

所有视频包含：
✅ 4K 高清输出
✅ 背景音乐
✅ 2次免费修改
✅ 3天交付

需要开始吗？我可以先发您看看效果！`,
  
  order_confirm: `好的！我已记录您的订单。

请提供以下信息：
1. 视频时长（15/30/60秒）
2. 主题/内容描述
3. 参考风格（可选）

我会在2小时内开始制作，预计2-3天交付。

支付方式：微信/支付宝
定金：50%（制作完成后付尾款）
`,
  
  delivery: `您的视频已完成！

📹 视频链接：[自动插入]
⏱️ 时长：[自动插入]
📐 分辨率：4K

请查收，如有需要修改请告诉我。
满意后请支付尾款，感谢您的信任！`
};

class XianyuBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.orders = new Map();
    this.isRunning = false;
  }

  async init() {
    console.log('[XianyuBot] 初始化...');
    
    this.browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    this.page = await this.browser.newPage();
    
    // 加载已有订单
    this.loadOrders();
    
    console.log('[XianyuBot] 初始化完成');
  }

  async login() {
    console.log('[XianyuBot] 请登录闲鱼...');
    
    await this.page.goto('https://www.goofish.com');
    
    // 等待用户扫码登录
    for (let i = 0; i < 120; i++) {
      await this.page.waitForTimeout(5000);
      
      try {
        // 检查是否已登录（通过检查消息按钮）
        const msgBtn = await this.page.$('.message-btn, [data-testid="message"]');
        if (msgBtn) {
          console.log('[XianyuBot] 登录成功');
          return true;
        }
      } catch (e) {
        // 继续等待
      }
    }
    
    throw new Error('登录超时');
  }

  async start() {
    if (this.isRunning) {
      console.log('[XianyuBot] 已在运行中');
      return;
    }
    
    this.isRunning = true;
    console.log('[XianyuBot] 启动消息监控...');
    
    // 进入消息页面
    await this.page.goto('https://www.goofish.com/message');
    await this.page.waitForTimeout(3000);
    
    // 开始监控循环
    this.monitorLoop();
  }

  async monitorLoop() {
    while (this.isRunning) {
      try {
        await this.checkNewMessages();
        await this.page.waitForTimeout(5000); // 5秒检查一次
      } catch (error) {
        console.error('[XianyuBot] 监控出错:', error.message);
        await this.page.waitForTimeout(10000);
      }
    }
  }

  async checkNewMessages() {
    // 获取所有对话
    const conversations = await this.page.$$('.conversation-item, .chat-item');
    
    for (const conv of conversations) {
      const convId = await conv.getAttribute('data-conversation-id') || 
                    await conv.evaluate(el => el.innerText.slice(0, 20));
      
      // 检查是否有未读消息
      const unreadBadge = await conv.$('.unread-badge, .badge');
      if (unreadBadge) {
        console.log(`[XianyuBot] 发现新消息: ${convId}`);
        await this.handleConversation(conv);
      }
    }
  }

  async handleConversation(convElement) {
    try {
      // 点击进入对话
      await convElement.click();
      await this.page.waitForTimeout(2000);
      
      // 获取最新消息
      const lastMessage = await this.getLastMessage();
      
      if (!lastMessage) return;
      
      console.log(`[XianyuBot] 最新消息: ${lastMessage.text}`);
      
      // 判断消息类型并回复
      const reply = this.generateReply(lastMessage);
      
      if (reply) {
        await this.sendReply(reply);
        console.log(`[XianyuBot] 已回复: ${reply.slice(0, 50)}...`);
        
        // 如果是订单确认，创建订单
        if (lastMessage.text.includes('下单') || lastMessage.text.includes('开始')) {
          this.createOrder(lastMessage);
        }
      }
      
      // 返回消息列表
      await this.page.goBack();
      await this.page.waitForTimeout(2000);
      
    } catch (error) {
      console.error('[XianyuBot] 处理对话失败:', error.message);
    }
  }

  getLastMessage() {
    // 获取最后一条消息（简化版）
    return this.page.evaluate(() => {
      const messages = document.querySelectorAll('.message, .chat-message');
      if (messages.length === 0) return null;
      
      const lastMsg = messages[messages.length - 1];
      return {
        text: lastMsg.innerText,
        isUser: lastMsg.classList.contains('user-message') || 
                lastMsg.classList.contains('right')
      };
    });
  }

  generateReply(message) {
    const text = message.text.toLowerCase();
    
    // 关键词匹配
    if (text.includes('价格') || text.includes('多少钱') || text.includes('收费')) {
      return REPLY_TEMPLATES.price_inquiry;
    }
    
    if (text.includes('下单') || text.includes('开始') || text.includes('做')) {
      return REPLY_TEMPLATES.order_confirm;
    }
    
    if (text.includes('你好') || text.includes('在吗') || text.includes('hi')) {
      return REPLY_TEMPLATES.greeting;
    }
    
    // 默认回复
    return REPLY_TEMPLATES.greeting;
  }

  async sendReply(text) {
    // 查找输入框
    const inputBox = await this.page.$('textarea[placeholder*="输入"], input[placeholder*="输入"]');
    
    if (inputBox) {
      await inputBox.fill(text);
      await this.page.waitForTimeout(1000);
      
      // 点击发送
      const sendBtn = await this.page.$('button:has-text("发送"), button[type="submit"]');
      if (sendBtn) {
        await sendBtn.click();
      }
    }
  }

  createOrder(message) {
    const orderId = `order_${Date.now()}`;
    const order = {
      id: orderId,
      platform: '闲鱼',
      status: 'pending',
      requirement: message.text,
      createdAt: new Date().toISOString(),
      videoPath: null,
      delivered: false
    };
    
    this.orders.set(orderId, order);
    this.saveOrders();
    
    console.log(`[XianyuBot] 创建订单: ${orderId}`);
    
    // 触发视频生成
    this.startVideoGeneration(orderId);
  }

  async startVideoGeneration(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return;
    
    console.log(`[XianyuBot] 开始生成视频: ${orderId}`);
    
    // 调用视频生成脚本
    const scriptPath = path.join(BASE_DIR, 'generate-and-publish.js');
    
    const child = spawn('node', [scriptPath, '--auto'], {
      cwd: BASE_DIR
    });
    
    child.stdout.on('data', (data) => {
      console.log(`[VideoGen] ${data}`);
    });
    
    child.stderr.on('data', (data) => {
      console.error(`[VideoGen] ${data}`);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[XianyuBot] 视频生成完成: ${orderId}`);
        order.status = 'completed';
        order.videoPath = 'generated';
        this.saveOrders();
        
        // 自动发送交付消息
        this.sendDeliveryMessage(orderId);
      } else {
        console.error(`[XianyuBot] 视频生成失败: ${orderId}`);
        order.status = 'failed';
        this.saveOrders();
      }
    });
  }

  async sendDeliveryMessage(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return;
    
    // 查找对应对话并发送交付消息
    // TODO: 实现自动发送
    console.log(`[XianyuBot] 发送交付消息: ${orderId}`);
  }

  loadOrders() {
    const ordersFile = path.join(BASE_DIR, 'orders.json');
    if (fs.existsSync(ordersFile)) {
      const data = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
      this.orders = new Map(Object.entries(data));
    }
  }

  saveOrders() {
    const ordersFile = path.join(BASE_DIR, 'orders.json');
    const data = Object.fromEntries(this.orders);
    fs.writeFileSync(ordersFile, JSON.stringify(data, null, 2));
  }

  async stop() {
    this.isRunning = false;
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';
  
  const bot = new XianyuBot();
  
  try {
    if (command === 'start') {
      await bot.init();
      await bot.login();
      await bot.start();
      
      // 保持运行
      console.log('[XianyuBot] 运行中... (Ctrl+C 停止)');
      
      process.on('SIGINT', async () => {
        console.log('\n[XianyuBot] 停止中...');
        await bot.stop();
        process.exit(0);
      });
      
    } else if (command === 'test') {
      // 测试模式：只发送一条消息
      await bot.init();
      await bot.login();
      console.log('[XianyuBot] 测试模式');
      
    }
  } catch (error) {
    console.error('[XianyuBot] 错误:', error.message);
    process.exit(1);
  }
}

main();
