import { newPage } from './browser.mjs';
import { randomDelay, extractItemId, extractUserId, sleep, waitIfVerification } from './utils.mjs';
import { DEFAULT_SELLER_LEXICON, DEFAULT_SELLER_FINE_RULES } from './config.mjs';

const BATCH_SIZE = 15;
const DEFAULT_SELLER_STRUCTURE_RULES = { luxuryCountThreshold: 5, luxuryRatioThreshold: 0.4, luxuryHighRatioThreshold: 0.6 };

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

  emitLog(`🔸 粗筛完成: ${hardPassed.length}/${products.length} 通过（仅列表页硬性条件）`);
  return hardPassed;
}

function judgeByHardRules(product, options = {}) {
  const manualLabel = getManualSellerLabel(product, options.sellerManualLabels);
  if (manualLabel === '小B') {
    return { pass: false, reason: `人工标注卖家：${manualLabel}` };
  }
  const sellerId = String(product?.sellerId || '').trim();
  const fingerprint = String(product?.sellerFingerprint || '').trim();
  const sellerName = normalizeSellerName(product?.sellerName);
  const sellerProfiles = options.sellerProfiles || {};
  const autoProfile = [
    sellerId && sellerProfiles[`id:${sellerId}`],
    fingerprint && sellerProfiles[`avatar:${fingerprint}`],
    sellerName && sellerProfiles[`name:${sellerName}`],
  ].find(profile => profile?.sellerAutoConfirmed === true && profile?.sellerType === '小B');
  if (autoProfile) return { pass: false, reason: '经营词自动确认小B' };
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
  const requiredBadges = [
    ['requireInspect', '验货宝'], ['requireGuarantee', '验号担保'], ['requireSuperShop', '超赞鱼小铺'],
    ['requireBrandNew', '全新'], ['requireStrictSelect', '严选'], ['requireResale', '转卖'],
  ];
  for (const [option, label] of requiredBadges) {
    if (options[option] && !product.badges?.includes(label)) return { pass: false, reason: `未标注${label}` };
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
  const product = typeof name === 'object' && name ? name : { sellerName: name };
  const sellerId = String(product.sellerId || '').trim();
  const fingerprint = String(product.sellerFingerprint || '').trim();
  const sellerName = String(product.sellerName || '').trim();
  const label = (sellerId && labels?.[`id:${sellerId}`])
    || (fingerprint && labels?.[`avatar:${fingerprint}`])
    || labels?.[normalizeSellerName(sellerName)]
    || labels?.[sellerName]
    || '';
  // 兼容旧数据中的历史等级；新写入只会使用新的五级定义。
  if (label === '大卖') return '小B';
  if (label === '重点个人卖家') return '个人卖家';
  return label === '待判断' ? '不明确' : label;
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

function buildSellerProfile(product, lexicon = DEFAULT_SELLER_LEXICON, _fineRules = DEFAULT_SELLER_FINE_RULES, structureRules = DEFAULT_SELLER_STRUCTURE_RULES) {
  const structure = { ...DEFAULT_SELLER_STRUCTURE_RULES, ...(structureRules || {}) };
  const businessWords = lexicon.businessWords || DEFAULT_SELLER_LEXICON.businessWords;
  const includesWord = (text, word) => String(text || '').toLowerCase().includes(String(word || '').toLowerCase());
  // 只认可卖家身份页的证据：名称/简介经营词，以及该卖家真实在售商品标题。
  // 当前商品标题、描述、成交量和在售总量都不参与卖家等级判断。
  const sellerNameBusinessHits = businessWords.filter(word => includesWord(product.sellerName, word));
  const sellerProfileBusinessHits = businessWords.filter(word => includesWord(product.sellerProfileText, word));
  const sellerOtherItems = Array.isArray(product.sellerOtherItems) ? product.sellerOtherItems : [];
  const luxuryProductWords = lexicon.luxuryProductWords || DEFAULT_SELLER_LEXICON.luxuryProductWords || [];
  const luxuryOtherItems = sellerOtherItems.filter(item => luxuryProductWords.some(word => includesWord(item, word)));
  const luxuryItemCount = luxuryOtherItems.length;
  const luxurySampleCount = sellerOtherItems.length;
  const luxuryItemRatio = luxurySampleCount ? luxuryItemCount / luxurySampleCount : null;
  const reasons = [];
  if (sellerNameBusinessHits.length) reasons.push(`卖家名称经营词：${sellerNameBusinessHits.slice(0, 4).join('/')}`);
  if (sellerProfileBusinessHits.length) reasons.push(`店铺介绍经营词：${sellerProfileBusinessHits.slice(0, 4).join('/')}`);
  const hasLuxuryStructure = luxuryItemCount >= structure.luxuryCountThreshold
    || (luxuryItemRatio != null && luxuryItemRatio >= structure.luxuryRatioThreshold);
  if (luxurySampleCount) {
    reasons.push(`在售样本 ${luxurySampleCount} 件，二奢 ${luxuryItemCount} 件（${Math.round(luxuryItemRatio * 100)}%）`);
  }
  const hasBusinessWordSignal = sellerNameBusinessHits.length > 0 || sellerProfileBusinessHits.length > 0;
  // 昵称或店铺简介属于卖家主动经营表述，是唯一可自动确认“小B”的强证据。
  // 卖家在售结构仍只产生“疑似小B”，保留给人工复核。
  const sellerType = hasBusinessWordSignal ? '小B' : (hasLuxuryStructure ? '疑似小B' : '不明确');

  return {
    sellerPersonalScore: null,
    sellerType,
    sellerProfileReason: `${hasBusinessWordSignal ? '经营词自动确认小B；' : ''}${reasons.join('；') || '未发现二奢经营证据'}`,
    sellerAutoConfirmed: hasBusinessWordSignal,
    sellerBusinessSignals: [...new Set([...sellerNameBusinessHits, ...sellerProfileBusinessHits])],
    sellerTitleBusinessSignals: [],
    sellerProfileBusinessSignals: sellerProfileBusinessHits,
    sellerPersonalSignals: [],
    sellerPersonalGoodsSignals: [],
    sellerLuxuryItemCount: luxuryItemCount,
    sellerLuxurySampleCount: luxurySampleCount,
    sellerLuxuryItemRatio: luxuryItemRatio,
    sellerLuxuryStructureStrong: luxuryItemRatio != null && luxuryItemRatio >= structure.luxuryHighRatioThreshold,
  };
}

function findCachedSellerProfile(product, sellerProfiles = {}) {
  const sellerId = String(product.sellerId || '').trim();
  const fingerprint = String(product.sellerFingerprint || '').trim();
  const sellerName = normalizeSellerName(product.sellerName);
  const keys = [
    sellerId && `id:${sellerId}`,
    fingerprint && `avatar:${fingerprint}`,
    sellerName && `name:${sellerName}`,
  ].filter(Boolean);
  const matches = keys.map(key => sellerProfiles[key]).filter(Boolean);
  if (!matches.length) return null;
  return matches.sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0))[0];
}

