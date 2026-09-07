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

function getManualSellerLabel(name, labels = {}) {
  const key = normalizeSellerName(name);
  return labels?.[key] || labels?.[String(name || '').trim()] || '';
}

function parseCountValue(value) {
  const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万千kKwW]?)/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  if (/万|w/i.test(match[2] || '')) return Math.round(n * 10000);
  if (/千|k/i.test(match[2] || '')) return Math.round(n * 1000);
  return Math.round(n);
}

function buildSellerProfile(product) {
  const text = [
    product.title,
    product.description,
    product.sellerName,
  ].filter(Boolean).join(' ');
  const sellerOtherText = String(product.sellerOtherText || '');
  const businessWords = [
    '现货', '秒发', '库存', '大量', '批发', '长期', '卡牌店', '卡店', '卡社',
    '工作室', '电玩', '补卡', '代开', '批量', '整箱', '整条', '原箱', '保配', '配置位',
  ];
  const personalWords = ['自留', '回血', '出坑', '闲置', '自用', '买多了', '仅拆', '个人', '转卖', '急出', '退坑', '重复了', '拆盒'];
  const personalGoodsWords = [
    '衣服', '鞋', '包包', '背包', '化妆品', '护肤', '香水', '家电', '电器', '手机', '相机',
    '耳机', '键盘', '鼠标', '家具', '桌子', '椅子', '书', '教材', '婴儿', '母婴', '玩具',
    '乐高', '吹风机', '电饭煲', '锅', '杯子', '运动', '健身', '自行车',
  ];
  const businessHits = businessWords.filter(word => text.includes(word));
  const personalHits = personalWords.filter(word => text.includes(word));
  const personalGoodsHits = personalGoodsWords.filter(word => sellerOtherText.includes(word));
  const dealCount = Number.isFinite(Number(product.sellerDealCount)) ? Number(product.sellerDealCount) : null;
  const listedCount = Number.isFinite(Number(product.sellerListedCount)) ? Number(product.sellerListedCount) : null;

  let score = 50;
  const reasons = [];

  if (dealCount != null) {
    if (dealCount <= 20) {
      score += 25;
      reasons.push(`交易/卖出 ${dealCount} 件`);
    } else if (dealCount <= 50) {
      score += 15;
      reasons.push(`交易/卖出 ${dealCount} 件`);
    } else if (dealCount <= 200) {
      score -= 10;
      reasons.push(`交易/卖出 ${dealCount} 件，疑似小B`);
    } else if (dealCount <= 500) {
      score -= 18;
      reasons.push(`交易/卖出 ${dealCount} 件，疑似小B`);
    } else if (dealCount <= 1000) {
      score -= 28;
      reasons.push(`交易/卖出 ${dealCount} 件，明显小B`);
    } else {
      score -= 42;
      reasons.push(`交易/卖出 ${dealCount} 件，明显小B`);
    }
  }

  if (listedCount != null) {
    if (listedCount <= 10) {
      score += 12;
      reasons.push(`在售/发布 ${listedCount} 件`);
    } else if (listedCount <= 30) {
      score += 6;
      reasons.push(`在售/发布 ${listedCount} 件`);
    } else if (listedCount <= 100) {
      score -= 6;
      reasons.push(`在售/发布 ${listedCount} 件，疑似小B`);
    } else {
      score -= 18;
      reasons.push(`在售/发布 ${listedCount} 件，明显小B`);
    }
  }

  if (personalHits.length > 0) {
    score += Math.min(20, personalHits.length * 8);
    reasons.push(`个人词：${personalHits.slice(0, 3).join('/')}`);
  }

  if (personalGoodsHits.length > 0) {
    score += Math.min(18, personalGoodsHits.length * 6);
    reasons.push(`卖家杂货：${personalGoodsHits.slice(0, 3).join('/')}`);
  }

  if (businessHits.length > 0) {
    score -= Math.min(30, businessHits.length * 6);
    reasons.push(`商家词：${businessHits.slice(0, 4).join('/')}`);
  }

  score = Math.max(0, Math.min(100, score));
  const hasStrongBusinessSignal = (dealCount != null && dealCount > 500)
    || (listedCount != null && listedCount > 100)
    || businessHits.length >= 2;
  let sellerType = '待判断';
  if (score >= 75) sellerType = '个人倾向';
  else if (score < 25 && hasStrongBusinessSignal) sellerType = '明显小B';
  else if (score < 45) sellerType = '疑似小B';

  return {
    sellerPersonalScore: score,
    sellerType,
    sellerProfileReason: reasons.join('；') || '信息不足',
    sellerBusinessSignals: businessHits,
    sellerPersonalSignals: personalHits,
    sellerPersonalGoodsSignals: personalGoodsHits,
  };
}

