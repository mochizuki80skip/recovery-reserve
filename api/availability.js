// 空き状況 API（Threease Pro の実予約・シフトから「スタッフ別」に計算）
//   GET /api/availability?clinic=192&start=YYYYMMDD&end=YYYYMMDD[&course_id=][&duration=][&for_new=]
//   → { clinic, start, end, courseId, duration, forNew, available:[{date,iso}], unknown:[], axisAvailable:[{date,iso}], ... }
//   レスポンスの形は旧版（公開API中継）と同じなので、フロント（app.js）は変更なしで動く。
//
//   course_id は公開APIのコースID（= Threease Pro の item id）。対応表から product_id と所要時間を引き、
//   そのコースを担当できるスタッフだけで空きを計算する。対応表に無い ID（限定メニュー等）は duration だけ使う。
import { CLINIC_IDS, getBranchMeta, getBlock, blockIndexFor, addDaysYmd, diffDays, MAX_BLOCK } from './_pro.js';
import { computeDay } from './_slots.js';
import { getBusy } from './_busy.js';

const MAX_DAYS = 7;

function ymdDashed(s) { return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; }
function toIso(date, hhmm) { return `${date}T${hhmm}:00+09:00`; }

export function resolveCourse(meta, courseId, durationParam) {
  const item = courseId ? meta.items[String(courseId)] : null;
  const minutes = (item && item.minutes) || durationParam || 30;
  return { productId: item ? item.productId : null, minutes, known: !!item };
}

// 1日分を計算（recheck からも使う）
export async function computeForDate(clinic, date, courseId, durationParam, { force = false } = {}) {
  const k = blockIndexFor(date);
  if (k < 0 || k > MAX_BLOCK) return { available: [], axis: [], fetchedAt: null, stale: false, refreshing: false, error: '', skipped: true };
  const [meta, block, busy] = await Promise.all([getBranchMeta(clinic), getBlock(clinic, k, { force }), getBusy(clinic)]);
  const { productId, minutes } = resolveCourse(meta, courseId, durationParam);
  const day = computeDay({
    date,
    staff: meta.staff,
    shifts: block.shifts,
    reservations: block.reservations,
    productId,
    minutes,
    unitCount: meta.unitCount,
    manual: busy[date] || {}, // 手動ブロック（管理画面で塞いだ枠）
  });
  return { ...day, minutes, productId, fetchedAt: block.fetchedAt, stale: block.stale, refreshing: block.refreshing, error: block.error };
}

export default async function handler(req, res) {
  const clinic = String(req.query.clinic || '');
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  const courseId = String(req.query.course_id || '').trim();
  const durationRaw = String(req.query.duration || '').trim();
  const duration = durationRaw && /^\d+$/.test(durationRaw) ? parseInt(durationRaw, 10) : null;
  const forNew = String(req.query.for_new || '').toLowerCase();
  const forNewBool = forNew === 'true' ? true : forNew === 'false' ? false : null;
  const debug = req.query.debug === '1';

  if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
  if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return res.status(400).json({ error: 'invalid date format, expect YYYYMMDD' });
  if (courseId && !/^\d+$/.test(courseId)) return res.status(400).json({ error: 'invalid course_id' });

  const startD = ymdDashed(start);
  const endD = ymdDashed(end);
  const nDays = diffDays(startD, endD) + 1;
  if (nDays < 1 || nDays > MAX_DAYS) return res.status(400).json({ error: 'date range too long' });

  try {
    const dates = Array.from({ length: nDays }, (_, i) => addDaysYmd(startD, i));
    const results = await Promise.all(dates.map((d) => computeForDate(clinic, d, courseId, duration)));

    const available = [];
    const axisAvailable = [];
    const detail = {};
    let fetchedAt = null; let stale = false; let refreshing = false; let error = '';
    let minutes = duration; let productId = null;
    results.forEach((r, i) => {
      const date = dates[i];
      for (const t of r.available) available.push({ date, iso: toIso(date, t) });
      for (const t of r.axis) axisAvailable.push({ date, iso: toIso(date, t) });
      if (r.fetchedAt) fetchedAt = r.fetchedAt;
      stale = stale || !!r.stale;
      refreshing = refreshing || !!r.refreshing;
      if (r.error) error = r.error;
      if (r.minutes) minutes = r.minutes;
      if (r.productId != null) productId = r.productId;
      if (debug) detail[date] = r.detail;
    });

    const payload = {
      clinic, start, end,
      courseId: courseId || null,
      duration: minutes,
      forNew: forNewBool,
      available,
      unknown: [],
      axisAvailable,
      _via: 'threease-pro',
      _courseFilterApplied: !!courseId,
      _productId: productId,
      fetchedAt, stale, refreshing,
    };
    if (debug) { payload._detail = detail; payload._error = error; }

    // サーバー側で 60 秒キャッシュ＋裏更新しているので、ブラウザ/Edge のキャッシュは短めに
    res.setHeader('Cache-Control', debug ? 'no-store' : 'public, max-age=30, s-maxage=30, stale-while-revalidate=120');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('availability failed:', err && err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'upstream error', message: (err && err.message) || String(err) });
  }
}
