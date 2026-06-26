// ========== State ==========
let ws = null;
let tasks = [];
let activeTaskId = null;
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
const PRODUCT_PAGE_SIZE = 50;

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
        currentConfig = data.config;
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

function hideBlacklistModal() {
  document.getElementById('blacklist-modal-overlay').classList.remove('show');
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
    if (data.config) currentConfig = data.config;
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
    currentConfig = await res.json();
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
  if (data.config) currentConfig = data.config;
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

async function createTask() {
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

    await apiPost('/api/tasks', body);

    hideCreateModal();
    clearForm();
  } catch { /* alert already shown */ }
}

function readTaskForm() {
  const name = document.getElementById('f-name').value.trim();
  const queriesRaw = document.getElementById('f-queries').value.trim();
  const priceMin = document.getElementById('f-price-min').value;
  const priceMax = document.getElementById('f-price-max').value;
  const wantMax = document.getElementById('f-want-max').value;
  const maxPages = document.getElementById('f-pages').value;
  const queries = queriesRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const wantMaxNumber = wantMax === '' ? null : Number(wantMax);

  if (wantMaxNumber !== null && (!Number.isFinite(wantMaxNumber) || wantMaxNumber < 0)) {
    alert('想要不低于不能填负数');
    return null;
  }

  return {
    name: name || queries[0],
    queries,
    priceMin: priceMin ? Number(priceMin) : null,
    priceMax: priceMax ? Number(priceMax) : null,
    maxPages: maxPages ? Number(maxPages) : 3,
    region: document.getElementById('f-region').value.trim(),
    personalSeller: document.getElementById('f-personal').checked,
    requireFreeShipping: document.getElementById('f-free-shipping').checked,
    wantMax: wantMaxNumber > 0 ? wantMaxNumber : null,
    titleExclude: document.getElementById('f-title-exclude').value.trim(),
    enableCoarseSemantic: document.getElementById('f-coarse-semantic').checked,
    customRequirements: document.getElementById('f-requirements').value.trim(),
    chatStrategy: document.getElementById('f-chat-strategy').value.trim(),
    persona: document.getElementById('f-persona').value.trim() || '',
    coarsePrompt: document.getElementById('f-coarse-prompt').value.trim() || '',
    finePrompt: document.getElementById('f-fine-prompt').value.trim() || '',
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
  document.getElementById('f-queries').value = (c.queries || []).join(', ');
  document.getElementById('f-price-min').value = c.priceMin ?? '';
  document.getElementById('f-price-max').value = c.priceMax ?? '';
  document.getElementById('f-pages').value = c.maxPages || 3;
  document.getElementById('f-region').value = c.region || '';
  document.getElementById('f-personal').checked = !!c.personalSeller;
  document.getElementById('f-free-shipping').checked = !!c.requireFreeShipping;
  document.getElementById('f-want-max').value = c.wantMax ?? '';
  document.getElementById('f-title-exclude').value = c.titleExclude || '';
  document.getElementById('f-coarse-semantic').checked = !!c.enableCoarseSemantic;
  document.getElementById('f-requirements').value = c.customRequirements || '';
  document.getElementById('f-chat-strategy').value = c.chatStrategy || '';
  document.getElementById('f-persona').value = c.persona || defaultPersona;
  document.getElementById('f-coarse-prompt').value = c.coarsePrompt || defaultCoarsePrompt;
  document.getElementById('f-fine-prompt').value = c.finePrompt || defaultFinePrompt;
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
  container.innerHTML = tasks.map(t => `
    <div class="task-card ${t.id === activeTaskId ? 'active' : ''}" onclick="selectTask('${t.id}')">
      <div class="task-card-name">${escapeHtml(t.name)}</div>
      <div class="task-card-meta">
        <span class="stage-badge stage-${t.stage}">${STAGE_LABELS[t.stage] || t.stage}</span>
        <span style="font-size:11px;color:var(--text2)">
          ${t.products ? `${t.products.rawCount || 0}件` : ''}
        </span>
      </div>
    </div>
  `).join('');
}

function selectTask(id) {
  activeTaskId = id;
  productFilter = 'fine';
  productPage = 1;
  productSort = { key: '', dir: 'asc' };
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
      <div class="stat-value" style="color:var(--green)">${task.products.fineCount || 0}</div><div class="stat-label">细筛通过</div>
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

    return `<tr>
      <td class="select-col">
        ${fineIds.has(p.id)
          ? `<input class="review-checkbox" type="checkbox" value="${escapeHtml(p.id)}" onchange="toggleReviewProductSelection('${escapeHtml(p.id)}', this.checked)" ${checked} ${selectable ? '' : 'disabled'}>`
          : ''}
      </td>
      <td>${p.image ? `<img class="product-img" src="${escapeHtml(p.image)}" loading="lazy" onclick="showImagePreview('${escapeHtml(p.image)}')">` : '-'}</td>
      <td class="product-title" title="${escapeHtml(p.title)}">${renderProductTitle(p)}</td>
      <td class="product-price">${escapeHtml(p.price || '')}</td>
      <td>${renderShipping(p.shipping)}</td>
      <td class="metric-cell">${formatCount(p.wantCount, p.wantText)}</td>
      <td class="metric-cell">${formatCount(p.viewCount, p.viewText)}</td>
      <td class="updated-cell">${escapeHtml(formatSellerLastSeen(p.sellerLastSeen || p.updatedAt))}</td>
      <td>${escapeHtml(p.sellerName || '')}</td>
      <td>${escapeHtml(p.sellerLocation || '')}</td>
      <td>${chatIds.has(p.id)
        ? `<button class="badge badge-button ${badgeCls}" onclick="showProductChatModal('${escapeHtml(p.id)}')">${badge}</button>`
        : `<span class="badge ${badgeCls}">${badge}</span>`}
      </td>
    </tr>`;
  }).join('');

  renderProductPagination(all.length, totalPages, pageStart, pageItems.length);
}

