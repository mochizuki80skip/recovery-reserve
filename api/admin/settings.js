// 管理画面の設定（離反リストの文面テンプレート）。Redis `recovery:settings`、ローカルは .local-settings.json
//   GET  /api/admin/settings        → { settings }
//   PUT  /api/admin/settings {…}    → 保存して { settings }
import { readFile, writeFile } from 'node:fs/promises';
import { Redis } from '@upstash/redis';
import { checkAuth, readJsonBody } from '../_admin-helpers.js';

const KEY = 'recovery:settings';
const LOCAL_FILE = new URL('../../.local-settings.json', import.meta.url);
const useLocalFile = () => !process.env.VERCEL && !(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);

let _redis = null;
function redis() {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { const e = new Error('storage_unconfigured'); e.code = 'storage_unconfigured'; throw e; }
  _redis = new Redis({ url, token });
  return _redis;
}

// 文面テンプレート [{ id, name, body }]（id は英数字、最大 20 件、本文 3000 文字まで）
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const templates = [];
  if (Array.isArray(src.churnTemplates)) {
    for (const t of src.churnTemplates.slice(0, 20)) {
      if (!t || typeof t !== 'object') continue;
      const id = String(t.id || '').trim().toLowerCase();
      const name = String(t.name || '').trim().slice(0, 40);
      const body = String(t.body || '').slice(0, 3000);
      if (!/^[a-z0-9-]{1,32}$/.test(id) || !name) continue;
      templates.push({ id, name, body });
    }
  }
  return { churnTemplates: templates };
}

async function load() {
  if (useLocalFile()) {
    try { return normalizeSettings(JSON.parse(await readFile(LOCAL_FILE, 'utf8'))); } catch { return normalizeSettings({}); }
  }
  return normalizeSettings(await redis().get(KEY));
}
async function save(raw) {
  const clean = normalizeSettings(raw);
  if (useLocalFile()) await writeFile(LOCAL_FILE, JSON.stringify(clean, null, 2));
  else await redis().set(KEY, clean);
  return clean;
}

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json({ settings: await load() });
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req);
      return res.status(200).json({ settings: await save(body) });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    if (err && err.code === 'storage_unconfigured') return res.status(503).json({ error: 'storage_unconfigured' });
    return res.status(500).json({ error: 'storage error', message: (err && err.message) || String(err) });
  }
}
