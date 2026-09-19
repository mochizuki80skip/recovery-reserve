// Public read-only endpoint: returns the promo menus for a given code.
// If the code does not match any active promo, returns empty.

import { listPromos, isStorageUnconfiguredError, isShortcutShape } from './_admin-helpers.js';

export default async function handler(req, res) {
  const code = String(req.query.code || '').trim();

  if (!code) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({ menus: [] });
  }

  try {
    const all = await listPromos();
    const matched = all.filter((p) => p.code === code);
    const menus = matched.map((p) => {
      // shortcut 形の promo は保存時の autoOpen 値に関わらず常に true として扱う
      const effectiveAutoOpen = isShortcutShape(p) ? true : !!p.autoOpen;
      return {
        id: 'promo-' + p.code,
        name: p.name,
        description: p.description || '',
        duration: p.duration,
        price: p.price,
        forClinic: p.forClinic || 'both',
        forFirstTime: p.forFirstTime || 'both',
        targetCourseId: typeof p.targetCourseId === 'number' ? p.targetCourseId : null,
        autoOpen: effectiveAutoOpen,
        autoOpenLevel: ['clinic', 'visit', 'course'].includes(p.autoOpenLevel) ? p.autoOpenLevel : 'course',
        keepOriginalMenu: !!p.keepOriginalMenu,
        useNewCustomerLine: !!p.useNewCustomerLine,
        customFieldLabel: typeof p.customFieldLabel === 'string' ? p.customFieldLabel : '',
        customFieldRequired: !!p.customFieldRequired,
        customFieldPlaceholder: typeof p.customFieldPlaceholder === 'string' ? p.customFieldPlaceholder : '',
      };
    });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ menus });
  } catch (err) {
    if (isStorageUnconfiguredError(err)) {
      // Storage not yet set up — silently return empty so the public site keeps working.
      return res.status(200).json({ menus: [] });
    }
    return res.status(200).json({ menus: [], error: 'storage error' });
  }
}
