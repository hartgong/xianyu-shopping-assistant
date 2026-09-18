import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEVICE_FILE = path.join(__dirname, '..', 'data', 'local-device.json');
let client = null;

function db() {
  const url = String(process.env.TURSO_DATABASE_URL || '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  return url && authToken ? (client ||= createClient({ url, authToken })) : null;
}
function device() {
  try { return JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8')); } catch {
    const value = { id: crypto.randomUUID(), label: os.hostname() || '本机' };
    fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true });
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(value, null, 2), 'utf8');
    return value;
  }
}
async function schema(d) {
  await d.execute("CREATE TABLE IF NOT EXISTS contact_claims (item_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_label TEXT NOT NULL, status TEXT NOT NULL, product_title TEXT NOT NULL DEFAULT '', seller_name TEXT NOT NULL DEFAULT '', claimed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
}

// 仅在真正发起询价前调用；跟踪页、任务列表和价格检查不会触发任何 Turso 请求。
export async function claimContact(product = {}) {
  const itemId = String(product.id || '').trim();
  if (!itemId) return { ok: false, error: '缺少商品 ID，无法确认联系占用' };
  const d = db();
  if (!d) return { ok: false, error: '未配置 Turso，无法确认跨电脑联系占用' };
  const owner = device(), now = Date.now();
  await schema(d);
  const result = await d.execute({
    sql: "INSERT INTO contact_claims (item_id, owner_id, owner_label, status, product_title, seller_name, claimed_at, updated_at) VALUES (?, ?, ?, 'chatting', ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET status='chatting', product_title=excluded.product_title, seller_name=excluded.seller_name, updated_at=excluded.updated_at WHERE contact_claims.owner_id=excluded.owner_id OR contact_claims.status IN ('released', 'closed')",
    args: [itemId, owner.id, owner.label, String(product.title || ''), String(product.sellerName || ''), now, now],
  });
  if (Number(result.rowsAffected || 0) > 0) return { ok: true, owner: owner.label };
  const row = (await d.execute({ sql: 'SELECT owner_label, status, updated_at FROM contact_claims WHERE item_id = ?', args: [itemId] })).rows[0];
  return { ok: false, blocked: true, error: `商品已由「${row?.owner_label || '另一台电脑'}」占用（${row?.status || '联系中'}），为避免重复出价已阻止询价。` };
}

export async function releaseContact(productId) {
  const d = db(); if (!d) return { ok: false, error: '未配置 Turso' };
  const owner = device(); await schema(d);
  const result = await d.execute({ sql: "UPDATE contact_claims SET status='released', updated_at=? WHERE item_id=? AND owner_id=?", args: [Date.now(), String(productId), owner.id] });
  return { ok: Number(result.rowsAffected || 0) > 0 };
}
