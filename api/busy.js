// 手動ブロック API（管理画面専用・要 x-admin-password）
//   GET /api/busy?clinic=192&date=YYYY-MM-DD
//     → { date, staff:[{id,name}], work:{staffId:[[start,end]…]}, reservations:[{staffId,start,end,type}], blocks:{staffId|'*':[slot…]}, axis:[slot…], step }
//   PUT /api/busy  { clinic, date, blocks: { staffId|'*': [slot…] } }  → その日のブロックを差し替え
import { checkAuth, readJsonBody } from './_admin-helpers.js';
import { CLINIC_IDS, getBranchMeta, getBlock, blockIndexFor, MAX_BLOCK } from './_pro.js';
import { getBusy, saveBusyDay, BLOCK_STEP, ALL_STAFF } from './_busy.js';
import { toLabel, isActive } from './_slots.js';

function workingRanges(shift) {
  let ranges = [[shift.start, shift.end]];
  for (const l of shift.leaves) {
    const next = [];
    for (const [s, e] of ranges) {
      if (!(s < l.end && l.start < e)) { next.push([s, e]); continue; }
      if (s < l.start) next.push([s, l.start]);
      if (l.end < e) next.push([l.end, e]);
    }
    ranges = next;
  }
  return ranges.filter(([s, e]) => e > s);
}

async function dayDetail(clinic, date) {
  const k = blockIndexFor(date);
  const blocks = (await getBusy(clinic))[date] || {};
  if (k < 0 || k > MAX_BLOCK) return { date, staff: [], work: {}, reservations: [], blocks, axis: [], step: BLOCK_STEP, outOfRange: true };
  const [meta, block] = await Promise.all([getBranchMeta(clinic), getBlock(clinic, k)]);
  const staffById = new Map(meta.staff.map((s) => [s.id, s]));
  const work = {};
  let dayStart = Infinity; let dayEnd = 0;
  for (const sh of block.shifts) {
    if (sh.date !== date || !staffById.has(sh.staffId)) continue;
    const ranges = workingRanges(sh);
    work[sh.staffId] = (work[sh.staffId] || []).concat(ranges);
    for (const [s, e] of ranges) { dayStart = Math.min(dayStart, s); dayEnd = Math.max(dayEnd, e); }
  }
  const staff = meta.staff.filter((s) => work[s.id]).map((s) => ({ id: s.id, name: s.name }));
  const reservations = block.reservations
    .filter((r) => r.date === date && isActive(r))
    .map((r) => ({ staffId: r.staffId, start: r.start, end: r.end, type: r.type }));
  const axis = [];
  if (Number.isFinite(dayStart)) {
    for (let t = Math.floor(dayStart / BLOCK_STEP) * BLOCK_STEP; t < dayEnd; t += BLOCK_STEP) axis.push(toLabel(t));
  }
  return { date, staff, work, reservations, blocks, axis, step: BLOCK_STEP, fetchedAt: block.fetchedAt, stale: block.stale };
}

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const clinic = String(req.query.clinic || '');
      const date = String(req.query.date || '');
      if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });
      return res.status(200).json(await dayDetail(clinic, date));
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req);
      const clinic = String(body.clinic || '');
      const date = String(body.date || '');
      if (!CLINIC_IDS.has(clinic)) return res.status(400).json({ error: 'invalid clinic' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });
      const blocks = {};
      for (const [k, v] of Object.entries(body.blocks || {})) if ((k === ALL_STAFF || /^\d+$/.test(k)) && Array.isArray(v)) blocks[k] = v.map(String);
      const saved = await saveBusyDay(clinic, date, blocks);
      return res.status(200).json({ ok: true, blocks: saved[date] || {} });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    if (err && err.code === 'storage_unconfigured') return res.status(503).json({ error: 'storage_unconfigured' });
    console.error('busy failed:', err && err.message);
    return res.status(500).json({ error: 'server error', message: (err && err.message) || String(err) });
  }
}
