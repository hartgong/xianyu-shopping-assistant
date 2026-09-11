import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pidFile = path.join(rootDir, '.runtime', 'server.pid');

if (!fs.existsSync(pidFile)) {
  console.log('ℹ️  服务未运行（未找到 PID 文件）。');
  process.exit(0);
}

const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
if (!Number.isInteger(pid) || pid <= 0) {
  fs.unlinkSync(pidFile);
  console.log('ℹ️  已清理无效的 PID 文件。');
  process.exit(0);
}

let command = '';
try {
  command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
} catch {
  fs.unlinkSync(pidFile);
  console.log('ℹ️  服务进程已不存在，已清理 PID 文件。');
  process.exit(0);
}

if (!command.includes('server.mjs')) {
  console.error(`拒绝停止 PID ${pid}：它不是本项目的 server.mjs 进程。`);
  process.exit(1);
}

process.kill(pid, 'SIGTERM');
console.log(`🛑 已通知服务（PID ${pid}）正常关闭。`);
