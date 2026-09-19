// Threease Pro から「院のスタッフ・コース対応表・シフト・予約」を取り、空き計算できる形にして返す。
//
// キャッシュの方針（stale-while-revalidate）:
//   - 院の基本情報（スタッフ・コース→product 対応・ユニット数）は 1 時間
//   - シフト＋予約は「本日から 7 日ごとのブロック」単位で 60 秒。期限切れでも前回分があれば
//     即返して裏で取り直す。取得失敗時は前回分を stale として返す（60 秒は再試行しない）
import { readCache, writeCache, acquireLock, releaseLock } from './_store.js';
import { apiGet, fetchAllPages } from './_threease.js';
import { normalizeReservation, normalizeShift } from './_slots.js';
import { recordUpstreamCall } from './_cache-stats.js';

export const CLINIC_IDS = new Set(['192', '193']);
const META_SECONDS = 60 * 60;
const BLOCK_SECONDS = 60;
const FAIL_SECONDS = 60;
export const BLOCK_DAYS = 7;
export const MAX_BLOCK = 8; // 約2か月先まで

export function todayJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function diffDays(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}
// 日付 → ブロック番号（本日から 7 日ごと。過去日は -1）
export function blockIndexFor(ymd) {
  const d = diffDays(todayJst(), ymd);
  if (d < 0) return -1;
  return Math.floor(d / BLOCK_DAYS);
}
export function blockRange(k) {
  const start = addDaysYmd(todayJst(), k * BLOCK_DAYS);
  return { start, end: addDaysYmd(start, BLOCK_DAYS - 1), key: `${start}~${addDaysYmd(start, BLOCK_DAYS - 1)}` };
}

// 応答を返した後も処理を続ける（Vercel では waitUntil、ローカルではそのまま走らせる）
async function runInBackground(promise) {
  const p = promise.catch((e) => console.error('background refresh failed:', e && e.message));
  try {
    const mod = await import('@vercel/functions');
    mod.waitUntil(p);
  } catch { /* Vercel 外 */ }
}

async function timed(kind, fn) {
  const t0 = Date.now();
  try {
    const v = await fn();
    recordUpstreamCall(kind, 'ok', Date.now() - t0);
    return v;
  } catch (e) {
    recordUpstreamCall(kind, 'fail', Date.now() - t0);
    throw e;
  }
}

// ---- 院の基本情報 ----
//   staff: 施術スタッフ（在籍中・field_therapist）と担当できる product_id
//   items: 公開APIのコースID（= item id）→ { productId, minutes, name }
//   unitCount: 稼働中のユニット数
async function fetchBranchMeta(clinic) {
  const [staffRes, itemsRes, unitsRes] = await Promise.all([
    apiGet(`/branches/${clinic}/staff`, { per: 100 }),
    apiGet(`/branches/${clinic}/items`, { per: 200 }),
    apiGet(`/branches/${clinic}/units`, { per: 100 }),
  ]);
  const therapists = (staffRes.staff || []).filter((s) => s.field_therapist && s.employment_status === 'active');
  const staff = await Promise.all(therapists.map(async (s) => {
    let products = null;
    if (s.product_option !== 'all') {
      const pr = await apiGet(`/staff/${s.id}/products`, { per: 300 });
      products = (pr.products || []).map((p) => Number(p.id));
    }
    return { id: Number(s.id), name: String(s.name || ''), products };
  }));
  const items = {};
  for (const it of itemsRes.items || []) {
    if (it.unit !== 'minutes') continue;
    items[String(it.id)] = { productId: Number(it.product_id), minutes: Number(it.quantity) || 0, name: String(it.product_name || it.display_name || '') };
  }
  const unitCount = (unitsRes.units || []).filter((u) => !u.hidden && u.status === 'working').length;
  return { staff, items, unitCount, fetchedAt: new Date().toISOString() };
}

export async function getBranchMeta(clinic, { force = false } = {}) {
  const key = `reserve:pro_meta:${clinic}`;
  if (!force) {
    const cached = await readCache(key);
    if (cached) return cached;
  }
  const meta = await timed('meta', () => fetchBranchMeta(clinic));
  await writeCache(key, meta, META_SECONDS);
  return meta;
}

// ---- シフト＋予約（7日ブロック） ----
async function fetchBlock(clinic, range) {
  const [assignments, reservations] = await Promise.all([
    fetchAllPages(`/branches/${clinic}/shift_assignments`, { start_date: range.start, end_date: range.end }, 'shift_assignments', { per: 200, maxPages: 5 }),
    fetchAllPages(`/branches/${clinic}/reservations`, { start_date: range.start, end_date: range.end }, 'reservations', { per: 100, maxPages: 30 }),
  ]);
  return {
    shifts: assignments.map(normalizeShift).filter(Boolean),
    reservations: reservations.map(normalizeReservation).filter(Boolean),
    range: range.key,
    fetchedAt: new Date().toISOString(),
  };
}

const blockKeys = (clinic, rangeKey) => ({
  cache: `reserve:pro_block:${clinic}:${rangeKey}`,
  last: `reserve:pro_last:${clinic}:${rangeKey}`,
  lock: `reserve:pro_lock:${clinic}:${rangeKey}`,
  fail: `reserve:pro_fail:${clinic}:${rangeKey}`,
});

async function refreshBlock(clinic, range, k) {
  try {
    const entry = await timed('courses', () => fetchBlock(clinic, range));
    await writeCache(k.cache, entry, BLOCK_SECONDS);
    await writeCache(k.last, entry);
    return entry;
  } catch (err) {
    await writeCache(k.fail, { at: new Date().toISOString(), error: err.message }, FAIL_SECONDS);
    throw err;
  }
}

/**
 * ブロック k（本日から 7k 日目〜）のシフト・予約
 * @returns {{ shifts, reservations, fetchedAt, stale, refreshing, error }}
 */
export async function getBlock(clinic, kIndex, { force = false } = {}) {
  const range = blockRange(kIndex);
  const k = blockKeys(clinic, range.key);

  if (force) {
    const entry = await refreshBlock(clinic, range, k);
    return { ...entry, stale: false, refreshing: false, error: '' };
  }

  const cached = await readCache(k.cache);
  if (cached) {
    recordUpstreamCall('courses', 'cache_hit', 0);
    return { ...cached, stale: false, refreshing: false, error: '' };
  }

  const last = await readCache(k.last);
  const fail = await readCache(k.fail);
  if (fail && last) {
    recordUpstreamCall('courses', 'stale', 0);
    return { ...last, stale: true, refreshing: false, error: fail.error || '' };
  }

  if (last) {
    if (await acquireLock(k.lock)) {
      runInBackground(refreshBlock(clinic, range, k).finally(() => releaseLock(k.lock)));
    }
    return { ...last, stale: false, refreshing: true, error: '' };
  }

  const entry = await refreshBlock(clinic, range, k);
  return { ...entry, stale: false, refreshing: false, error: '' };
}
