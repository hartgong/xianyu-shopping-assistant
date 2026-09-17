import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '..', 'browser-data');

let _context = null;
let _launching = null;

// Chromium 在异常退出后有时会遗留 SingletonLock。这个锁会阻止同一
// browser-data 目录再次启动，导致任务无法显示登录窗口。只清理「本机且
// 进程已经不存在」的锁，绝不触碰仍在运行的 Chromium。
function clearStaleProfileLock() {
  const lockPath = path.join(USER_DATA_DIR, 'SingletonLock');
  try {
    fs.lstatSync(lockPath);
  } catch {
    return false;
  }

  let target = '';
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return false;
  }

  const match = target.match(/^(.*)-(\d+)$/);
  if (!match) return false;
  const [, host, pidText] = match;
  const pid = Number.parseInt(pidText, 10);
  const localHosts = new Set([os.hostname(), `${os.hostname()}.local`]);
  if (!localHosts.has(host) || !Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM 代表该进程存在、但当前用户无权探测；同样不可删除锁。
    if (err?.code === 'EPERM') return false;
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(USER_DATA_DIR, name), { force: true });
  }
  console.log('🧹 已清理异常退出后遗留的 Chromium 资料锁，正在重新打开浏览器。');
  return true;
}

async function launchContext() {
  clearStaleProfileLock();
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1366, height: 900 },
    locale: 'zh-CN',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
    ],
  });
}

export async function getBrowserContext() {
  if (_context) return _context;
  if (_launching) return _launching;

  _launching = (async () => {
    try {
      const context = await launchContext();
      _context = context;
      _context.on('close', () => { _context = null; });
      return _context;
    } catch (err) {
      _context = null;
      throw err;
    } finally {
      _launching = null;
    }
  })();

  return _launching;
}

export async function newPage() {
  const ctx = await getBrowserContext();
  return ctx.newPage();
}

export async function closeBrowser() {
  // 服务恰好在 Chromium 启动中收到退出信号时，也要等启动完成再关闭；
  // 否则子进程会被 Node 直接带走，持久 profile 会留下异常退出标记。
  const context = _context || await _launching?.catch(() => null);
  if (context) {
    await context.close().catch(() => {});
    _context = null;
  }
}
