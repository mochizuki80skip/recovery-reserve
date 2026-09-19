// 手動ブロック（院側が「この時間はこのスタッフは受けない」と塞ぐ枠）。空き状況の計算で埋まり扱いにする。
//   保存形: { 'YYYY-MM-DD': { '<staffId>': ['10:00', '10:30', ...], '*': ['13:00'] } }  '*' = 全スタッフ
//   Redis `recovery:busy:{clinic}`。ローカル（Redis 無し）は .local-busy-{clinic}.json
//   保存時に前日より古い日付は捨てる
import { readFile, writeFile } from 'node:fs/promises';
import { getRedis } from './_store.js';
import { todayJst, addDaysYmd } from './_pro.js';

export const BLOCK_STEP = 30; // 手動ブロックの刻み（分）
export const ALL_STAFF = '*';

const key = (clinic) => `recovery:busy:${clinic}`;
const localFile = (clinic) => new URL(`../.local-busy-${clinic}.json`, import.meta.url);
const useLocalFile = () => !getRedis() && !process.env.VERCEL;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isSlot = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isKey = (k) => k === ALL_STAFF || /^\d{1,10}$/.test(k);

export function normalizeBusy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cutoff = addDaysYmd(todayJst(), -1);
  const out = {};
  for (const [date, lanes] of Object.entries(src)) {
    if (!isDate(date) || date < cutoff || !lanes || typeof lanes !== 'object') continue;
    const day = {};
    for (const [k, slots] of Object.entries(lanes)) {
      if (!isKey(k) || !Array.isArray(slots)) continue;
      const clean = [...new Set(slots.filter(isSlot))].sort();
      if (clean.length) day[k] = clean;
    }
    if (Object.keys(day).length) out[date] = day;
  }
  return out;
}

export async function getBusy(clinic) {
  if (useLocalFile()) {
    try { return normalizeBusy(JSON.parse(await readFile(localFile(clinic), 'utf8'))); } catch { return {}; }
  }
  const redis = getRedis();
  if (!redis) return {};
  try { return normalizeBusy(await redis.get(key(clinic))); } catch { return {}; }
}

let chain = Promise.resolve();
export async function saveBusy(clinic, busy) {
  const clean = normalizeBusy(busy);
  if (useLocalFile()) {
    chain = chain.then(() => writeFile(localFile(clinic), JSON.stringify(clean, null, 2)));
    await chain;
    return clean;
  }
  const redis = getRedis();
  if (!redis) { const e = new Error('Storage not configured'); e.code = 'storage_unconfigured'; throw e; }
  await redis.set(key(clinic), clean);
  return clean;
}

// 1 日分だけ差し替えて保存
export async function saveBusyDay(clinic, date, lanes) {
  const busy = await getBusy(clinic);
  busy[date] = lanes && typeof lanes === 'object' ? lanes : {};
  return saveBusy(clinic, busy);
}
