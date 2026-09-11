import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const tasksFile = path.join(rootDir, 'data', 'tasks.json');
const configFile = path.join(rootDir, 'data', 'config.json');

if (!process.argv.includes('--yes')) {
  console.error('此命令会清空全部任务、卖家池档案和卖家标记。');
  console.error('确认执行：npm run reset:test-data -- --yes');
  process.exit(1);
}

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (error) {
  console.error(`读取配置失败：${error.message}`);
  process.exit(1);
}

config.sellerProfiles = {};
config.sellerManualLabels = {};
fs.writeFileSync(tasksFile, '[]\n', 'utf8');
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log('已清空：任务、卖家池档案、卖家人工标记。');
console.log('已保留：API 设置、模型、二奢词库、黑名单、跟踪商品。');
