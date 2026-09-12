import '../lib/env.mjs';
import { getSharedSellerPoolStatus, syncSharedSellerPool } from '../lib/seller-pool.mjs';

if (!getSharedSellerPoolStatus().enabled) {
  console.error('缺少 TURSO_DATABASE_URL 或 TURSO_AUTH_TOKEN，请先在 .env 中配置。');
  process.exit(1);
}
const result = await syncSharedSellerPool();
if (result.error) process.exit(1);
console.log(`✅ 已同步 ${result.profiles} 条卖家档案到共享卖家池。`);
