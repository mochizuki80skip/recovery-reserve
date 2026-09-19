// Admin-only: read upstream call telemetry from KV.
// Output: per-day per-kind { total, ok, fail, avgMs, successRate }.

import { checkAuth } from '../_admin-helpers.js';
import { readDailyStats } from '../_cache-stats.js';

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const days = Math.min(parseInt(req.query.days || '3', 10) || 3, 14);
    const stats = await readDailyStats(days);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ stats: stats || {} });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
