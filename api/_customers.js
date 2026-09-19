// お客様データのスナップショット（離反対策リスト・離反リスト・継続率/離反率の元データ）
//
// Threease のお客様一覧 API には 初回来院日・初回担当・最終来院日・最終担当・次回予約日・来院回数・症状・紹介経路 が
// 入っている。全件読むのに三島院 約15秒・裾野院 約40秒かかるので、毎朝の cron と「Threease から読み直す」で
// 読んで Redis に保存し、管理画面はそれを返すだけにする。
// 保存するのは「最終来院が KEEP_DAYS 日以内」の人だけ（3ページ全部に十分で、サイズも 200KB 程度に収まる）。
import { readCache, writeCache } from './_store.js';
import { fetchAllPages } from './_threease.js';
import { todayJst, addDaysYmd, diffDays } from './_pro.js';

export const KEEP_DAYS = 400;
const CACHE_HOURS = 48;

const ymd = (v) => (v ? String(v).slice(0, 10) : '');

// 1 人分を最小の形に
function compact(c) {
  return {
    id: c.id,
    code: String(c.customer_code || ''),
    name: String(c.name || '').trim(),
    kana: String(c.name_kana || '').trim(),
    first: ymd(c.first_visit),
    last: ymd(c.last_visit),
    next: ymd(c.next_visit),
    count: Number(c.reservation_count) || 0,
    fs: String(c.first_visit_staff || ''),
    ls: String(c.last_visit_staff || ''),
    sym: Array.isArray(c.customer_symptoms) ? c.customer_symptoms.map(String).slice(0, 5) : [],
    ref: String(c.referral_source || ''),
    gender: String(c.gender || ''),
  };
}

export async function fetchCustomers(clinic) {
  const today = todayJst();
  const cutoff = addDaysYmd(today, -KEEP_DAYS);
  const t0 = Date.now();
  const all = await fetchAllPages(`/branches/${clinic}/customers`, {}, 'customers', { per: 100, maxPages: 120 });
  const rows = all
    .filter((c) => !c.hidden && c.last_visit && ymd(c.last_visit) >= cutoff)
    .map(compact)
    .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  return {
    clinic: String(clinic),
    today,
    keepDays: KEEP_DAYS,
    rows,
    stats: { total: all.length, kept: rows.length, seconds: Math.round((Date.now() - t0) / 100) / 10 },
    builtAt: new Date().toISOString(),
  };
}

const cacheKey = (clinic) => `recovery:customers:${clinic}`;

// { data, cached, stale }。cachedOnly=true でキャッシュが無ければ data=null
export async function getCustomers(clinic, { force = false, cachedOnly = false } = {}) {
  if (!force) {
    const cached = await readCache(cacheKey(clinic));
    if (cached) return { data: cached, cached: true, stale: cached.today !== todayJst() };
    if (cachedOnly) return { data: null, cached: false, stale: false };
  }
  const data = await fetchCustomers(clinic);
  await writeCache(cacheKey(clinic), data, CACHE_HOURS * 3600);
  return { data, cached: false, stale: false };
}

// 経過日数（画面側と同じ計算をサーバーでも使えるように）
export function elapsedDays(row, today) {
  return row.last ? diffDays(row.last, today) : null;
}
