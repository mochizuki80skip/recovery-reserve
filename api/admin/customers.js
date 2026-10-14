// 管理画面: お客様スナップショット（離反対策リスト・離反リスト・継続率/離反率はこのデータから画面側で計算する）
//   GET /api/admin/customers?clinic=192            保存済みがあればそれ（日付が変わっていても返す。stale:true）、無ければ Threease から作る（15〜40秒）
//   GET /api/admin/customers?clinic=192&cached=1   保存済みだけ（無ければ data:null。ホーム画面用）
//   GET /api/admin/customers?clinic=192&force=1    Threease から作り直す
//   GET /api/admin/customers?clinic=192&contacted=1            空き枠の案内を送った記録 { contacted: { customerId: [{at,date,time}] } }
//   POST /api/admin/customers { clinic, action:'contact'|'uncontact', customerId, date, time }  記録の追加／取り消し
import { readFile, writeFile } from 'node:fs/promises';
import { checkAuth, readJsonBody } from '../_admin-helpers.js';
import { CLINIC_IDS, addDaysYmd, todayJst } from '../_pro.js';
import { getCustomers } from '../_customers.js';
import { getRedis } from '../_store.js';

// ---- 空き枠の案内を送った記録（Redis recovery:contacted:{clinic}、ローカルは .local-contacted-{clinic}.json）----
const KEEP_DAYS = 180;
const contactedKey = (clinic) => `recovery:contacted:${clinic}`;
const localFile = (clinic) => new URL(`../../.local-contacted-${clinic}.json`, import.meta.url);
const useLocalFile = () => !getRedis() && !process.env.VERCEL;

function normalizeContacted(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cutoff = addDaysYmd(todayJst(), -KEEP_DAYS);
  const out = {};
  for (const [id, list] of Object.entries(src)) {
    if (!/^\d+$/.test(id) || !Array.isArray(list)) continue;
    const clean = list.filter((x) => x && typeof x.at === 'string' && x.at.slice(0, 10) >= cutoff)
      .map((x) => ({ at: String(x.at), date: String(x.date || ''), time: String(x.time || '') }))
      .slice(-20);
    if (clean.length) out[id] = clean;
  }
  return out;
}
async function getContacted(clinic) {
  if (useLocalFile()) { try { return normalizeContacted(JSON.parse(await readFile(localFile(clinic), 'utf8'))); } catch { return {}; } }
  const redis = getRedis();
  if (!redis) return {};
  try { return normalizeContacted(await redis.get(contactedKey(clinic))); } catch { return {}; }
}
async function saveContacted(clinic, data) {
  const clean = normalizeContacted(data);
  if (useLocalFile()) { await writeFile(localFile(clinic), JSON.stringify(clean, null, 2)); return clean; }
  const redis = getRedis();
  if (!redis) { const e = new Error('storage_unconfigured'); e.code = 'storage_unconfigured'; throw e; }
  await redis.set(contactedKey(clinic), clean);
  return clean;
}

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const clinic = String(body.clinic || '');
      if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
      const id = String(body.customerId || '');
      if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid customerId' });
      const data = await getContacted(clinic);
      if (body.action === 'contact') {
        (data[id] ||= []).push({ at: new Date().toISOString(), date: String(body.date || ''), time: String(body.time || '') });
      } else if (body.action === 'uncontact') {
        if (data[id]) { data[id].pop(); if (!data[id].length) delete data[id]; }
      } else {
        return res.status(400).json({ error: 'invalid action' });
      }
      const saved = await saveContacted(clinic, data);
      return res.status(200).json({ ok: true, contacted: saved });
    }

    const clinic = String(req.query.clinic || '');
    if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
    if (req.query.contacted === '1') return res.status(200).json({ clinic, contacted: await getContacted(clinic) });

    const r = await getCustomers(clinic, { force: req.query.force === '1', cachedOnly: req.query.cached === '1' });
    return res.status(200).json({ clinic, ...r });
  } catch (err) {
    if (err && err.code === 'storage_unconfigured') return res.status(503).json({ error: 'storage_unconfigured' });
    console.error('customers failed:', err && err.message);
    return res.status(502).json({ error: 'threease error', message: (err && err.message) || String(err) });
  }
}
