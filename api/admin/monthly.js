// 管理画面: 月ごとの来院データ（月次の数字ページ用）
//   GET /api/admin/monthly?clinic=192&month=2026-08
//   → { month, visits, visitors, visitorIds:[…], perCustomer:{ '1':n, '2':n, '3':n, '4+':n }, builtAt }
//   その月の有効な予約（取消・仮予約を除く、今日までの分）から、来院回数と来院した人を数える。
//   終わった月は Redis に無期限で保存（変わらないため）、今月は 12 時間。
import { checkAuth } from '../_admin-helpers.js';
import { CLINIC_IDS, todayJst } from '../_pro.js';
import { fetchAllPages } from '../_threease.js';
import { readCache, writeCache } from '../_store.js';

const NOT_VISITED = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'absent']);

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const endDate = new Date(Date.UTC(y, m, 0)); // 翌月0日 = 月末
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

async function buildMonth(clinic, month) {
  const today = todayJst();
  const { start, end } = monthRange(month);
  const until = end < today ? end : today;
  const list = await fetchAllPages(`/branches/${clinic}/reservations`, { start_date: start, end_date: until }, 'reservations', { per: 100, maxPages: 40 });
  const perCustomer = new Map();
  const slots = {}; // customerId → ['曜日(0=日)-時', …]（いつも通う時間帯の集計用）
  const firsts = {}; // customerId → { d, menu, price, total }（初診メニューの予約。ワンコインは施術料で判定）
  let visits = 0;
  for (const r of list) {
    if (!r.customer_id || r.reservation_type === 'temporary' || NOT_VISITED.has(String(r.status || ''))) continue;
    const st = String(r.start_time || '');
    const date = st.slice(0, 10);
    if (date > today) continue;
    visits++;
    perCustomer.set(r.customer_id, (perCustomer.get(r.customer_id) || 0) + 1);
    const wdJst = new Date(`${date}T00:00:00Z`).getUTCDay(); // 日付文字列の曜日（0=日）
    const hour = Number(st.slice(11, 13));                     // start_time は +09:00 表記なので時はそのまま JST
    (slots[r.customer_id] ||= []).push(`${wdJst}-${hour}`);
    // 初診メニュー（初診：〜／初回／ワンコイン／体験）が入っている予約 → その人の初回メニューと料金
    const fi = (r.reservation_items || []).find((i) => /初診|初回|ワンコイン|体験/.test(String(i.product_name || '')));
    if (fi && !firsts[r.customer_id]) {
      const price = Math.max(0, (Number(fi.price) || 0) - (Number(fi.discount) || 0)); // 施術料（割引後）
      let menu = String(fi.product_name || '').replace(/^初診[：:]\s*/, '').replace(/施術$/, '').trim();
      if (price <= 1000) menu = 'ワンコイン';
      firsts[r.customer_id] = { d: date, menu, price, total: Number(r.total_price) || 0 };
    }
  }
  const dist = { 1: 0, 2: 0, 3: 0, '4+': 0 };
  for (const n of perCustomer.values()) dist[n >= 4 ? '4+' : n]++;
  return {
    month, start, end: until,
    visits,
    visitors: perCustomer.size,
    visitorIds: [...perCustomer.keys()],
    perCustomer: dist,
    slots,
    firsts,
    complete: end < today,
    builtAt: new Date().toISOString(),
  };
}

// 月次データを取得（保存済みがあればそれ。終わった月は無期限、今月は 12 時間）
export async function getMonthly(clinic, month, { force = false } = {}) {
  const key = `recovery:monthly3:${clinic}:${month}`; // v3: slots（時間帯）と firsts（初回メニュー）を含む
  if (!force) {
    const cached = await readCache(key);
    if (cached) return { ...cached, cached: true };
  }
  const data = await buildMonth(clinic, month);
  await writeCache(key, data, data.complete ? undefined : 12 * 3600);
  return { ...data, cached: false };
}

// 今月から過去 n か月（新しい順、'YYYY-MM'）
export function recentMonths(n) {
  const [y, mo] = todayJst().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, mo - 1 - i, 1)).toISOString().slice(0, 7));
}

// 毎朝の cron 用: 今月は作り直し、過去 13 か月で未保存の月があれば作る（保存済みは何もしない）
export async function warmMonthly(clinic, { months = 14 } = {}) {
  const out = {};
  const list = recentMonths(months);
  for (const month of list) {
    const cur = month === list[0];
    try {
      const r = await getMonthly(clinic, month, { force: cur });
      out[month] = r.cached ? 'cached' : 'built';
    } catch (e) { out[month] = 'error: ' + ((e && e.message) || e); }
  }
  return out;
}

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.setHeader('Cache-Control', 'no-store');
  const clinic = String(req.query.clinic || '');
  const month = String(req.query.month || '');
  if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'invalid month' });
  if (month > todayJst().slice(0, 7)) return res.status(400).json({ error: 'future month' });
  try {
    return res.status(200).json(await getMonthly(clinic, month, { force: req.query.force === '1' }));
  } catch (err) {
    console.error('monthly failed:', err && err.message);
    return res.status(502).json({ error: 'threease error', message: (err && err.message) || String(err) });
  }
}
