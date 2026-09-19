// 検算用: 指定日のスタッフごとの稼働・予約と、API が返した空きを並べて表示（名前はスタッフ名のみ）
//   node scripts/verify-day.mjs 192 2026-09-20 24281
import { readFile } from 'node:fs/promises';
const [clinic = '192', date, itemId = '24281'] = process.argv.slice(2);
const BASE = 'https://api.threease.com/api/v1/therapists';
const env = {};
for (const line of (await readFile(new URL('../.env.local', import.meta.url), 'utf8')).split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const res = await fetch(`${BASE}/auth/sign_in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ institute_code: env.THREEASE_INSTITUTE_CODE, staff_code: env.THREEASE_STAFF_CODE, password: env.THREEASE_PASSWORD }) });
const H = Object.fromEntries(['access-token','token-type','client','expiry','uid'].map(k => [k, res.headers.get(k)]));
const get = async (p, q = {}) => { const u = new URL(BASE + p); Object.entries(q).forEach(([k, v]) => u.searchParams.set(k, v)); const r = await fetch(u, { headers: { ...H, accept: 'application/json' } }); return r.json(); };
const hm = (iso) => String(iso).slice(11, 16);
const sa = await get(`/branches/${clinic}/shift_assignments`, { start_date: date, end_date: date, per: 100 });
const rv = await get(`/branches/${clinic}/reservations`, { start_date: date, end_date: date, per: 200 });
const st = await get(`/branches/${clinic}/staff`, { per: 100 });
const names = Object.fromEntries((st.staff || []).map((s) => [s.id, s.name]));
console.log(`== ${clinic} ${date}`);
for (const a of sa.shift_assignments || []) {
  const br = (a.leaves || []).map((l) => `休憩${hm(l.start_time)}-${hm(l.end_time)}`).join(',');
  const mine = (rv.reservations || []).filter((r) => r.staff_id === a.staff_id && r.status !== 'cancelled').sort((x, y) => x.start_time.localeCompare(y.start_time));
  console.log(`${names[a.staff_id] || a.staff_id} シフト ${hm(a.start_time)}-${hm(a.end_time)} ${br}`);
  console.log('   予約: ' + mine.map((r) => `${hm(r.start_time)}-${hm(r.end_time)}${r.reservation_type === 'temporary' ? '(仮)' : ''}`).join(' '));
}
const fl = (rv.reservations || []).filter((r) => !r.staff_id && r.status !== 'cancelled');
if (fl.length) console.log('担当未定: ' + fl.map((r) => `${hm(r.start_time)}-${hm(r.end_time)}`).join(' '));
const api = await (await fetch(`http://localhost:4100/api/availability?clinic=${clinic}&start=${date.replace(/-/g, '')}&end=${date.replace(/-/g, '')}&course_id=${itemId}`)).json();
console.log(`API(${api.duration}分コース) 空き: ` + api.available.map((s) => hm(s.iso)).join(' '));
