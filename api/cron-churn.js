// 毎朝の離反リスト作成（Vercel Cron）。両院分を順に作って Redis に置く → 管理画面はキャッシュを返すだけ。
//   vercel.json の crons から呼ばれる。CRON_SECRET を設定していれば Authorization: Bearer <CRON_SECRET> を確認する。
//   手動: GET /api/cron-churn?clinic=193（管理パスワードでも可: x-admin-password）
import { cleanEnv } from './_store.js';
import { CLINIC_IDS } from './_pro.js';
import { getChurn } from './_churn.js';

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
      const { data } = await getChurn(clinic, { force: true });
      result[clinic] = { rows: data.rows.length, ...data.stats };
    } catch (err) {
      result[clinic] = { error: (err && err.message) || String(err) };
    }
  }
  return res.status(200).json({ ok: true, result });
}