export async function fineFilter(products, requirements, emitLog, shouldStop, customPromptHead, sellerBlacklist = [], sellerManualLabels = {}) {
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
      Object.assign(enriched, buildSellerProfile(enriched));
      const manualLabel = getManualSellerLabel(enriched.sellerName, sellerManualLabels);
      if (manualLabel) {
        enriched.sellerManualLabel = manualLabel;
        enriched.sellerType = manualLabel;
        enriched.sellerPersonalScore = manualLabel === '大卖' ? 0 : 25;
        enriched.sellerProfileReason = `人工标注：${manualLabel}`;
      }
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
        if (/万|w/i.test(match[2] || '')) return Math.round(n * 10000);
        if (/千|k/i.test(match[2] || '')) return Math.round(n * 1000);
        return Math.round(n);
      };
      const extractCount = (patterns) => {
        const sourceText = `${bodyText}\n${labelTexts.join('\n')}`.replace(/,/g, '');
        for (const pattern of patterns) {
          const match = sourceText.match(pattern);
          const count = parseCountMatch(match);
          if (count != null) return count;
        }
        return null;
      };
      const extractWantCount = (text = '') => parseCountMatch(
        String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万wW]?)\s*人?想要/)
      );
      const extractWantText = (text = '') => (
        String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?\s*[万wW]?\s*人?想要)/)?.[1]?.trim() || ''
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
      const sellerDealCount = extractCount([
        /(?:交易过|卖出过|卖出|已卖出|已售|成交|出售)\D{0,10}(\d+(?:\.\d+)?)\s*([万千kKwW]?)\s*(?:件|单|个|笔)?/,
        /(\d+(?:\.\d+)?)\s*([万千kKwW]?)\s*(?:件|单|个|笔)?\D{0,10}(?:交易|卖出|已售|成交|出售)/,
      ]);
      const sellerListedCount = extractCount([
        /(?:发布|在售|上架|宝贝)\D{0,10}(\d+(?:\.\d+)?)\s*([万千kKwW]?)\s*(?:件|个)?/,
        /(\d+(?:\.\d+)?)\s*([万千kKwW]?)\s*(?:件|个)?\D{0,10}(?:发布|在售|上架|宝贝)/,
      ]);

      const priceEl = document.querySelector('[class*="price--"][class*="windows"]')
        || document.querySelector('[class*="price--"]');
      const detailPrice = priceEl?.textContent?.trim() || '';

      const wantEl = document.querySelector('[class*="want--"]');
      const wantSourceText = wantEl?.textContent?.trim() || matchText([/(\d+(?:\.\d+)?\s*[万wW]?\s*人?想要)/]);
      const wantText = extractWantText(wantSourceText);
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
      const currentItemId = new URLSearchParams(location.search).get('id') || '';
      const sellerOtherText = [...document.querySelectorAll('a[href*="/item?id="], [class*="seller"], [class*="user"], [class*="shop"]')]
        .map(el => {
          const href = el.getAttribute?.('href') || '';
          if (currentItemId && href.includes(`id=${currentItemId}`)) return '';
          return el.textContent?.trim() || el.getAttribute?.('title') || '';
        })
        .filter(Boolean)
        .join('\n')
        .slice(0, 1200);

      return {
        description,
        sellerName,
        sellerLocation,
        sellerRating,
        sellerLastSeen,
        sellerDealCount,
        sellerListedCount,
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
        sellerOtherText,
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
