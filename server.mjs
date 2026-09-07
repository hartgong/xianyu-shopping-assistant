import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskManager } from './lib/task.mjs';
import {
  addTrackedProduct,
  checkAllTrackedProducts,
  checkTrackedProduct,
  deleteTrackedProduct,
  listTrackedProducts,
  updateTrackedProduct,
} from './lib/tracker.mjs';
import {
  DEFAULT_PERSONA, DEFAULT_COARSE_PROMPT, DEFAULT_FINE_PROMPT,
  getCurrentModel, setCurrentModel, getAvailableModels,
} from './lib/ai.mjs';
import {
  PROVIDERS, getConfig, saveConfig, getSafeConfig, isConfigured,
} from './lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.send(JSON.stringify({
    event: 'connected',
    data: {
      tasks: taskManager.getAllTasks(),
      configured: isConfigured(),
    },
  }));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

const taskManager = new TaskManager(broadcast);

// ========== Config API ==========
app.get('/api/providers', (req, res) => {
  res.json(PROVIDERS);
});

app.get('/api/config', (req, res) => {
  res.json(getSafeConfig());
});

app.post('/api/config', (req, res) => {
  const { provider, apiKey, baseUrl, model, customModels, sellerBlacklist, sellerManualLabels } = req.body;
  const update = {};
  if (provider !== undefined) update.provider = provider;
  if (apiKey !== undefined) update.apiKey = apiKey;
  if (baseUrl !== undefined) update.baseUrl = baseUrl;
  if (model !== undefined) update.model = model;
  if (customModels !== undefined) update.customModels = customModels;
  if (sellerBlacklist !== undefined) update.sellerBlacklist = sellerBlacklist;
  if (sellerManualLabels !== undefined) update.sellerManualLabels = sellerManualLabels;

  saveConfig(update);
  broadcast({
    event: 'config:changed',
    data: { configured: isConfigured(), config: getSafeConfig() },
  });
  res.json({ ok: true, config: getSafeConfig() });
});

app.post('/api/config/test', async (req, res) => {
  try {
    const cfg = getConfig();
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      return res.json({ ok: false, error: '请先完整填写 API 密钥、服务地址和模型' });
    }

    const testRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '请回复"OK"' }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!testRes.ok) {
      const errText = await testRes.text();
      return res.json({ ok: false, error: `API 返回 ${testRes.status}: ${errText.slice(0, 200)}` });
    }

    const data = await testRes.json();
    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ ok: true, reply: reply.slice(0, 100), model: data.model || cfg.model });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ========== Task API ==========
app.get('/api/tasks', (req, res) => {
  res.json(taskManager.getAllTasks());
});

app.get('/api/tasks/:id', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

app.post('/api/tasks', (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ error: '请先在设置中配置 AI API' });
  }
  const task = taskManager.createTask(req.body);
  taskManager.startTask(task.id);
  res.json(task);
});

app.post('/api/tasks/:id/start', (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ error: '请先在设置中配置 AI API' });
  }
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const updates = {};
  if (req.body.chatStrategy !== undefined) updates.chatStrategy = req.body.chatStrategy;
  if (req.body.persona !== undefined) updates.persona = req.body.persona;
  taskManager.startTask(req.params.id, updates);
  res.json({ ok: true });
});

app.put('/api/tasks/:id', (req, res) => {
  const result = taskManager.updateTask(req.params.id, req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.post('/api/tasks/:id/chat', async (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ error: '请先在设置中配置 AI API' });
  }
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const updates = {};
  if (req.body.chatStrategy !== undefined) updates.chatStrategy = req.body.chatStrategy;
  if (req.body.persona !== undefined) updates.persona = req.body.persona;

  const result = await taskManager.startChat(req.params.id, req.body.productIds || [], updates);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  taskManager.stopTask(req.params.id);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/rerun', (req, res) => {
  const result = taskManager.rerunStage(req.params.id, req.body.stage);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/duplicate', (req, res) => {
  const newTask = taskManager.duplicateTask(req.params.id);
  if (!newTask) return res.status(404).json({ error: 'Source task not found' });
  res.json(newTask);
});

app.delete('/api/tasks/:id', (req, res) => {
  taskManager.deleteTask(req.params.id);
  res.json({ ok: true });
});

function clientErrorMessage(err) {
  const message = String(err?.message || err || '');
  if (/launchPersistentContext|Target page, context or browser has been closed/i.test(message)) {
    return '浏览器启动失败。请先关闭残留的自动化 Chromium 窗口，或重启本服务后再检查。';
  }
  return message.split('\n')[0] || '操作失败';
}

// ========== Price Tracker API ==========
app.get('/api/tracked-products', (req, res) => {
  res.json(listTrackedProducts());
});

app.post('/api/tracked-products', (req, res) => {
  try {
    const item = addTrackedProduct(req.body.url, req.body.note || '', req.body.title || '');
    res.json({ ok: true, item, items: listTrackedProducts() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tracked-products/check-all', async (req, res) => {
  try {
    const results = await checkAllTrackedProducts();
    res.json({ ok: true, results, items: listTrackedProducts() });
  } catch (err) {
    res.status(500).json({ error: clientErrorMessage(err) });
  }
});

app.post('/api/tracked-products/:id/check', async (req, res) => {
  try {
    const item = await checkTrackedProduct(req.params.id);
    res.json({ ok: true, item, items: listTrackedProducts() });
  } catch (err) {
    res.status(500).json({ error: clientErrorMessage(err) });
  }
});

app.patch('/api/tracked-products/:id', (req, res) => {
  try {
    const item = updateTrackedProduct(req.params.id, req.body || {});
    res.json({ ok: true, item, items: listTrackedProducts() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tracked-products/:id', (req, res) => {
  deleteTrackedProduct(req.params.id);
  res.json({ ok: true, items: listTrackedProducts() });
});

app.get('/api/default-persona', (req, res) => {
  res.json({ persona: DEFAULT_PERSONA });
});

app.get('/api/defaults', (req, res) => {
  res.json({
    persona: DEFAULT_PERSONA,
    coarsePrompt: DEFAULT_COARSE_PROMPT,
    finePrompt: DEFAULT_FINE_PROMPT,
  });
});

app.get('/api/model', (req, res) => {
  res.json({ current: getCurrentModel(), models: getAvailableModels() });
});

app.post('/api/model', (req, res) => {
  const { modelId } = req.body;
  const ok = setCurrentModel(modelId);
  if (!ok) return res.status(400).json({ error: '不支持的模型' });
  broadcast({ event: 'model:changed', data: { current: getCurrentModel(), models: getAvailableModels() } });
  res.json({ ok: true, current: getCurrentModel() });
});

server.listen(PORT, () => {
  const configured = isConfigured();
  console.log(`🚀 闲鱼智能助手已启动: http://localhost:${PORT}`);
  if (!configured) {
    console.log(`⚠️  AI 尚未配置，请打开浏览器进入设置页面配置 API 密钥`);
  }
});
