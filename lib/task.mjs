import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { genId, timestamp } from './utils.mjs';
import { checkLogin } from './login.mjs';
import { searchProducts } from './search.mjs';
import { coarseFilter, fineFilter } from './filter.mjs';
import { ChatManager } from './chat.mjs';
import { claimContact } from './contact-claims.mjs';
import { getConfig, getSafeConfig, saveConfig, setSellerPoolRuntime } from './config.mjs';
import { queueSharedSellerPoolSync, syncSharedSellerPool } from './seller-pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

const STAGES = ['login', 'searching', 'coarse_filter', 'fine_filter', 'review', 'chatting'];
const LOCATION_ONLY_NAMES = new Set([
  '北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
  '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆', '台湾', '香港', '澳门', '海外',
]);

function hasUsableSellerIdentity({ sellerId, sellerName } = {}) {
  if (String(sellerId || '').trim()) return true;
  const name = String(sellerName || '').trim();
  return Boolean(name) && !LOCATION_ONLY_NAMES.has(name);
}

function parsePriceNumber(value) {
  const match = String(value || '').replace(/,/g, '').match(/[\d.]+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function mergeProductSnapshot(existing, incoming, now = Date.now()) {
  const currentPrice = parsePriceNumber(incoming.price);
  const previousPrice = parsePriceNumber(existing?.price);
  const firstSeenAt = existing?.firstSeenAt || now;
  const priceHistory = Array.isArray(existing?.priceHistory) ? [...existing.priceHistory] : [];

  if (currentPrice != null) {
    const last = priceHistory[priceHistory.length - 1];
    if (!last || last.price !== currentPrice) {
      priceHistory.push({ time: now, price: currentPrice });
    }
  }

  const priceDelta = currentPrice != null && previousPrice != null ? currentPrice - previousPrice : 0;
  const priceChange = priceDelta < 0 ? '降价' : priceDelta > 0 ? '涨价' : (existing ? '未变' : '新发现');

  return {
    ...(existing || {}),
    ...incoming,
    firstSeenAt,
    lastSeenAt: now,
    previousPrice: previousPrice ?? null,
    currentPrice: currentPrice ?? previousPrice ?? null,
    priceDelta,
    priceChange,
    priceHistory: priceHistory.slice(-20),
  };
}

function mergeSnapshotStore(currentStore = {}, products = []) {
  const store = { ...(currentStore || {}) };
  for (const product of products || []) {
    if (!product?.id) continue;
    store[product.id] = mergeProductSnapshot(store[product.id], product, product.lastSeenAt || Date.now());
  }
  return store;
}

function isFineCandidate(product, sellerManualLabels = {}) {
  const sellerId = String(product?.sellerId || '').trim();
  const fingerprint = String(product?.sellerFingerprint || '').trim();
  const sellerName = String(product?.sellerName || '').trim();
  const saved = (sellerId && sellerManualLabels[`id:${sellerId}`])
    || (fingerprint && sellerManualLabels[`avatar:${fingerprint}`])
    || sellerManualLabels[sellerName.toLowerCase()]
    || sellerManualLabels[sellerName]
    || '';
  const manual = (saved === '大卖' ? '小B' : saved === '重点个人卖家' ? '个人卖家' : saved === '待判断' ? '不明确' : saved) || product?.sellerManualLabel || '';
  const automatic = product?.sellerType === '待判断' ? '不明确' : product?.sellerType;
  const level = manual || automatic || '不明确';
  return !['小B', '疑似小B'].includes(level);
}

export class TaskManager {
  constructor(broadcast) {
    this.tasks = new Map();
    this.broadcast = broadcast;
    this._loadFromDisk();
  }

  _removeInvalidSellerProfiles() {
    const profiles = { ...(getConfig().sellerProfiles || {}) };
    let changed = false;
    for (const [key, profile] of Object.entries(profiles)) {
      if (hasUsableSellerIdentity(profile)) continue;
      delete profiles[key];
      changed = true;
    }
    if (changed) {
      setSellerPoolRuntime(profiles, getConfig().sellerManualLabels || {});
      void queueSharedSellerPoolSync();
      console.log('🧹 已移除缺少可靠卖家身份的历史档案');
    }
  }

  _migrateHistoricalSellerProfiles() {
    const existing = { ...(getConfig().sellerProfiles || {}) };
    let changed = false;
    for (const task of this.tasks.values()) {
      for (const product of task.products?.fineFiltered || []) {
        const legacyType = product.sellerType === '明显小B' ? '疑似小B'
          : (product.sellerType === '个人倾向' ? '疑似个人卖家'
            : (product.sellerType === '待判断' ? '不明确' : product.sellerType));
        const fingerprint = String(product.sellerFingerprint || '').trim();
        const sellerId = String(product.sellerId || '').trim();
        const sellerName = String(product.sellerName || '').trim();
        if (!hasUsableSellerIdentity({ sellerId, sellerName })) continue;
        const key = sellerId ? `id:${sellerId}` : (fingerprint ? `avatar:${fingerprint}` : (sellerName ? `name:${sellerName.toLowerCase()}` : ''));
        if (!key || existing[key]) continue;
        existing[key] = {
          sellerId, sellerName, sellerFingerprint: fingerprint, sellerAvatarUrl: product.sellerAvatarUrl || '',
          sellerLocation: product.sellerLocation || '', sellerRating: product.sellerRating || '',
          sellerDealCount: product.sellerDealCount ?? null, sellerListedCount: product.sellerListedCount ?? null,
          sellerType: legacyType, sellerAutoConfirmed: product.sellerAutoConfirmed === true, sellerPersonalScore: product.sellerPersonalScore ?? null,
          sellerProfileReason: product.sellerProfileReason || '从历史细筛结果迁移',
          sellerBusinessSignals: product.sellerBusinessSignals || [], sellerPersonalSignals: product.sellerPersonalSignals || [], sellerPersonalGoodsSignals: product.sellerPersonalGoodsSignals || [],
          latestProductTitle: product.title || '', latestProductHref: product.href || '', taskId: task.id, taskName: task.name,
          checkedAt: product.lastSeenAt || product.updatedAt || task.createdAt || Date.now(),
        };
        changed = true;
      }
    }
    if (changed) {
      setSellerPoolRuntime(existing, getConfig().sellerManualLabels || {});
      void queueSharedSellerPoolSync();
      console.log(`🔄 已迁移 ${Object.keys(existing).length} 条卖家档案`);
    }
  }

  _syncSellerProfiles(products, task, { detailVerified = false } = {}) {
    const profiles = { ...(getConfig().sellerProfiles || {}) };
    let changed = false;
    for (const product of products || []) {
      const fingerprint = String(product.sellerFingerprint || '').trim();
      const sellerId = String(product.sellerId || '').trim();
      const sellerName = String(product.sellerName || '').trim();
      // 头像本身不是可靠卖家身份；没有昵称和卖家 ID 时不进入卖家池。
      if (!hasUsableSellerIdentity({ sellerId, sellerName })) continue;
      const keys = [sellerId && `id:${sellerId}`, fingerprint && `avatar:${fingerprint}`, sellerName && `name:${sellerName.toLowerCase()}`].filter(Boolean);
      if (!keys.length) continue;
      const current = keys.map(key => profiles[key]).filter(Boolean).sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0))[0] || {};
      const next = {
        ...current,
        sellerId: sellerId || current.sellerId || '', sellerName: sellerName || current.sellerName || '',
        sellerFingerprint: fingerprint || current.sellerFingerprint || '', sellerAvatarUrl: product.sellerAvatarUrl || current.sellerAvatarUrl || '',
        sellerLocation: product.sellerLocation || current.sellerLocation || '', sellerRating: product.sellerRating || current.sellerRating || '',
        sellerDealCount: product.sellerDealCount ?? current.sellerDealCount ?? null, sellerListedCount: product.sellerListedCount ?? current.sellerListedCount ?? null,
        sellerType: product.sellerType || current.sellerType || '不明确', sellerAutoConfirmed: product.sellerAutoConfirmed === true, sellerPersonalScore: product.sellerPersonalScore ?? current.sellerPersonalScore ?? null,
        sellerProfileReason: product.sellerProfileReason || current.sellerProfileReason || '',
        sellerProfileUrl: product.sellerProfileUrl || current.sellerProfileUrl || '', sellerProfileText: product.sellerProfileText || current.sellerProfileText || '', sellerOtherItems: product.sellerOtherItems || current.sellerOtherItems || [], sellerStructureSource: product.sellerStructureSource || current.sellerStructureSource || '',
        sellerTitleBusinessSignals: product.sellerTitleBusinessSignals || current.sellerTitleBusinessSignals || [],
        sellerProfileBusinessSignals: product.sellerProfileBusinessSignals || current.sellerProfileBusinessSignals || [],
        sellerLuxuryItemCount: product.sellerLuxuryItemCount ?? current.sellerLuxuryItemCount ?? 0, sellerLuxurySampleCount: product.sellerLuxurySampleCount ?? current.sellerLuxurySampleCount ?? 0, sellerLuxuryItemRatio: product.sellerLuxuryItemRatio ?? current.sellerLuxuryItemRatio ?? null,
        sellerBusinessSignals: product.sellerBusinessSignals || current.sellerBusinessSignals || [], sellerPersonalSignals: product.sellerPersonalSignals || current.sellerPersonalSignals || [], sellerPersonalGoodsSignals: product.sellerPersonalGoodsSignals || current.sellerPersonalGoodsSignals || [],
        latestProductTitle: product.title || current.latestProductTitle || '', latestProductHref: product.href || current.latestProductHref || '', taskId: task.id, taskName: task.name,
        // 列表页采集只用于建立卖家池，不代表已访问详情页。只有细筛或手动核验
        // 写入的档案才可被后续细筛复用，避免首次细筛被列表页临时档案短路。
        sellerProfileVerified: detailVerified || current.sellerProfileVerified === true,
        checkedAt: product.lastSeenAt || Date.now(),
      };
      keys.forEach(key => { profiles[key] = next; });
      changed = true;
    }
    if (changed) {
      setSellerPoolRuntime(profiles, getConfig().sellerManualLabels || {});
      void queueSharedSellerPoolSync();
      // 卖家池是全局配置的一部分；细筛完成后必须立即通知页面刷新缓存。
      this.broadcast?.({ event: 'config:changed', data: { configured: true, config: getSafeConfig() } });
    }
  }

  async refreshSellerProfile(identity = {}) {
    const profile = Object.values(getConfig().sellerProfiles || {}).find(item =>
      (identity.sellerId && item.sellerId === identity.sellerId)
      || (identity.sellerFingerprint && item.sellerFingerprint === identity.sellerFingerprint)
      || (identity.sellerName && item.sellerName === identity.sellerName)
    );
    const candidates = [...this.tasks.values()].flatMap(task => [
      ...(task.products?.fineFiltered || []).map(product => ({ task, product })),
      ...(task.products?.coarseFiltered || []).map(product => ({ task, product })),
      ...(task.products?.raw || []).map(product => ({ task, product })),
    ]);
    const found = candidates.find(({ product }) => profile?.latestProductHref && product.href === profile.latestProductHref)
      || candidates.find(({ product }) => (identity.sellerId && product.sellerId === identity.sellerId)
        || (identity.sellerFingerprint && product.sellerFingerprint === identity.sellerFingerprint)
        || (identity.sellerName && product.sellerName === identity.sellerName));
    if (!found?.product?.href) throw new Error('未找到可用于核验的历史商品链接');

    const result = await fineFilter(
      [found.product], { forceDetail: true, sellerStructureRules: found.task.config?.sellerStructureRules }, () => {}, () => false,
      getConfig().sellerBlacklist || [], getConfig().sellerManualLabels || {}, getConfig().sellerLexicon,
      getConfig().sellerFineRules, getConfig().sellerProfiles || {}
    );
    if (!result.length) throw new Error('详情页未返回可用卖家信息');
    this._syncSellerProfiles(result, found.task, { detailVerified: true });
    return result[0];
  }

  _buildTaskConfig(config) {
    return {
      keywordGroups: (config.keywordGroups?.length ? config.keywordGroups : [config.queries || []]).map(group => (group || []).flatMap(query => String(query || '').split(/[,，\s]+/)).map(query => query.trim()).filter(Boolean)).filter(group => group.length),
      queries: (config.queries || []).flatMap(query => String(query || '').split(/[,，\s]+/)).map(query => query.trim()).filter(Boolean),
      priceMin: config.priceMin !== undefined ? config.priceMin : 500,
      priceMax: config.priceMax ?? null,
      region: config.region || '',
      personalSeller: config.personalSeller || false,
      requireFreeShipping: config.requireFreeShipping || false,
      wantMax: Number(config.wantMax) > 0 ? Number(config.wantMax) : null,
      titleExclude: config.titleExclude !== undefined ? config.titleExclude : '求购、维修、养护、配件',
      searchSort: config.searchSort || 'newest',
      requireInspect: !!config.requireInspect,
      requireGuarantee: !!config.requireGuarantee,
      requireSuperShop: !!config.requireSuperShop,
      requireBrandNew: !!config.requireBrandNew,
      requireStrictSelect: !!config.requireStrictSelect,
      requireResale: !!config.requireResale,
      sellerStructureRules: {
        sampleSize: Math.min(50, Math.max(1, Number(config.sellerStructureRules?.sampleSize) || 20)),
        luxuryCountThreshold: Math.max(1, Number(config.sellerStructureRules?.luxuryCountThreshold) || 5),
        luxuryRatioThreshold: Math.min(1, Math.max(0, Number(config.sellerStructureRules?.luxuryRatioThreshold) || 0.4)),
        luxuryHighRatioThreshold: Math.min(1, Math.max(0, Number(config.sellerStructureRules?.luxuryHighRatioThreshold) || 0.6)),
      },
      runStages: {
        collect: config.runStages?.collect !== false,
        coarse: config.runStages?.coarse !== false,
        fine: config.runStages?.fine === true,
        inquiry: !!config.runStages?.inquiry,
      },
      chatStrategy: config.chatStrategy || '',
      persona: config.persona || '',
      coarsePrompt: config.coarsePrompt || '',
      finePrompt: config.finePrompt || '',
      maxPages: config.maxPages || 1,
    };
  }

  createTask(config) {
    const id = genId();
    const task = {
      id,
      name: config.name || `任务-${id}`,
      group: config.group || '未分组',
      config: this._buildTaskConfig(config),
      stage: 'pending',
      running: false,
      stopped: false,
      products: { raw: [], coarseFiltered: [], fineFiltered: [] },
      selectedProductIds: [],
      chatSessions: [],
      chatSessionsFull: [],
      productSnapshots: {},
      logs: [],
      createdAt: Date.now(),
    };

    this.tasks.set(id, task);
    this._persistToDisk();
    this._emit(id, 'task:created', this._serialize(task));
    return task;
  }

  duplicateTask(sourceId) {
    const source = this.tasks.get(sourceId);
    if (!source) return null;

    const id = genId();
    const task = {
      id,
      name: `${source.name} (副本)`,
      group: source.group || '未分组',
      config: { ...source.config },
      stage: 'pending',
      running: false,
      stopped: false,
      products: { raw: [], coarseFiltered: [], fineFiltered: [] },
      selectedProductIds: [],
      chatSessions: [],
      chatSessionsFull: [],
      productSnapshots: {},
      logs: [],
      createdAt: Date.now(),
    };

    this.tasks.set(id, task);
    this._persistToDisk();
    this._emit(id, 'task:created', this._serialize(task));
    return task;
  }

  async startTask(id, configUpdates = {}) {
    const task = this.tasks.get(id);
    if (!task || task.running) return;

    if (configUpdates.chatStrategy !== undefined) {
      task.config.chatStrategy = configUpdates.chatStrategy;
    }
    if (configUpdates.persona !== undefined) {
      task.config.persona = configUpdates.persona;
    }

    task.running = true;
    task.stopped = false;
    this._persistToDisk();
    this._emit(id, 'task:started', { id });

    const emitLog = (msg) => {
      const entry = { time: timestamp(), message: msg };
      task.logs.push(entry);
      this._emit(id, 'task:log', entry);
    };

    const shouldStop = () => task.stopped;

    try {
      const sellerPool = await syncSharedSellerPool();
      if (sellerPool.enabled) emitLog(`💾 已加载本机卖家池副本：${sellerPool.profiles} 条档案${sellerPool.pending ? `，待同步 ${sellerPool.pending} 项` : ''}`);
      await this._runPipeline(task, emitLog, shouldStop, { runChat: !!task.config.runStages?.inquiry });
      if (!task.stopped && task.stage !== 'review') {
        task.stage = 'completed';
      }
    } catch (err) {
      // 后台服务模式下，任务页面可能已关闭；同时写入 server.log，便于定位
      // Chromium 启动、网络访问等异常。
      console.error(`任务 ${id} 执行失败:`, err);
      emitLog(`❌ 任务异常: ${err.message}`);
    } finally {
      task.running = false;
      if (task.stopped) {
        task.stage = 'stopped';
      }
      this._persistToDisk();
      this._emit(id, 'task:finished', this._serialize(task));
    }
  }

  startChat(id, productIds = [], configUpdates = {}) {
    const task = this.tasks.get(id);
    if (!task || task.running) return { ok: false, error: 'Task not found or already running' };

    const fineIds = new Set(task.products.fineFiltered.map(p => p.id));
    const selectedProductIds = [...new Set(productIds)].filter(productId => fineIds.has(productId));
    if (selectedProductIds.length === 0) {
      return { ok: false, error: '请至少选择一个细筛通过的商品' };
    }

    if (configUpdates.chatStrategy !== undefined) {
      task.config.chatStrategy = configUpdates.chatStrategy;
    }
    if (configUpdates.persona !== undefined) {
      task.config.persona = configUpdates.persona;
    }

    task.selectedProductIds = selectedProductIds;
    task.running = true;
    task.stopped = false;
    this._persistToDisk();
    this._emit(id, 'task:started', { id });

    const emitLog = (msg) => {
      const entry = { time: timestamp(), message: msg };
      task.logs.push(entry);
      this._emit(id, 'task:log', entry);
    };
    const shouldStop = () => task.stopped;

    (async () => {
      try {
        await this._runPipeline(task, emitLog, shouldStop, { runChat: true });
        if (!task.stopped) {
          task.stage = 'completed';
        }
      } catch (err) {
        emitLog(`鉂?浠诲姟寮傚父: ${err.message}`);
      } finally {
        task.running = false;
        if (task.stopped) {
          task.stage = 'stopped';
        }
        this._persistToDisk();
        this._emit(id, 'task:finished', this._serialize(task));
      }
    })();

    return { ok: true };
  }

  rerunStage(id, stage) {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, error: 'Task not found' };
    if (task.running) return { ok: false, error: '请先停止任务后再重跑' };

    const validStages = new Set(['collect', 'append_collect', 'coarse', 'fine', 'fine_missing']);
    if (!validStages.has(stage)) return { ok: false, error: '不支持的重跑阶段' };

    if (stage === 'collect') {
      task.productSnapshots = mergeSnapshotStore(task.productSnapshots, task.products.raw);
      task.products = { raw: [], coarseFiltered: [], fineFiltered: [] };
      task.selectedProductIds = [];
      task.chatSessions = [];
      task.chatSessionsFull = [];
      task.stage = 'pending';
    } else if (stage === 'append_collect') {
      task.products.coarseFiltered = [];
      task.products.fineFiltered = [];
      task.selectedProductIds = [];
      task.stage = 'searching';
    } else if (stage === 'coarse') {
      if (task.products.raw.length === 0) return { ok: false, error: '没有采集结果可粗筛' };
      task.products.coarseFiltered = [];
      task.products.fineFiltered = [];
      task.selectedProductIds = [];
      task.stage = 'coarse_filter';
    } else if (stage === 'fine') {
      if (task.products.coarseFiltered.length === 0) return { ok: false, error: '没有粗筛结果可细筛' };
      task.products.fineFiltered = [];
      task.selectedProductIds = [];
      task.stage = 'fine_filter';
    } else if (stage === 'fine_missing') {
      if (task.products.coarseFiltered.length === 0) return { ok: false, error: '没有粗筛结果可补跑细筛' };
      task.selectedProductIds = [];
      task.stage = 'fine_filter';
    }

    task.running = true;
    task.stopped = false;
    this._persistToDisk();
    this._emit(id, 'task:started', { id });
    this._emitProducts(task);

    const emitLog = (msg) => {
      const entry = { time: timestamp(), message: msg };
      task.logs.push(entry);
      this._emit(id, 'task:log', entry);
    };
    const shouldStop = () => task.stopped;
    const label = {
      collect: '重新采集',
      append_collect: '追加采集',
      coarse: '重新粗筛',
      fine: '重新细筛',
      fine_missing: '补跑未细筛',
    }[stage];

    (async () => {
      try {
        emitLog(`========== ${label} ==========`); 
        await this._runPipeline(task, emitLog, shouldStop, {
          forceSearch: stage === 'append_collect',
          forceFine: stage === 'fine',
          fineMissing: stage === 'fine_missing',
        });
        if (!task.stopped && task.stage !== 'review') {
          task.stage = task.products.fineFiltered.length > 0 ? 'review' : 'completed';
        }
      } catch (err) {
        emitLog(`重跑异常: ${err.message}`);
      } finally {
        task.running = false;
        if (task.stopped) task.stage = 'stopped';
        this._persistToDisk();
        this._emit(id, 'task:finished', this._serialize(task));
      }
    })();

    return { ok: true };
  }

  stopTask(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.stopped = true;
    task.stage = 'stopping';
    this._persistToDisk();
    this._emit(id, 'task:stopping', { id });
  }

  updateTask(id, config) {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, error: 'Task not found' };
    if (task.running) return { ok: false, error: '请先停止任务后再编辑' };

    const nextConfig = this._buildTaskConfig(config);
    const heavyKeys = [
      'queries',
      'priceMin',
      'priceMax',
      'region',
      'personalSeller',
      'requireFreeShipping',
      'wantMax',
      'titleExclude',
      'searchSort', 'requireInspect', 'requireGuarantee', 'requireSuperShop',
      'requireBrandNew', 'requireStrictSelect', 'requireResale',
      'runStages',
      'maxPages',
    ];
    const changed = (key) => JSON.stringify(task.config?.[key] ?? null) !== JSON.stringify(nextConfig[key] ?? null);
    const affectsResults = heavyKeys.some(changed);

    task.name = config.name || task.name;
    task.group = config.group || task.group || '未分组';
    task.config = nextConfig;

    if (affectsResults) {
      task.logs.push({ time: timestamp(), message: '任务配置已更新，已有结果已保留；如需应用新条件，请使用「重跑」菜单。' });
    } else {
      task.logs.push({ time: timestamp(), message: '聊天策略/人设已更新，已有商品和聊天记录已保留。' });
    }

    this._persistToDisk();
    this._emit(id, 'task:finished', this._serialize(task));
    return { ok: true, task: this._serialize(task), affectsResults };
  }

  deleteTask(id) {
    const task = this.tasks.get(id);
    if (task) {
      task.stopped = true;
      this.tasks.delete(id);
      this._persistToDisk();
    }
  }

  getTask(id) {
    const task = this.tasks.get(id);
    return task ? this._serialize(task) : null;
  }

  getAllTasks() {
    return [...this.tasks.values()].map(t => this._serialize(t));
  }

  _resolveResumeStage(task) {
    if ((task.chatSessionsFull || []).length > 0) return 'chatting';
    if (task.products.fineFiltered.length > 0) return 'review';
    if (task.products.coarseFiltered.length > 0) return 'fine_filter';
    if (task.products.raw.length > 0) return 'coarse_filter';
    return null;
  }

  async _runPipeline(task, emitLog, shouldStop, { runChat = false, forceSearch = false, forceFine = false, fineMissing = false } = {}) {
    const runStages = task.config.runStages || { collect: true, coarse: true, fine: false, inquiry: false };
    const resumeStage = this._resolveResumeStage(task);
    const stageOrder = ['login', 'searching', 'coarse_filter', 'fine_filter', 'review', 'chatting'];
    const resumeIdx = resumeStage ? stageOrder.indexOf(resumeStage) : -1;

    if (resumeStage) {
      emitLog(`♻️ 检测到历史数据，从「${resumeStage}」阶段恢复`);
      emitLog(`  已有: ${task.products.raw.length}采集 / ${task.products.coarseFiltered.length}粗筛 / ${task.products.fineFiltered.length}细筛 / ${(task.chatSessionsFull || []).length}聊天`);
    }

    // Stage 1: Login (always)
    task.stage = 'login';
    this._emitStage(task);
    emitLog('========== 阶段1: 登录验证 ==========');

    const loggedIn = await checkLogin(emitLog);
    if (!loggedIn || shouldStop()) return;

    const filterRequirements = this._buildFilterRequirements(task.config);

    // Stage 2: Search
    if (!runStages.collect && !forceSearch) {
      emitLog('⏭️ 未勾选采集阶段');
    } else if (!forceSearch && resumeIdx >= stageOrder.indexOf('searching')) {
      emitLog(`⏭️ 跳过搜索采集（已有 ${task.products.raw.length} 个商品）`);
    } else {
      task.stage = 'searching';
      this._emitStage(task);
      emitLog('========== 阶段2: 搜索采集 ==========');

      const filters = {
        priceMin: task.config.priceMin,
        priceMax: task.config.priceMax,
        region: task.config.region,
        personalSeller: task.config.personalSeller,
        searchSort: task.config.searchSort,
        requireInspect: task.config.requireInspect,
        requireGuarantee: task.config.requireGuarantee,
        requireFreeShipping: task.config.requireFreeShipping,
        requireSuperShop: task.config.requireSuperShop,
        requireBrandNew: task.config.requireBrandNew,
        requireStrictSelect: task.config.requireStrictSelect,
        requireResale: task.config.requireResale,
      };

      let newCount = 0;
      let changedCount = 0;
      const keywordGroups = task.config.keywordGroups?.length ? task.config.keywordGroups : [task.config.queries];
      for (const titleKeywords of keywordGroups) {
        if (shouldStop()) break;
        const combinedQuery = titleKeywords.join(' ');
        const products = await searchProducts(combinedQuery, filters, task.config.maxPages, emitLog, shouldStop, titleKeywords);
        const now = Date.now();
        for (const product of products) {
        const existingIndex = task.products.raw.findIndex(e => e.id === product.id);
        if (existingIndex >= 0) {
          const merged = mergeProductSnapshot(task.products.raw[existingIndex], product, now);
          if (merged.priceDelta !== 0) changedCount += 1;
          task.products.raw[existingIndex] = merged;
          task.productSnapshots = { ...(task.productSnapshots || {}), [product.id]: merged };
        } else {
          const merged = mergeProductSnapshot(task.productSnapshots?.[product.id] || null, product, now);
          if (merged.priceDelta !== 0) changedCount += 1;
          task.products.raw.push(merged);
          task.productSnapshots = { ...(task.productSnapshots || {}), [product.id]: merged };
          newCount += 1;
        }
      }
      }

      emitLog(`  本轮新增 ${newCount} 个，价格变化 ${changedCount} 个`);
      this._syncSellerProfiles(task.products.raw, task);
      this._emitProducts(task);

      emitLog(`📊 总计采集 ${task.products.raw.length} 个商品（去重后）`);
      this._persistToDisk();
    }
    if (shouldStop() || task.products.raw.length === 0) return;

    // Stage 3: Coarse Filter
    if (!runStages.coarse) {
      emitLog('⏭️ 未勾选粗筛阶段');
    } else if (resumeIdx > stageOrder.indexOf('coarse_filter')) {
      emitLog(`⏭️ 跳过粗筛（已有 ${task.products.coarseFiltered.length} 个通过）`);
    } else {
      task.stage = 'coarse_filter';
      this._emitStage(task);
      emitLog('========== 阶段3: 粗筛（硬性条件） ==========');

      task.products.coarseFiltered = await coarseFilter(
        task.products.raw,
        '',
        emitLog,
        shouldStop,
        {
          priceMin: task.config.priceMin,
          priceMax: task.config.priceMax,
          requireFreeShipping: task.config.requireFreeShipping,
          wantMax: task.config.wantMax,
          titleExclude: task.config.titleExclude,
          requireInspect: task.config.requireInspect,
          requireGuarantee: task.config.requireGuarantee,
          requireSuperShop: task.config.requireSuperShop,
          requireBrandNew: task.config.requireBrandNew,
          requireStrictSelect: task.config.requireStrictSelect,
          requireResale: task.config.requireResale,
          sellerManualLabels: getConfig().sellerManualLabels || {},
          sellerProfiles: getConfig().sellerProfiles || {},
        }
      );
      this._emitProducts(task);
      this._persistToDisk();
    }
    if (!runStages.coarse) {
      task.stage = 'completed';
      this._emitStage(task);
      this._persistToDisk();
      return;
    }
    if (shouldStop() || task.products.coarseFiltered.length === 0) return;

    // Stage 4: Fine Filter
    if (!runStages.fine) {
      emitLog('⏭️ 未勾选细筛阶段');
    } else if (!forceFine && !fineMissing && resumeIdx > stageOrder.indexOf('fine_filter')) {
      emitLog(`⏭️ 跳过细筛（已有 ${task.products.fineFiltered.length} 个通过）`);
    } else {
      task.stage = 'fine_filter';
      this._emitStage(task);
      emitLog('========== 阶段4: 细筛（详情页筛选） ==========');

      const existingFineIds = new Set(task.products.fineFiltered.map(p => p.id));
      const fineInput = fineMissing
        ? task.products.coarseFiltered.filter(p => !existingFineIds.has(p.id))
        : task.products.coarseFiltered;
      if (fineMissing) {
        emitLog(`  补跑未细筛商品 ${fineInput.length}/${task.products.coarseFiltered.length}`);
      }

      const fineResult = await fineFilter(
        fineInput,
        { forceDetail: forceFine, sellerStructureRules: task.config.sellerStructureRules },
        emitLog,
        shouldStop,
        getConfig().sellerBlacklist || [],
        getConfig().sellerManualLabels || {},
        getConfig().sellerLexicon,
        getConfig().sellerFineRules,
        getConfig().sellerProfiles || {}
      );
      this._syncSellerProfiles(fineResult, task, { detailVerified: true });
      task.products.fineFiltered = fineMissing
        ? [...task.products.fineFiltered, ...fineResult.filter(p => !existingFineIds.has(p.id))]
        : fineResult;
      this._emitProducts(task);
      this._persistToDisk();
    }
    if (!runStages.fine) {
      task.stage = 'completed';
      this._emitStage(task);
      this._persistToDisk();
      emitLog(`粗筛完成：${task.products.coarseFiltered.length} 个商品可在列表中查看。`);
      return;
    }
    if (shouldStop() || task.products.fineFiltered.length === 0) return;

    if (!runChat) {
      task.stage = 'review';
      this._emitStage(task);
      this._persistToDisk();
      emitLog(`细筛完成：${task.products.fineFiltered.length} 个商品待确认，请在商品列表勾选后开始询价。`);
      return;
    }

    // Stage 5: Chat
    task.stage = 'chatting';
    this._emitStage(task);
    emitLog('========== 阶段5: 询价沟通 ==========');

    const chatManager = new ChatManager(emitLog, shouldStop);
    const chatContext = {
      requirements: filterRequirements,
      chatStrategy: task.config.chatStrategy,
      persona: task.config.persona,
    };

    const savedFull = task.chatSessionsFull || [];
    if (savedFull.length > 0) {
      const restored = chatManager.restoreSessions(savedFull, chatContext);
      if (restored > 0) {
        task.chatSessions = chatManager.getSessionsData();
        this._emit(task.id, 'task:chats', task.chatSessions);
      }
    }

    const chattedIds = new Set([...chatManager.sessions.keys()]);
    const selectedIds = new Set(task.selectedProductIds || []);
    const newProducts = task.products.fineFiltered
      .filter(p => selectedIds.size === 0 || selectedIds.has(p.id))
      .filter(p => !chattedIds.has(p.id));

    if (newProducts.length > 0) {
      emitLog(`  ${newProducts.length} 个商品待发起聊天（跳过已有 ${chattedIds.size} 个）`);
    }

    // 有恢复会话时立即启动 WS 监控（边监听边补漏）
    let monitorPromise = null;
    if (chatManager.sessions.size > 0) {
      monitorPromise = chatManager.monitorSessions();
    }

    for (const product of newProducts) {
      if (shouldStop()) {
        emitLog(`  ⚠️ 任务已停止，跳过剩余 ${newProducts.length - newProducts.indexOf(product)} 个商品`);
        break;
      }
      // 只在真正进入闲鱼聊天前读取 Turso 占用表，不影响页面或跟踪加载。
      const claim = await claimContact(product);
      if (!claim.ok) {
        emitLog(`⛔ 跳过「${product.title || product.id}」：${claim.error}`);
        continue;
      }
      emitLog(`🔒 已占用联系商品：${product.title || product.id}`);
      await chatManager.startChat(product, chatContext);
      task.chatSessions = chatManager.getSessionsData();
      task.chatSessionsFull = chatManager.getSessionsFullData();
      this._emit(task.id, 'task:chats', task.chatSessions);

      // 第一个聊天发送完后，立即启动 WS 监控（并行运行）
      if (!monitorPromise) {
        monitorPromise = chatManager.monitorSessions();
      }

      const delay = 8000 + Math.random() * 12000;
      emitLog(`  等待 ${Math.round(delay / 1000)}s 后处理下一个...`);
      await new Promise(r => setTimeout(r, delay));
    }

    // 无论是否被停止，先保存当前聊天数据
    task.chatSessions = chatManager.getSessionsData();
    task.chatSessionsFull = chatManager.getSessionsFullData();
    this._emit(task.id, 'task:chats', task.chatSessions);
    this._persistToDisk();

    if (shouldStop()) {
      emitLog('⚠️ 任务已停止，跳过聊天监控（聊天数据已保存，可稍后恢复）');
      await chatManager.cleanup();
      return;
    }

    emitLog('开始持续监控聊天回复...');

    const chatBroadcastInterval = setInterval(() => {
      task.chatSessions = chatManager.getSessionsData();
      task.chatSessionsFull = chatManager.getSessionsFullData();
      this._emit(task.id, 'task:chats', task.chatSessions);
    }, 5000);

    const persistInterval = setInterval(() => {
      this._persistToDisk();
    }, 30000);

    try {
      // 如果监控已在并行运行，等待它结束；否则现在启动
      if (monitorPromise) {
        await monitorPromise;
      } else {
        await chatManager.monitorSessions();
      }
    } finally {
      clearInterval(chatBroadcastInterval);
      clearInterval(persistInterval);
    }

    task.chatSessions = chatManager.getSessionsData();
    task.chatSessionsFull = chatManager.getSessionsFullData();
    this._emit(task.id, 'task:chats', task.chatSessions);

    await chatManager.cleanup();
    this._persistToDisk();
    emitLog('========== 任务流程结束 ==========');
  }

  _buildCoarseRequirements(config) {
    const parts = [];
    if (config.queries.length > 0) {
      parts.push(`目标商品（标题须同时包含）: ${config.queries.join(' + ')}`);
    }
    if (config.customRequirements) {
      parts.push(`补充需求: ${config.customRequirements}`);
    }
    return parts.join('\n');
  }

  _buildFilterRequirements(config) {
    const parts = [];
    if (config.queries.length > 0) {
      parts.push(`搜索关键词（标题 AND）: ${config.queries.join(' + ')}`);
    }
    if (config.priceMin != null || config.priceMax != null) {
      parts.push(`价格范围: ${config.priceMin ?? '不限'} - ${config.priceMax ?? '不限'}`);
    }
    if (config.region) {
      parts.push(`地区偏好: ${config.region}`);
    }
    if (config.personalSeller) {
      parts.push('只要个人卖家');
    }
    if (config.customRequirements) {
      parts.push(`商品需求: ${config.customRequirements}`);
    }
    return parts.join('\n');
  }

  _serialize(task) {
    return {
      id: task.id,
      name: task.name,
      group: task.group || '未分组',
      config: task.config,
      stage: task.stage,
      running: task.running,
      stopped: task.stopped,
      products: {
        rawCount: task.products.raw.length,
        coarseCount: task.products.coarseFiltered.length,
        fineCount: task.products.fineFiltered.filter(product => isFineCandidate(product, getConfig().sellerManualLabels || {})).length,
        fineReviewedCount: task.products.fineFiltered.length,
        raw: task.products.raw.slice(0, 100),
        coarseFiltered: task.products.coarseFiltered.slice(0, 50),
        fineFiltered: task.products.fineFiltered,
      },
      selectedProductIds: task.selectedProductIds || [],
      chatSessions: task.chatSessions || [],
      productSnapshots: task.productSnapshots || {},
      logs: task.logs.slice(-200),
      createdAt: task.createdAt,
    };
  }

  _serializeFull(task) {
    return {
      id: task.id,
      name: task.name,
      group: task.group || '未分组',
      config: task.config,
      stage: task.stage,
      products: {
        raw: task.products.raw,
        coarseFiltered: task.products.coarseFiltered,
        fineFiltered: task.products.fineFiltered,
      },
      selectedProductIds: task.selectedProductIds || [],
      chatSessions: task.chatSessions || [],
      chatSessionsFull: task.chatSessionsFull || [],
      productSnapshots: task.productSnapshots || {},
      logs: task.logs.slice(-500),
      createdAt: task.createdAt,
    };
  }

  _persistToDisk() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = [...this.tasks.values()].map(t => this._serializeFull(t));
      fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('持久化任务失败:', err.message);
    }
  }

  _loadFromDisk() {
    try {
      if (!fs.existsSync(TASKS_FILE)) return;
      const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      for (const t of data) {
        let chatSessionsFull = t.chatSessionsFull || [];

        if (chatSessionsFull.length === 0 && (t.chatSessions || []).length > 0) {
          const fineMap = new Map((t.products?.fineFiltered || []).map(p => [p.id, p]));
          chatSessionsFull = t.chatSessions.map(s => {
            const product = fineMap.get(s.id) || {
              id: s.id,
              title: s.productTitle || '',
              price: s.productPrice || '',
              description: s.productDescription || '',
              sellerName: s.sellerName || '',
              chatUrl: '',
            };
            const messages = (s.messages || []).map(m => ({
              ...m,
              fingerprint: `${m.role}:${m.content?.trim()}`,
            }));
            const chatHistory = messages.map(m => ({
              role: m.role === 'self' ? 'assistant' : 'user',
              content: m.content,
            }));
            return {
              id: s.id,
              product,
              chatContext: null,
              status: s.status || 'waiting',
              goalReason: s.goalReason || '',
              messages,
              chatHistory,
              lastChecked: s.lastChecked || Date.now(),
              backoffLevel: 0,
            };
          });
          console.log(`  🔄 任务 ${t.id}: 从旧格式迁移了 ${chatSessionsFull.length} 个聊天会话`);
        }

        const task = {
          id: t.id,
          name: t.name,
          group: t.group || '未分组',
          config: t.config,
          stage: (t.stage === 'completed' || t.stage === 'stopped' || t.stage === 'review') ? t.stage : 'stopped',
          running: false,
          stopped: true,
          products: {
            raw: t.products?.raw || [],
            coarseFiltered: t.products?.coarseFiltered || [],
            fineFiltered: t.products?.fineFiltered || [],
          },
          selectedProductIds: t.selectedProductIds || [],
          chatSessions: t.chatSessions || [],
          chatSessionsFull,
          productSnapshots: mergeSnapshotStore(t.productSnapshots, t.products?.raw || []),
          logs: t.logs || [],
          createdAt: t.createdAt || Date.now(),
        };
        this.tasks.set(task.id, task);
      }
      console.log(`📂 从磁盘恢复了 ${data.length} 个任务`);
    } catch (err) {
      console.error('加载持久化任务失败:', err.message);
    }
  }

  _emit(taskId, event, data) {
    this.broadcast({ event, taskId, data });
  }

  _emitStage(task) {
    this._emit(task.id, 'task:stage', { id: task.id, stage: task.stage });
  }

  _emitProducts(task) {
    this._emit(task.id, 'task:products', {
      id: task.id,
      rawCount: task.products.raw.length,
      coarseCount: task.products.coarseFiltered.length,
      fineCount: task.products.fineFiltered.filter(product => isFineCandidate(product, getConfig().sellerManualLabels || {})).length,
      fineReviewedCount: task.products.fineFiltered.length,
      raw: task.products.raw.slice(0, 100),
      coarseFiltered: task.products.coarseFiltered.slice(0, 50),
      fineFiltered: task.products.fineFiltered,
    });
  }
}
