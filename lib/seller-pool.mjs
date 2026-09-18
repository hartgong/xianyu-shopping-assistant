import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';
import { getConfig, setSellerPoolRuntime } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', 'data', 'seller-pool-cache.json');
const DEVICE_ID = `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'local'}:${process.env.USER || 'user'}`;
let client = null, initialized = false, lastError = '', cache = null;
const stamp = p => Number(p?.sellerManualUpdatedAt || p?.checkedAt || 0) || 0;
const name = v => String(v || '').trim().toLowerCase();
const canonical = p => p.sellerId ? `id:${p.sellerId}` : p.sellerFingerprint ? `avatar:${p.sellerFingerprint}` : `name:${name(p.sellerName)}`;
const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
function merge(a = {}, b = {}) { const am = Number(a.sellerManualUpdatedAt || 0), bm = Number(b.sellerManualUpdatedAt || 0); return { ...((am || bm) ? (am >= bm ? a : b) : (stamp(a) >= stamp(b) ? a : b)) }; }
function aliases(p, fingerprints = []) { return [...new Set([p.sellerId && `id:${p.sellerId}`, p.sellerName && `name:${name(p.sellerName)}`, p.sellerFingerprint && `avatar:${p.sellerFingerprint}`, ...fingerprints.map(f => `avatar:${f}`)].filter(Boolean))]; }
function config() { const url = String(process.env.TURSO_DATABASE_URL || '').trim(), authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim(); return { url, authToken, enabled: Boolean(url && authToken) }; }
function db() { const c = config(); return c.enabled ? (client ||= createClient(c)) : null; }
function blankCache() { return { version: 2, updatedAt: 0, sellers: {}, fingerprints: {}, pending: [], conflicts: [] }; }
function readCache() { if (cache) return cache; try { cache = { ...blankCache(), ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) }; } catch { cache = blankCache(); } return cache; }
function writeCache() { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(readCache(), null, 2), 'utf8'); }
function runtimeFromCache() {
  const data = readCache(), profiles = {}, labels = {}, fingerprintsBySeller = new Map();
  for (const [fp, key] of Object.entries(data.fingerprints || {})) { if (!fingerprintsBySeller.has(key)) fingerprintsBySeller.set(key, []); fingerprintsBySeller.get(key).push(fp); }
  for (const [key, entry] of Object.entries(data.sellers || {})) {
    const profile = { ...(entry.profile || {}), sellerPoolRevision: Number(entry.revision || 0) };
    for (const alias of aliases(profile, fingerprintsBySeller.get(key) || [])) { profiles[alias] = profile; if (profile.sellerManualLabel) labels[alias] = profile.sellerManualLabel; }
  }
  setSellerPoolRuntime(profiles, labels);
  return { profiles: Object.keys(data.sellers || {}).length, fingerprints: Object.keys(data.fingerprints || {}).length };
}
function localSellers() {
  const c = getConfig(), result = new Map();
  for (const [key, raw] of Object.entries(c.sellerProfiles || {})) {
    const p = { ...raw, sellerManualLabel: c.sellerManualLabels?.[key] || raw.sellerManualLabel || '' };
    if (p.sellerId || p.sellerFingerprint || p.sellerName) result.set(canonical(p), merge(result.get(canonical(p)), p));
  }
  return result;
}
function cacheLookup(data) { const lookup = new Map(); for (const [key, entry] of Object.entries(data.sellers || {})) for (const alias of aliases(entry.profile || {})) lookup.set(alias, key); for (const [fp, key] of Object.entries(data.fingerprints || {})) lookup.set(`avatar:${fp}`, key); return lookup; }
async function schema(d) {
  await d.execute("CREATE TABLE IF NOT EXISTS sellers (seller_key TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL DEFAULT '')");
  await d.execute('CREATE TABLE IF NOT EXISTS seller_fingerprints (fingerprint TEXT PRIMARY KEY, seller_key TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, is_current INTEGER NOT NULL DEFAULT 1)');
  await d.execute('ALTER TABLE sellers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1').catch(() => {});
  await d.execute("ALTER TABLE sellers ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''").catch(() => {});
}
async function remoteAll(d) {
  const sellers = {};
  for (const row of (await d.execute('SELECT seller_key, profile_json, revision FROM sellers')).rows) { try { sellers[String(row.seller_key)] = { profile: JSON.parse(String(row.profile_json)), revision: Number(row.revision || 1) }; } catch {} }
  const fingerprints = Object.fromEntries((await d.execute('SELECT fingerprint, seller_key FROM seller_fingerprints')).rows.map(r => [String(r.fingerprint), String(r.seller_key)]));
  return { sellers, fingerprints };
}
async function remoteSeller(d, key) { const result = await d.execute({ sql: 'SELECT profile_json, revision FROM sellers WHERE seller_key = ?', args: [key] }); const row = result.rows[0]; if (!row) return null; try { return { profile: JSON.parse(String(row.profile_json)), revision: Number(row.revision || 1) }; } catch { return null; } }
function stageRuntimeChanges() {
  const data = readCache(), lookup = cacheLookup(data), local = localSellers(); let changed = 0;
  for (const [localKey, profile] of local) {
    const key = aliases(profile).map(alias => lookup.get(alias)).find(Boolean) || localKey;
    const previous = data.sellers[key] || { profile: {}, revision: 0 }, next = merge(previous.profile, profile);
    if (same(previous.profile, next)) continue;
    const priorPending = data.pending.find(op => op.sellerKey === key);
    const manualChanged = Number(next.sellerManualUpdatedAt || 0) > Number(previous.profile?.sellerManualUpdatedAt || 0);
    data.sellers[key] = { profile: next, revision: Number(previous.revision || 0) };
    data.pending = data.pending.filter(op => op.sellerKey !== key);
    data.pending.push({ sellerKey: key, profile: next, baseRevision: priorPending?.baseRevision ?? Number(previous.revision || 0), manualChanged: priorPending?.manualChanged || manualChanged, queuedAt: Date.now() });
    for (const alias of aliases(next)) lookup.set(alias, key);
    if (next.sellerFingerprint) data.fingerprints[next.sellerFingerprint] = key;
    changed += 1;
  }
  if (changed) { data.updatedAt = Date.now(); writeCache(); runtimeFromCache(); }
  return changed;
}
function mergeAutomatic(remote, local) {
  const merged = { ...remote, ...local };
  if (remote.sellerManualUpdatedAt) Object.assign(merged, { sellerManualUpdatedAt: remote.sellerManualUpdatedAt, sellerManualLabel: remote.sellerManualLabel || '', sellerType: remote.sellerManualLabel || remote.sellerType, sellerProfileReason: remote.sellerProfileReason || merged.sellerProfileReason });
  return merged;
}
async function writeSeller(d, key, profile, expectedRevision) {
  const nextRevision = Number(expectedRevision || 0) + 1, now = Date.now();
  const result = await d.execute({ sql: 'INSERT INTO sellers (seller_key, profile_json, updated_at, revision, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(seller_key) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at, revision=excluded.revision, updated_by=excluded.updated_by WHERE sellers.revision = ?', args: [key, JSON.stringify(profile), now, nextRevision, DEVICE_ID, Number(expectedRevision || 0)] });
  return { ok: Number(result.rowsAffected || 0) > 0, revision: nextRevision };
}
async function writeFingerprints(d, data, key) {
  const now = Date.now(), items = Object.entries(data.fingerprints || {}).filter(([, owner]) => owner === key);
  if (items.length) await d.batch(items.map(([fp]) => ({ sql: 'INSERT INTO seller_fingerprints (fingerprint, seller_key, first_seen_at, last_seen_at, is_current) VALUES (?, ?, ?, ?, 1) ON CONFLICT(fingerprint) DO UPDATE SET seller_key=excluded.seller_key, last_seen_at=excluded.last_seen_at, is_current=1', args: [fp, key, now, now] })), 'write');
}

