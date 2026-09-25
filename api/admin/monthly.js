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
  let visits = 0;
  for (const r of list) {
    if (!r.customer_id || r.reservation_type === 'temporary' || NOT_VISITED.has(String(r.status || ''))) continue;
    const date = String(r.start_time || '').slice(0, 10);
    if (date > today) continue;
    visits++;
    perCustomer.set(r.customer_id, (perCustomer.get(r.customer_id) || 0) + 1);
  }
  const dist = { 1: 0, 2: 0, 3: 0, '4+': 0 };
  for (const n of perCustomer.values()) dist[n >= 4 ? '4+' : n]++;
  return {
    month, start, end: until,
    visits,
    visitors: perCustomer.size,
    visitorIds: [...perCustomer.keys()],
    perCustomer: dist,
    complete: end < today,
    builtAt: new Date().toISOString(),
  };
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

  const key = `recovery:monthly:${clinic}:${month}`;
  try {
    if (req.query.force !== '1') {
      const cached = await readCache(key);
      if (cached) return res.status(200).json({ ...cached, cached: true });
    }
    const data = await buildMonth(clinic, month);
    await writeCache(key, data, data.complete ? undefined : 12 * 3600);
    return res.status(200).json({ ...data, cached: false });
  } catch (err) {
    console.error('monthly failed:', err && err.message);
    return res.status(502).json({ error: 'threease error', message: (err && err.message) || String(err) });
  }
}
