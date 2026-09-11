import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '..', 'browser-data');

let _context = null;
let _launching = null;

export async function getBrowserContext() {
  if (_context) return _context;
  if (_launching) return _launching;

  _launching = (async () => {
    try {
      const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        viewport: { width: 1366, height: 900 },
        locale: 'zh-CN',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
        ],
      });
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
