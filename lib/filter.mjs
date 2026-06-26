import { newPage } from './browser.mjs';
import { judgeByTitle, judgeByDetail } from './ai.mjs';
import { randomDelay, extractItemId, extractUserId, sleep, waitIfVerification } from './utils.mjs';

const BATCH_SIZE = 15;

export async function coarseFilter(products, requirements, emitLog, shouldStop, options = {}) {
  emitLog(`🔸 粗筛开始，共 ${products.length} 个商品`);
  const hardPassed = [];

  for (const product of products) {
    if (shouldStop()) break;
    const result = judgeByHardRules(product, options);
    if (result.pass) {
      hardPassed.push(product);
    } else {
      emitLog(`  硬筛排除: ${product.title.slice(0, 30)}... (${result.reason})`);
    }
  }

  emitLog(`  硬性条件通过 ${hardPassed.length}/${products.length}`);

  if (!options.enableCoarseSemantic) {
    emitLog(`🔸 粗筛完成: ${hardPassed.length}/${products.length} 通过（未启用标题语义筛）`);
    return hardPassed;
  }

  emitLog(`  已启用标题语义筛，开始 AI 判断 ${hardPassed.length} 个商品`);
  const passed = [];

  for (let i = 0; i < hardPassed.length; i += BATCH_SIZE) {
    if (shouldStop()) break;

    const batch = hardPassed.slice(i, i + BATCH_SIZE);
    const titles = batch.map(p => p.title);
    emitLog(`  AI判断第 ${i + 1}-${Math.min(i + BATCH_SIZE, hardPassed.length)} 个...`);

    try {
      const passedIndices = await judgeByTitle(titles, requirements, options.coarsePrompt, emitLog);
      const validIndices = passedIndices.filter(idx => idx >= 0 && idx < batch.length);
      validIndices.forEach(idx => passed.push(batch[idx]));
      emitLog(`  本批通过 ${validIndices.length}/${batch.length}`);
    } catch (err) {
      emitLog(`  ⚠️ AI判断出错，保留本批全部: ${err.message}`);
      passed.push(...batch);
    }

    await randomDelay(1000, 2000);
  }

  emitLog(`🔸 粗筛完成: ${passed.length}/${products.length} 通过`);
  return passed;
}

function judgeByHardRules(product, options = {}) {
  const price = parsePrice(product.price);
  if (options.priceMin != null && price != null && price < options.priceMin) {
    return { pass: false, reason: `价格低于 ${options.priceMin}` };
  }
  if (options.priceMax != null && price != null && price > options.priceMax) {
    return { pass: false, reason: `价格高于 ${options.priceMax}` };
  }

  const title = String(product.title || '').toLowerCase();
  const excludeWords = normalizeWordList(options.titleExclude);
  const hitExclude = excludeWords.find(word => title.includes(word));
  if (hitExclude) {
    return { pass: false, reason: `标题命中排除词: ${hitExclude}` };
  }

  if (options.requireFreeShipping && product.shipping !== '包邮') {
    return { pass: false, reason: product.shipping ? '非包邮' : '未标明包邮' };
  }

  if (options.wantMax != null && Number.isFinite(Number(product.wantCount)) && Number(product.wantCount) < options.wantMax) {
    return { pass: false, reason: `想要人数低于 ${options.wantMax}` };
  }

  return { pass: true, reason: '' };
}

