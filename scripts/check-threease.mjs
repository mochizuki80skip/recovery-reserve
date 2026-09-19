// Threease Pro（管理画面の裏API）に接続できるかの確認スクリプト
//   使い方: node scripts/check-threease.mjs
//   .env.local の THREEASE_INSTITUTE_CODE / THREEASE_STAFF_CODE / THREEASE_PASSWORD を読む
//   出力は接続結果・院ID・院一覧・本日の予約件数のみ（お客様の名前などは出さない）
import { readFile } from 'node:fs/promises';

const BASE = 'https://api.threease.com/api/v1/therapists';
const AUTH_KEYS = ['access-token', 'token-type', 'client', 'expiry', 'uid'];

function cleanEnv(v) {
  return String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

async function loadEnvLocal() {
  const out = {};
  try {
    const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = cleanEnv(m[2]);
    }
  } catch {}
  return out;
}

function todayJst(offsetDays = 0) {
  return new Date(Date.now() + (9 * 60 + offsetDays * 24 * 60) * 60 * 1000).toISOString().slice(0, 10);
}

async function main() {
  const env = { ...(await loadEnvLocal()), ...process.env };
  const creds = {
    institute_code: cleanEnv(env.THREEASE_INSTITUTE_CODE),
    staff_code: cleanEnv(env.THREEASE_STAFF_CODE),
    password: cleanEnv(env.THREEASE_PASSWORD),
  };
  if (!creds.institute_code || !creds.staff_code || !creds.password) {
    console.error('NG: .env.local の THREEASE_INSTITUTE_CODE / THREEASE_STAFF_CODE / THREEASE_PASSWORD が未記入です');
    process.exit(2);
  }

  // 1) ログイン
  const t0 = Date.now();
  const res = await fetch(`${BASE}/auth/sign_in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(creds),
  });
  console.log(`ログイン: HTTP ${res.status} (${Date.now() - t0}ms)`);
  if (res.status !== 200) {
    console.error('NG: ログインできませんでした。整骨院コード・スタッフコード・パスワードを確認してください');
    try { console.error(JSON.stringify(await res.json())); } catch {}
    process.exit(1);
  }
  const body = await res.json();
  const headers = Object.fromEntries(AUTH_KEYS.map((k) => [k, res.headers.get(k)]));
  const d = body?.data || {};
  console.log(`  スタッフ: ${d.name || d.staff_code || '(不明)'} / active_branch=${d.active_branch}`);
  console.log(`  data のキー: ${Object.keys(d).join(', ')}`);

  const get = async (path, params = {}) => {
    const url = new URL(`${BASE}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const r = await fetch(url, { headers: { ...headers, accept: 'application/json' } });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };

  // 2) 院（branch）一覧（あれば）
  const br = await get('/branches');
  if (br.status === 200 && Array.isArray(br.body?.branches)) {
    console.log(`院一覧 (${br.body.branches.length}件):`);
    for (const b of br.body.branches) console.log(`  - id=${b.id} ${b.name || ''}`);
  } else {
    console.log(`院一覧: HTTP ${br.status}（取得できない場合は active_branch=${d.active_branch} のみ使用）`);
  }

  // 3) 本日〜7日間の予約件数（active_branch）
  const branchId = d.active_branch;
  const rv = await get(`/branches/${branchId}/reservations`, { start_date: todayJst(), end_date: todayJst(6), page: 1, per: 100 });
  if (rv.status === 200) {
    const list = rv.body?.reservations || [];
    const total = rv.body?.pagination?.total_count ?? list.length;
    console.log(`予約 (${todayJst()}〜${todayJst(6)}, 院${branchId}): 合計 ${total} 件`);
    const byDate = {};
    for (const r of list) {
      const day = String(r.start_time || '').slice(0, 10);
      byDate[day] = (byDate[day] || 0) + 1;
    }
    for (const [day, n] of Object.entries(byDate).sort()) console.log(`  ${day}: ${n} 件（1ページ目のみ集計）`);
    const beds = new Set();
    for (const r of list) for (const u of r.utilizations || []) if (u.unit_name) beds.add(u.unit_name);
    console.log(`  ベッド名: ${[...beds].join(', ') || '(なし)'}`);
  } else {
    console.log(`予約取得: HTTP ${rv.status}`);
  }

  // 4) シフト
  const sh = await get(`/branches/${branchId}/shifts`);
  console.log(`シフト定義: HTTP ${sh.status}${sh.status === 200 ? ` (${(sh.body?.shifts || []).length} 件)` : ''}`);

  console.log('OK: Threease Pro に接続できました');
}

main().catch((e) => { console.error('NG:', e.message); process.exit(1); });
