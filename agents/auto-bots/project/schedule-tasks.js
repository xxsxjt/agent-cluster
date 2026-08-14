/**
 * 配置 Windows 定时任务
 * 自动发布视频到各平台
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';
const TASK_NAME = 'AgnesAutoPublish';

class TaskScheduler {
  constructor() {
    this.tasks = [
      {
        name: 'Agnes 早间发布',
        time: '08:00',
        platforms: ['douyin', 'xiaohongshu'],
        description: '每天早8点自动发布视频到抖音和小红书'
      },
      {
        name: 'Agnes 午间发布',
        time: '12:00',
        platforms: ['bilibili'],
        description: '每天中午12点自动发布到B站'
      },
      {
        name: 'Agnes 晚间发布',
        time: '18:00',
        platforms: ['douyin', 'bilibili', 'xiaohongshu'],
        description: '每天晚6点全平台发布'
      },
      {
        name: 'Agnes 闲鱼监控',
        time: '*/10 * * * *', // 每10分钟
        platforms: [],
        description: '每10分钟监控闲鱼消息'
      }
    ];
  }

  async setup() {
    console.log('[Scheduler] 配置定时任务...\n');
    
    // 删除已有任务
    this.deleteExistingTasks();
    
    // 创建新任务
    for (const task of this.tasks) {
      await this.createTask(task);
    }
    
    // 列出所有任务
    this.listTasks();
    
    console.log('\n[Scheduler] 定时任务配置完成!');
    console.log(`[Scheduler] 查看任务: schtasks /query /tn ${TASK_NAME}*`);
    console.log(`[Scheduler] 删除任务: schtasks /delete /tn ${TASK_NAME}* /f`);
  }

  deleteExistingTasks() {
    try {
      const output = execSync(`schtasks /query /fo csv /v`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes(TASK_NAME)) {
          const taskName = line.split(',')[1].replace(/"/g, '');
          console.log(`[Scheduler] 删除已有任务: ${taskName}`);
          try {
            execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' });
          } catch (e) {
            console.log(`[Scheduler] 删除失败: ${taskName}`);
          }
        }
      }
    } catch (e) {
      console.log('[Scheduler] 无法查询现有任务');
    }
  }

  async createTask(task) {
    const taskFullName = `${TASK_NAME} - ${task.name}`;
    
    // 构建任务命令
    let command;
    if (task.platforms.length > 0) {
      // 视频发布任务
      command = `node "${BASE_DIR}/generate-and-publish.js" --auto --platforms=${task.platforms.join(',')}`;
    } else {
      // 闲鱼监控任务
      command = `node "${BASE_DIR}/bots/xianyu-bot.js" monitor`;
    }
    
    // 创建 XML 任务定义
    const xml = this.createTaskXML(taskFullName, command, task.time, task.description);
    const xmlPath = `${BASE_DIR}/task-${Date.now()}.xml`;
    
    fs.writeFileSync(xmlPath, xml);
    
    try {
      // 导入任务
      execSync(`schtasks /create /tn "${taskFullName}" /xml "${xmlPath}" /f`, {
        stdio: 'pipe'
      });
      
      console.log(`[Scheduler] ✓ 创建任务: ${taskFullName}`);
      console.log(`   时间: ${task.time}`);
      console.log(`   命令: ${command}\n`);
      
    } catch (e) {
      console.error(`[Scheduler] ✗ 创建任务失败: ${taskFullName}`);
      console.error(`   错误: ${e.message}\n`);
    } finally {
      // 清理临时文件
      if (fs.existsSync(xmlPath)) {
        fs.unlinkSync(xmlPath);
      }
    }
  }

  createTaskXML(name, command, schedule, description) {
    // 解析时间
    let startTime, startDate;
    
    if (schedule.includes('*')) {
      // 间隔任务
      startTime = '00:00';
      startDate = new Date().toISOString().split('T')[0];
    } else {
      // 定时任务
      startTime = schedule;
      startDate = new Date().toISOString().split('T')[0];
    }
    
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startDate}T${startTime}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c "${command}"</Arguments>
      <WorkingDirectory>${BASE_DIR}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
  }

  listTasks() {
    try {
      const output = execSync(`schtasks /query /fo csv /v | findstr "${TASK_NAME}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      
      console.log('[Scheduler] 当前定时任务:');
      console.log(output);
      
    } catch (e) {
      console.log('[Scheduler] 暂无定时任务');
    }
  }

  async remove() {
    console.log('[Scheduler] 删除所有定时任务...');
    this.deleteExistingTasks();
    console.log('[Scheduler] 已删除');
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'setup';
  
  const scheduler = new TaskScheduler();
  
  switch (command) {
    case 'setup':
      await scheduler.setup();
      break;
      
    case 'remove':
      await scheduler.remove();
      break;
      
    case 'list':
      scheduler.listTasks();
      break;
      
    default:
      console.log('用法: node schedule-tasks.js [setup|remove|list]');
  }
}

main().catch(e => {
  console.error('[Scheduler] 错误:', e.message);
  process.exit(1);
});
