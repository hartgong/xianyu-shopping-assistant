import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(rootDir, '.runtime');
const pidFile = path.join(runtimeDir, 'server.pid');
const logFile = path.join(runtimeDir, 'server.log');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (fs.existsSync(pidFile)) {
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
    console.log(`ℹ️  服务已在运行（PID ${pid}）：http://localhost:3000`);
    process.exit(0);
  }
  fs.rmSync(pidFile, { force: true });
}

fs.mkdirSync(runtimeDir, { recursive: true });
const logFd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: rootDir,
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
fs.closeSync(logFd);

// 启用云端卖家池后，首次 TLS 连接和数据库建表可能需要数秒；
// 等待服务真正写入 PID，避免后台进程仍在启动时被误报为失败。
for (let attempt = 0; attempt < 150; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 100));
  if (fs.existsSync(pidFile)) {
    console.log(`🚀 服务已在后台启动（PID ${child.pid}）：http://localhost:3000`);
    console.log(`日志：${logFile}`);
    process.exit(0);
  }
}

console.error(`❌ 服务未能启动。请查看日志：${logFile}`);
process.exit(1);
