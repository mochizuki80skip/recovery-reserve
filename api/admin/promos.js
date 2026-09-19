// Admin CRUD for promos. Auth via X-Admin-Password header.

import {
  checkAuth,
  listPromos,
  savePromos,
  readJsonBody,
  validatePromo,
  normalizePromo,
  isShortcutShape,
  isStorageUnconfiguredError,
} from '../_admin-helpers.js';

// 既存データの shortcut 形を読み出し時に修正（autoOpen 強制 true）
function applyShortcutAutoOpen(items) {
  return items.map((p) => (
    isShortcutShape(p) && !p.autoOpen
      ? { ...p, autoOpen: true }
      : p
  ));
}

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const items = await listPromos();
      return res.status(200).json({ items: applyShortcutAutoOpen(items) });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const err = validatePromo(body);
      if (err) return res.status(400).json({ error: err });
      const normalized = normalizePromo(body);
      const items = await listPromos();
      const idx = items.findIndex((p) => p.code === normalized.code);
      if (idx >= 0) items[idx] = normalized; else items.push(normalized);
      await savePromos(items);
      return res.status(200).json({ items: applyShortcutAutoOpen(items) });
    }

    if (req.method === 'DELETE') {
      const code = String(req.query.code || '').trim();
      if (!code) return res.status(400).json({ error: 'code is required' });
      const items = await listPromos();
      const next = items.filter((p) => p.code !== code);
      await savePromos(next);
      return res.status(200).json({ items: applyShortcutAutoOpen(next) });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    if (isStorageUnconfiguredError(err)) {
      return res.status(503).json({
        error: 'storage_unconfigured',
        message:
          'Upstash Redis が未接続です。Vercel ダッシュボード → Storage → Marketplace → Upstash → Redis を作成してこのプロジェクトに接続してください。',
      });
    }
    return res.status(500).json({
      error: 'storage error',
      message: (err && err.message) || String(err),
    });
  }
}
