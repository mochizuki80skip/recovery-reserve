// 毎朝のお客様スナップショット作成（Vercel Cron）。院ごとに Threease から全件読んで Redis に置く
// → 管理画面（離反対策リスト・離反リスト・継続率/離反率・ホーム）は保存済みを返すだけ。
//   vercel.json の crons から呼ばれる。CRON_SECRET を設定していれば Authorization: Bearer <CRON_SECRET> を確認する。
//   手動: GET /api/cron-churn?clinic=193（管理パスワードでも可: x-admin-password）
import { cleanEnv } from './_store.js';
import { CLINIC_IDS } from './_pro.js';
import { getCustomers } from './_customers.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = cleanEnv(process.env.CRON_SECRET);
  const adminPw = cleanEnv(process.env.ADMIN_PASSWORD);
  const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const byAdmin = adminPw && req.headers?.['x-admin-password'] === adminPw;
  if (!byAdmin && (!secret || bearer !== secret)) return res.status(401).json({ error: 'unauthorized' });

  const only = String(req.query?.clinic || '');
  const clinics = CLINIC_IDS.has(only) ? [only] : [...CLINIC_IDS];
  const result = {};
  for (const clinic of clinics) {
    try {
      const { data } = await getCustomers(clinic, { force: true });
      result[clinic] = data.stats;
    } catch (err) {
      result[clinic] = { error: (err && err.message) || String(err) };
    }
  }
  return res.status(200).json({ ok: true, result });
}
