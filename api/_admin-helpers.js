// Shared helpers for admin endpoints.

import { Redis } from '@upstash/redis';

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  // Accept env vars set by either Vercel KV (legacy) or direct Upstash Redis integration.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const e = new Error('Storage not configured. Connect Upstash Redis to this Vercel project.');
    e.code = 'storage_unconfigured';
    throw e;
  }
  _redis = new Redis({ url, token });
  return _redis;
}

export function checkAuth(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return { ok: false, status: 500, error: 'ADMIN_PASSWORD env var is not set' };
  }
  const provided =
    (req.headers && (req.headers['x-admin-password'] || req.headers['X-Admin-Password'])) || '';
  if (provided !== expected) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const PROMO_KEY = 'reserve:promos';

export async function listPromos() {
  const redis = getRedis();
  const items = await redis.get(PROMO_KEY);
  return Array.isArray(items) ? items : [];
}

export async function savePromos(items) {
  const redis = getRedis();
  await redis.set(PROMO_KEY, items);
}

export function isStorageUnconfiguredError(err) {
  return err && err.code === 'storage_unconfigured';
}

export function validatePromo(p) {
  if (!p || typeof p !== 'object') return 'invalid body';
  if (!p.code || typeof p.code !== 'string') return 'code is required';
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(p.code)) return 'code must be 3-40 chars (letters, numbers, _, -)';
  if (p.targetCourseId !== null && p.targetCourseId !== undefined && p.targetCourseId !== '' && typeof p.targetCourseId !== 'number') {
    return 'targetCourseId must be a number or null';
  }
  const isOverride = typeof p.targetCourseId === 'number';
  const hasContent = (typeof p.price === 'number')
    || (typeof p.name === 'string' && p.name.trim() !== '')
    || (typeof p.description === 'string' && p.description.trim() !== '');
  // name is required only when adding a brand-new menu
  // (no target course AND has content to display)
  if (!isOverride && hasContent) {
    if (!p.name || typeof p.name !== 'string' || !p.name.trim()) return 'name is required';
  } else if (p.name != null && typeof p.name !== 'string') {
    return 'name must be a string';
  }
  if (typeof p.duration !== 'number' && p.duration !== null && p.duration !== undefined) return 'duration must be a number';
  if (typeof p.price !== 'number' && p.price !== null && p.price !== undefined) return 'price must be a number';
  const validClinic = !p.forClinic || ['both', '192', '193'].includes(p.forClinic);
  if (!validClinic) return 'forClinic must be both/192/193';
  const validFt = !p.forFirstTime || ['both', 'true', 'false', 'three_months'].includes(p.forFirstTime);
  if (!validFt) return 'forFirstTime must be both/true/false/three_months';
  if (p.autoOpen) {
    const hasClinic = p.forClinic === '192' || p.forClinic === '193';
    const hasFt = p.forFirstTime === 'true' || p.forFirstTime === 'false' || p.forFirstTime === 'three_months';
    if (!hasClinic && !hasFt && !isOverride) {
      return 'autoOpen には「対象院」「対象来院」「対象既存メニュー」のうち最低1つを具体的に指定してください';
    }
  }
  if (p.customFieldLabel != null && typeof p.customFieldLabel !== 'string') {
    return 'customFieldLabel must be a string';
  }
  if (typeof p.customFieldLabel === 'string' && p.customFieldLabel.length > 60) {
    return 'customFieldLabel must be 60 characters or fewer';
  }
  if (p.customFieldPlaceholder != null && typeof p.customFieldPlaceholder !== 'string') {
    return 'customFieldPlaceholder must be a string';
  }
  return null;
}

// "Shortcut" 形を判定するヘルパー：
//   targetCourseId が指定されていて、表示用の上書き値（name/desc/price）が
//   一切ない promo は「対象コースの空き状況にユーザーを直接案内するだけ」の
//   ショートカット用途と見なす。この形のとき autoOpen は常に true として扱う。
export function isShortcutShape(p) {
  if (!p) return false;
  if (typeof p.targetCourseId !== 'number') return false;
  const hasName = typeof p.name === 'string' && p.name.trim() !== '';
  const hasDesc = typeof p.description === 'string' && p.description.trim() !== '';
  const hasPrice = typeof p.price === 'number';
  return !hasName && !hasDesc && !hasPrice;
}

export function normalizePromo(p) {
  const targetCourseId = typeof p.targetCourseId === 'number' ? p.targetCourseId : null;
  const rawName = typeof p.name === 'string' ? p.name.trim() : '';
  const rawDesc = typeof p.description === 'string' ? p.description.trim() : '';
  const rawPrice = typeof p.price === 'number' ? p.price : null;
  // shortcut 形の promo は autoOpen を強制 true に
  let autoOpen = !!p.autoOpen;
  if (isShortcutShape({ ...p, name: rawName, description: rawDesc, price: rawPrice, targetCourseId })) {
    autoOpen = true;
  }
  // 予約時の任意記入欄（例: 紹介者のお名前）。ラベルが空なら欄なし。
  const customFieldLabel = typeof p.customFieldLabel === 'string' ? p.customFieldLabel.trim() : '';
  const customFieldPlaceholder = customFieldLabel && typeof p.customFieldPlaceholder === 'string'
    ? p.customFieldPlaceholder.trim() : '';
  const customFieldRequired = customFieldLabel ? !!p.customFieldRequired : false;
  // 価格変更（override）で「通常メニューも残す」かどうか
  const keepOriginalMenu = !!p.keepOriginalMenu;
  // このキャンペーンURL経由の初回予約を新規集客用LINEに送るかどうか
  const useNewCustomerLine = !!p.useNewCustomerLine;
  // autoOpen の到達範囲: clinic（院だけ） / visit（来院まで） / course（コースまで＝既定）
  const autoOpenLevel = ['clinic', 'visit', 'course'].includes(p.autoOpenLevel)
    ? p.autoOpenLevel : 'course';
  return {
    code: String(p.code).trim(),
    name: rawName,
    description: rawDesc,
    duration: typeof p.duration === 'number' ? p.duration : null,
    price: rawPrice,
    forClinic: p.forClinic || 'both',
    forFirstTime: p.forFirstTime || 'both',
    targetCourseId,
    autoOpen,
    autoOpenLevel,
    keepOriginalMenu,
    useNewCustomerLine,
    customFieldLabel,
    customFieldRequired,
    customFieldPlaceholder,
    updatedAt: new Date().toISOString(),
  };
}
