// 管理画面: お客様スナップショット（離反対策リスト・離反リスト・継続率/離反率はこのデータから画面側で計算する）
//   GET /api/admin/customers?clinic=192            保存済みがあればそれ（日付が変わっていても返す。stale:true）、無ければ Threease から作る（15〜40秒）
//   GET /api/admin/customers?clinic=192&cached=1   保存済みだけ（無ければ data:null。ホーム画面用）
//   GET /api/admin/customers?clinic=192&force=1    Threease から作り直す
import { checkAuth } from '../_admin-helpers.js';
import { CLINIC_IDS } from '../_pro.js';
import { getCustomers } from '../_customers.js';

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.setHeader('Cache-Control', 'no-store');

  const clinic = String(req.query.clinic || '');
  if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });

  try {
    const r = await getCustomers(clinic, { force: req.query.force === '1', cachedOnly: req.query.cached === '1' });
    return res.status(200).json({ clinic, ...r });
  } catch (err) {
    console.error('customers failed:', err && err.message);
    return res.status(502).json({ error: 'threease error', message: (err && err.message) || String(err) });
  }
}
