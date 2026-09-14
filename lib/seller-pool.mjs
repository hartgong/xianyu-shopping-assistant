import { createClient } from '@libsql/client';
import { getConfig, setSellerPoolRuntime } from './config.mjs';

let client = null, initialized = false, lastError = '', syncQueue = Promise.resolve();
const stamp = p => Number(p?.sellerManualUpdatedAt || p?.checkedAt || 0) || 0;
const name = v => String(v || '').trim().toLowerCase();
const canonical = p => p.sellerId ? `id:${p.sellerId}` : p.sellerFingerprint ? `avatar:${p.sellerFingerprint}` : `name:${name(p.sellerName)}`;
function merge(a = {}, b = {}) {
  const am = Number(a.sellerManualUpdatedAt || 0), bm = Number(b.sellerManualUpdatedAt || 0);
  return { ...((am || bm) ? (am >= bm ? a : b) : (stamp(a) >= stamp(b) ? a : b)) };
}
function aliases(p, fingerprints = []) {
  return [...new Set([
    p.sellerId && `id:${p.sellerId}`,
    p.sellerName && `name:${name(p.sellerName)}`,
    p.sellerFingerprint && `avatar:${p.sellerFingerprint}`,
    ...fingerprints.map(f => `avatar:${f}`),
  ].filter(Boolean))];
}
function config() {
  const url = String(process.env.TURSO_DATABASE_URL || '').trim(), authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  return { url, authToken, enabled: Boolean(url && authToken) };
}
function db() { const c = config(); if (!c.enabled) return null; return client ||= createClient(c); }
function localSellers() {
  const c = getConfig(), result = new Map();
  for (const [key, raw] of Object.entries(c.sellerProfiles || {})) {
    const p = { ...raw, sellerManualLabel: c.sellerManualLabels?.[key] || raw.sellerManualLabel || '' };
    if (p.sellerId || p.sellerFingerprint || p.sellerName) result.set(canonical(p), merge(result.get(canonical(p)), p));
  }
  return result;
}
async function schema(d) {
  await d.execute('CREATE TABLE IF NOT EXISTS sellers (seller_key TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  await d.execute('CREATE TABLE IF NOT EXISTS seller_fingerprints (fingerprint TEXT PRIMARY KEY, seller_key TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, is_current INTEGER NOT NULL DEFAULT 1)');
}
async function remote(d) {
  const sellers = new Map();
  for (const r of (await d.execute('SELECT seller_key, profile_json FROM sellers')).rows) try { sellers.set(String(r.seller_key), JSON.parse(String(r.profile_json))); } catch {}
  const fps = new Map((await d.execute('SELECT fingerprint, seller_key FROM seller_fingerprints')).rows.map(r => [String(r.fingerprint), String(r.seller_key)]));
  return { sellers, fps };
}
function mergeRemote(remoteData, local) {
  const lookup = new Map();
  for (const [key, p] of remoteData.sellers) for (const alias of aliases(p)) lookup.set(alias, key);
  for (const [fp, key] of remoteData.fps) lookup.set(`avatar:${fp}`, key);
  for (const [localKey, p] of local) {
    const key = aliases(p).map(a => lookup.get(a)).find(Boolean) || localKey;
    remoteData.sellers.set(key, merge(remoteData.sellers.get(key), p));
    for (const alias of aliases(p)) lookup.set(alias, key);
    if (p.sellerFingerprint) remoteData.fps.set(p.sellerFingerprint, key);
  }
  return remoteData;
}
async function saveRemote(d, data) {
  const sellers = [...data.sellers].map(([key, p]) => ({ sql: 'INSERT INTO sellers (seller_key, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(seller_key) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at WHERE excluded.updated_at >= sellers.updated_at', args: [key, JSON.stringify(p), stamp(p)] }));
  const now = Date.now(), fps = [...data.fps].map(([fp, key]) => ({ sql: 'INSERT INTO seller_fingerprints (fingerprint, seller_key, first_seen_at, last_seen_at, is_current) VALUES (?, ?, ?, ?, 1) ON CONFLICT(fingerprint) DO UPDATE SET seller_key=excluded.seller_key, last_seen_at=excluded.last_seen_at, is_current=1', args: [fp, key, now, now] }));
  if (sellers.length) await d.batch(sellers, 'write'); if (fps.length) await d.batch(fps, 'write');
}
function saveLocal(data) {
  const profiles = {}, labels = {};
  for (const [key, p] of data.sellers) {
    const fps = [...data.fps].filter(([, owner]) => owner === key).map(([fp]) => fp);
    for (const alias of aliases(p, fps)) { profiles[alias] = p; if (p.sellerManualLabel) labels[alias] = p.sellerManualLabel; }
  }
  setSellerPoolRuntime(profiles, labels);
}
export function getSharedSellerPoolStatus() { return { enabled: config().enabled, connected: initialized, lastError }; }
export async function syncSharedSellerPool() {
  const d = db(); if (!d) return { enabled: false, profiles: 0 };
  try { await schema(d); const data = await remote(d); saveLocal(data); initialized = true; lastError = ''; return { enabled: true, profiles: data.sellers.size, fingerprints: data.fps.size }; }
  catch (error) { initialized = false; lastError = error.message; console.error(`⚠️ 共享卖家池同步失败，继续使用本地数据：${error.message}`); return { enabled: true, profiles: 0, error: error.message }; }
}
export function queueSharedSellerPoolSync() { syncQueue = syncQueue.then(async () => { const d = db(); if (!d) return syncSharedSellerPool(); await schema(d); const data = mergeRemote(await remote(d), localSellers()); await saveRemote(d, data); return syncSharedSellerPool(); }).catch(e => console.error(`⚠️ 共享卖家池队列失败：${e.message}`)); return syncQueue; }
