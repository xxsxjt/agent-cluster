/**
 * 成本追踪和收益分析
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';
const LOG_DIR = `${BASE_DIR}/logs`;

class CostTracker {
  constructor() {
    this.costs = [];
    this.revenues = [];
    this.loadHistory();
  }

  loadHistory() {
    // 加载历史成本数据
    const costFiles = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('cost-') && f.endsWith('.json'))
      .sort();
    
    for (const file of costFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(LOG_DIR, file), 'utf8'));
        this.costs.push(data);
      } catch (e) {
        console.error(`加载成本日志失败: ${file}`, e.message);
      }
    }
    
    // 加载历史收益数据
    const revenueFiles = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('revenue-') && f.endsWith('.json'))
      .sort();
    
    for (const file of revenueFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(LOG_DIR, file), 'utf8'));
        this.revenues.push(data);
      } catch (e) {
        console.error(`加载收益日志失败: ${file}`, e.message);
      }
    }
    
    console.log(`[CostTracker] 已加载 ${this.costs.length} 条成本记录, ${this.revenues.length} 条收益记录`);
  }

  getSummary(period = 'all') {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    let filteredCosts = this.costs;
    let filteredRevenues = this.revenues;
    
    if (period === 'today') {
      const todayStart = new Date().setHours(0, 0, 0, 0);
      filteredCosts = this.costs.filter(c => new Date(c.timestamp) >= todayStart);
      filteredRevenues = this.revenues.filter(r => new Date(r.timestamp) >= todayStart);
    } else if (period === 'week') {
      const weekStart = now - 7 * dayMs;
      filteredCosts = this.costs.filter(c => new Date(c.timestamp) >= weekStart);
      filteredRevenues = this.revenues.filter(r => new Date(r.timestamp) >= weekStart);
    } else if (period === 'month') {
      const monthStart = now - 30 * dayMs;
      filteredCosts = this.costs.filter(c => new Date(c.timestamp) >= monthStart);
      filteredRevenues = this.revenues.filter(r => new Date(r.timestamp) >= monthStart);
    }
    
    const totalCost = filteredCosts.reduce((sum, c) => sum + (c.total || 0), 0);
    const totalRevenue = filteredRevenues.reduce((sum, r) => sum + (r.total || 0), 0);
    
    return {
      period,
      cost: {
        total: totalCost,
        count: filteredCosts.length,
        avg: filteredCosts.length > 0 ? totalCost / filteredCosts.length : 0
      },
      revenue: {
        total: totalRevenue,
        count: filteredRevenues.length,
        avg: filteredRevenues.length > 0 ? totalRevenue / filteredRevenues.length : 0
      },
      profit: totalRevenue - totalCost,
      roi: totalCost > 0 ? ((totalRevenue - totalCost) / totalCost * 100).toFixed(1) : 0
    };
  }

  getDailyReport() {
    const summary = this.getSummary('today');
    
    console.log('\n========== 每日报告 ==========');
    console.log(`日期: ${new Date().toLocaleDateString()}`);
    console.log(`成本: ¥${summary.cost.total.toFixed(2)} (${summary.cost.count} 条视频)`);
    console.log(`收益: ¥${summary.revenue.total.toFixed(2)} (${summary.revenue.count} 个平台)`);
    console.log(`利润: ¥${summary.profit.toFixed(2)}`);
    console.log(`ROI: ${summary.roi}%`);
    console.log('==============================\n');
    
    return summary;
  }

  getWeeklyReport() {
    const summary = this.getSummary('week');
    
    console.log('\n========== 每周报告 ==========');
    console.log(`周期: 最近 7 天`);
    console.log(`总成本: ¥${summary.cost.total.toFixed(2)}`);
    console.log(`总收益: ¥${summary.revenue.total.toFixed(2)}`);
    console.log(`净利润: ¥${summary.profit.toFixed(2)}`);
    console.log(`ROI: ${summary.roi}%`);
    console.log(`日均成本: ¥${(summary.cost.total / 7).toFixed(2)}`);
    console.log(`日均收益: ¥${(summary.revenue.total / 7).toFixed(2)}`);
    console.log('==============================\n');
    
    return summary;
  }

  checkHealth() {
    const summary = this.getSummary('week');
    
    // 健康度检查
    const issues = [];
    
    if (summary.cost.total > 100) {
      issues.push('本周成本超过 100 元，建议检查生成频率');
    }
    
    if (summary.revenue.total === 0) {
      issues.push('本周暂无收益，检查发布流程');
    }
    
    if (parseFloat(summary.roi) < 0) {
      issues.push('ROI 为负，需要优化内容或提高发布量');
    }
    
    if (issues.length === 0) {
      console.log('[CostTracker] ✓ 系统健康，一切正常');
    } else {
      console.log('[CostTracker] ⚠️ 发现问题:');
      issues.forEach(issue => console.log(`  - ${issue}`));
    }
    
    return issues;
  }

  exportReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        all: this.getSummary('all'),
        today: this.getSummary('today'),
        week: this.getSummary('week'),
        month: this.getSummary('month')
      },
      recentCosts: this.costs.slice(-10),
      recentRevenues: this.revenues.slice(-10)
    };
    
    const reportPath = path.join(LOG_DIR, `report-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    console.log(`[CostTracker] 报告已导出: ${reportPath}`);
    return report;
  }
}

module.exports = { CostTracker };

// ================= CLI 入口 =================
// 支持子命令: today | week | month | export | health
// 用法: node trackers/cost-tracker.js today
if (require.main === module) {
  const [, , cmd = 'today'] = process.argv;
  const tracker = new CostTracker();

  switch (cmd) {
    case 'today':
      tracker.getDailyReport();
      break;
    case 'week':
      tracker.getWeeklyReport();
      break;
    case 'month': {
      const summary = tracker.getSummary('month');
      console.log('\n========== 每月报告 ==========');
      console.log('周期: 最近 30 天');
      console.log(`总成本: ¥${summary.cost.total.toFixed(2)}`);
      console.log(`总收益: ¥${summary.revenue.total.toFixed(2)}`);
      console.log(`净利润: ¥${summary.profit.toFixed(2)}`);
      console.log(`ROI: ${summary.roi}%`);
      console.log('==============================\n');
      break;
    }
    case 'export':
      tracker.exportReport();
      break;
    case 'health':
      tracker.checkHealth();
      break;
    default:
      console.log('未知子命令: ' + cmd);
      console.log('用法: node trackers/cost-tracker.js <today|week|month|export|health>');
      process.exit(1);
  }
}