function renderProductTitle(product) {
  const title = escapeHtml(product.title || '');
  if (!product.href) return title;
  return `<button class="title-link" data-href="${escapeHtml(product.href)}" onclick="openProductPage(this.dataset.href)" title="用本机默认浏览器打开商品页">${title}</button>`;
}

async function openProductPage(url) {
  if (!url) {
    alert('这个商品没有可打开的链接');
    return;
  }
  try {
    const res = await fetch('/api/open-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      alert(data.error || '打开失败，请重启服务后再试');
    }
  } catch (err) {
    alert(`打开失败，请确认服务已重启: ${err.message}`);
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
  return String(value || '').replace(/\s+/g, ' ').trim() || '-';
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
  if (!productSort.key) return products;

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
  ['price', 'want', 'view', 'updated', 'seller', 'location', 'stage'].forEach(key => {
    const el = document.getElementById(`sort-${key}`);
    if (!el) return;
    const label = { price: '价格', want: '想要', view: '浏览', updated: '来过', seller: '卖家', location: '地区', stage: '阶段' }[key];
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
}

// ========== Modal ==========
function openNewTaskModal() {
  editingTaskId = null;
  clearForm();
  showCreateModal();
}

function showCreateModal() {
  const isEditing = !!editingTaskId;
  const title = document.getElementById('task-modal-title');
  const submit = document.getElementById('task-modal-submit');
  if (title) title.textContent = isEditing ? '编辑任务' : '新建采购任务';
  if (submit) submit.textContent = isEditing ? '保存修改' : '创建并启动';
  document.getElementById('modal-overlay').classList.add('show');
}

function hideCreateModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  editingTaskId = null;
}

function clearForm() {
  ['f-name', 'f-queries', 'f-price-min', 'f-price-max', 'f-region', 'f-want-max', 'f-title-exclude', 'f-requirements', 'f-chat-strategy'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-pages').value = '3';
  document.getElementById('f-personal').checked = false;
  document.getElementById('f-free-shipping').checked = false;
  document.getElementById('f-coarse-semantic').checked = false;
  document.getElementById('f-persona').value = defaultPersona;
  document.getElementById('f-coarse-prompt').value = defaultCoarsePrompt;
  document.getElementById('f-fine-prompt').value = defaultFinePrompt;
}

function resetPersona() {
  document.getElementById('f-persona').value = defaultPersona;
}

function resetCoarsePrompt() {
  document.getElementById('f-coarse-prompt').value = defaultCoarsePrompt;
}

function resetFinePrompt() {
  document.getElementById('f-fine-prompt').value = defaultFinePrompt;
}

async function loadDefaults() {
  try {
    const res = await fetch('/api/defaults');
    const data = await res.json();
    defaultPersona = data.persona || '';
    defaultCoarsePrompt = data.coarsePrompt || '';
    defaultFinePrompt = data.finePrompt || '';
    document.getElementById('f-persona').value = defaultPersona;
    document.getElementById('f-coarse-prompt').value = defaultCoarsePrompt;
    document.getElementById('f-fine-prompt').value = defaultFinePrompt;
  } catch { /* ignore */ }
}

// ========== Utils ==========
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
