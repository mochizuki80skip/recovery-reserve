// Shared cache + telemetry for upstream threease calls.
// Both are best-effort — any failure is silently ignored so we never block
// the main request path. KV/Redis is shared with promos via the same env.

import { Redis } from '@upstash/redis';

let _redis = null;
function getRedis() {
  if (_redis !== null) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { _redis = false; return false; }
  try { _redis = new Redis({ url, token }); } catch { _redis = false; }
  return _redis;
}

// --------------- /courses?start_time=Y cache ---------------
// 2層の有効期限:
//   FRESH  … この間はキャッシュをそのまま返す（上流を叩かない）
//   STALE  … 上流失敗時のフォールバック用に「最後に成功した値」を保持する期間
// 「LINE で最終確認」という運用前提なので、数分の鮮度劣化は許容範囲。
const FRESH_TTL_SEC = 180;   // 鮮度（旧 60 秒 → 180 秒に延長して上流呼び出しを削減）
const STALE_TTL_SEC = 1800;  // 最後の good 値を 30 分まで保持（stale-on-error）
const FAIL_TTL_SEC = 15;     // good 値が無いときの失敗バックオフ

function coursesCacheKey(clinic, forNewBool, startIso) {
  return `cc:${clinic}:${forNewBool ? 't' : 'f'}:${startIso}`;
}
function coursesFreshKey(clinic, forNewBool, startIso) {
  return `ccf:${clinic}:${forNewBool ? 't' : 'f'}:${startIso}`;
}
function coursesFailKey(clinic, forNewBool, startIso) {
  return `ccx:${clinic}:${forNewBool ? 't' : 'f'}:${startIso}`;
}

// 戻り値:
//   undefined                  … 完全なミス（上流を叩く）
//   { ids: <array>, fresh: true }   … 鮮度内の good 値（そのまま使う）
//   { ids: <array>, fresh: false }  … 古い good 値（上流を試し、失敗時に使う）
//   { ids: null,  fresh: true }     … 直近で失敗（再取得せず unknown 扱い）
export async function getCachedCourseIds(clinic, forNewBool, startIso) {
  const redis = getRedis();
  if (!redis) return undefined; // KV unavailable → caller falls through to live fetch
  try {
    const [good, fresh, failed] = await Promise.all([
      redis.get(coursesCacheKey(clinic, forNewBool, startIso)),
      redis.get(coursesFreshKey(clinic, forNewBool, startIso)),
      redis.get(coursesFailKey(clinic, forNewBool, startIso)),
    ]);
    if (good !== null && good !== undefined) {
      // good 値あり: 鮮度フラグがあれば fresh、なければ stale
      return { ids: good, fresh: fresh != null };
    }
    if (failed != null) {
      // good 値は無いが直近で失敗 → バックオフ中。再取得せず unknown 扱い。
      return { ids: null, fresh: true };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// 成功時のみ呼ぶ: good 値を STALE TTL で保存し、鮮度フラグを FRESH TTL で立てる。
export async function setCachedCourseIds(clinic, forNewBool, startIso, ids) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await Promise.all([
      redis.set(coursesCacheKey(clinic, forNewBool, startIso), ids, { ex: STALE_TTL_SEC }),
      redis.set(coursesFreshKey(clinic, forNewBool, startIso), 1, { ex: FRESH_TTL_SEC }),
    ]);
  } catch {}
}

// 上流失敗かつフォールバック可能な good 値も無いときに呼ぶ短命バックオフ。
export async function setCourseFetchFailed(clinic, forNewBool, startIso) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(coursesFailKey(clinic, forNewBool, startIso), 1, { ex: FAIL_TTL_SEC });
  } catch {}
}

// --------------- Telemetry counters ---------------
// Simple per-day counters so admin can see success rate / response time.

function ymdJst(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
}

const STAT_TTL_SEC = 86400 * 7; // keep 7 days

export function recordUpstreamCall(kind, status, durationMs) {
  // Fire and forget — don't await.
  const redis = getRedis();
  if (!redis) return;
  const day = ymdJst(new Date());
  const base = `st:${day}:${kind}`;
  const tasks = [
    redis.incr(`${base}:total`),
    redis.incr(`${base}:${status}`),
  ];
  if (typeof durationMs === 'number' && status === 'ok') {
    tasks.push(redis.incrby(`${base}:dur_total`, Math.round(durationMs)));
    tasks.push(redis.incr(`${base}:dur_count`));
  }
  // Set expiry once (Redis ignores re-setting same ttl on already-counted key)
  tasks.push(redis.expire(`${base}:total`, STAT_TTL_SEC));
  Promise.allSettled(tasks).catch(() => {});
}

export async function readDailyStats(daysBack = 3) {
  const redis = getRedis();
  if (!redis) return null;
  const now = new Date();
  const days = [];
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(ymdJst(d));
  }
  const out = {};
  for (const day of days) {
    const kinds = ['courses', 'calendar'];
    const entry = {};
    for (const kind of kinds) {
      const base = `st:${day}:${kind}`;
      try {
        const [total, ok, fail, cacheHit, staleHit, durTotal, durCount] = await Promise.all([
          redis.get(`${base}:total`),
          redis.get(`${base}:ok`),
          redis.get(`${base}:fail`),
          redis.get(`${base}:cache_hit`),
          redis.get(`${base}:stale`),
          redis.get(`${base}:dur_total`),
          redis.get(`${base}:dur_count`),
        ]);
        const t = Number(total) || 0;
        const o = Number(ok) || 0;
        const f = Number(fail) || 0;
        const ch = Number(cacheHit) || 0;
        const st = Number(staleHit) || 0;
        const dt = Number(durTotal) || 0;
        const dc = Number(durCount) || 0;
        // live = 実際に threease を叩いた回数（成功+失敗）。
        // 成功率はこの live に対する割合で見る（キャッシュ命中で薄まらない）。
        const live = o + f;
        entry[kind] = {
          total: t,
          ok: o,
          fail: f,
          cacheHit: ch,
          stale: st,
          avgMs: dc > 0 ? Math.round(dt / dc) : null,
          // 上流（threease）への実呼び出しの成功率
          successRate: live > 0 ? Math.round((o / live) * 1000) / 10 : null,
          // キャッシュ＋staleで上流を回避できた割合
          cacheHitRate: t > 0 ? Math.round(((ch + st) / t) * 1000) / 10 : null,
        };
      } catch { entry[kind] = null; }
    }
    out[day] = entry;
  }
  return out;
}
