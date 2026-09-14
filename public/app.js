// ========== State ==========
let ws = null;
let tasks = [];
let activeTaskId = null;
let hasInitializedTaskSelection = false;
let defaultPersona = '';
let defaultCoarsePrompt = '';
let defaultFinePrompt = '';
let providers = [];
let currentConfig = {};
let customModels = [];
let productFilter = 'fine';
let editingTaskId = null;
let productPage = 1;
let productSort = { key: '', dir: 'asc' };
let labelingSeller = null;
let activeTaskGroup = '全部';
let trackedProducts = [];
let trackerBusy = false;
let trackerSearch = '';
let trackerSort = { key: '', dir: 'asc' };
let trackerOnlyStarred = false;
let trackerOnlyDrops = false;
let trackerPage = 1;
let merchantPoolPage = 1;
let merchantPoolSearch = '';
let merchantPoolFilter = 'all';
let merchantPoolVisibleRows = [];
let selectedTrackedProductIds = new Set();
const PRODUCT_PAGE_SIZE = 50;
const TRACKER_PAGE_SIZE = 50;
const SELLER_LABELS_STORAGE_KEY = 'bricksSellerManualLabels';

const STAGE_LABELS = {
  pending: '等待中',
  login: '登录验证',
  searching: '搜索采集',
  coarse_filter: '粗筛',
  fine_filter: '细筛',
  review: '待确认',
  chatting: '询价中',
  completed: '已完成',
  stopped: '已停止',
  stopping: '停止中',
};

const STAGES_ORDER = ['searching', 'coarse_filter', 'fine_filter', 'review', 'chatting'];

// ========== WebSocket ==========
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    document.getElementById('ws-status').classList.add('connected');
  };

  ws.onclose = () => {
    document.getElementById('ws-status').classList.remove('connected');
    setTimeout(connectWS, 2000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  };
}

function handleWSMessage(msg) {
  const { event, taskId, data } = msg;

  switch (event) {
    case 'connected':
      if (data?.tasks) {
        tasks = data.tasks;
        renderTaskList();
        // 页面首次加载时固定选中任务列表的第一项；WebSocket 断线重连不改变用户当前选择。
        if (!hasInitializedTaskSelection && tasks.length > 0) {
          hasInitializedTaskSelection = true;
          selectTask(tasks[0].id);
        }
      }
      if (data?.configured === false) {
        showConfigBanner();
      } else {
        hideConfigBanner();
      }
      break;

    case 'task:created':
      tasks.push(data);
      renderTaskList();
      selectTask(data.id);
      break;

    case 'task:started':
    case 'task:stopping':
      updateTaskField(taskId, 'running', event === 'task:started');
      if (event === 'task:stopping') updateTaskField(taskId, 'stage', 'stopping');
      renderTaskList();
      if (activeTaskId === taskId) renderPipeline();
      break;

    case 'task:stage':
      updateTaskField(taskId, 'stage', data.stage);
      renderTaskList();
      if (activeTaskId === taskId) renderPipeline();
      if (activeTaskId === taskId) renderReviewActions();
      if (activeTaskId === taskId) renderProducts();
      break;

    case 'task:log':
      appendLog(taskId, data);
      break;

    case 'task:products':
      updateProductCounts(taskId, data);
      if (activeTaskId === taskId) renderProductStats();
      if (activeTaskId === taskId) renderPipeline();
      if (activeTaskId === taskId) renderReviewActions();
      if (activeTaskId === taskId) renderProducts();
      break;

    case 'task:chats':
      updateTaskField(taskId, 'chatSessions', data);
      if (activeTaskId === taskId) renderChats();
      break;

    case 'task:finished':
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx >= 0) tasks[idx] = data;
      renderTaskList();
      if (activeTaskId === taskId) renderTaskDetail();
      break;

    case 'model:changed':
      if (data?.current) {
        const select = document.getElementById('model-select');
        if (select) select.value = data.current;
      }
      break;

    case 'config:changed':
      if (data?.configured) {
        hideConfigBanner();
      } else {
        showConfigBanner();
      }
      if (data?.config) {
        currentConfig = mergeSellerManualLabels(data.config);
      }
      loadModel();
      break;
  }
}

function updateTaskField(taskId, field, value) {
  const task = tasks.find(t => t.id === taskId);
  if (task) task[field] = value;
}

function updateProductCounts(taskId, data) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.products) task.products = {};
  task.products.rawCount = data.rawCount;
  task.products.coarseCount = data.coarseCount;
  task.products.fineCount = data.fineCount;
  task.products.fineReviewedCount = data.fineReviewedCount;
  if (data.raw) task.products.raw = data.raw;
  if (data.coarseFiltered) task.products.coarseFiltered = data.coarseFiltered;
  if (data.fineFiltered) task.products.fineFiltered = data.fineFiltered;
}

function appendLog(taskId, entry) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.logs) task.logs = [];
  task.logs.push(entry);
  if (task.logs.length > 500) task.logs = task.logs.slice(-300);

  if (activeTaskId === taskId) {
    const panel = document.getElementById('log-panel');
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `<span class="log-time">${entry.time}</span>${escapeHtml(entry.message)}`;
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
  }
}

// ========== Config Banner ==========
function showConfigBanner() {
  document.getElementById('config-banner').style.display = 'flex';
  document.getElementById('settings-btn').classList.add('pulse');
}

function hideConfigBanner() {
  document.getElementById('config-banner').style.display = 'none';
  document.getElementById('settings-btn').classList.remove('pulse');
}

// ========== Settings Modal ==========
function toggleSettingsMenu(event) {
  event?.stopPropagation();
  document.getElementById('settings-dropdown')?.classList.toggle('show');
}

function closeSettingsMenu() {
  document.getElementById('settings-dropdown')?.classList.remove('show');
}

function toggleRerunMenu(event, taskId) {
  event?.stopPropagation();
  document.querySelectorAll('.rerun-dropdown.show').forEach(menu => {
    if (menu.id !== `rerun-menu-${taskId}`) menu.classList.remove('show');
  });
  document.getElementById(`rerun-menu-${taskId}`)?.classList.toggle('show');
}

function closeRerunMenus() {
  document.querySelectorAll('.rerun-dropdown.show').forEach(menu => menu.classList.remove('show'));
}

function openApiSettings() {
  closeSettingsMenu();
  showSettingsModal();
}

function openBlacklistSettings() {
  closeSettingsMenu();
  populateBlacklistForm();
  document.getElementById('blacklist-modal-overlay').classList.add('show');
}

function openSellerLexiconSettings() {
  closeSettingsMenu();
  const lexicon = currentConfig.sellerLexicon || {};
  document.getElementById('seller-business-words').value = (lexicon.businessWords || []).join('\n');
  document.getElementById('seller-luxury-product-words').value = (lexicon.luxuryProductWords || []).join('\n');
  document.getElementById('seller-lexicon-modal-overlay').classList.add('show');
}

function hideSellerLexiconModal() {
  document.getElementById('seller-lexicon-modal-overlay').classList.remove('show');
}

const SELLER_FINE_RULE_FIELDS = {
  personalThreshold: 'fine-personal-threshold', businessThreshold: 'fine-business-threshold',
  dealPersonalMax: 'fine-deal-personal', dealLightMax: 'fine-deal-light', dealSuspectMax: 'fine-deal-suspect', dealStrongMax: 'fine-deal-strong',
  listedPersonalMax: 'fine-listed-personal', listedLightMax: 'fine-listed-light', listedSuspectMax: 'fine-listed-suspect',
  personalWordWeight: 'fine-personal-word-weight', businessWordWeight: 'fine-business-word-weight', personalGoodsWeight: 'fine-personal-goods-weight',
};

function openSellerFineRulesSettings() {
  closeSettingsMenu();
  const rules = currentConfig.sellerFineRules || {};
  Object.entries(SELLER_FINE_RULE_FIELDS).forEach(([key, id]) => { document.getElementById(id).value = rules[key] ?? ''; });
  document.getElementById('seller-fine-rules-modal-overlay').classList.add('show');
}

function hideSellerFineRulesModal() {
  document.getElementById('seller-fine-rules-modal-overlay').classList.remove('show');
}

async function saveSellerFineRules() {
  const sellerFineRules = {};
  for (const [key, id] of Object.entries(SELLER_FINE_RULE_FIELDS)) {
    const value = Number(document.getElementById(id).value);
    if (!Number.isFinite(value) || value < 0) return alert('请填写有效的非负数规则参数');
    sellerFineRules[key] = value;
  }
  if (sellerFineRules.businessThreshold >= sellerFineRules.personalThreshold) return alert('疑似小B分数线必须低于疑似个人卖家分数线');
  if (!(sellerFineRules.dealPersonalMax <= sellerFineRules.dealLightMax && sellerFineRules.dealLightMax <= sellerFineRules.dealSuspectMax && sellerFineRules.dealSuspectMax <= sellerFineRules.dealStrongMax)) return alert('成交量分段必须从小到大填写');
  if (!(sellerFineRules.listedPersonalMax <= sellerFineRules.listedLightMax && sellerFineRules.listedLightMax <= sellerFineRules.listedSuspectMax)) return alert('在售量分段必须从小到大填写');
  try {
    const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sellerFineRules }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '保存失败');
    currentConfig = mergeSellerManualLabels(data.config || currentConfig);
    hideSellerFineRulesModal();
  } catch (err) { alert('细筛规则保存失败：' + err.message); }
}

async function openMerchantPool() {
  merchantPoolPage = 1;
  merchantPoolSearch = '';
  merchantPoolFilter = 'all';
  document.getElementById('merchant-pool-search').value = '';
  // 即使浏览器错过 WebSocket 事件，也以服务端的卖家池为准，避免显示旧缓存。
  try {
    const res = await fetch('/api/seller-pool');
    if (res.ok) {
      const data = await res.json();
      currentConfig = mergeSellerManualLabels(data.config || currentConfig);
    }
  } catch { /* 保留当前缓存，页面仍可正常打开 */ }
  renderMerchantPool();
  document.getElementById('merchant-pool-modal-overlay').classList.add('show');
}

function hideMerchantPool() {
  document.getElementById('merchant-pool-modal-overlay').classList.remove('show');
}

function merchantProfiles() {
  const profiles = currentConfig.sellerProfiles || {};
  const byIdentity = new Map();
  for (const [key, profile] of Object.entries(profiles)) {
    const fingerprint = profile.sellerFingerprint || (key.startsWith('avatar:') ? key.slice(7) : '');
    const identity = profile.sellerId ? `id:${profile.sellerId}` : `avatar:${fingerprint || key}`;
    const merged = { ...profile, sellerFingerprint: fingerprint };
    const existing = byIdentity.get(identity);
    if (!existing || Number(merged.checkedAt || 0) > Number(existing.checkedAt || 0)) byIdentity.set(identity, merged);
  }
  return [...byIdentity.values()];
}

function setMerchantPoolFilter(filter) {
  merchantPoolFilter = filter;
  merchantPoolPage = 1;
  renderMerchantPool();
}

function setMerchantPoolSearch(value) {
  merchantPoolSearch = String(value || '').trim();
  merchantPoolPage = 1;
  renderMerchantPool();
}

function clearMerchantPoolSearch() {
  merchantPoolSearch = '';
  const input = document.getElementById('merchant-pool-search');
  if (input) input.value = '';
  merchantPoolPage = 1;
  renderMerchantPool();
}