export function loadSellerPoolCache() { const result = runtimeFromCache(); initialized = true; lastError = ''; const data = readCache(); return { enabled: config().enabled, ...result, pending: data.pending.length, conflicts: data.conflicts.length, updatedAt: data.updatedAt }; }
// 兼容旧调用：它现在只加载本地高速副本，绝不会访问 Turso。
export async function syncSharedSellerPool() { return loadSellerPoolCache(); }
// 兼容旧调用：任务和人工标记只进入本机待同步队列，不会自动上传。
export function queueSharedSellerPoolSync() { const staged = stageRuntimeChanges(); return Promise.resolve({ staged, ...loadSellerPoolCache() }); }
export function getSharedSellerPoolStatus() { const data = readCache(); return { enabled: config().enabled, connected: initialized, lastError, updatedAt: data.updatedAt, pending: data.pending.length, conflicts: data.conflicts.length }; }
export function getSellerPoolConflicts() { return readCache().conflicts || []; }
export function resolveSellerPoolConflict(sellerKey, choice) {
  const data = readCache(), conflict = data.conflicts.find(item => item.sellerKey === sellerKey);
  if (!conflict) return { ok: false, error: '未找到该冲突' };
  if (choice === 'cloud') {
    if (conflict.remote) data.sellers[sellerKey] = { profile: conflict.remote, revision: Number(conflict.remoteRevision || 0) };
    data.pending = data.pending.filter(item => item.sellerKey !== sellerKey);
  } else if (choice === 'local') {
    const pending = data.pending.find(item => item.sellerKey === sellerKey);
    if (pending) pending.baseRevision = Number(conflict.remoteRevision || 0);
    else data.pending.push({ sellerKey, profile: conflict.local, baseRevision: Number(conflict.remoteRevision || 0), manualChanged: true, queuedAt: Date.now() });
  } else return { ok: false, error: '无效的冲突处理方式' };
  data.conflicts = data.conflicts.filter(item => item.sellerKey !== sellerKey); data.updatedAt = Date.now(); writeCache(); runtimeFromCache();
  return { ok: true, ...loadSellerPoolCache() };
}
export async function pullSharedSellerPool() {
  const d = db(); if (!d) return { ok: false, error: '未配置 Turso，无法从云端更新' };
  const data = readCache(); if (data.pending.length) return { ok: false, error: `本机有 ${data.pending.length} 项待同步修改，请先上传或处理冲突` };
  try { await schema(d); const remote = await remoteAll(d); cache = { ...blankCache(), ...remote, updatedAt: Date.now() }; writeCache(); initialized = true; lastError = ''; return { ok: true, ...loadSellerPoolCache() }; } catch (error) { lastError = error.message; return { ok: false, error: error.message }; }
}
export async function pushSharedSellerPool() {
  const d = db(); if (!d) return { ok: false, error: '未配置 Turso，无法上传本机修改' };
  stageRuntimeChanges(); const data = readCache(); if (!data.pending.length) return { ok: true, pushed: 0, ...loadSellerPoolCache() };
  try {
    await schema(d); let pushed = 0; const remaining = [];
    for (const op of data.pending) {
      const cloud = await remoteSeller(d, op.sellerKey), cloudRevision = Number(cloud?.revision || 0);
      if (cloudRevision !== Number(op.baseRevision || 0) && op.manualChanged) {
        data.conflicts = data.conflicts.filter(item => item.sellerKey !== op.sellerKey);
        data.conflicts.push({ sellerKey: op.sellerKey, local: op.profile, remote: cloud?.profile || null, remoteRevision: cloudRevision, detectedAt: Date.now(), reason: '人工卖家等级在另一台电脑已被修改' });
        remaining.push(op); continue;
      }
      const profile = cloud ? (op.manualChanged ? op.profile : mergeAutomatic(cloud.profile, op.profile)) : op.profile;
      const written = await writeSeller(d, op.sellerKey, profile, cloudRevision);
      if (!written.ok) { remaining.push(op); continue; }
      data.sellers[op.sellerKey] = { profile, revision: written.revision }; await writeFingerprints(d, data, op.sellerKey);
      data.conflicts = data.conflicts.filter(item => item.sellerKey !== op.sellerKey); pushed += 1;
    }
    data.pending = remaining; data.updatedAt = Date.now(); writeCache(); runtimeFromCache(); initialized = true; lastError = '';
    return { ok: true, pushed, pending: data.pending.length, conflicts: data.conflicts.length, ...loadSellerPoolCache() };
  } catch (error) { lastError = error.message; return { ok: false, error: error.message }; }
}