function parsePrice(value) {
  const match = String(value || '').replace(/,/g, '').match(/[\d.]+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function normalizeWordList(value) {
  return String(value || '')
    .split(/[,，、\n]/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeSellerName(name) {
  return String(name || '').trim().toLowerCase();
}

export async function fineFilter(products, requirements, emitLog, shouldStop, customPromptHead, sellerBlacklist = []) {
  emitLog(`🔹 细筛开始，共 ${products.length} 个商品`);
  const passed = [];
  const blacklist = new Set((sellerBlacklist || []).map(normalizeSellerName).filter(Boolean));

  for (let i = 0; i < products.length; i++) {
    if (shouldStop()) break;

    const product = products[i];
    emitLog(`  细筛 [${i + 1}/${products.length}] ${product.title.slice(0, 30)}...`);

    try {
      const detail = await fetchProductDetail(product, emitLog, shouldStop);
      const enriched = { ...product, ...detail };
      const sellerName = normalizeSellerName(enriched.sellerName);

      if (sellerName && blacklist.has(sellerName)) {
        emitLog(`    黑名单跳过 - ${enriched.sellerName}`);
        continue;
      }

      const result = await judgeByDetail(enriched, requirements, customPromptHead, emitLog);
      if (result.pass) {
        emitLog(`    ✅ 通过 - ${result.reason}`);
        passed.push(enriched);
      } else {
        emitLog(`    ❌ 不通过 - ${result.reason}`);
      }
    } catch (err) {
      emitLog(`    ⚠️ 细筛出错，跳过: ${err.message}`);
    }

    await randomDelay(5000, 12000);
  }

  emitLog(`🔹 细筛完成: ${passed.length}/${products.length} 通过`);
  return passed;
}

async function fetchProductDetail(product, emitLog, shouldStop) {
  const page = await newPage();
  try {
    await page.goto(product.href, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const verifyOk = await waitIfVerification(page, {
      emitLog,
      shouldStop,
      label: product.title?.slice(0, 15),
    });
    if (!verifyOk) {
      return { description: '', sellerName: '', sellerLocation: '', error: '校验未通过' };
    }

    await sleep(3000);

    const detail = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const parseCountMatch = (match) => {
        if (!match) return null;
        const n = Number(match[1]);
        if (!Number.isFinite(n)) return null;
        return match[2] ? Math.round(n * 10000) : Math.round(n);
      };
      const extractWantCount = (text = '') => parseCountMatch(
        String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万wW]?)\s*人?想要/)
      );
      const extractViewCount = (text = '') => parseCountMatch(
        String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万wW]?)\s*(?:次)?浏览/)
      );
      const detectShipping = (text = '') => {
        if (/不包邮|邮费自理|到付|运费另算/.test(text)) return '不包邮';
        if (/包邮|免邮|卖家承担运费/.test(text)) return '包邮';
        return '';
      };
      const matchText = (patterns) => {
        for (const pattern of patterns) {
          const match = bodyText.match(pattern);
          if (match?.[1]) return match[1].trim();
        }
        return '';
      };

      const descEl = document.querySelector('[class*="main--"][class*="open--"]')
        || document.querySelector('[class*="notLoginContainer"] [class*="main--"]');
      const description = descEl?.textContent?.trim().slice(0, 500) || '';

      const nickEl = document.querySelector('[class*="item-user-info-nick"]');
      const sellerName = nickEl?.textContent?.trim() || '';

      const labels = document.querySelectorAll('[class*="item-user-info-label"]');
      const labelTexts = [...labels].map(l => l.textContent?.trim());
      const isLastSeenText = (text = '') => /来过|在线|活跃/.test(text);
      const sellerLocation = labelTexts.find(t => t && !isLastSeenText(t) && !t.includes('好评')) || '';
      const sellerRating = labelTexts.find(t => t?.includes('好评')) || '';
      const sellerLastSeen = labelTexts.find(t => isLastSeenText(t || '')) || matchText([
        /((?:刚刚|今天|昨天|前天|\d+\s*(?:分钟|小时|天|周|月)前)\s*来过)/,
        /(当前在线|在线)/,
      ]);

      const priceEl = document.querySelector('[class*="price--"][class*="windows"]')
        || document.querySelector('[class*="price--"]');
      const detailPrice = priceEl?.textContent?.trim() || '';

      const wantEl = document.querySelector('[class*="want--"]');
      const wantText = wantEl?.textContent?.trim() || matchText([/(\d+(?:\.\d+)?\s*[万wW]?\s*人?想要)/]);
      const wantCount = extractWantCount(wantText);
      const viewText = matchText([
        /(\d+(?:\.\d+)?\s*[万wW]?\s*(?:次)?浏览)/,
        /浏览量[:：\s]*(\d+(?:\.\d+)?\s*[万wW]?)/,
      ]);
      const viewCount = extractViewCount(viewText) ?? parseCountMatch(String(viewText).replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([万wW]?)$/));
      const updatedAt = matchText([
        /(?:更新于|编辑于|最近更新|最新更新)[:：\s]*([^\n]+)/,
        /(?:发布于|发布时间|上架时间)[:：\s]*([^\n]+)/,
      ]);
      const shipping = detectShipping(bodyText);

      const chatLink = document.querySelector('a[href*="/im?itemId="]');
      const chatUrl = chatLink?.href || '';

      const buyLink = document.querySelector('a[href*="/create-order"]');
      const buyUrl = buyLink?.href || '';

      const images = [...document.querySelectorAll('[class*="carouselItem"] img')]
        .map(img => img.src).filter(Boolean).slice(0, 5);

      return {
        description,
        sellerName,
        sellerLocation,
        sellerRating,
        sellerLastSeen,
        detailPrice: detailPrice,
        wantCount,
        wantText,
        viewCount,
        viewText,
        updatedAt,
        shipping,
        chatUrl,
        buyUrl,
        images,
      };
    });

    const chatLink = await page.locator('a[href*="/im?itemId="]').first().getAttribute('href').catch(() => '');
    if (chatLink) {
      detail.chatUrl = chatLink.startsWith('http') ? chatLink : `https://www.goofish.com${chatLink}`;
      detail.sellerId = extractUserId(chatLink);
    }

    return detail;
  } catch (err) {
    return { description: '', sellerName: '', sellerLocation: '', error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}