function setMerchantPoolPage(page) {
  merchantPoolPage = Math.max(1, Number(page) || 1);
  renderMerchantPool();
}

function editMerchantProfile(index) {
  const profile = merchantPoolVisibleRows[Number(index)];
  if (profile) showSellerLabelModal(profile);
}

async function refreshMerchantProfile(index) {
  const profile = merchantPoolVisibleRows[Number(index)];
  if (!profile) return;
  try {
    const res = await fetch('/api/sellers/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sellerId: profile.sellerId || '', sellerFingerprint: profile.sellerFingerprint || '', sellerName: profile.sellerName || '' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '核验失败');
    currentConfig = mergeSellerManualLabels(data.config || currentConfig);
    renderMerchantPool();
  } catch (err) { alert('重新核验失败：' + err.message); }
}

function renderMerchantPool() {
  const query = merchantPoolSearch.toLowerCase();
  const allProfiles = merchantProfiles();
  const levelCounts = Object.fromEntries(['小B', '个人卖家', '疑似小B', '疑似个人卖家', '不明确'].map(level => [level, allProfiles.filter(profile => getSellerLevel(profile) === level).length]));
  const rows = allProfiles.filter(profile => {
    const level = getSellerLevel(profile);
    if (merchantPoolFilter !== 'all' && level !== merchantPoolFilter) return false;
    const source = [profile.sellerName, profile.sellerId, profile.sellerFingerprint, profile.sellerProfileReason, profile.latestProductTitle, ...(profile.sellerBusinessSignals || []), ...(profile.sellerPersonalSignals || [])].join(' ').toLowerCase();
    return !query || source.includes(query);
  }).sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0));
  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  merchantPoolPage = Math.min(merchantPoolPage, totalPages);
  const pageRows = rows.slice((merchantPoolPage - 1) * pageSize, merchantPoolPage * pageSize);
  merchantPoolVisibleRows = pageRows;
  const summary = document.getElementById('merchant-pool-summary');
  if (summary) summary.textContent = `共 ${allProfiles.length} 个卖家 · 小B ${levelCounts['小B']} · 个人 ${levelCounts['个人卖家']} · 疑似小B ${levelCounts['疑似小B']} · 不明确 ${levelCounts['不明确']}${query ? ` · 搜索结果 ${rows.length}` : ''}`;
  [['all', 'merchant-filter-all'], ['小B', 'merchant-filter-confirmed'], ['个人卖家', 'merchant-filter-personal'], ['疑似小B', 'merchant-filter-suspected'], ['疑似个人卖家', 'merchant-filter-suspected-personal'], ['不明确', 'merchant-filter-unknown']].forEach(([filter, id]) => {
    document.getElementById(id)?.classList.toggle('active', merchantPoolFilter === filter);
  });
  const tbody = document.getElementById('merchant-pool-tbody');
  tbody.innerHTML = pageRows.length ? pageRows.map((profile, index) => {
    const level = getSellerLevel(profile);
    const cls = sellerLevelClass(level);
    const avatar = profile.sellerAvatarUrl ? `<img class="merchant-avatar" src="${escapeHtml(profile.sellerAvatarUrl)}" alt="">` : '<div class="merchant-avatar"></div>';
    const identity = profile.sellerId || profile.sellerFingerprint || '未获取稳定身份';
    return `<tr>
      <td><div class="merchant-seller">${avatar}<div><div class="merchant-seller-name" title="${escapeHtml(profile.sellerName || '')}">${escapeHtml(profile.sellerName || '未命名卖家')}</div><div class="compact-meta merchant-seller-meta" title="${escapeHtml(identity)}">${escapeHtml([profile.sellerLocation, profile.sellerRating, identity].filter(Boolean).join(' · '))}</div></div></div></td>
      <td><button class="seller-profile seller-profile-button ${cls}" title="点击修改卖家等级" onclick="editMerchantProfile(${index})">${escapeHtml(level)}</button></td>
      <td class="merchant-data">成交：${escapeHtml(String(profile.sellerDealCount ?? '—'))}<br>在售：${escapeHtml(String(profile.sellerListedCount ?? '—'))}</td>
      <td class="merchant-evidence" title="${escapeHtml(profile.sellerProfileReason || '人工标记')}">${escapeHtml(profile.sellerProfileReason || '人工标记')}</td>
      <td>${profile.latestProductHref ? `<a class="merchant-product-link" href="${escapeHtml(profile.latestProductHref)}" target="_blank" rel="noreferrer" title="${escapeHtml(profile.latestProductTitle || '')}">${escapeHtml(profile.latestProductTitle || '查看商品')}</a>` : `<span class="merchant-product-link">${escapeHtml(profile.latestProductTitle || '—')}</span>`}</td>
      <td>${escapeHtml(formatTimeAgo(profile.checkedAt))}</td>
      <td><div class="merchant-actions">${profile.sellerProfileUrl ? `<a class="btn btn-sm" href="${escapeHtml(profile.sellerProfileUrl)}" target="_blank" rel="noreferrer" title="打开卖家在售页，人工核对判断证据">店铺</a>` : ''}<button class="btn btn-sm" title="打开最近商品详情并更新卖家档案" onclick="refreshMerchantProfile(${index})">核验</button></div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="empty-cell">暂无商家档案</td></tr>';
  const pagination = document.getElementById('merchant-pool-pagination');
  if (pagination) {
    pagination.innerHTML = rows.length > pageSize ? `<button class="btn btn-sm" onclick="setMerchantPoolPage(${merchantPoolPage - 1})" ${merchantPoolPage <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${merchantPoolPage} / ${totalPages} 页 · ${rows.length} 条</span><button class="btn btn-sm" onclick="setMerchantPoolPage(${merchantPoolPage + 1})" ${merchantPoolPage >= totalPages ? 'disabled' : ''}>下一页</button>` : (rows.length ? `<span>${rows.length} 条档案</span>` : '');
  }
}

function parseWordList(value) {
  return [...new Set(String(value || '').split(/[\n,，、]/).map(word => word.trim()).filter(Boolean))];
}

async function saveSellerLexicon() {
  const sellerLexicon = {
    businessWords: parseWordList(document.getElementById('seller-business-words').value),
    luxuryProductWords: parseWordList(document.getElementById('seller-luxury-product-words').value),
  };
  try {
    const res = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sellerLexicon }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '卖家标注保存失败');
    if (!data.ok) throw new Error(data.error || '保存失败');
    currentConfig = mergeSellerManualLabels(data.config || currentConfig);
    hideSellerLexiconModal();
  } catch (err) {
    alert('词库保存失败：' + err.message);
  }
}

function hideBlacklistModal() {
  document.getElementById('blacklist-modal-overlay').classList.remove('show');
}

function normalizeSellerKey(name) {
  return String(name || '').trim().toLowerCase();
}

function loadLocalSellerManualLabels() {
  try {
    return JSON.parse(localStorage.getItem(SELLER_LABELS_STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveLocalSellerManualLabels() {
  // 卖家等级以服务端配置为唯一来源。清除旧版离线缓存，避免已删除的标记重现。
  try { localStorage.removeItem(SELLER_LABELS_STORAGE_KEY); } catch { /* ignore */ }
}

function mergeSellerManualLabels(config = {}) {
  saveLocalSellerManualLabels();
  return { ...config, sellerManualLabels: { ...(config.sellerManualLabels || {}) } };
}

function sellerIdentityKeys(productOrName) {
  const product = typeof productOrName === 'object' && productOrName ? productOrName : { sellerName: productOrName };
  const keys = [];
  if (product.sellerId) keys.push(`id:${String(product.sellerId).trim()}`);
  if (product.sellerFingerprint) keys.push(`avatar:${String(product.sellerFingerprint).trim()}`);
  // 地区不是卖家身份，绝不能用作标记键或指纹兼容项。
  const name = String(product.sellerName || '').trim();
  if (name) keys.push(normalizeSellerKey(name), name);
  return keys.filter(Boolean);
}

function getSellerManualLabel(productOrName) {
  const labels = currentConfig.sellerManualLabels || {};
  const label = sellerIdentityKeys(productOrName).map(key => labels[key]).find(Boolean) || '';
  if (label === '大卖') return '小B';
  if (label === '重点个人卖家') return '个人卖家';
  return label === '待判断' ? '不明确' : label;
}

function getSellerLevel(product) {
  const manual = getSellerManualLabel(product) || product?.sellerManualLabel || '';
  const automatic = product?.sellerType === '待判断' ? '不明确' : product?.sellerType;
  return manual || automatic || '不明确';
}

function sellerLevelClass(level) {
  if (level === '小B') return 'seller-business-strong';
  if (level === '疑似小B') return 'seller-business';
  if (level === '个人卖家') return 'seller-personal-strong';
  if (level === '疑似个人卖家') return 'seller-personal';
  return 'seller-unknown';
}

function markFineSeller(productId) {
  const task = tasks.find(item => item.id === activeTaskId);
  const product = (task?.products?.fineFiltered || []).find(item => String(item.id) === String(productId));
  if (!product) {
    alert('未找到对应的细筛商品，请刷新页面后重试。');
    return;
  }
  if (!product.sellerName && !product.sellerId && !product.sellerFingerprint) {
    alert('该历史细筛结果没有卖家身份信息，无法安全标记。请重新细筛该商品后再标记。');
    return;
  }
  labelingSeller = product;
  const sellerName = String(product.sellerName || product.sellerId || '该卖家');
  const current = getSellerManualLabel(product);
  document.getElementById('seller-label-desc').textContent = current
    ? `${sellerName} 当前人工标注：${current}`
    : `${sellerName} 尚未人工标注`;
  document.getElementById('seller-label-modal-overlay').classList.add('show');
}

async function quickLabelSeller(select) {
  const label = select.value;
  if (!label) return;
  try {
    labelingSeller = JSON.parse(select.dataset.seller || '{}');
  } catch {
    labelingSeller = null;
  }
  if (!labelingSeller?.sellerName && !labelingSeller?.sellerId && !labelingSeller?.sellerFingerprint) {
    alert('未取得可靠卖家身份，无法标记。');
    select.value = '';
    return;
  }
  await saveSellerManualLabel(label === '__clear__' ? '' : label);
}

function showSellerLabelModal(product) {
  labelingSeller = product || null;
  const sellerName = String(labelingSeller?.sellerName || '').trim();
  if (!sellerName && !labelingSeller?.sellerFingerprint && !labelingSeller?.sellerId) return;
  const current = getSellerManualLabel(labelingSeller);
  document.getElementById('seller-label-desc').textContent = current
    ? `${sellerName || '该卖家'} 当前人工标注：${current}`
    : `${sellerName || '该卖家'} 尚未人工标注`;
  document.getElementById('seller-label-modal-overlay').classList.add('show');
}

function hideSellerLabelModal() {
  document.getElementById('seller-label-modal-overlay').classList.remove('show');
  labelingSeller = null;
}

async function saveSellerManualLabel(label) {
  if (!labelingSeller) return;
  const labels = { ...(currentConfig.sellerManualLabels || {}) };
  const keys = sellerIdentityKeys(labelingSeller);
  if (label) keys.forEach(key => { labels[key] = label; });
  else keys.forEach(key => { delete labels[key]; });
  currentConfig = { ...currentConfig, sellerManualLabels: labels };
  saveLocalSellerManualLabels(labels);

  try {
    const seller = {
      sellerId: labelingSeller.sellerId || '',
      sellerFingerprint: labelingSeller.sellerFingerprint || '',
      sellerName: labelingSeller.sellerName || '',
      sellerAvatarUrl: labelingSeller.sellerAvatarUrl || '',
      sellerLocation: labelingSeller.sellerLocation || '',
      sellerRating: labelingSeller.sellerRating || '',
      sellerDealCount: labelingSeller.sellerDealCount ?? null,
      sellerListedCount: labelingSeller.sellerListedCount ?? null,
    };
    const res = await fetch('/api/sellers/label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seller, label }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '卖家标注保存失败');
    if (data.config) currentConfig = mergeSellerManualLabels(data.config);
    hideSellerLabelModal();
    renderProducts();
    renderMerchantPool();
  } catch (err) {
    hideSellerLabelModal();
    renderProducts();
    renderMerchantPool();
    alert('卖家标注已在当前浏览器保存；后端保存失败，重启服务后会恢复完整保存: ' + err.message);
  }
}

function populateBlacklistForm() {
  const input = document.getElementById('seller-blacklist');
  if (input) input.value = (currentConfig.sellerBlacklist || []).join('\n');
}

async function saveBlacklist() {
  const raw = document.getElementById('seller-blacklist').value;
  const sellerBlacklist = raw.split(/\r?\n/)
    .map(name => name.trim())
    .filter(Boolean);

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sellerBlacklist }),
    });
    const data = await res.json();
    if (data.config) currentConfig = mergeSellerManualLabels(data.config);
    hideBlacklistModal();
  } catch (err) {
    alert('保存黑名单失败: ' + err.message);
  }
}

async function loadProviders() {
  try {
    const res = await fetch('/api/providers');
    providers = await res.json();
    const select = document.getElementById('cfg-provider');
    select.innerHTML = '<option value="">-- 请选择 --</option>' +
      providers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  } catch { /* ignore */ }
}

async function loadCurrentConfig() {
  try {
    const res = await fetch('/api/config');
    currentConfig = mergeSellerManualLabels(await res.json());
  } catch { /* ignore */ }
}

function showSettingsModal() {
  populateSettingsForm();
  document.getElementById('settings-modal-overlay').classList.add('show');
  document.getElementById('test-result').textContent = '';
}

function hideSettingsModal() {
  document.getElementById('settings-modal-overlay').classList.remove('show');
}

function populateSettingsForm() {
  const cfg = currentConfig;
  document.getElementById('cfg-provider').value = cfg.provider || '';
  document.getElementById('cfg-base-url').value = cfg.baseUrl || '';
  document.getElementById('cfg-api-key').value = '';
  document.getElementById('cfg-api-key').placeholder = cfg.hasKey ? '已配置（留空保持不变）' : 'sk-...';

  customModels = (cfg.customModels || []).map(m =>
    typeof m === 'string' ? { id: m, name: m } : m
  );

  onProviderChange(cfg.provider || '', cfg.model);
  renderCustomModelTags();
}

function onProviderChange(providerId, preserveModel) {
  const provider = providers.find(p => p.id === providerId);
  const baseUrlInput = document.getElementById('cfg-base-url');
  const modelSelect = document.getElementById('cfg-model');

  if (provider) {
    if (provider.baseUrl) {
      baseUrlInput.value = provider.baseUrl;
    }
    if (providerId === 'custom') {
      baseUrlInput.value = currentConfig.baseUrl || '';
    }
  }

  const models = provider?.models || [];
  const allModels = [...models, ...customModels];

  if (allModels.length > 0) {
    modelSelect.innerHTML = allModels.map(m =>
      `<option value="${m.id}">${m.name}</option>`
    ).join('');
  } else {
    modelSelect.innerHTML = '<option value="">请添加自定义模型</option>';
  }

  const targetModel = preserveModel || currentConfig.model;
  if (targetModel && allModels.some(m => m.id === targetModel)) {
    modelSelect.value = targetModel;
  }
}

function addCustomModel() {
  const input = document.getElementById('cfg-custom-model');
  const modelId = input.value.trim();
  if (!modelId) return;
  if (customModels.some(m => m.id === modelId)) return;

  customModels.push({ id: modelId, name: modelId });
  input.value = '';
  renderCustomModelTags();

  const providerId = document.getElementById('cfg-provider').value;
  onProviderChange(providerId, modelId);
}

function removeCustomModel(modelId) {
  customModels = customModels.filter(m => m.id !== modelId);
  renderCustomModelTags();
  const providerId = document.getElementById('cfg-provider').value;
  onProviderChange(providerId);
}

function renderCustomModelTags() {
  const container = document.getElementById('custom-model-tags');
  container.innerHTML = customModels.map(m =>
    `<span class="model-tag">${escapeHtml(m.id)} <button onclick="removeCustomModel('${escapeHtml(m.id)}')">&times;</button></span>`
  ).join('');
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('cfg-api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function testApiConfig() {
  const btn = document.getElementById('test-api-btn');
  const result = document.getElementById('test-result');
  btn.disabled = true;
  result.textContent = '测试中...';
  result.className = 'test-result';

  try {
    await saveSettingsQuiet();

    const res = await fetch('/api/config/test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      result.textContent = `✅ 连接成功！模型: ${data.model}，回复: "${data.reply}"`;
      result.className = 'test-result success';
    } else {
      result.textContent = `❌ ${data.error}`;
      result.className = 'test-result error';
    }
  } catch (err) {
    result.textContent = `❌ 请求失败: ${err.message}`;
    result.className = 'test-result error';
  } finally {
    btn.disabled = false;
  }
}

async function saveSettingsQuiet() {
  const provider = document.getElementById('cfg-provider').value;
  const baseUrl = document.getElementById('cfg-base-url').value.trim();
  const apiKey = document.getElementById('cfg-api-key').value.trim();
  const model = document.getElementById('cfg-model').value;

  const body = { provider, baseUrl, model, customModels };
  if (apiKey) body.apiKey = apiKey;

  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.config) currentConfig = mergeSellerManualLabels(data.config);
  return data;
}

async function saveSettings() {
  try {
    const data = await saveSettingsQuiet();
    if (data.ok) {
      hideSettingsModal();
      loadModel();
      if (currentConfig.hasKey) {
        hideConfigBanner();
      }
    }
  } catch (err) {
    alert('保存失败: ' + err.message);
  }
}

// ========== API ==========
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok && data.error) {
    alert(data.error);
    throw new Error(data.error);
  }
  return data;
}

async function apiPut(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok && data.error) {
    alert(data.error);
    throw new Error(data.error);
  }
  return data;
}

async function createTask(startImmediately = true) {
  const body = readTaskForm();
  if (!body) return;

  if (!body.queries.length) {
    alert('请输入至少一个搜索关键词');
    return;
  }

  try {
    if (editingTaskId) {
      const result = await apiPut(`/api/tasks/${editingTaskId}`, body);
      const idx = tasks.findIndex(t => t.id === editingTaskId);
      if (idx >= 0 && result.task) tasks[idx] = result.task;
      activeTaskId = editingTaskId;
      hideCreateModal();
      renderTaskList();
      renderTaskDetail();
      return;
    }

    await apiPost('/api/tasks', { ...body, startImmediately });

    hideCreateModal();
    clearForm();
  } catch { /* alert already shown */ }
}

function readTaskForm() {
  const name = document.getElementById('f-name').value.trim();
  const group = document.getElementById('f-group').value.trim();
  const keywordGroups = [1, 2, 3, 4].map(i => document.getElementById(`f-query-group-${i}`).value.trim()).filter(Boolean).map(value => value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean));
  const priceMin = document.getElementById('f-price-min').value;
  const priceMax = document.getElementById('f-price-max').value;
  const wantMax = document.getElementById('f-want-max').value;
  const maxPages = document.getElementById('f-pages').value;
  const queries = keywordGroups.flat();
  const wantMaxNumber = wantMax === '' ? null : Number(wantMax);

  if (wantMaxNumber !== null && (!Number.isFinite(wantMaxNumber) || wantMaxNumber < 0)) {
    alert('想要不低于不能填负数');
    return null;
  }

  return {
    name: name || queries[0],
    group: group || (activeTaskGroup !== '全部' ? activeTaskGroup : '未分组'),
    queries,
    keywordGroups,
    priceMin: priceMin ? Number(priceMin) : null,
    priceMax: priceMax ? Number(priceMax) : null,
    maxPages: maxPages ? Number(maxPages) : 1,
    region: document.getElementById('f-region').value.trim(),
    personalSeller: document.getElementById('f-personal').checked,
    requireFreeShipping: document.getElementById('f-free-shipping').checked,
    wantMax: wantMaxNumber > 0 ? wantMaxNumber : null,
    titleExclude: document.getElementById('f-title-exclude').value.trim(),
    searchSort: document.getElementById('f-search-sort').value,
    requireInspect: document.getElementById('f-inspect').checked,
    requireGuarantee: document.getElementById('f-guarantee').checked,
    requireSuperShop: document.getElementById('f-super-shop').checked,
    requireBrandNew: document.getElementById('f-brand-new').checked,
    requireStrictSelect: document.getElementById('f-strict-select').checked,
    requireResale: document.getElementById('f-resale').checked,
    sellerStructureRules: {
      sampleSize: Number(document.getElementById('f-luxury-sample-size').value) || 20,
      luxuryCountThreshold: Number(document.getElementById('f-luxury-count-threshold').value) || 5,
      luxuryRatioThreshold: (Number(document.getElementById('f-luxury-ratio-threshold').value) || 40) / 100,
      luxuryHighRatioThreshold: (Number(document.getElementById('f-luxury-high-ratio-threshold').value) || 60) / 100,
    },
    runStages: {
      collect: document.getElementById('f-stage-collect').checked,
      coarse: document.getElementById('f-stage-coarse').checked,
      fine: document.getElementById('f-stage-fine').checked,
      inquiry: document.getElementById('f-stage-inquiry').checked,
    },
    chatStrategy: document.getElementById('f-chat-strategy').value.trim(),
    persona: document.getElementById('f-persona').value.trim() || '',
  };
}

let pendingStartTaskId = null;

function startTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  pendingStartTaskId = id;
  document.getElementById('start-modal-task-name').textContent = `任务: ${task.name}`;
  document.getElementById('s-chat-strategy').value = task.config?.chatStrategy || '';
  document.getElementById('s-persona').value = task.config?.persona || defaultPersona;
  document.getElementById('start-modal-overlay').classList.add('show');
}

function hideStartModal() {
  document.getElementById('start-modal-overlay').classList.remove('show');
  pendingStartTaskId = null;
}

async function confirmStartTask() {
  if (!pendingStartTaskId) return;

  const chatStrategy = document.getElementById('s-chat-strategy').value.trim();
  const persona = document.getElementById('s-persona').value.trim();

  try {
    await apiPost(`/api/tasks/${pendingStartTaskId}/start`, { chatStrategy, persona });
    hideStartModal();
  } catch { /* alert already shown */ }
}

async function stopTask(id) {
  await apiPost(`/api/tasks/${id}/stop`);
}

async function rerunTaskStage(id, stage) {
  const labels = {
    collect: '重新采集',
    append_collect: '追加采集',
    coarse: '重新粗筛',
    fine: '重新细筛',
    fine_missing: '补跑未细筛',
  };
  closeRerunMenus();
  if (!confirm(`确认${labels[stage] || '重跑'}？后续阶段结果会按需清空。`)) return;
  try {
    await apiPost(`/api/tasks/${id}/rerun`, { stage });
  } catch { /* alert already shown */ }
}

function duplicateTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task?.config) return;

  fillTaskForm(task, task.name ? `${task.name} (副本)` : '');
  editingTaskId = null;
  showCreateModal();
}

function editTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task?.config) return;
  if (task.running) {
    alert('请先停止任务后再编辑');
    return;
  }

  fillTaskForm(task);
  editingTaskId = id;
  showCreateModal();
}

function fillTaskForm(task, nameOverride) {
  const c = task.config;
  document.getElementById('f-name').value = nameOverride ?? (task.name || '');
  populateTaskGroupSelect(getTaskGroup(task));
  document.getElementById('f-group').value = getTaskGroup(task) || (activeTaskGroup !== '全部' ? activeTaskGroup : '未分组');
  const groups = c.keywordGroups || [(c.queries || [])];
  [1, 2, 3, 4].forEach((i, index) => { document.getElementById(`f-query-group-${i}`).value = (groups[index] || []).join(' '); });
  document.getElementById('f-price-min').value = c.priceMin ?? '';
  document.getElementById('f-price-max').value = c.priceMax ?? '';
  document.getElementById('f-pages').value = c.maxPages || 1;
  document.getElementById('f-region').value = c.region || '';
  document.getElementById('f-personal').checked = !!c.personalSeller;
  document.getElementById('f-free-shipping').checked = !!c.requireFreeShipping;
  document.getElementById('f-want-max').value = c.wantMax ?? '';
  document.getElementById('f-title-exclude').value = c.titleExclude || '';
  document.getElementById('f-search-sort').value = c.searchSort || 'newest';
  document.getElementById('f-inspect').checked = !!c.requireInspect;
  document.getElementById('f-guarantee').checked = !!c.requireGuarantee;
  document.getElementById('f-super-shop').checked = !!c.requireSuperShop;
  document.getElementById('f-brand-new').checked = !!c.requireBrandNew;
  document.getElementById('f-strict-select').checked = !!c.requireStrictSelect;
  document.getElementById('f-resale').checked = !!c.requireResale;
  document.getElementById('f-luxury-sample-size').value = c.sellerStructureRules?.sampleSize ?? 20;
  document.getElementById('f-luxury-count-threshold').value = c.sellerStructureRules?.luxuryCountThreshold ?? 5;
  document.getElementById('f-luxury-ratio-threshold').value = Math.round((c.sellerStructureRules?.luxuryRatioThreshold ?? 0.4) * 100);
  document.getElementById('f-luxury-high-ratio-threshold').value = Math.round((c.sellerStructureRules?.luxuryHighRatioThreshold ?? 0.6) * 100);
  document.getElementById('f-stage-collect').checked = c.runStages?.collect !== false;
  document.getElementById('f-stage-coarse').checked = c.runStages?.coarse !== false;
  document.getElementById('f-stage-fine').checked = c.runStages?.fine !== false;
  document.getElementById('f-stage-inquiry').checked = !!c.runStages?.inquiry;
  document.getElementById('f-chat-strategy').value = c.chatStrategy || '';
  document.getElementById('f-persona').value = c.persona || defaultPersona;
}

async function deleteTask(id) {
  if (!confirm('确认删除此任务？')) return;
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  tasks = tasks.filter(t => t.id !== id);
  if (activeTaskId === id) {
    activeTaskId = null;
    renderTaskDetail();
  }
  renderTaskList();
}

async function refreshTask(id) {
  const res = await fetch(`/api/tasks/${id}`);
  const task = await res.json();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx >= 0) tasks[idx] = task;
  if (activeTaskId === id) renderTaskDetail();
}

// ========== Render: Task List ==========
function renderTaskList() {
  const container = document.getElementById('task-list');
  const groupCounts = new Map();
  tasks.forEach(t => {
    const group = getTaskGroup(t);
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
  });
  const groups = ['全部', ...[...groupCounts.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))];
  if (activeTaskGroup !== '全部' && !groupCounts.has(activeTaskGroup)) activeTaskGroup = '全部';

  const visibleTasks = activeTaskGroup === '全部'
    ? tasks
    : tasks.filter(t => getTaskGroup(t) === activeTaskGroup);

  container.innerHTML = `
    <div class="task-group-filter">
      <label>分组</label>
      <select onchange="setTaskGroup(this.value)">
        ${groups.map(group => `
          <option value="${escapeHtml(group)}" ${group === activeTaskGroup ? 'selected' : ''}>
            ${escapeHtml(group)} (${group === '全部' ? tasks.length : groupCounts.get(group)})
          </option>
        `).join('')}
      </select>
    </div>
    <div class="task-list-items">
      ${visibleTasks.map(t => `
    <div class="task-card ${t.id === activeTaskId ? 'active' : ''}" onclick="selectTask('${t.id}')">
      <div class="task-card-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
      <div class="task-card-meta">
        <span class="stage-badge stage-${t.stage}">${STAGE_LABELS[t.stage] || t.stage}</span>
        <span class="task-count">${t.products ? `${t.products.rawCount || 0}件` : ''}</span>
      </div>
    </div>
      `).join('') || '<div class="task-empty">这个分组暂无任务</div>'}
    </div>
  `;
}

function setTaskGroup(group) {
  activeTaskGroup = group || '全部';
  const visible = activeTaskGroup === '全部'
    ? tasks
    : tasks.filter(t => getTaskGroup(t) === activeTaskGroup);
  if (activeTaskId && !visible.some(t => t.id === activeTaskId)) {
    activeTaskId = visible[0]?.id || null;
    renderTaskDetail();
  }
  renderTaskList();
}

function selectTask(id) {
  activeTaskId = id;
  productFilter = 'fine';
  productPage = 1;
  productSort = { key: '', dir: 'asc' };
  if (document.querySelector('.tab.active')?.dataset.tab === 'tracking') {
    switchTab('products');
  }
  renderTaskList();
  refreshTask(id).then(() => renderTaskDetail());
}

// ========== Render: Task Detail ==========
function renderTaskDetail() {
  const task = tasks.find(t => t.id === activeTaskId);
  const detail = document.getElementById('task-detail');
  const empty = document.getElementById('empty-state');

  if (!task) {
    detail.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  detail.style.display = 'flex';
  empty.style.display = 'none';

  renderPipeline();
  renderProductStats();
  renderReviewActions();
  renderProducts();
  renderChats();
  renderLogs();
}

function renderPipeline() {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task) return;

  const fineCount = task.products?.fineCount || task.products?.fineFiltered?.length || 0;
  const canStartChat = task.stage === 'review' && fineCount > 0 && !task.running;
  const currentIdx = STAGES_ORDER.indexOf(task.stage);
  const container = document.getElementById('pipeline');

  let html = STAGES_ORDER.map((stage, i) => {
    let cls = '';
    if (task.stage === 'completed') {
      cls = 'done';
    } else if (task.stage === 'stopped' || task.stage === 'stopping') {
      cls = i <= currentIdx ? 'done' : '';
    } else if (i < currentIdx) {
      cls = 'done';
    } else if (i === currentIdx) {
      cls = 'active';
    }
    return `
      ${i > 0 ? '<span class="pipeline-arrow">→</span>' : ''}
      <div class="pipeline-step ${cls}">${STAGE_LABELS[stage]}</div>
    `;
  }).join('');

  html += `
    <div class="pipeline-controls">
      ${canStartChat ? `<button class="btn btn-primary btn-sm" onclick="startSelectedChats('${task.id}')">开始询价</button>` : ''}
      ${task.running
        ? `<button class="btn btn-danger btn-sm" onclick="stopTask('${task.id}')">停止任务</button>`
        : `<button class="btn btn-sm" style="color:var(--green)" onclick="startTask('${task.id}')">启动</button>
           <span class="rerun-menu">
             <button class="btn btn-sm rerun-trigger" onclick="toggleRerunMenu(event, '${task.id}')">重跑 <span class="rerun-caret">▾</span></button>
             <span class="rerun-dropdown" id="rerun-menu-${task.id}">
               <button onclick="rerunTaskStage('${task.id}', 'collect')">重新采集</button>
               <button onclick="rerunTaskStage('${task.id}', 'append_collect')">追加采集</button>
               <button onclick="rerunTaskStage('${task.id}', 'coarse')">重新粗筛</button>
               <button onclick="rerunTaskStage('${task.id}', 'fine')">重新细筛</button>
               <button onclick="rerunTaskStage('${task.id}', 'fine_missing')">补跑未细筛</button>
             </span>
           </span>
           <button class="btn btn-sm" onclick="editTask('${task.id}')">编辑</button>
           <button class="btn btn-sm" onclick="duplicateTask('${task.id}')" title="复制任务配置">复制</button>
           <button class="btn btn-sm" onclick="deleteTask('${task.id}')">删除</button>`
      }
    </div>
  `;

  container.innerHTML = html;
}

function renderProductStats() {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task?.products) return;

  document.getElementById('product-stats').innerHTML = `
    <button class="stat-card stat-filter ${productFilter === 'raw' ? 'active' : ''}" onclick="setProductFilter('raw')">
      <div class="stat-value">${task.products.rawCount || 0}</div><div class="stat-label">采集总量</div>
    </button>
    <button class="stat-card stat-filter ${productFilter === 'coarse' ? 'active' : ''}" onclick="setProductFilter('coarse')">
      <div class="stat-value" style="color:var(--orange)">${task.products.coarseCount || 0}</div><div class="stat-label">粗筛通过</div>
    </button>
    <button class="stat-card stat-filter ${productFilter === 'fine' ? 'active' : ''}" onclick="setProductFilter('fine')">
      <div class="stat-value" style="color:var(--green)">${task.products.fineCount || 0}</div><div class="stat-label">细筛可跟进（已核验 ${task.products.fineReviewedCount ?? task.products.fineFiltered?.length ?? 0}）</div>
    </button>
    <button class="stat-card stat-filter ${productFilter === 'chat' ? 'active' : ''}" onclick="setProductFilter('chat')">
      <div class="stat-value" style="color:var(--accent)">${task.chatSessions?.length || 0}</div><div class="stat-label">聊天会话</div>
    </button>
  `;
}

function setProductFilter(filter) {
  productFilter = filter;
  productPage = 1;
  renderProductStats();
  renderProducts();
}

function renderReviewActions() {
  const task = tasks.find(t => t.id === activeTaskId);
  const container = document.getElementById('review-actions');
  if (!task || !container) return;

  container.style.display = 'none';
  container.innerHTML = '';
}

function toggleAllReviewProducts(checked) {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task) return;
  const fineIds = (task.products?.fineFiltered || []).map(p => p.id);
  task.selectedProductIds = checked ? fineIds : [];
  renderProducts();
}

function toggleReviewProductSelection(productId, checked) {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task) return;
  const selected = new Set(task.selectedProductIds || []);
  if (checked) selected.add(productId);
  else selected.delete(productId);
  task.selectedProductIds = [...selected];
  renderSelectionHeader(task, new Set((task.products?.fineFiltered || []).map(p => p.id)));
}

async function startSelectedChats(id) {
  const task = tasks.find(t => t.id === id);
  const selectedIds = task?.selectedProductIds?.length
    ? task.selectedProductIds
    : [...document.querySelectorAll('.review-checkbox:checked')].map(input => input.value);
  const fineIds = new Set((task?.products?.fineFiltered || []).map(p => p.id));
  const productIds = selectedIds.filter(productId => fineIds.has(productId));
  if (productIds.length === 0) {
    alert('请至少选择一个细筛通过的商品');
    return;
  }

  try {
    await apiPost(`/api/tasks/${id}/chat`, {
      productIds,
      chatStrategy: task?.config?.chatStrategy || '',
      persona: task?.config?.persona || '',
    });
  } catch { /* alert already shown */ }
}

function renderProducts() {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task?.products) {
    const headerActions = document.getElementById('select-header-actions');
    if (headerActions) headerActions.innerHTML = '';
    return;
  }

  const fineIds = new Set((task.products.fineFiltered || []).map(p => p.id));
  const coarseIds = new Set((task.products.coarseFiltered || []).map(p => p.id));
  const chatIds = new Set((task.chatSessions || []).map(s => s.id));

  let all = task.products.raw || [];
  if (productFilter === 'coarse') all = task.products.coarseFiltered || [];
  if (productFilter === 'fine') all = task.products.fineFiltered || [];
  if (productFilter === 'chat') {
    const rawById = new Map((task.products.raw || []).map(p => [p.id, p]));
    all = (task.chatSessions || []).map(s => rawById.get(s.id) || {
      id: s.id,
      title: s.productTitle,
      price: s.productPrice,
      sellerName: s.sellerName,
      sellerLocation: '',
      image: '',
      href: '',
      shipping: '',
      wantCount: null,
      viewCount: null,
      updatedAt: '',
      sellerLastSeen: '',
      sellerType: '',
      sellerPersonalScore: null,
      firstSeenAt: null,
      priceChange: '',
      priceDelta: 0,
    });
  }

  all = sortProducts(all, chatIds, fineIds, coarseIds);
  renderSelectionHeader(task, fineIds);
  renderSortHeaders();

  const totalPages = Math.max(1, Math.ceil(all.length / PRODUCT_PAGE_SIZE));
  if (productPage > totalPages) productPage = totalPages;
  if (productPage < 1) productPage = 1;

  const pageStart = (productPage - 1) * PRODUCT_PAGE_SIZE;
  const pageItems = all.slice(pageStart, pageStart + PRODUCT_PAGE_SIZE);

  const tbody = document.getElementById('product-tbody');
  tbody.innerHTML = pageItems.map(p => {
    let badge, badgeCls;
    if (chatIds.has(p.id)) { badge = '聊天中'; badgeCls = 'badge-chat'; }
    else if (fineIds.has(p.id)) { badge = '细筛✓'; badgeCls = 'badge-fine'; }
    else if (coarseIds.has(p.id)) { badge = '粗筛✓'; badgeCls = 'badge-coarse'; }
    else { badge = '采集'; badgeCls = 'badge-raw'; }

    const selectable = task.stage === 'review' && fineIds.has(p.id);
    const checked = (task.selectedProductIds || []).includes(p.id) ? 'checked' : '';
    const tracked = isProductTracked(p);

    return `<tr>
      <td class="select-col">
        ${fineIds.has(p.id)
          ? `<input class="review-checkbox" type="checkbox" value="${escapeHtml(p.id)}" onchange="toggleReviewProductSelection('${escapeHtml(p.id)}', this.checked)" ${checked} ${selectable ? '' : 'disabled'}>`
          : ''}
      </td>
      <td>${p.image ? `<img class="product-img" src="${escapeHtml(p.image)}" loading="lazy" onclick="showImagePreview('${escapeHtml(p.image)}')">` : '-'}</td>
      <td class="product-title" title="${escapeHtml(p.title)}">${renderProductTitle(p)}</td>
      <td class="product-price">${escapeHtml(p.price || '')}</td>
      <td class="list-flags-col">${renderListFlags(p)}</td>
      <td>${renderProductFreshness(p)}</td>
      <td>${renderSellerCell(p, false)}</td>
      <td>
        <div class="product-actions">
          ${chatIds.has(p.id)
            ? `<button class="badge badge-button ${badgeCls}" onclick="showProductChatModal('${escapeHtml(p.id)}')">${badge}</button>`
            : `<span class="badge ${badgeCls}">${badge}</span>`}
          <button class="track-btn ${tracked ? 'tracked' : ''}" data-url="${escapeHtml(p.href || '')}" data-title="${escapeHtml(p.title || '')}" onclick="addProductToTrackerFromList(this.dataset.url, this.dataset.title)" ${p.href && !tracked ? '' : 'disabled'}>${tracked ? '已跟踪' : '跟踪'}</button>
          ${fineIds.has(p.id) ? renderQuickSellerLabel(p) : ''}
        </div>
      </td>
    </tr>`;
  }).join('');

  renderProductPagination(all.length, totalPages, pageStart, pageItems.length);
}

function renderListFlags(product) {
  const badges = Array.isArray(product.badges) ? product.badges : [];
  const labels = ['个人闲置', '验货宝', '验号担保', '包邮', '超赞鱼小铺', '全新', '严选', '转卖'];
  const hits = labels.filter(label => badges.includes(label) || (label === '个人闲置' && product.personalSeller === true));
  return hits.length
    ? `<div class="list-flags">${hits.map(label => `<span class="list-flag list-flag-yes">${escapeHtml(label)}</span>`).join('')}</div>`
    : '<span class="list-flag">—</span>';
}

function getProductTrackId(productOrUrl) {
  const raw = typeof productOrUrl === 'string' ? productOrUrl : (productOrUrl?.href || productOrUrl?.url || '');
  try {
    const url = new URL(raw, window.location.href);
    return url.searchParams.get('id') || url.pathname.match(/(\d{8,})/)?.[1] || '';
  } catch {
    return typeof productOrUrl === 'string' ? '' : (productOrUrl?.id || '');
  }
}

function isProductTracked(product) {
  const trackId = getProductTrackId(product);
  if (!trackId) return false;
  return trackedProducts.some(item => item.id === trackId);
}

function renderProductTitle(product) {
  const title = escapeHtml(product.title || '');
  if (!product.href) return title;
  return `<button class="title-link" data-href="${escapeHtml(product.href)}" onclick="openProductPage(this.dataset.href)" title="在当前浏览器新标签页打开商品页">${title}</button>`;
}

function openProductPage(url) {
  if (!url) {
    alert('这个商品没有可打开的链接');
    return;
  }
  try {
    const parsed = new URL(url, window.location.href);
    const allowedHosts = ['www.goofish.com', 'goofish.com', '2.taobao.com', 'item.taobao.com'];
    if (!['http:', 'https:'].includes(parsed.protocol) || !allowedHosts.includes(parsed.hostname)) {
      alert('只支持打开闲鱼/淘宝商品链接');
      return;
    }
    window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
  } catch (err) {
    alert(`打开失败: ${err.message}`);
  }
}

function renderSelectionHeader(task, fineIds) {
  const container = document.getElementById('select-header-actions');
  if (!container) return;
  const fineCount = task.products?.fineCount || fineIds.size;
  const show = task.stage === 'review' && fineCount > 0 && !task.running;
  if (!show) {
    container.innerHTML = '';
    return;
  }
  const selectedCount = (task.selectedProductIds || []).filter(id => fineIds.has(id)).length;
  container.innerHTML = `<input id="review-select-all" class="review-checkbox" type="checkbox" onchange="toggleAllReviewProducts(this.checked)" title="全选/清空细筛商品">`;
  const checkbox = document.getElementById('review-select-all');
  if (!checkbox) return;
  checkbox.checked = selectedCount > 0 && selectedCount === fineIds.size;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < fineIds.size;
}

function renderShipping(value) {
  const text = String(value || '').trim();
  if (!text) return '<span class="shipping-tag shipping-unknown">-</span>';
  const cls = text === '包邮' ? 'shipping-free' : 'shipping-paid';
  return `<span class="shipping-tag ${cls}">${escapeHtml(text)}</span>`;
}

function renderPriceChange(product) {
  const change = product.priceChange || (product.firstSeenAt ? '未变' : '');
  const delta = Number(product.priceDelta || 0);
  if (!change) return '<span class="price-change muted">-</span>';
  if (change === '新发现') return '<span class="price-change price-new">新</span>';
  if (change === '降价') return `<span class="price-change price-down">降 ${escapeHtml(Math.abs(delta).toFixed(0))}</span>`;
  if (change === '涨价') return `<span class="price-change price-up">涨 ${escapeHtml(Math.abs(delta).toFixed(0))}</span>`;
  return '<span class="price-change muted">未变</span>';
}

function renderSellerProfile(product, canLabel = false) {
  const manualLabel = getSellerManualLabel(product) || product.sellerManualLabel || '';
  const type = getSellerLevel(product);
  const score = manualLabel ? null : (Number.isFinite(Number(product.sellerPersonalScore)) ? Number(product.sellerPersonalScore) : null);
  const reason = manualLabel ? `人工标注：${manualLabel}` : (product.sellerProfileReason || '细筛后生成');
  const cls = sellerLevelClass(type);
  const label = type === '疑似小B' ? '⚠ 疑似小B' : (type === '小B' && !manualLabel && product.sellerAutoConfirmed ? '⚠ 小B（经营词）' : (score == null ? type : `${type} ${score}`));
  if (!canLabel) return `<span class="seller-profile ${cls}" title="${escapeHtml(reason)}">${escapeHtml(label)}</span>`;
  const payload = escapeHtml(JSON.stringify({ sellerName: product.sellerName || '', sellerId: product.sellerId || '', sellerFingerprint: product.sellerFingerprint || '' }));
  return `<button class="seller-profile seller-profile-button ${cls}" data-seller="${payload}" title="${escapeHtml(reason)}" onclick="showSellerLabelModal(JSON.parse(this.dataset.seller))">${escapeHtml(label)}</button>`;
}

function renderQuickSellerLabel(product) {
  const payload = escapeHtml(JSON.stringify({ sellerName: product.sellerName || '', sellerId: product.sellerId || '', sellerFingerprint: product.sellerFingerprint || '', sellerAvatarUrl: product.sellerAvatarUrl || '', sellerLocation: product.sellerLocation || '', sellerRating: product.sellerRating || '', sellerDealCount: product.sellerDealCount ?? null, sellerListedCount: product.sellerListedCount ?? null }));
  return `<select class="quick-seller-label" data-seller="${payload}" onchange="quickLabelSeller(this)" title="直接标记卖家等级"><option value="">标记卖家…</option><option value="小B">小B</option><option value="个人卖家">个人卖家</option><option value="疑似小B">疑似小B</option><option value="疑似个人卖家">疑似个人卖家</option><option value="不明确">不明确</option><option value="__clear__">清除标记</option></select>`;
}

function renderProductHeat(product) {
  return `
    <div class="compact-stack">
      <div>${renderShipping(product.shipping)}</div>
      <div class="compact-meta">想 ${formatCount(product.wantCount, product.wantText)} / 浏览 ${formatCount(product.viewCount, product.viewText)}</div>
    </div>
  `;
}

function renderProductFreshness(product) {
  const sellerTime = formatSellerLastSeen(product.sellerLastSeen || product.updatedAt);
  const discoveredTime = formatTimeAgo(product.firstSeenAt);
  return `
    <div class="compact-stack">
      ${sellerTime ? `<div>${escapeHtml(sellerTime)}</div>` : ''}
      ${discoveredTime ? `<div class="compact-meta">${escapeHtml(discoveredTime)}</div>` : ''}
    </div>
  `;
}

function renderSellerCell(product, canLabel = false) {
  return `
    <div class="seller-cell">
      <div>${renderSellerProfile(product, canLabel)}</div>
      <div class="seller-line" title="${escapeHtml(product.sellerName || '')}">${escapeHtml(product.sellerName || '-')}</div>
      <div class="compact-meta">${escapeHtml(product.sellerLocation || '')}</div>
    </div>
  `;
}

function formatCount(value, fallback = '') {
  if (value === 0) return '0';
  if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) {
    const n = Number(value);
    if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
    return String(n);
  }
  return escapeHtml(fallback || '-');
}

function formatSellerLastSeen(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatTimeAgo(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  const diff = Date.now() - time;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)}天前`;
  return new Date(time).toLocaleDateString('zh-CN');
}

function renderProductPagination(total, totalPages, pageStart, pageCount) {
  const container = document.getElementById('product-pagination');
  if (!container) return;

  if (total === 0) {
    container.innerHTML = '<span class="pagination-info">暂无记录</span>';
    return;
  }

  const from = pageStart + 1;
  const to = pageStart + pageCount;
  container.innerHTML = `
    <span class="pagination-info">显示 ${from}-${to} / ${total} 条，每页 ${PRODUCT_PAGE_SIZE} 条</span>
    <div class="pagination-buttons">
      <button class="btn btn-sm" onclick="setProductPage(1)" ${productPage === 1 ? 'disabled' : ''}>首页</button>
      <button class="btn btn-sm" onclick="setProductPage(${productPage - 1})" ${productPage === 1 ? 'disabled' : ''}>上一页</button>
      <span class="pagination-page">第 ${productPage} / ${totalPages} 页</span>
      <button class="btn btn-sm" onclick="setProductPage(${productPage + 1})" ${productPage === totalPages ? 'disabled' : ''}>下一页</button>
      <button class="btn btn-sm" onclick="setProductPage(${totalPages})" ${productPage === totalPages ? 'disabled' : ''}>末页</button>
    </div>
  `;
}

function setProductPage(page) {
  productPage = page;
  renderProducts();
}

function setProductSort(key) {
  if (productSort.key === key) {
    productSort.dir = productSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    productSort = { key, dir: 'asc' };
  }
  productPage = 1;
  renderProducts();
}

function sortProducts(products, chatIds, fineIds, coarseIds) {
  const sellerLevelRank = (p) => ({
    '小B': 0,
    '疑似小B': 1,
    '不明确': 2,
    '疑似个人卖家': 3,
    '个人卖家': 4,
  })[getSellerLevel(p)] ?? 5;

  // 细筛默认按排除优先级排列，方便先核查已确认和疑似的小B。
  if (!productSort.key) {
    if (productFilter !== 'fine') return products;
    return [...products].sort((a, b) => sellerLevelRank(a) - sellerLevelRank(b));
  }

  const dir = productSort.dir === 'desc' ? -1 : 1;
  const numberValue = (value) => {
    if (value === 0) return 0;
    if (value === null || value === undefined || value === '') return Number.POSITIVE_INFINITY;
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  const lastSeenValue = (value) => {
    const text = String(value || '').trim();
    if (!text) return Number.POSITIVE_INFINITY;
    if (/在线|刚刚/.test(text)) return 0;
    const minute = text.match(/(\d+)\s*分钟前/);
    if (minute) return Number(minute[1]) * 60 * 1000;
    const hour = text.match(/(\d+)\s*小时前/);
    if (hour) return Number(hour[1]) * 60 * 60 * 1000;
    const day = text.match(/(\d+)\s*天前/);
    if (day) return Number(day[1]) * 24 * 60 * 60 * 1000;
    const week = text.match(/(\d+)\s*周前/);
    if (week) return Number(week[1]) * 7 * 24 * 60 * 60 * 1000;
    const month = text.match(/(\d+)\s*月前/);
    if (month) return Number(month[1]) * 30 * 24 * 60 * 60 * 1000;
    if (text.includes('今天')) return 0;
    if (text.includes('昨天')) return 24 * 60 * 60 * 1000;
    if (text.includes('前天')) return 2 * 24 * 60 * 60 * 1000;
    return Number.POSITIVE_INFINITY;
  };
  const stageRank = (p) => {
    if (chatIds.has(p.id)) return 4;
    if (fineIds.has(p.id)) return 3;
    if (coarseIds.has(p.id)) return 2;
    return 1;
  };
  const valueOf = (p) => {
    if (productSort.key === 'price') {
      const match = String(p.price || '').replace(/,/g, '').match(/[\d.]+/);
      return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
    }
    if (productSort.key === 'want') return numberValue(p.wantCount);
    if (productSort.key === 'view') return numberValue(p.viewCount);
    if (productSort.key === 'updated') return lastSeenValue(p.sellerLastSeen || p.updatedAt);
    if (productSort.key === 'sellerScore') {
      return sellerLevelRank(p);
    }
    if (productSort.key === 'firstSeen') return Number.isFinite(Number(p.firstSeenAt)) ? -Number(p.firstSeenAt) : Number.POSITIVE_INFINITY;
    if (productSort.key === 'priceChange') {
      if (p.priceChange === '降价') return -1000000000 + Number(p.priceDelta || 0);
      if (p.priceChange === '新发现') return -500000000;
      if (p.priceChange === '涨价') return 500000000 + Number(p.priceDelta || 0);
      return 0;
    }
    if (productSort.key === 'seller') return String(p.sellerName || '');
    if (productSort.key === 'location') return String(p.sellerLocation || '');
    if (productSort.key === 'stage') return stageRank(p);
    return '';
  };

  return [...products].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (typeof av === 'number' && typeof bv === 'number') {
      if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
      if (!Number.isFinite(av)) return 1;
      if (!Number.isFinite(bv)) return -1;
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv), 'zh-CN') * dir;
  });
}

