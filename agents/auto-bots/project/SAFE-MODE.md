# 安全模式使用指南

> 避免平台反自动化检测，确保账号安全

## 核心原则

1. **永不直接自动发布** - 所有内容先经过人工审核
2. **模拟真人操作** - 随机延迟、鼠标移动、打字速度
3. **隔离浏览器环境** - 每个平台独立浏览器配置
4. **限制操作频率** - 避免短时间内大量操作

## 安全流程

```
生成视频 → 待审核目录 → 人工确认 → 手动发布
```

### 步骤 1：生成视频（自动）
```bash
node automation/generate-and-publish-safe.js
```

视频会保存到：
```
automation/pending/pending_1234567890.mp4
automation/pending/pending_1234567890.json
```

### 步骤 2：人工审核（必须）
打开 `automation/pending/` 目录，查看生成的视频：
- 确认内容质量
- 检查是否有异常
- 决定是否发布

### 步骤 3：手动发布（推荐）或 审核后自动发布

**选项 A：手动发布（最安全）**
1. 打开对应平台创作者中心
2. 手动上传视频
3. 填写标题、描述、标签
4. 发布

**选项 B：审核后自动发布（较安全）**
```bash
# 单个视频
node automation/uploaders/index.js approve pending_1234567890

# 批量发布所有已审核
node automation/uploaders/index.js approve-all
```

## 反检测机制

### 已实现
- ✅ 移除 webdriver 标记
- ✅ 模拟真人打字速度（50-150ms/字符）
- ✅ 随机鼠标移动
- ✅ 随机页面滚动
- ✅ 随机操作延迟（1-5秒）
- ✅ 持久化浏览器配置（保存登录态）
- ✅ 每个平台独立浏览器环境
- ✅ 限制上传频率（视频间隔 10-30 秒）

### 平台特定限制

| 平台 | 安全限制 | 建议 |
|------|----------|------|
| **抖音** | 每天最多 3-5 条 | 早中晚各 1 条 |
| **B站** | 每天最多 2-3 条 | 中午、晚上各 1 条 |
| **小红书** | 每天最多 3-4 条 | 早、中、晚各 1 条 |
| **闲鱼** | 消息发送限制 | 每 10 分钟最多 5 条 |

## 账号安全建议

### 1. 新账号养号（第 1-2 周）
- 不要自动发布
- 手动浏览、点赞、评论
- 建立正常使用模式

### 2. 渐增发布量
- 第 1 周：每天 1 条
- 第 2 周：每天 2 条
- 第 3 周+：每天 3-5 条

### 3. 内容多样化
- 不要全部用 AI 生成
- 混合原创内容
- 不同风格、不同时长

### 4. 避免敏感操作
- 不要频繁修改账号信息
- 不要短时间内大量删除
- 不要跨平台同步相同内容

## 应急方案

### 如果被检测到
1. **立即停止**所有自动化操作
2. **手动登录**平台，正常使用 3-7 天
3. **降低发布频率**到原来的 50%
4. **更换 IP**（如果使用代理）

### 如果账号被限制
1. 查看平台通知，了解限制原因
2. 提交申诉（如果是误判）
3. 等待解封（通常 3-7 天）
4. 解封后降低自动化程度

## 最佳实践

### 推荐工作流
```bash
# 1. 生成视频（自动）
node automation/generate-and-publish-safe.js

# 2. 审核视频（手动）
# 打开 automation/pending/ 查看

# 3. 发布到单个平台（手动或半自动）
node automation/uploaders/index.js approve <pendingId> --platforms=douyin

# 4. 观察数据（手动）
# 查看播放量、点赞、评论

# 5. 批量发布剩余平台（第 2 天）
node automation/uploaders/index.js approve <pendingId> --platforms=bilibili,xiaohongshu
```

### 时间间隔建议
- **同一平台**：至少间隔 4 小时
- **不同平台**：至少间隔 1 小时
- **每天总发布**：不超过 5 条

## 监控与日志

### 查看操作日志
```bash
# 查看今日操作
ls -lt logs/*.json | head -10

# 查看错误日志
grep -l "error" logs/*.json
```

### 成本监控
```bash
node trackers/cost-tracker.js today
```

### 收益监控
```bash
node trackers/cost-tracker.js week
```

## 技术细节

### 浏览器隔离
每个平台使用独立的浏览器数据目录：
```
agnes/.browsers/
├── douyin/
├── bilibili/
└── xiaohongshu/
```

登录态保存在本地，不会互相干扰。

### 反检测脚本
每个上传器都注入了以下脚本：
```javascript
// 移除 webdriver 标记
Object.defineProperty(navigator, 'webdriver', { get: () => false });

// 模拟真实浏览器特征
window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
navigator.plugins = [1, 2, 3, 4, 5];
navigator.languages = ['zh-CN', 'zh', 'en'];
```

## 联系与支持

如果遇到平台限制或有其他问题：
1. 查看日志文件 `logs/`
2. 检查待审核目录 `automation/pending/`
3. 调整发布频率和时间间隔

---

**记住：安全第一，宁可慢一点，不要被封号！** 🛡️
