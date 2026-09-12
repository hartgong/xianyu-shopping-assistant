import { createClient } from '@libsql/client';
import { getConfig, saveConfig } from './config.mjs';

let client = null;
let initialized = false;
let lastError = '';
let syncQueue = Promise.resolve();

function settings() {
  const url = String(process.env.TURSO_DATABASE_URL || '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  return { url, authToken, enabled: Boolean(url && authToken) };
}

function db() {
  const config = settings();
  if (!config.enabled) return null;
  if (!client) client = createClient({ url: config.url, authToken: config.authToken });
  return client;
}

function modifiedAt(profile = {}) {
  return Number(profile.sellerManualUpdatedAt || profile.checkedAt || 0) || 0;
}

function localProfiles() {
  const config = getConfig();
  const labels = config.sellerManualLabels || {};
  return Object.fromEntries(Object.entries(config.sellerProfiles || {}).map(([key, profile]) => [key, {
    ...profile,
    sellerManualLabel: labels[key] || profile.sellerManualLabel || '',
  }]));
}

function mergeProfile(local = {}, remote = {}) {
  const localManual = Number(local.sellerManualUpdatedAt || 0);
  const remoteManual = Number(remote.sellerManualUpdatedAt || 0);
  if (localManual || remoteManual) return { ...(localManual >= remoteManual ? local : remote) };
  return { ...(modifiedAt(local) >= modifiedAt(remote) ? local : remote) };
}

function mergeStores(local, remote) {
  const merged = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) merged[key] = mergeProfile(local[key], remote[key]);
  return merged;
}

function labelsFromProfiles(profiles) {
  return Object.fromEntries(Object.entries(profiles)
    .filter(([, profile]) => String(profile?.sellerManualLabel || '').trim())
    .map(([key, profile]) => [key, String(profile.sellerManualLabel).trim()]));
}

async function ensureSchema(clientInstance) {
  await clientInstance.execute(`CREATE TABLE IF NOT EXISTS seller_profiles (
    seller_key TEXT PRIMARY KEY,
    profile_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

async function remoteProfiles(clientInstance) {
  const result = await clientInstance.execute('SELECT seller_key, profile_json FROM seller_profiles');
  const profiles = {};
  for (const row of result.rows) {
    try { profiles[String(row.seller_key)] = JSON.parse(String(row.profile_json)); } catch { /* 跳过损坏记录 */ }
  }
  return profiles;
}

async function saveRemoteProfiles(clientInstance, profiles) {
  const statements = Object.entries(profiles).map(([key, profile]) => ({
    sql: `INSERT INTO seller_profiles (seller_key, profile_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(seller_key) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at
      WHERE excluded.updated_at >= seller_profiles.updated_at`,
    args: [key, JSON.stringify(profile), modifiedAt(profile)],
  }));
  if (statements.length) await clientInstance.batch(statements, 'write');
}

export function getSharedSellerPoolStatus() {
  return { enabled: settings().enabled, connected: initialized, lastError };
}

export async function syncSharedSellerPool() {
  const clientInstance = db();
  if (!clientInstance) return { enabled: false, profiles: 0 };
  try {
    await ensureSchema(clientInstance);
    const merged = mergeStores(localProfiles(), await remoteProfiles(clientInstance));
    await saveRemoteProfiles(clientInstance, merged);
    saveConfig({ sellerProfiles: merged, sellerManualLabels: labelsFromProfiles(merged) });
    initialized = true;
    lastError = '';
    return { enabled: true, profiles: Object.keys(merged).length };
  } catch (error) {
    initialized = false;
    lastError = error.message;
    console.error(`⚠️ 共享卖家池同步失败，继续使用本地数据：${error.message}`);
    return { enabled: true, profiles: 0, error: error.message };
  }
}

export function queueSharedSellerPoolSync() {
  syncQueue = syncQueue.then(() => syncSharedSellerPool()).catch(error => console.error(`⚠️ 共享卖家池队列失败：${error.message}`));
  return syncQueue;
}