function renderSortHeaders() {
  ['price', 'priceChange', 'want', 'view', 'updated', 'sellerScore', 'firstSeen', 'seller', 'location', 'stage'].forEach(key => {
    const el = document.getElementById(`sort-${key}`);
    if (!el) return;
    const label = { price: '价格', priceChange: '变化', want: '热度', view: '浏览', updated: '时效', sellerScore: '卖家等级', firstSeen: '发现', seller: '卖家', location: '地区', stage: '阶段' }[key];
    const arrow = productSort.key === key ? (productSort.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
    el.textContent = label + arrow;
    el.title = '点击排序';
    el.classList.toggle('active', productSort.key === key);
  });
}

function showImagePreview(src) {
  const img = document.getElementById('image-preview-img');
  img.src = src;
  document.getElementById('image-preview-overlay').classList.add('show');
}

function hideImagePreview() {
  document.getElementById('image-preview-overlay').classList.remove('show');
  document.getElementById('image-preview-img').src = '';
}

function showProductChatModal(productId) {
  const task = tasks.find(t => t.id === activeTaskId);
  const session = (task?.chatSessions || []).find(s => s.id === productId);
  if (!session) return;

  document.getElementById('product-chat-title').textContent = session.productTitle || '聊天详情';
  document.getElementById('product-chat-meta').innerHTML = `
    <span>${escapeHtml(session.productPrice || '')}</span>
    ${session.sellerName ? `<span>@${escapeHtml(session.sellerName)}</span>` : ''}
    <span>${session.messageCount || session.messages?.length || 0} 条消息</span>
  `;

  const messages = session.messages || [];
  document.getElementById('product-chat-messages').innerHTML = messages.length
    ? messages.map(m => {
      const timeStr = m.time ? new Date(m.time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
      return `
        <div class="chat-msg ${m.role === 'self' ? 'self' : 'other'}">
          <div class="chat-bubble">${escapeHtml(m.content)}</div>
          ${timeStr ? `<div class="chat-msg-time">${timeStr}</div>` : ''}
        </div>`;
    }).join('')
    : '<div class="empty-state" style="padding:24px">暂无聊天记录</div>';

  document.getElementById('product-chat-modal-overlay').classList.add('show');
  const box = document.getElementById('product-chat-messages');
  box.scrollTop = box.scrollHeight;
}

function hideProductChatModal() {
  document.getElementById('product-chat-modal-overlay').classList.remove('show');
}

function renderChats() {
  const task = tasks.find(t => t.id === activeTaskId);
  const container = document.getElementById('chat-sessions');
  const sessions = task?.chatSessions || [];

  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:40px"><p style="color:var(--text2)">暂无聊天会话</p></div>';
    return;
  }

  container.innerHTML = sessions.map(s => {
    const ps = s.promptSummary || {};
    const statusMap = { initiating: '发起中', waiting: '监控中', error: '异常', goal_reached: '目标达成' };
    const statusLabel = statusMap[s.status] || s.status;
    const statusCls = s.status === 'goal_reached' ? 'goal' : s.status === 'waiting' ? 'chatting' : s.status === 'error' ? 'stopped' : 'pending';
    return `
    <div class="chat-session ${s.status === 'goal_reached' ? 'chat-goal-reached' : ''}">
      <div class="chat-header">
        <div>
          <span class="chat-product-name">${escapeHtml(s.productTitle?.slice(0, 40) || '')}</span>
          <span class="chat-product-price">${escapeHtml(s.productPrice || '')}</span>
          ${s.sellerName ? `<span class="chat-seller">@${escapeHtml(s.sellerName)}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="prompt-tag ${ps.hasStrategy ? 'on' : ''}">策略</span>
          <span class="prompt-tag ${ps.hasProductContext ? 'on' : ''}">商品</span>
          <span class="prompt-tag ${ps.hasRequirements ? 'on' : ''}">需求</span>
          <span class="chat-msg-count">${s.messageCount || 0}条</span>
          <span class="stage-badge stage-${statusCls}">${statusLabel}</span>
        </div>
      </div>
      ${s.status === 'goal_reached' && s.goalReason ? `
      <div class="chat-goal-banner">🎯 ${escapeHtml(s.goalReason)}</div>` : ''}
      ${s.productDescription ? `
      <div class="chat-context">
        <div class="chat-context-label">卖家商品描述</div>
        <div class="chat-context-text">${escapeHtml(s.productDescription)}</div>
      </div>` : ''}
      <div class="chat-messages">
        ${(s.messages || []).map(m => {
          const timeStr = m.time ? new Date(m.time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
          return `
          <div class="chat-msg ${m.role === 'self' ? 'self' : 'other'}">
            <div class="chat-bubble">${escapeHtml(m.content)}</div>
            ${timeStr ? `<div class="chat-msg-time">${timeStr}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  const chatBoxes = container.querySelectorAll('.chat-messages');
  chatBoxes.forEach(box => { box.scrollTop = box.scrollHeight; });
}

function renderLogs() {
  const task = tasks.find(t => t.id === activeTaskId);
  const panel = document.getElementById('log-panel');
  const logs = task?.logs || [];

  panel.innerHTML = logs.map(l =>
    `<div class="log-entry"><span class="log-time">${l.time}</span>${escapeHtml(l.message)}</div>`
  ).join('');
  panel.scrollTop = panel.scrollHeight;
}

// ========== Tab Switching ==========
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  if (tab === 'tracking') loadTrackedProducts();
}

// ========== Price Tracking ==========
async function loadTrackedProducts() {
  try {
    const res = await fetch('/api/tracked-products');
    trackedProducts = await res.json();
    renderTrackedProducts();
  } catch (err) {
    renderTrackerError(err.message);
  }
}

function renderTrackerError(message) {
  const tbody = document.getElementById('tracker-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="10" class="tracker-empty">加载失败：${escapeHtml(message)}</td></tr>`;
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  return Number.isFinite(n) ? `¥${n.toFixed(n % 1 === 0 ? 0 : 2)}` : escapeHtml(String(value));
}

function formatTrackerChange(item) {
  const change = item.priceChange || '待检查';
  const delta = Number(item.priceDelta || 0);
  if (change === '降价') return `<span class="price-change price-down">降 ${formatMoney(Math.abs(delta))}</span>`;
  if (change === '涨价') return `<span class="price-change price-up">涨 ${formatMoney(Math.abs(delta))}</span>`;
  if (change === '首次记录') return '<span class="price-change price-new">首次</span>';
  if (change === '待检查') return '<span class="price-change muted">待检查</span>';
  return '<span class="price-change muted">未变</span>';
}

function getTrackerHistory(item) {
  return Array.isArray(item?.history)
    ? item.history
      .map(h => ({ time: Number(h.time), price: Number(h.price) }))
      .filter(h => Number.isFinite(h.time) && Number.isFinite(h.price))
      .sort((a, b) => a.time - b.time)
    : [];
}

function getTrackerHistoryStats(item) {
  const history = getTrackerHistory(item);
  let drops = 0;
  let rises = 0;
  for (let i = 1; i < history.length; i += 1) {
    if (history[i].price < history[i - 1].price) drops += 1;
    if (history[i].price > history[i - 1].price) rises += 1;
  }
  return { history, drops, rises };
}

function renderTrackerQuickStats(item) {
  const { history, drops, rises } = getTrackerHistoryStats(item);
  if (history.length < 2) return '<div class="tracker-change-meta">暂无历史变化</div>';
  const parts = [];
  if (drops) parts.push(`${drops}次降价`);
  if (rises) parts.push(`${rises}次涨价`);
  if (!parts.length) parts.push('价格稳定');
  return `<div class="tracker-change-meta">${escapeHtml(parts.join('，'))}</div>`;
}

function renderTrackerStatus(item) {
  const status = String(item?.status || 'tracking');
  const map = {
    tracking: { label: '在售', cls: 'tracker-status-on' },
    invalid: { label: '下架', cls: 'tracker-status-off' },
    down: { label: '下架', cls: 'tracker-status-off' },
    sold: { label: '售出', cls: 'tracker-status-sold' },
    deleted: { label: '已删', cls: 'tracker-status-off' },
  };
  const info = map[status] || { label: '未知', cls: 'tracker-status-unknown' };
  return `<span class="tracker-status ${info.cls}">${info.label}</span>`;
}

function findSellerProfileSource(sellerName) {
  const name = String(sellerName || '').trim();
  if (!name) return null;
  for (const task of tasks) {
    const lists = [
      task.products?.fineFiltered,
      task.products?.coarseFiltered,
      task.products?.raw,
    ];
    for (const list of lists) {
      const found = (list || []).find(product => String(product.sellerName || '').trim() === name);
      if (found) return found;
    }
  }
  return null;
}

function renderTrackerSeller(item) {
  const manualLabel = getSellerManualLabel(item) || item.sellerManualLabel || '';
  const cls = sellerLevelClass(manualLabel);
  const payload = escapeHtml(JSON.stringify({ sellerName: item.sellerName || '', sellerId: item.sellerId || '', sellerFingerprint: item.sellerFingerprint || '' }));
  const profile = manualLabel
    ? `<button class="seller-profile seller-profile-button ${cls}" data-seller="${payload}" title="人工标注：${escapeHtml(manualLabel)}" onclick="showSellerLabelModal(JSON.parse(this.dataset.seller))">${escapeHtml(manualLabel)}</button>`
    : '';
  return `
    <div class="tracker-seller-line">
      ${profile}
      <span class="tracker-seller-name">${escapeHtml(item.sellerName || '-')}</span>
    </div>
  `;
}

function getTrackedProductTitle(item) {
  const title = String(item?.title || '').trim();
  if (title && !['为你推荐', '相关推荐', '猜你喜欢'].includes(title)) return title;
  return item?.url || '';
}

function getVisibleTrackedProducts() {
  const query = trackerSearch.trim().toLowerCase();
  let items = trackedProducts;
  if (trackerOnlyStarred) {
    items = items.filter(item => item.starred);
  }
  if (trackerOnlyDrops) {
    items = items.filter(item => item.priceChange === '降价' || Number(item.priceDelta || 0) < 0);
  }
  if (query) {
    items = items.filter(item => {
      const title = getTrackedProductTitle(item).toLowerCase();
      const seller = String(item.sellerName || '').toLowerCase();
      return title.includes(query) || seller.includes(query);
    });
  }
  return sortTrackedProducts(items);
}

function trackerNumberValue(value) {
  if (value === 0) return 0;
  if (value === null || value === undefined || value === '') return Number.POSITIVE_INFINITY;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function sortTrackedProducts(items) {
  const starredRank = item => item.starred ? 0 : 1;
  const base = [...items].sort((a, b) => starredRank(a) - starredRank(b));
  if (!trackerSort.key) return base;

  const dir = trackerSort.dir === 'desc' ? -1 : 1;
  const valueOf = (item) => {
    if (['currentPrice', 'firstPrice', 'lowestPrice', 'priceDelta', 'lastCheckedAt'].includes(trackerSort.key)) {
      return trackerNumberValue(item[trackerSort.key]);
    }
    if (trackerSort.key === 'status') {
      const rank = { tracking: 1, sold: 2, down: 3, invalid: 3, deleted: 4 };
      return rank[item.status] || 99;
    }
    return '';
  };

  return base.sort((a, b) => {
    const starDiff = starredRank(a) - starredRank(b);
    if (starDiff !== 0) return starDiff;
    const av = valueOf(a);
    const bv = valueOf(b);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return (av - bv) * dir;
  });
}

function renderTrackerSortHeaders() {
  ['currentPrice', 'firstPrice', 'lowestPrice', 'priceDelta', 'lastCheckedAt', 'status'].forEach(key => {
    const el = document.getElementById(`tracker-sort-${key}`);
    if (!el) return;
    const label = {
      currentPrice: '当前价',
      firstPrice: '首次',
      lowestPrice: '最低',
      priceDelta: '变化',
      lastCheckedAt: '最近检查',
      status: '状态',
    }[key];
    const arrow = trackerSort.key === key ? (trackerSort.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
    el.textContent = label + arrow;
    el.title = '点击排序';
    el.classList.toggle('active', trackerSort.key === key);
  });
}

function setTrackerSort(key) {
  if (trackerSort.key === key) {
    trackerSort.dir = trackerSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    trackerSort = { key, dir: 'asc' };
  }
  trackerPage = 1;
  renderTrackedProducts();
}

function setTrackerSearch(value) {
  trackerSearch = String(value || '');
  trackerPage = 1;
  renderTrackedProducts();
}

function renderTrackerFilterButtons() {
  const starredBtn = document.getElementById('tracker-filter-starred');
  const dropBtn = document.getElementById('tracker-filter-drops');
  if (starredBtn) {
    starredBtn.classList.toggle('active', trackerOnlyStarred);
    starredBtn.textContent = trackerOnlyStarred ? '★ 星标中' : '★ 星标';
  }
  if (dropBtn) {
    dropBtn.classList.toggle('active', trackerOnlyDrops);
    dropBtn.textContent = trackerOnlyDrops ? '只看降价中' : '只看降价';
  }
}

function toggleTrackerStarredFilter() {
  trackerOnlyStarred = !trackerOnlyStarred;
  trackerPage = 1;
  renderTrackedProducts();
}

function toggleTrackerDropFilter() {
  trackerOnlyDrops = !trackerOnlyDrops;
  trackerPage = 1;
  renderTrackedProducts();
}

function syncTrackerSelectAll(visibleItems) {
  const checkbox = document.getElementById('tracker-select-all');
  if (!checkbox) return;
  const ids = visibleItems.map(item => item.id);
  const selected = ids.filter(id => selectedTrackedProductIds.has(id)).length;
  checkbox.checked = ids.length > 0 && selected === ids.length;
  checkbox.indeterminate = selected > 0 && selected < ids.length;
}

function toggleTrackedProductSelection(id, checked) {
  if (checked) selectedTrackedProductIds.add(id);
  else selectedTrackedProductIds.delete(id);
  syncTrackerSelectAll(getVisibleTrackedProducts());
}

function toggleAllTrackedProducts(checked) {
  getVisibleTrackedProducts().forEach(item => {
    if (checked) selectedTrackedProductIds.add(item.id);
    else selectedTrackedProductIds.delete(item.id);
  });
  renderTrackedProducts();
}

function renderTrackedProducts() {
  const tbody = document.getElementById('tracker-tbody');
  if (!tbody) return;
  selectedTrackedProductIds = new Set([...selectedTrackedProductIds].filter(id => trackedProducts.some(item => item.id === id)));
  const visibleItems = getVisibleTrackedProducts();
  renderTrackerSortHeaders();
  renderTrackerFilterButtons();
  syncTrackerSelectAll(visibleItems);
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / TRACKER_PAGE_SIZE));
  if (trackerPage > totalPages) trackerPage = totalPages;
  if (trackerPage < 1) trackerPage = 1;
  const pageStart = (trackerPage - 1) * TRACKER_PAGE_SIZE;
  const pageItems = visibleItems.slice(pageStart, pageStart + TRACKER_PAGE_SIZE);

  if (!trackedProducts.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="tracker-empty">暂无跟踪链接</td></tr>';
    renderTrackerPagination(0, 1, 0, 0);
    return;
  }
  if (!visibleItems.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="tracker-empty">没有匹配的商品</td></tr>';
    renderTrackerPagination(0, 1, 0, 0);
    return;
  }

  tbody.innerHTML = pageItems.map(item => `
    <tr>
      <td class="tracker-check-col">
        <input class="review-checkbox" type="checkbox" value="${escapeHtml(item.id)}" onchange="toggleTrackedProductSelection('${escapeHtml(item.id)}', this.checked)" ${selectedTrackedProductIds.has(item.id) ? 'checked' : ''}>
      </td>
      <td class="tracker-star-col">
        <button class="star-btn ${item.starred ? 'active' : ''}" onclick="toggleTrackedProductStar('${escapeHtml(item.id)}', ${item.starred ? 'false' : 'true'})" title="${item.starred ? '取消星标' : '标为重点关注'}">★</button>
      </td>
      <td class="tracker-product">
        <div class="tracker-product-main">
          ${item.image ? `<img class="tracker-img" src="${escapeHtml(item.image)}" loading="lazy" onclick="showImagePreview('${escapeHtml(item.image)}')" alt="">` : '<div class="tracker-img tracker-img-empty"></div>'}
          <div class="tracker-product-text">
            <div class="tracker-title">
              <button class="title-link" data-href="${escapeHtml(item.url)}" onclick="openProductPage(this.dataset.href)">
                ${escapeHtml(getTrackedProductTitle(item))}
              </button>
            </div>
            <div class="tracker-meta">${renderTrackerSeller(item)}</div>
          </div>
        </div>
      </td>
      <td class="product-price">${formatMoney(item.currentPrice)}</td>
      <td>${formatMoney(item.firstPrice)}</td>
      <td>${formatMoney(item.lowestPrice)}</td>
      <td>${formatTrackerChange(item)}${renderTrackerQuickStats(item)}</td>
      <td class="updated-cell">${escapeHtml(formatTimeAgo(item.lastCheckedAt))}</td>
      <td>${renderTrackerStatus(item)}</td>
      <td>${escapeHtml(item.note || '')}</td>
      <td>
        <div class="tracker-actions">
          <button class="btn btn-sm" onclick="checkTrackedProduct('${escapeHtml(item.id)}')" ${trackerBusy ? 'disabled' : ''}>检查</button>
          <button class="btn btn-sm" onclick="showTrackerHistoryModal('${escapeHtml(item.id)}')">历史</button>
          <button class="btn btn-sm btn-danger" onclick="deleteTrackedProduct('${escapeHtml(item.id)}')" ${trackerBusy ? 'disabled' : ''}>删除</button>
        </div>
      </td>
    </tr>
  `).join('');

  renderTrackerPagination(visibleItems.length, totalPages, pageStart, pageItems.length);
}

function renderTrackerPagination(total, totalPages, pageStart, pageCount) {
  const container = document.getElementById('tracker-pagination');
  if (!container) return;

  if (total === 0) {
    container.innerHTML = '<span class="pagination-info">暂无记录</span>';
    return;
  }

  const from = pageStart + 1;
  const to = pageStart + pageCount;
  container.innerHTML = `
    <span class="pagination-info">显示 ${from}-${to} / ${total} 条，每页 ${TRACKER_PAGE_SIZE} 条</span>
    <div class="pagination-buttons">
      <button class="btn btn-sm" onclick="setTrackerPage(1)" ${trackerPage === 1 ? 'disabled' : ''}>首页</button>
      <button class="btn btn-sm" onclick="setTrackerPage(${trackerPage - 1})" ${trackerPage === 1 ? 'disabled' : ''}>上一页</button>
      <span class="pagination-page">第 ${trackerPage} / ${totalPages} 页</span>
      <button class="btn btn-sm" onclick="setTrackerPage(${trackerPage + 1})" ${trackerPage === totalPages ? 'disabled' : ''}>下一页</button>
      <button class="btn btn-sm" onclick="setTrackerPage(${totalPages})" ${trackerPage === totalPages ? 'disabled' : ''}>末页</button>
    </div>
  `;
}

function setTrackerPage(page) {
  trackerPage = page;
  renderTrackedProducts();
}

function formatTrackerTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function showTrackerHistoryModal(id) {
  const item = trackedProducts.find(p => p.id === id);
  if (!item) return;

  const history = getTrackerHistory(item);
  const { drops, rises } = getTrackerHistoryStats(item);
  const title = document.getElementById('tracker-history-title');
  const summary = document.getElementById('tracker-history-summary');
  const tbody = document.getElementById('tracker-history-tbody');
  if (!title || !summary || !tbody) return;

  title.textContent = getTrackedProductTitle(item) || '价格历史';
  summary.innerHTML = `
    <span>当前 ${formatMoney(item.currentPrice)}</span>
    <span>首次 ${formatMoney(item.firstPrice)}</span>
    <span>最低 ${formatMoney(item.lowestPrice)}</span>
    <span>${history.length} 条记录</span>
    <span>${drops} 次降价</span>
    <span>${rises} 次涨价</span>
  `;

  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="tracker-empty">还没有价格记录，先检查一次商品即可生成历史</td></tr>';
  } else {
    tbody.innerHTML = history.slice().reverse().map((entry, index, rows) => {
      const previous = rows[index + 1];
      const delta = previous ? entry.price - previous.price : 0;
      const change = delta < 0
        ? `<span class="price-change price-down">降 ${formatMoney(Math.abs(delta))}</span>`
        : delta > 0
          ? `<span class="price-change price-up">涨 ${formatMoney(Math.abs(delta))}</span>`
          : '<span class="price-change muted">首次</span>';
      return `
        <tr>
          <td>${escapeHtml(formatTrackerTime(entry.time))}</td>
          <td class="product-price">${formatMoney(entry.price)}</td>
          <td>${change}</td>
          <td>${index === 0 ? '最新' : ''}</td>
        </tr>
      `;
    }).join('');
  }

  document.getElementById('tracker-history-modal-overlay')?.classList.add('show');
}

function hideTrackerHistoryModal() {
  document.getElementById('tracker-history-modal-overlay')?.classList.remove('show');
}

async function addTrackedProductFromInput() {
  const urlInput = document.getElementById('tracker-url');
  const url = urlInput.value.trim();
  if (!url) {
    alert('请先粘贴商品链接');
    return;
  }
  try {
    const res = await fetch('/api/tracked-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '添加失败');
    trackedProducts = data.items || [];
    urlInput.value = '';
    renderTrackedProducts();
  } catch (err) {
    alert(err.message);
  }
}

async function addProductToTrackerFromList(url, title = '') {
  if (!url) {
    alert('这个商品没有可跟踪的链接');
    return;
  }

  try {
    const res = await fetch('/api/tracked-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加入价格跟踪失败');
    trackedProducts = data.items || [];
    renderTrackedProducts();
    renderProducts();
  } catch (err) {
    alert(`加入价格跟踪失败：${err.message}`);
  }
}

async function checkTrackedProduct(id) {
  trackerBusy = true;
  renderTrackedProducts();
  try {
    const res = await fetch(`/api/tracked-products/${id}/check`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '检查失败');
    trackedProducts = data.items || [];
  } catch (err) {
    alert(err.message);
  } finally {
    trackerBusy = false;
    renderTrackedProducts();
  }
}

async function checkSelectedTrackedProducts() {
  const ids = [...selectedTrackedProductIds].filter(id => trackedProducts.some(item => item.id === id));
  if (!ids.length) {
    alert('请先选择要检查的商品');
    return;
  }
  trackerBusy = true;
  renderTrackedProducts();
  try {
    for (const id of ids) {
      const res = await fetch(`/api/tracked-products/${id}/check`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '检查失败');
      trackedProducts = data.items || trackedProducts;
      renderTrackedProducts();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    trackerBusy = false;
    renderTrackedProducts();
  }
}

async function toggleTrackedProductStar(id, starred) {
  try {
    const res = await fetch(`/api/tracked-products/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '星标保存失败');
    trackedProducts = data.items || trackedProducts;
    renderTrackedProducts();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteTrackedProduct(id) {
  if (!confirm('确认删除这个价格跟踪？')) return;
  try {
    const res = await fetch(`/api/tracked-products/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '删除失败');
    trackedProducts = data.items || [];
    renderTrackedProducts();
  } catch (err) {
    alert(err.message);
  }
}

// ========== Modal ==========
function openNewTaskModal() {
  editingTaskId = null;
  clearForm();
  showCreateModal();
}

function showCreateModal() {
  const isEditing = !!editingTaskId;
  populateTaskGroupSelect(document.getElementById('f-group').value || (activeTaskGroup !== '全部' ? activeTaskGroup : '未分组'));
  const title = document.getElementById('task-modal-title');
  const submit = document.getElementById('task-modal-submit');
  const createOnly = document.getElementById('task-modal-create-only');
  if (title) title.textContent = isEditing ? '编辑任务' : '新建采购任务';
  if (submit) submit.textContent = isEditing ? '保存修改' : '创建并启动';
  if (createOnly) createOnly.hidden = isEditing;
  document.getElementById('modal-overlay').classList.add('show');
}

function hideCreateModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  editingTaskId = null;
}

function clearForm() {
  ['f-name', 'f-price-max', 'f-region', 'f-want-max', 'f-chat-strategy', 'f-query-group-1', 'f-query-group-2', 'f-query-group-3', 'f-query-group-4'].forEach(id => {
    document.getElementById(id).value = '';
  });
  populateTaskGroupSelect(activeTaskGroup !== '全部' ? activeTaskGroup : '未分组');
  document.getElementById('f-group').value = activeTaskGroup !== '全部' ? activeTaskGroup : '未分组';
  document.getElementById('f-pages').value = '1';
  document.getElementById('f-price-min').value = '500';
  document.getElementById('f-title-exclude').value = '求购、维修、养护、配件';
  document.getElementById('f-personal').checked = false;
  document.getElementById('f-free-shipping').checked = false;
  ['f-inspect', 'f-guarantee', 'f-super-shop', 'f-brand-new', 'f-strict-select', 'f-resale'].forEach(id => { document.getElementById(id).checked = false; });
  document.getElementById('f-search-sort').value = 'newest';
  document.getElementById('f-luxury-sample-size').value = '20';
  document.getElementById('f-luxury-count-threshold').value = '5';
  document.getElementById('f-luxury-ratio-threshold').value = '40';
  document.getElementById('f-luxury-high-ratio-threshold').value = '60';
  document.getElementById('f-persona').value = defaultPersona;
  document.getElementById('f-stage-collect').checked = true;
  document.getElementById('f-stage-coarse').checked = true;
  document.getElementById('f-stage-fine').checked = true;
  document.getElementById('f-stage-inquiry').checked = false;
}

function resetPersona() {
  document.getElementById('f-persona').value = defaultPersona;
}

async function loadDefaults() {
  try {
    const res = await fetch('/api/defaults');
    const data = await res.json();
    defaultPersona = data.persona || '';
    document.getElementById('f-persona').value = defaultPersona;
  } catch { /* ignore */ }
}

// ========== Utils ==========
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getTaskGroup(task) {
  if (task?.group) return task.group;
  if ((task?.name || '').includes('宝可梦')) return '宝可梦';
  return '未分组';
}

function populateTaskGroupSelect(selectedGroup = '未分组') {
  const select = document.getElementById('f-group');
  if (!select) return;
  const groups = [...new Set(tasks.map(getTaskGroup).filter(Boolean))]
    .filter(group => group !== '未分组')
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const target = selectedGroup || '未分组';
  if (target !== '未分组' && !groups.includes(target)) groups.push(target);
  select.innerHTML = ['未分组', ...groups]
    .map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
    .concat('<option value="__new_group__">＋ 新建分组…</option>')
    .join('');
  select.value = target;
}

function handleTaskGroupSelect(select) {
  if (select.value !== '__new_group__') return;
  const group = prompt('请输入新分组名称：', '');
  if (!group?.trim()) {
    select.value = '未分组';
    return;
  }
  populateTaskGroupSelect(group.trim());
}

// ========== Model Switching ==========
async function loadModel() {
  try {
    const res = await fetch('/api/model');
    const data = await res.json();
    const select = document.getElementById('model-select');
    if (data.models && data.models.length > 0) {
      select.innerHTML = data.models.map(m =>
        `<option value="${m.id}" ${m.id === data.current ? 'selected' : ''}>${m.name}</option>`
      ).join('');
    } else {
      select.innerHTML = '<option value="">未配置</option>';
    }
  } catch { /* ignore */ }
}

async function switchModel(modelId) {
  try {
    await apiPost('/api/model', { modelId });
  } catch { /* ignore */ }
}

// ========== Init ==========
connectWS();
document.addEventListener('click', closeSettingsMenu);
document.addEventListener('click', closeRerunMenus);
loadDefaults();
loadProviders().then(() => loadCurrentConfig());
loadModel();
loadTrackedProducts();