export async function fineFilter(products, options, emitLog, shouldStop, sellerBlacklist = [], sellerManualLabels = {}, sellerLexicon = DEFAULT_SELLER_LEXICON, sellerFineRules = DEFAULT_SELLER_FINE_RULES, sellerProfiles = {}) {
  emitLog(`🔹 细筛开始，共 ${products.length} 个商品`);
  const passed = [];
  const sellerPageCache = new Map();
  const blacklist = new Set((sellerBlacklist || []).map(normalizeSellerName).filter(Boolean));

  for (let i = 0; i < products.length; i++) {
    if (shouldStop()) break;

    const product = products[i];
    emitLog(`  细筛 [${i + 1}/${products.length}] ${product.title.slice(0, 30)}...`);

    try {
      const cachedProfile = findCachedSellerProfile(product, sellerProfiles);
      // 仅复用已由详情页细筛或手动核验过的档案。列表页采集建立的卖家池
      // 属于待核验档案，首次细筛必须打开商品详情页补齐卖家信息。
      if (cachedProfile?.sellerProfileVerified === true && cachedProfile.sellerStructureSource === 'seller-profile' && !options.forceDetail) {
        const enriched = { ...product, ...cachedProfile, sellerFingerprint: product.sellerFingerprint || cachedProfile.sellerFingerprint || '', sellerProfileSource: '卖家档案复用' };
        const manualLabel = getManualSellerLabel(enriched, sellerManualLabels);
        if (manualLabel) enriched.sellerManualLabel = manualLabel;
        emitLog(`    ♻️ 复用卖家档案，不打开详情页`);
        passed.push(enriched);
        continue;
      }
      const detail = await fetchProductDetail(product, emitLog, shouldStop);
      // 详情页有头像时以它更新指纹；页面暂时未加载到头像时保留列表页指纹，
      // 避免把已知身份意外清空。
      const enriched = {
        ...product,
        ...detail,
        sellerAvatarUrl: detail.sellerAvatarUrl || product.sellerAvatarUrl || '',
        sellerFingerprint: detail.sellerFingerprint || product.sellerFingerprint || '',
      };
      const sellerPageUrl = detail.sellerProfileUrl || product.sellerProfileUrl || '';
      if (sellerPageUrl) {
        const cacheKey = detail.sellerId || sellerPageUrl;
        let sellerPage = sellerPageCache.get(cacheKey);
        if (!sellerPage) {
          sellerPage = await fetchSellerProfile(sellerPageUrl, enriched.sellerName, options.sellerStructureRules?.sampleSize || 20, emitLog, shouldStop);
          sellerPageCache.set(cacheKey, sellerPage);
        }
        Object.assign(enriched, sellerPage);
      }
      Object.assign(enriched, buildSellerProfile(enriched, sellerLexicon, sellerFineRules, options.sellerStructureRules));
      const manualLabel = getManualSellerLabel(enriched, sellerManualLabels);
      if (manualLabel) {
        enriched.sellerManualLabel = manualLabel;
        enriched.sellerType = manualLabel;
        enriched.sellerPersonalScore = manualLabel === '小B' ? 0 : 100;
        enriched.sellerProfileReason = `人工标注：${manualLabel}`;
      }
      const sellerName = normalizeSellerName(enriched.sellerName);

      if (sellerName && blacklist.has(sellerName)) {
        emitLog(`    黑名单跳过 - ${enriched.sellerName}`);
        continue;
      }

      const result = judgeByFineRules(enriched, options);
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

function judgeByFineRules(product) {
  return { pass: true, reason: `卖家等级：${product.sellerType}；${product.sellerProfileReason}` };
}

async function fetchSellerProfile(url, sellerName, sampleSize, emitLog, shouldStop) {
  const page = await newPage();
  try {
    emitLog('    读取卖家在售列表…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const verifyOk = await waitIfVerification(page, { emitLog, shouldStop, label: sellerName?.slice(0, 15) || '卖家页' });
    if (!verifyOk) return { sellerOtherItems: [], sellerProfileText: '', sellerProfileUrl: url, sellerStructureSource: 'seller-profile' };
    await sleep(3000);
    return await page.evaluate(({ expectedSeller, limit }) => {
      const bodyText = document.body?.innerText || '';
      const itemLinks = [...document.querySelectorAll('a[href*="/item?id="]')]
        .map(link => ({ href: link.href || '', text: link.textContent?.trim() || '' }))
        // 卖家页卡片必须包含当前卖家昵称；这条约束可避免把任何推荐流混入样本。
        .filter(item => item.text && expectedSeller && item.text.includes(expectedSeller))
        .filter((item, index, items) => items.findIndex(other => other.href === item.href) === index)
        .slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)));
      return {
        sellerOtherItems: itemLinks.map(item => item.text),
        sellerProfileText: bodyText.slice(0, 5000),
        sellerProfileUrl: location.href,
        sellerStructureSource: 'seller-profile',
      };
    }, { expectedSeller: sellerName || '', limit: sampleSize });
  } catch (err) {
    emitLog(`    ⚠️ 卖家页读取失败: ${err.message}`);
    return { sellerOtherItems: [], sellerProfileText: '', sellerProfileUrl: url, sellerStructureSource: 'seller-profile' };
  } finally {
    await page.close().catch(() => {});
  }
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
      const canonicalAvatarFingerprint = (url = '') => {
        const value = String(url || '').trim();
        const image = value.match(/^(.*?\.(?:jpe?g|png|webp|gif))(?:_.+)?$/i)?.[1] || value;
        return image.replace(/^https?:/i, '');
      };
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

      const sellerInfo = document.querySelector('[class*="item-user-info"]');
      const nickEl = sellerInfo?.querySelector('[class*="item-user-info-nick"]')
        || document.querySelector('[class*="item-user-info-nick"]');
      // 闲鱼会调整昵称节点的 class；限定在卖家信息块中寻找备用昵称节点，
      // 并避开地区、好评和活跃状态等标签，不能把地区误作昵称。
      const sellerNameCandidates = [...(sellerInfo?.querySelectorAll('[class*="nick"], [class*="user-name"], [class*="userName"]') || [])]
        .map(el => el.textContent?.trim() || '')
        .filter(text => text && !/^(?:北京|天津|河北|山西|内蒙古|辽宁|吉林|黑龙江|上海|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|重庆|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|台湾|香港|澳门|海外)$/.test(text))
        .filter(text => !/好评|来过|在线|活跃/.test(text));
      const sellerName = nickEl?.textContent?.trim() || sellerNameCandidates[0] || '';
      const sellerAvatarUrl = sellerInfo?.querySelector('img')?.getAttribute('src')
        || document.querySelector('[class*="item-user-info"] img')?.getAttribute('src')
        || '';
      const sellerProfileUrl = nickEl?.closest('a[href*="/personal"]')?.href
        || document.querySelector('a[href*="/personal?userId="]')?.href
        || '';

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
      const sellerOtherItems = [...document.querySelectorAll('a[href*="/item?id="]')]
        .map(el => {
          const href = el.getAttribute?.('href') || '';
          const title = el.textContent?.trim() || el.getAttribute?.('title') || '';
          if (!title || (currentItemId && href.includes(`id=${currentItemId}`))) return null;
          return { href, title };
        })
        .filter(Boolean)
        .filter((item, index, items) => items.findIndex(other => other.href === item.href) === index)
        .slice(0, 20);
      const sellerOtherText = sellerOtherItems.map(item => item.title).join('\n').slice(0, 1200);

      return {
        description,
        sellerName,
        sellerAvatarUrl,
        sellerProfileUrl,
        sellerFingerprint: canonicalAvatarFingerprint(sellerAvatarUrl),
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
        sellerOtherItems: sellerOtherItems.map(item => item.title),
      };
    });

    const chatLink = await page.locator('a[href*="/im?itemId="]').first().getAttribute('href').catch(() => '');
    if (chatLink) {
      detail.chatUrl = chatLink.startsWith('http') ? chatLink : `https://www.goofish.com${chatLink}`;
      detail.sellerId = extractUserId(chatLink) || extractUserId(detail.sellerProfileUrl || '');
    }
    if (!detail.sellerId) detail.sellerId = extractUserId(detail.sellerProfileUrl || '');

    return detail;
  } catch (err) {
    return { description: '', sellerName: '', sellerLocation: '', error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}
