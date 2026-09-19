// Threease Pro（管理画面）が使っている API（非公式）へのアクセス。
//   ログイン: POST /auth/sign_in { institute_code, staff_code, password }
//             → レスポンスヘッダ access-token / token-type / client / expiry / uid を以後のリクエストに付ける
//   トークンは Redis（無ければメモリ）に保存して使い回し、401 なら再ログインする。
//   リカバリーは2院（192 / 193）あるので、院IDは呼び出し側が /branches/{id}/... で指定する。
import { cleanEnv, readCache, writeCache } from './_store.js';
import { recordUpstreamCall } from './_cache-stats.js';

const BASE = 'https://api.threease.com/api/v1/therapists';
const AUTH_KEYS = ['access-token', 'token-type', 'client', 'expiry', 'uid'];
const AUTH_KEY = 'recovery:threease_auth';
const TIMEOUT_MS = 15000;

function credentials() {
  const c = {
    institute_code: cleanEnv(process.env.THREEASE_INSTITUTE_CODE),
    staff_code: cleanEnv(process.env.THREEASE_STAFF_CODE),
    password: cleanEnv(process.env.THREEASE_PASSWORD),
  };
  if (!c.institute_code || !c.staff_code || !c.password) {
    const e = new Error('Threease のログイン情報（THREEASE_INSTITUTE_CODE / STAFF_CODE / PASSWORD）が未設定です');
    e.code = 'threease_unconfigured';
    throw e;
  }
  return c;
}

function fetchWithTimeout(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

let loginInFlight = null;
async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    const res = await fetchWithTimeout(`${BASE}/auth/sign_in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(credentials()),
    });
    if (res.status !== 200) {
      const e = new Error(`Threease ログイン失敗 (HTTP ${res.status})`);
      e.code = 'threease_login_failed';
      throw e;
    }
    const body = await res.json().catch(() => ({}));
    const headers = Object.fromEntries(AUTH_KEYS.map((k) => [k, res.headers.get(k)]));
    const auth = { headers, activeBranch: String(body?.data?.active_branch || ''), loggedInAt: new Date().toISOString() };
    await writeCache(AUTH_KEY, auth);
    return auth;
  })().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

function isExpired(auth) {
  const exp = Number(auth?.headers?.expiry);
  return !exp || exp * 1000 < Date.now() + 60 * 1000;
}

// 通信ログ用: Threease への実際の HTTP 呼び出しを 1 回ずつ数える（kind = api と api_<種類>）
function apiKind(path) {
  if (/\/reservations/.test(path)) return 'api_reservations';
  if (/\/customers/.test(path)) return 'api_customers';
  if (/shift/.test(path)) return 'api_shifts';
  return 'api_other';
}

export async function apiGet(path, params, allowRelogin = true) {
  let auth = await readCache(AUTH_KEY);
  if (!auth || !auth.headers || isExpired(auth)) auth = await login();
  const url = new URL(`${BASE}${path}`);
  // 値が配列なら同じキーを繰り返す（customer_ids[]=1&customer_ids[]=2 …）
  Object.entries(params || {}).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  });
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { ...auth.headers, accept: 'application/json' } });
  } catch (e) {
    recordUpstreamCall('api', 'fail', Date.now() - t0);
    recordUpstreamCall(apiKind(path), 'fail', Date.now() - t0);
    throw e;
  }
  const okStatus = res.status === 200 ? 'ok' : 'fail';
  recordUpstreamCall('api', okStatus, Date.now() - t0);
  recordUpstreamCall(apiKind(path), okStatus, Date.now() - t0);
  if (res.status === 401 && allowRelogin) {
    await login();
    return apiGet(path, params, false);
  }
  if (res.status !== 200) {
    const e = new Error(`Threease API エラー (HTTP ${res.status}) ${path}`);
    e.code = 'threease_api_error';
    e.status = res.status;
    throw e;
  }
  const rotated = res.headers.get('access-token');
  if (rotated && rotated !== auth.headers['access-token']) {
    await writeCache(AUTH_KEY, { ...auth, headers: { ...auth.headers, 'access-token': rotated } });
  }
  return res.json();
}

// ページ分割 API を全ページ取る（listKey = 'reservations' など）。1ページ目の後は PARALLEL 本ずつ並列
const PARALLEL = 5;
export async function fetchAllPages(path, params, listKey, { per = 100, maxPages = 40 } = {}) {
  const get = (page) => apiGet(path, { ...params, page, per });
  const first = await get(1);
  const all = [...(first[listKey] || [])];
  const totalPages = Math.min(Number(first.pagination?.total_pages) || 1, maxPages);
  for (let p = 2; p <= totalPages; p += PARALLEL) {
    const pages = [];
    for (let q = p; q < p + PARALLEL && q <= totalPages; q++) pages.push(q);
    const results = await Promise.all(pages.map(get));
    for (const r of results) all.push(...(r[listKey] || []));
  }
  return all;
}
