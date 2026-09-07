import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newPage } from './browser.mjs';
import { sleep, waitIfVerification } from './utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TRACKED_FILE = path.join(DATA_DIR, 'tracked-products.json');
const VERIFICATION_ERROR_CODE = 'VERIFICATION_DETECTED';

function verificationError(message = '\u68c0\u6d4b\u5230\u4eba\u673a\u6821\u9a8c\uff0c\u5df2\u505c\u6b62\u672c\u8f6e\u4ef7\u683c\u68c0\u67e5') {
  const err = new Error(message);
  err.code = VERIFICATION_ERROR_CODE;
  return err;
}

function loadTracked() {
  try {
    if (!fs.existsSync(TRACKED_FILE)) return [];
    return JSON.parse(fs.readFileSync(TRACKED_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTracked(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRACKED_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

function parsePrice(value) {
  const text = String(value || '').replace(/,/g, '').trim();
  if (!text) return null;
  if (/\u4eba\u60f3\u8981|\u6d4f\u89c8|\u7d2f\u8ba1\u964d\u4ef7|\u964d\u4ef7\d+%|\u60f3\u8981/.test(text)) return null;
  if (/浜烘兂瑕亅娴忚|绱闄嶄环|闄嶄环\d+%|鎯宠/.test(text)) return null;
  const match = text.match(/(?:¥|￥|楼|锟)\s*(\d+(?:\.\d+)?)/)
    || text.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isBadTrackedImage(src) {
  const text = String(src || '');
  return !text
    || /6000000006144-2-tps-242-150/.test(text)
    || /(?:gw|img)\.alicdn\.com\/imgextra\/.*-tps-/i.test(text)
    || /\/imgextra\/.*-tps-\d+-\d+/i.test(text)
    || /mtopupload.*_110x/i.test(text)
    || /_(?:60|80|100|110|120)x\d+/i.test(text)
    || /logo|avatar|icon/i.test(text);
}

function parseItemId(rawUrl) {
  const url = new URL(rawUrl);
  return url.searchParams.get('id') || url.pathname.match(/(\d{8,})/)?.[1] || '';
}

function isBlockedTitle(title) {
  const text = String(title || '').trim();
  return !text
    || [
      '\u4e3a\u4f60\u63a8\u8350',
      '\u76f8\u5173\u63a8\u8350',
      '\u731c\u4f60\u559c\u6b22',
      '\u63a8\u52a8\u7eff\u8272\u53d1\u5c55\uff0c\u4fc3\u8fdb\u95f2\u7f6e\u6d41\u901a',
      '\u7cdf\u7cd5\uff01\u5b9d\u8d1d\u88ab\u5220\u6389\u4e86',
      '涓轰綘鎺ㄨ崘',
      '鐩稿叧鎺ㄨ崘',
      '鐚滀綘鍠滄',
    ].includes(text)
    || text.includes('\u4fc3\u8fdb\u95f2\u7f6e\u6d41\u901a');
}

function normalizeUrl(rawUrl) {
  const url = new URL(String(rawUrl || '').trim());
  const allowedHosts = ['www.goofish.com', 'goofish.com', '2.taobao.com', 'item.taobao.com'];
  if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.includes(url.hostname)) {
    throw new Error('\u53ea\u652f\u6301\u95f2\u9c7c/\u6dd8\u5b9d\u5546\u54c1\u94fe\u63a5');
  }
  const id = parseItemId(url.toString());
  if (!id) throw new Error('\u672a\u8bc6\u522b\u5230\u5546\u54c1ID');
  return { id, url: url.toString() };
}

function applySnapshot(item, detail, checkedAt = Date.now()) {
  const currentPrice = parsePrice(detail.price);
  const lastPrice = item.currentPrice ?? null;
  const history = Array.isArray(item.history) ? [...item.history] : [];

  if (currentPrice != null) {
    const last = history[history.length - 1];
    if (!last || last.price !== currentPrice) {
      history.push({ time: checkedAt, price: currentPrice });
    }
  }

  const firstPrice = item.firstPrice ?? currentPrice ?? null;
  const previousLowest = Number(item.lowestPrice);
  const lowestPrice = currentPrice == null
    ? (item.lowestPrice ?? null)
    : Math.min(...[
      Number.isFinite(previousLowest) && previousLowest > 0 ? previousLowest : null,
      currentPrice,
    ].filter(value => Number.isFinite(Number(value))).map(Number));
  const priceDelta = currentPrice != null && lastPrice != null ? currentPrice - lastPrice : 0;
  const priceChange = priceDelta < 0
    ? '\u964d\u4ef7'
    : priceDelta > 0
      ? '\u6da8\u4ef7'
      : (item.lastCheckedAt ? '\u672a\u53d8' : '\u9996\u6b21\u8bb0\u5f55');
  const detailTitle = isBlockedTitle(detail.title) ? '' : detail.title;
  const image = isBadTrackedImage(detail.image) ? (item.image || '') : detail.image;

  return {
    ...item,
    ...detail,
    image,
    price: currentPrice == null ? (item.price || '') : `\u00a5${currentPrice}`,
    title: detailTitle || item.title || '',
    firstPrice,
    lastPrice,
    currentPrice: currentPrice ?? item.currentPrice ?? null,
    lowestPrice,
    priceDelta,
    priceChange,
    lastCheckedAt: checkedAt,
    status: detail.status || item.status || 'tracking',
    history: history.slice(-50),
  };
}

export function listTrackedProducts() {
  return loadTracked();
}

export function addTrackedProduct(rawUrl, note = '', title = '') {
  const { id, url } = normalizeUrl(rawUrl);
  const items = loadTracked();
  const cleanTitle = String(title || '').trim();
  const existing = items.find(item => item.id === id);
  if (existing) {
    existing.url = url;
    existing.note = note || existing.note || '';
    if (cleanTitle && isBlockedTitle(existing.title)) existing.title = cleanTitle;
    existing.status = existing.status === 'deleted' ? 'tracking' : existing.status;
    saveTracked(items);
    return existing;
  }

  const item = {
    id,
    url,
    note,
    title: cleanTitle,
    sellerName: '',
    currentPrice: null,
    firstPrice: null,
    lowestPrice: null,
    lastPrice: null,
    priceDelta: 0,
    priceChange: '\u5f85\u68c0\u67e5',
    status: 'tracking',
    createdAt: Date.now(),
    lastCheckedAt: null,
    history: [],
  };
  items.unshift(item);
  saveTracked(items);
  return item;
}

export function deleteTrackedProduct(id) {
  const items = loadTracked().filter(item => item.id !== id);
  saveTracked(items);
  return true;
}

export function updateTrackedProduct(id, patch = {}) {
  const items = loadTracked();
  const item = items.find(entry => entry.id === id);
  if (!item) throw new Error('\u672a\u627e\u5230\u8ddf\u8e2a\u5546\u54c1');
  if (Object.prototype.hasOwnProperty.call(patch, 'starred')) {
    item.starred = !!patch.starred;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
    item.note = String(patch.note || '').trim();
  }
  saveTracked(items);
  return item;
}

async function fetchTrackedDetail(url) {
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ok = await waitIfVerification(page, {
      emitLog: () => {},
      shouldStop: () => false,
      label: '\u4ef7\u683c\u8ddf\u8e2a',
      stopOnVerify: true,
    });
    if (!ok) throw verificationError();
    await sleep(1500);

    return await page.evaluate(() => {
      const currentItemId = new URLSearchParams(location.search).get('id') || '';
      const bodyText = document.body?.innerText || '';
      const titleEl = document.querySelector('[class*="title--"]') || document.querySelector('h1');
      const title = titleEl?.textContent?.trim()
        || document.title?.replace(/-.*$/, '').trim()
        || '';

      const isNoise = (text = '') => /\u4eba\u60f3\u8981|\u6d4f\u89c8|\u7d2f\u8ba1\u964d\u4ef7|\u964d\u4ef7\d+%|\u60f3\u8981/.test(text)
        || /浜烘兂瑕亅娴忚|绱闄嶴环|闄嶴环\d+%|鎯宠/.test(text);
      const parseCandidatePrice = (text = '') => {
        if (isNoise(text)) return null;
        const clean = String(text).replace(/,/g, '').trim();
        const match = clean.match(/(?:¥|￥|楼|锟)\s*(\d+(?:\.\d+)?)/)
          || clean.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
        if (!match) return null;
        const price = Number(match[1]);
        return Number.isFinite(price) && price > 0 ? price : null;
      };

      const titleRect = titleEl?.getBoundingClientRect();
      const priceCandidates = Array.from(document.querySelectorAll('[class*="price--"], [class*="Price--"]'))
        .map(el => {
          const text = el.textContent?.trim() || '';
          const price = parseCandidatePrice(text);
          if (price == null) return null;

          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') return null;

          const link = el.closest('a[href*="/item?id="], a[href*="item.taobao.com/item.htm"]');
          const href = link?.getAttribute('href') || '';
          if (currentItemId && href && !href.includes(`id=${currentItemId}`)) return null;

          const className = String(el.className || '');
          const nearTitle = titleRect ? Math.abs(rect.top - titleRect.top) : 0;
          const score = (className.includes('windows') ? -1000 : 0)
            + (link ? 5000 : 0)
            + nearTitle
            + Math.max(0, rect.top);
          return { text, score };
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score);
      const price = priceCandidates[0]?.text || '';

      const sellerName = document.querySelector('[class*="item-user-info-nick"]')?.textContent?.trim() || '';
      const image = Array.from(document.querySelectorAll('[class*="carouselItem"] img'))
        .map(img => img.src || '')
        .find(src => src && !/6000000006144-2-tps-242-150|(?:gw|img)\.alicdn\.com\/imgextra\/.*-tps-|\/imgextra\/.*-tps-\d+-\d+|mtopupload.*_110x|_(?:60|80|100|110|120)x\d+|logo|avatar|icon/i.test(src))
        || '';

      const pageLines = bodyText.split(/\n+/).map(line => line.trim()).filter(Boolean);
      const isSold = pageLines.some(line =>
        /^(卖掉了|已售出|已卖出|商品已售出|商品已卖出|宝贝已售出|宝贝已卖出|该商品已售出|该商品已卖出)$/.test(line)
        || (line.includes('卖掉了') && line.length <= 30)
      );
      const isDown = pageLines.some(line =>
        /^(已下架|商品已下架|宝贝已下架|商品不存在|宝贝不存在|页面不存在|该商品已失效|商品已删除|宝贝已失效|宝贝已删除|该宝贝已下架|该宝贝已失效)$/.test(line)
        || (line.includes('已下架') && line.length <= 30)
        || (line.includes('已失效') && line.length <= 30)
      );

      return {
        title,
        price,
        sellerName,
        image,
        status: isSold ? 'sold' : (isDown ? 'down' : 'tracking'),
      };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

export async function checkTrackedProduct(id) {
  const items = loadTracked();
  const idx = items.findIndex(item => item.id === id);
  if (idx < 0) throw new Error('\u672a\u627e\u5230\u8ddf\u8e2a\u5546\u54c1');
  const detail = await fetchTrackedDetail(items[idx].url);
  items[idx] = applySnapshot(items[idx], detail);
  saveTracked(items);
  return items[idx];
}

export async function checkAllTrackedProducts() {
  const items = loadTracked();
  const results = [];
  for (const item of items) {
    if (item.status === 'deleted') continue;
    try {
      const updated = await checkTrackedProduct(item.id);
      results.push({ id: item.id, ok: true, item: updated });
      await sleep(8000 + Math.random() * 7000);
    } catch (err) {
      results.push({ id: item.id, ok: false, error: err.message });
      if (err.code === VERIFICATION_ERROR_CODE) break;
    }
  }
  return results;
}
