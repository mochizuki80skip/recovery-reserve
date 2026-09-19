// 共通のキャッシュ層。Upstash Redis があればそれを、無ければメモリ（ローカル確認用）を使う。
import { Redis } from '@upstash/redis';

// 環境変数の値から前後の空白・引用符を取り除く
export function cleanEnv(v) {
  return String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

let _redis = null;
export function getRedis() {
  if (_redis !== null) return _redis || null;
  const url = cleanEnv(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
  const token = cleanEnv(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!url || !token) { _redis = false; return null; }
  try { _redis = new Redis({ url, token }); } catch { _redis = false; }
  return _redis || null;
}

// ローカルの dev-server がモジュールを読み直しても残るよう globalThis に置く
const mem = (globalThis.__reserveMem ||= new Map());

export async function readCache(key) {
  const redis = getRedis();
  if (redis) {
    try { const v = await redis.get(key); return v && typeof v === 'object' ? v : null; } catch { return null; }
  }
  const v = mem.get(key);
  if (v && v._expires && v._expires < Date.now()) { mem.delete(key); return null; }
  return v ? v.value : null;
}

export async function writeCache(key, value, ttlSec) {
  const redis = getRedis();
  if (redis) {
    try { await redis.set(key, value, ttlSec ? { ex: ttlSec } : undefined); } catch { /* best effort */ }
    return;
  }
  mem.set(key, { value, _expires: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}

export async function deleteCache(key) {
  const redis = getRedis();
  if (redis) { try { await redis.del(key); } catch { /* ignore */ } return; }
  mem.delete(key);
}

// 同時に何人も開いた時に Threease へ何度も取りに行かないための簡易ロック
export async function acquireLock(key, sec = 30) {
  const redis = getRedis();
  if (redis) {
    try { return (await redis.set(key, '1', { nx: true, ex: sec })) === 'OK'; } catch { return true; }
  }
  const v = mem.get(key);
  if (v && v._expires > Date.now()) return false;
  mem.set(key, { value: 1, _expires: Date.now() + sec * 1000 });
  return true;
}
export async function releaseLock(key) { await deleteCache(key); }
