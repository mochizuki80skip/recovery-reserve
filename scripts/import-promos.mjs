// 旧サイト（mochizuki-bn3q）のキャンペーンを新サイト（recovery-reserve）に取り込む
//   node scripts/import-promos.mjs            … 旧サイトの一覧を表示するだけ（何も変更しない）
//   node scripts/import-promos.mjs --apply    … 新サイトに登録（同じURLコードが既にあればスキップ）
//   node scripts/import-promos.mjs --apply --overwrite … 同じURLコードは上書き
// .env.local に OLD_ADMIN_PASSWORD（旧サイトの管理パスワード）と NEW_ADMIN_PASSWORD（新サイト。無ければ ADMIN_PASSWORD）を記入
import { readFile } from 'node:fs/promises';

const OLD = 'https://mochizuki-bn3q.vercel.app';
const NEW = 'https://recovery-reserve.vercel.app';

const env = {};
for (const line of (await readFile(new URL('../.env.local', import.meta.url), 'utf8')).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']+|["']+$/g, '');
}
const oldPw = env.OLD_ADMIN_PASSWORD;
const newPw = env.NEW_ADMIN_PASSWORD || env.ADMIN_PASSWORD;
if (!oldPw) { console.error('NG: .env.local に OLD_ADMIN_PASSWORD（旧サイトの管理パスワード）を記入してください'); process.exit(2); }

const apply = process.argv.includes('--apply');
const overwrite = process.argv.includes('--overwrite');

async function getPromos(base, pw) {
  const r = await fetch(`${base}/api/admin/promos`, { headers: { accept: 'application/json', 'x-admin-password': pw } });
  if (r.status === 401) throw new Error(`${base} のパスワードが違います`);
  if (!r.ok) throw new Error(`${base} から取得できません (HTTP ${r.status})`);
  return (await r.json()).items || [];
}

const kindOf = (p) => (typeof p.targetCourseId === 'number')
  ? ((p.name || p.description || typeof p.price === 'number') ? '価格上書き' : '直行')
  : '新メニュー';
const clinicOf = (c) => (c === '192' ? '三島院' : c === '193' ? '裾野院' : '両院');

const oldItems = await getPromos(OLD, oldPw);
console.log(`旧サイトのキャンペーン: ${oldItems.length} 件`);
for (const p of oldItems) {
  console.log(`  ?promo=${p.code}  [${kindOf(p)}] ${clinicOf(p.forClinic)} / ${p.name || '(コース名のまま)'}${typeof p.price === 'number' ? ` ¥${p.price}` : ''}${p.autoOpen ? ' ⚡自動' : ''}${p.useNewCustomerLine ? ' 💬新規LINE' : ''}`);
}
if (!apply) { console.log('\n（表示だけ。登録するには --apply を付けて実行）'); process.exit(0); }

if (!newPw) { console.error('NG: 新サイトのパスワード（NEW_ADMIN_PASSWORD または ADMIN_PASSWORD）が未記入です'); process.exit(2); }
const newItems = await getPromos(NEW, newPw);
const existing = new Set(newItems.map((p) => p.code));
let added = 0; let skipped = 0; let failed = 0;
for (const p of oldItems) {
  if (existing.has(p.code) && !overwrite) { console.log(`  スキップ（既にある）: ${p.code}`); skipped++; continue; }
  const body = { ...p };
  delete body.updatedAt;
  const r = await fetch(`${NEW}/api/admin/promos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-password': newPw },
    body: JSON.stringify(body),
  });
  if (r.ok) { console.log(`  登録: ${p.code}`); added++; }
  else { console.log(`  失敗: ${p.code} (HTTP ${r.status}) ${(await r.text()).slice(0, 120)}`); failed++; }
}
console.log(`\n完了: 登録 ${added} 件 / スキップ ${skipped} 件 / 失敗 ${failed} 件`);
console.log('新サイトでの URL は https://recovery-reserve.vercel.app/?promo=<URLコード> です（旧 URL のチラシ・QR はそのままでは新サイトに来ません）');
