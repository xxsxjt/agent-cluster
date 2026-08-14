# Agnes AI 工作室 - 自动化系统

全自动 AI 视频生成 + 发布 + 接单系统

## 快速启动

```bash
# 1. 安装依赖
npm install playwright

# 2. 启动所有服务
node start.js

# 3. 部署作品集
node deploy-portfolio.js quick

# 4. 配置定时任务
node schedule-tasks.js setup
```

## 系统架构

```
Agnes AI 工作室
├── video-project/          # 视频生成管线
│   ├── pipeline.js         # 主生成脚本
│   ├── SCRIPT.md           # 剧本
│   └── videos/             # 输出目录
│
├── start.js               # 主启动器
├── generate-and-publish.js      # 生成+发布
├── deploy-portfolio.js          # 部署作品集
├── schedule-tasks.js            # 定时任务
├── trackers/
│   └── cost-tracker.js          # 成本追踪
├── uploaders/
│   ├── douyin.js                # 抖音上传
│   ├── bilibili.js              # B站上传
│   └── xiaohongshu.js           # 小红书上传
└── bots/
    └── xianyu-bot.js            # 闲鱼自动回复
│
├── logs/                   # 日志目录
│   ├── cost-*.json         # 成本记录
│   ├── revenue-*.json      # 收益记录
│   └── report-*.json       # 分析报告
│
├── deploy/                 # 部署目录
│   └── index.html          # 作品集网站
│
├── server.js               # API 代理服务器
├── cli.js                  # CLI 工具
└── portfolio.html          # 作品集源码
```

## 使用指南

### 1. 手动生成视频

```bash
# 生成所有场景
node video-project/pipeline.js all

# 生成特定场景
node video-project/pipeline.js videos scene2_fortress
```

### 2. 自动发布视频

```bash
# 生成并发布到所有平台
node generate-and-publish.js --auto

# 发布到特定平台
node generate-and-publish.js --platforms=douyin,bilibili
```

### 3. 闲鱼自动接单

```bash
# 启动监控
node bots/xianyu-bot.js start

# 测试模式
node bots/xianyu-bot.js test
```

### 4. 查看收益报告

```bash
# 每日报告
node trackers/cost-tracker.js today

# 每周报告
node trackers/cost-tracker.js week

# 每月报告
node trackers/cost-tracker.js month

# 导出完整报告
node trackers/cost-tracker.js export

# 健康检查
node trackers/cost-tracker.js health
```

## 成本估算

| 项目 | 费用 |
|------|------|
| 图生图 | ~0.05 元/张 |
| 图生视频 | ~1.5 元/次 |
| 本地处理 | 0 元 |
| **单条视频** | **~1.55 元** |

## 收益预期

| 周期 | 预期收益 |
|------|----------|
| 第 1 月 | 500-1200 元 |
| 第 2 月 | 1300-2800 元 |
| 第 3 月 | 2800-7800 元 |

## 定时任务

| 任务 | 时间 | 内容 |
|------|------|------|
| 早间发布 | 08:00 | 抖音 + 小红书 |
| 午间发布 | 12:00 | B站 |
| 晚间发布 | 18:00 | 全平台 |
| 闲鱼监控 | 每10分钟 | 自动回复消息 |

## 注意事项

1. **首次使用需要手动登录**各平台（抖音/B站/小红书/闲鱼）
2. **API 密钥**配置在 `keys.json` 中
3. **定时任务**需要管理员权限配置
4. **成本监控**自动记录在 `logs/` 目录

## 故障排查

### API 服务器无法启动
```bash
# 检查端口占用
netstat -ano | findstr :3456

# 更换端口
node server.js 3457
```

### 视频生成失败
```bash
# 检查 API 连接
curl http://localhost:3457/v1/models

# 查看日志
tail -f logs/*.log
```

### 上传失败
- 检查浏览器是否已登录
- 检查网络连接
- 查看平台 API 限制

## 更新日志

- 2026-06-17: 初始版本，包含完整自动化流程
- 2026-06-18: 添加成本追踪和收益分析
- 2026-08-11: 修正 README 路径偏差——脚本均位于项目根目录，移除不存在的 automation/ 前缀（start.js / generate-and-publish.js / deploy-portfolio.js / schedule-tasks.js / bots/xianyu-bot.js）

## 联系方式

- 项目: WorkBuddy/agnes
- 作品集: 见 deploy/index.html
