// スタッフ別の空き計算（純粋関数。Threease のデータを最小形に正規化したものを受け取る）
//
// リカバリー鍼灸院の予約の取り方:
//   - 予約は「スタッフ」に紐づく（ベッド/ユニットは使わない。unit_id は常に null）
//   - スタッフの稼働時間は shift_assignments（start/end ＋ leaves=休憩）
//   - 担当スタッフ未定（staff_id null）の予約は「誰か1人のスタッフを消費する」扱い
//   - 仮予約（reservation_type=temporary）も埋まり扱い。キャンセル済みは無視
//   - コースごとに担当できるスタッフが決まっている（staff の products）
//
// ある開始時刻 t にコース（所要 minutes 分）が取れる条件:
//   [t, t+minutes) を丸ごと稼働中（休憩を除く）で、他の予約と重ならないスタッフが
//   「担当未定の予約（同じ時間帯と重なる分）」より多く存在すること。
//   さらに、その時間帯に同時に使うユニット数が院のユニット数を超えないこと。

export function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
export function toLabel(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
// "2026-09-19T09:00:00+09:00" → { date: '2026-09-19', min: 540 }
export function parseIso(iso) {
  const s = String(iso || '');
  if (s.length < 16) return null;
  return { date: s.slice(0, 10), min: toMin(s.slice(11, 16)) };
}

// Threease の予約1件 → { date, staffId, start, end, status, type }
export function normalizeReservation(r) {
  const st = parseIso(r.start_time);
  const en = parseIso(r.end_time);
  if (!st || !en) return null;
  let end = en.min;
  if (en.date !== st.date) end = 24 * 60; // 日をまたぐことは無い想定だが念のため
  return {
    date: st.date,
    staffId: r.staff_id == null ? null : Number(r.staff_id),
    start: st.min,
    end,
    status: String(r.status || ''),
    type: String(r.reservation_type || 'reservation'),
  };
}

// Threease のシフト割当1件 → { date, staffId, start, end, leaves: [{start,end}] }
export function normalizeShift(a) {
  const st = parseIso(a.start_time);
  const en = parseIso(a.end_time);
  if (!st || !en) return null;
  const leaves = [];
  for (const l of a.leaves || []) {
    const ls = parseIso(l.start_time);
    const le = parseIso(l.end_time);
    if (ls && le) leaves.push({ start: ls.min, end: le.min });
  }
  return { date: String(a.date || st.date), staffId: Number(a.staff_id), start: st.min, end: en.min, type: String(a.type || 'regular'), leaves };
}

export function isActive(r) {
  return r && r.status !== 'cancelled' && r.status !== 'canceled';
}

const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

// [start, end) から休憩を除いた稼働区間のリスト
function workingRanges(shift) {
  let ranges = [{ start: shift.start, end: shift.end }];
  for (const l of shift.leaves) {
    const next = [];
    for (const r of ranges) {
      if (!overlaps(r.start, r.end, l.start, l.end)) { next.push(r); continue; }
      if (r.start < l.start) next.push({ start: r.start, end: l.start });
      if (l.end < r.end) next.push({ start: l.end, end: r.end });
    }
    ranges = next;
  }
  return ranges.filter((r) => r.end > r.start);
}

/**
 * 1日分の空きを計算する
 * @param {object} p
 * @param {string} p.date              'YYYY-MM-DD'
 * @param {Array}  p.staff             [{ id, name, products: number[] | null }]  null = 全コース可
 * @param {Array}  p.shifts            normalizeShift 済み（この日の分だけでなくてもよい）
 * @param {Array}  p.reservations      normalizeReservation 済み
 * @param {number|null} p.productId    コースの product_id（null = コースで絞らない）
 * @param {number} p.minutes           所要時間（分）
 * @param {number} p.unitCount         院のユニット（施術スペース）数。0 = 制限しない
 * @param {number} [p.step=30]         表示する開始時刻の刻み（分）
 * @param {object} [p.manual]          手動ブロック { '<staffId>' | '*': ['HH:MM', …] }（各枠 step 分を埋まり扱い）
 * @returns {{ available: string[], axis: string[], detail: object }}
 */
export function computeDay({ date, staff, shifts, reservations, productId, minutes, unitCount = 0, step = 30, manual = {} }) {
  const dayShifts = shifts.filter((s) => s.date === date && s.end > s.start);
  const dayRes = reservations.filter((r) => r.date === date && isActive(r));
  const staffById = new Map(staff.map((s) => [Number(s.id), s]));

  // スタッフごとの稼働区間（この院の施術スタッフだけ）
  const work = new Map(); // staffId -> ranges[]
  for (const sh of dayShifts) {
    if (!staffById.has(sh.staffId)) continue;
    const prev = work.get(sh.staffId) || [];
    work.set(sh.staffId, prev.concat(workingRanges(sh)));
  }
  if (work.size === 0) return { available: [], axis: [], detail: { reason: 'no_shift' } };

  // 時間軸: 誰かが稼働している時刻（step 刻み）
  let dayStart = Infinity; let dayEnd = 0;
  for (const ranges of work.values()) for (const r of ranges) { dayStart = Math.min(dayStart, r.start); dayEnd = Math.max(dayEnd, r.end); }
  const firstSlot = Math.floor(dayStart / step) * step;
  const axis = [];
  for (let t = firstSlot; t < dayEnd; t += step) {
    let anyone = false;
    for (const ranges of work.values()) if (ranges.some((r) => r.start <= t && t < r.end)) { anyone = true; break; }
    if (anyone) axis.push(toLabel(t));
  }

  // コースを担当できるスタッフ
  const eligible = [...work.keys()].filter((id) => {
    const s = staffById.get(id);
    if (productId == null || !s || !Array.isArray(s.products)) return true;
    return s.products.includes(Number(productId));
  });

  const busyByStaff = new Map();
  const floating = []; // 担当未定
  for (const r of dayRes) {
    if (r.staffId == null) { floating.push(r); continue; }
    const list = busyByStaff.get(r.staffId) || [];
    list.push(r);
    busyByStaff.set(r.staffId, list);
  }
  // 手動ブロック: 指定スタッフ（'*' は稼働中の全員）のその枠を埋まり扱いに
  for (const [k, slots] of Object.entries(manual || {})) {
    const targets = k === '*' ? [...work.keys()] : [Number(k)];
    for (const id of targets) {
      const list = busyByStaff.get(id) || [];
      for (const s of slots || []) { const t = toMin(s); list.push({ start: t, end: t + step, manual: true }); }
      busyByStaff.set(id, list);
    }
  }

  const available = [];
  const detail = {};
  for (const label of axis) {
    const t = toMin(label);
    const tEnd = t + minutes;
    // その時間帯を丸ごと空けられるスタッフ
    const free = eligible.filter((id) => {
      const ranges = work.get(id) || [];
      if (!ranges.some((r) => r.start <= t && tEnd <= r.end)) return false;
      return !(busyByStaff.get(id) || []).some((b) => overlaps(t, tEnd, b.start, b.end));
    });
    const floatingHere = floating.filter((f) => overlaps(t, tEnd, f.start, f.end)).length;
    let ok = free.length > floatingHere;
    // ユニット数の上限（同時刻に重なる予約数 + 1 が上限を超えないこと）
    if (ok && unitCount > 0) {
      const points = new Set([t]);
      for (const r of dayRes) if (overlaps(t, tEnd, r.start, r.end)) points.add(Math.max(t, r.start));
      for (const p of points) {
        const concurrent = dayRes.filter((r) => r.start <= p && p < r.end).length;
        if (concurrent + 1 > unitCount) { ok = false; break; }
      }
    }
    detail[label] = { free: free.length, floating: floatingHere };
    if (ok) available.push(label);
  }
  return { available, axis, detail };
}
