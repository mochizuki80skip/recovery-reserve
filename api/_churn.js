// 離反リスト: 最終来院から 60 日以上（120 日以内）経っていて、次回予約が無いお客様。
//
// お客様一覧 API は全件読むと 15〜40 秒かかる（並び順も最終来院順ではなく、期間の絞り込みも効かない）ので、
// 予約 API から求める。Threease は返す予約 1 件あたり約 15ms かかるため、読む量を最小にする:
//   1) 「120 日前〜60 日前」の予約だけ読む（候補者＝この期間に来院した人）
//   2) 候補者の ID をまとめて渡し（40 人ずつ）、「60 日前より後〜今後」に予約がある人を調べる
//      → あれば「その後も来ている／次回予約がある」ので外す
// 名前・カルテ番号・来院回数は予約データに入っている。
//
// 結果は Redis（無ければメモリ）に CACHE_HOURS 時間キャッシュ。毎朝の cron と「Threease から読み直す」で作り直す。
import { readCache, writeCache } from './_store.js';
import { fetchAllPages } from './_threease.js';
import { todayJst, addDaysYmd, diffDays } from './_pro.js';

export const CHURN_MIN_DAYS = 60;   // この日数以上あいたら離反候補
export const CHURN_MAX_DAYS = 120;  // これより前の人は載せない
const FUTURE_DAYS = 180;            // 次回予約を探す範囲
const CACHE_HOURS = 12;

const NOT_VISITED = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'absent']);

function isVisit(r) {
  return r.reservation_type !== 'temporary' && !NOT_VISITED.has(String(r.status || ''));
}

// 予約項目の名前（窓口対応・物販は除く）
function itemNames(r) {
  return (r.reservation_items || [])
    .map((i) => String(i.product_name || '').trim())
    .filter((n) => n && !/窓口|物販/.test(n));
}

// 候補者のうち「窓より後（60 日前より後〜今後）」に有効な予約がある人の ID 集合。
//   customer_ids[] をまとめて渡せる（40 人ずつ）。窓の中で最後に来た人が窓より後にも来ていれば、その人は外す。
const CHECK_BATCH = 40;
async function customersWithLaterReservation(clinic, ids, afterDate, until) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += CHECK_BATCH) {
    const batch = ids.slice(i, i + CHECK_BATCH);
    const list = await fetchAllPages(`/branches/${clinic}/reservations`, {
      'customer_ids[]': batch, start_date: afterDate, end_date: until,
    }, 'reservations', { per: 100, maxPages: 10 });
    for (const r of list) if (isVisit(r)) found.add(r.customer_id);
  }
  return found;
}

export async function fetchChurn(clinic) {
  const today = todayJst();
  const winStart = addDaysYmd(today, -CHURN_MAX_DAYS);
  const winEnd = addDaysYmd(today, -CHURN_MIN_DAYS);
  const until = addDaysYmd(today, FUTURE_DAYS);

  const t0 = Date.now();
  const window = await fetchAllPages(`/branches/${clinic}/reservations`, { start_date: winStart, end_date: winEnd }, 'reservations', { per: 100, maxPages: 80 });

  // 候補者ごとの、期間内での最終来院
  const byCustomer = new Map();
  for (const r of window) {
    if (!r.customer_id || !isVisit(r)) continue;
    const date = String(r.start_time || '').slice(0, 10);
    const prev = byCustomer.get(r.customer_id);
    if (!prev || date > prev.last) {
      byCustomer.set(r.customer_id, {
        id: r.customer_id,
        code: String(r.customer_code || ''),
        name: String(r.customer_name || '').trim(),
        kana: String(r.customer_name_kana || '').trim(),
        last: date,
        lastStaff: String(r.staff_name || ''),
        lastItems: itemNames(r),
        count: Number(r.customer_reservation_count) || 0,
      });
    }
  }

  // その後に予約（来院済み or 今後）がある人を外す
  const candidates = [...byCustomer.values()];
  const later = await customersWithLaterReservation(clinic, candidates.map((c) => c.id), addDaysYmd(winEnd, 1), until);

  const rows = candidates
    .filter((c) => !later.has(c.id))
    .map((c) => ({ ...c, elapsed: diffDays(c.last, today) }))
    // 60 日を超えたばかりの人を上に（連絡の優先度が高い）
    .sort((a, b) => a.elapsed - b.elapsed || a.kana.localeCompare(b.kana, 'ja'));

  return {
    clinic: String(clinic),
    today,
    minDays: CHURN_MIN_DAYS,
    maxDays: CHURN_MAX_DAYS,
    rows,
    stats: { windowReservations: window.length, candidates: candidates.length, seconds: Math.round((Date.now() - t0) / 100) / 10 },
    builtAt: new Date().toISOString(),
  };
}

const cacheKey = (clinic) => `recovery:churn:${clinic}`;

// { data, cached, stale } を返す。cachedOnly=true でキャッシュが無ければ data=null
export async function getChurn(clinic, { force = false, cachedOnly = false } = {}) {
  if (!force) {
    const cached = await readCache(cacheKey(clinic));
    if (cached && cached.today === todayJst()) return { data: cached, cached: true, stale: false };
    if (cachedOnly) return { data: cached || null, cached: !!cached, stale: !!cached };
  }
  const data = await fetchChurn(clinic);
  await writeCache(cacheKey(clinic), data, CACHE_HOURS * 3600);
  return { data, cached: false, stale: false };
}
