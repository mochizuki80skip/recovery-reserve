// 離反リストの検算: お客様一覧 API の last_visit / next_visit と突き合わせる
//   node scripts/verify-churn.mjs 192
import { readFile } from 'node:fs/promises';
const clinic = process.argv[2] || '192';
for (const line of (await readFile(new URL('../.env.local', import.meta.url), 'utf8')).split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
const { fetchChurn } = await import('../api/_churn.js');
const { apiGet } = await import('../api/_threease.js');
const churn = await fetchChurn(clinic);
console.log(`予約ベース: ${churn.rows.length}人`, JSON.stringify(churn.stats));
const t1 = Date.now();
const first = await apiGet(`/branches/${clinic}/customers`, { page: 1, per: 100 });
const pages = first.pagination?.total_pages || 1;
const all = [...(first.customers || [])];
for (let p = 2; p <= pages; p += 6) {
  const rs = await Promise.all(Array.from({ length: Math.min(6, pages - p + 1) }, (_, i) => apiGet(`/branches/${clinic}/customers`, { page: p + i, per: 100 })));
  for (const r of rs) all.push(...(r.customers || []));
}
const days = (d) => Math.round((new Date(churn.today) - new Date(String(d).slice(0, 10))) / 86400000);
const ref = new Map(all.filter((c) => c.last_visit && !c.next_visit && !c.hidden && days(c.last_visit) >= 60 && days(c.last_visit) <= 120).map((c) => [c.id, c]));
console.log(`お客様一覧ベース: ${ref.size}人 (${((Date.now() - t1) / 1000).toFixed(1)}秒)`);
const mine = new Map(churn.rows.map((r) => [r.id, r]));
console.log(`一致 ${[...mine.keys()].filter((id) => ref.has(id)).length} / 予約ベースだけ ${[...mine.values()].filter((r) => !ref.has(r.id)).length} / 一覧だけ ${[...ref.values()].filter((c) => !mine.has(c.id)).length}`);
