/**
 * 部署 portfolio.html 到 GitHub Pages 或 Vercel
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = 'C:/Users/du_ji/pi_workspace/org/agents/auto-bots/project';
const PORTFOLIO_FILE = `${BASE_DIR}/portfolio.html`;

class PortfolioDeployer {
  constructor() {
    this.platform = process.argv[2] || 'github'; // github 或 vercel
  }

  async deploy() {
    console.log(`[Deploy] 部署到 ${this.platform}...`);
    
    switch (this.platform) {
      case 'github':
        await this.deployToGitHub();
        break;
      case 'vercel':
        await this.deployToVercel();
        break;
      default:
        throw new Error(`不支持的平台: ${this.platform}`);
    }
  }

  async deployToGitHub() {
    console.log('[Deploy] 使用 GitHub Pages 部署...');
    
    // 检查 git 配置
    try {
      execSync('git --version', { stdio: 'pipe' });
    } catch (e) {
      throw new Error('Git 未安装，请先安装 Git');
    }
    
    // 创建临时部署目录
    const deployDir = `${BASE_DIR}/deploy-temp`;
    if (!fs.existsSync(deployDir)) {
      fs.mkdirSync(deployDir, { recursive: true });
    }
    
    // 复制 portfolio.html
    fs.copyFileSync(PORTFOLIO_FILE, path.join(deployDir, 'index.html'));
    
    // 初始化 git 仓库
    try {
      execSync('git init', { cwd: deployDir, stdio: 'pipe' });
      execSync('git add .', { cwd: deployDir, stdio: 'pipe' });
      execSync('git commit -m "Deploy portfolio"', { cwd: deployDir, stdio: 'pipe' });
      
      // 提示用户创建 GitHub 仓库
      console.log('\n[Deploy] 请按以下步骤操作:');
      console.log('1. 在 GitHub 上创建新仓库 (例如: agnes-portfolio)');
      console.log('2. 运行以下命令推送:');
      console.log(`   cd ${deployDir}`);
      console.log('   git remote add origin https://github.com/你的用户名/agnes-portfolio.git');
      console.log('   git branch -M main');
      console.log('   git push -u origin main');
      console.log('3. 在仓库 Settings → Pages 中启用 GitHub Pages');
      console.log('4. 访问 https://你的用户名.github.io/agnes-portfolio\n');
      
    } catch (e) {
      console.log('[Deploy] Git 操作失败，请手动部署');
    }
  }

  async deployToVercel() {
    console.log('[Deploy] 使用 Vercel 部署...');
    
    // 检查 vercel CLI
    try {
      execSync('vercel --version', { stdio: 'pipe' });
    } catch (e) {
      console.log('[Deploy] Vercel CLI 未安装，正在安装...');
      try {
        execSync('npm install -g vercel', { stdio: 'pipe' });
      } catch (e) {
        throw new Error('Vercel CLI 安装失败，请手动安装: npm install -g vercel');
      }
    }
    
    // 部署
    try {
      const output = execSync(`vercel --yes --prod`, {
        cwd: BASE_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      });
      
      console.log('[Deploy] 部署成功!');
      console.log(output);
      
      // 提取 URL
      const urlMatch = output.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        console.log(`\n[Deploy] 作品集地址: ${urlMatch[0]}`);
      }
      
    } catch (e) {
      console.error('[Deploy] 部署失败:', e.message);
      throw e;
    }
  }
}

// 快速部署：直接复制到本地 Web 服务器目录
function quickDeploy() {
  console.log('[Deploy] 快速部署到本地...');
  
  // 创建本地访问链接
  const deployDir = `${BASE_DIR}/deploy`;
  if (!fs.existsSync(deployDir)) {
    fs.mkdirSync(deployDir, { recursive: true });
  }
  
  fs.copyFileSync(PORTFOLIO_FILE, path.join(deployDir, 'index.html'));
  
  console.log(`[Deploy] 已部署到: ${deployDir}`);
  console.log(`[Deploy] 直接用浏览器打开: file:///${deployDir.replace(/\\/g, '/')}/index.html`);
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'quick';
  
  if (command === 'quick') {
    quickDeploy();
  } else {
    const deployer = new PortfolioDeployer();
    await deployer.deploy();
  }
}

main().catch(e => {
  console.error('[Deploy] 错误:', e.message);
  process.exit(1);
});
