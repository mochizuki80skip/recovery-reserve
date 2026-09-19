// カレンダーの「?」枠をタップした時の再確認。キャッシュを使わず Threease Pro から取り直して1枠だけ判定する。
//   GET /api/recheck?clinic=192&course_id=24281&iso=2026-09-20T10:00:00+09:00
//   → { status: 'ok', bookable: true|false } / { status: 'failed' }
import { CLINIC_IDS } from './_pro.js';
import { computeForDate } from './availability.js';

export default async function handler(req, res) {
  const clinic = String(req.query.clinic || '');
  const courseId = String(req.query.course_id || '').trim();
  const iso = String(req.query.iso || '');
  const durationRaw = String(req.query.duration || '').trim();
  const duration = durationRaw && /^\d+$/.test(durationRaw) ? parseInt(durationRaw, 10) : null;

  if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
  if (courseId && !/^\d+$/.test(courseId)) return res.status(400).json({ error: 'invalid course_id' });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return res.status(400).json({ error: 'invalid iso' });

  res.setHeader('Cache-Control', 'no-store');
  try {
    const date = iso.slice(0, 10);
    const hhmm = iso.slice(11, 16);
    const r = await computeForDate(clinic, date, courseId, duration, { force: true });
    return res.status(200).json({ status: 'ok', bookable: r.available.includes(hhmm) });
  } catch (err) {
    console.error('recheck failed:', err && err.message);
    return res.status(200).json({ status: 'failed' });
  }
}
