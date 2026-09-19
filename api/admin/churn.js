// 管理画面: 離反リスト（最終来院 60〜120 日・次回予約なし）
//   GET /api/admin/churn?clinic=192            キャッシュがあればそれ、無ければ Threease から作る（数十秒）
//   GET /api/admin/churn?clinic=192&cached=1   キャッシュだけ返す（無ければ data:null。ホーム画面用）
//   GET /api/admin/churn?clinic=192&force=1    Threease から作り直す
import { checkAuth } from '../_admin-helpers.js';
import { CLINIC_IDS } from '../_pro.js';
import { getChurn } from '../_churn.js';

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.setHeader('Cache-Control', 'no-store');

  const clinic = String(req.query.clinic || '');
  if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
  const force = req.query.force === '1';
  const cachedOnly = req.query.cached === '1';

  try {
    const r = await getChurn(clinic, { force, cachedOnly });
    return res.status(200).json({ clinic, ...r });
  } catch (err) {
    console.error('churn failed:', err && err.message);
    return res.status(502).json({ error: 'threease error', message: (err && err.message) || String(err) });
  }
}
