// ローカル確認専用の簡易開発サーバー。
// 静的ファイルを配信しつつ、/api/* を Vercel 形式のサーバー関数(handler)に橋渡しする。
// .env.local を読み込んで process.env に入れる（Vercel では環境変数の設定画面で行う）。
// 本番では Vercel が同じことをするため、このファイルはデプロイ対象外（動作確認用）。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4100;

async function loadEnvLocal() {
  try {
    const text = await readFile(join(ROOT, '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']+|["']+$/g, '');
      if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch { /* .env.local が無ければ何もしない */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function wrapRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(o));
    return res;
  };
  return res;
}

async function handleApi(url, req, res) {
  // /api/availability -> ./api/availability.js / /api/admin/promos -> ./api/admin/promos.js
  const file = join(ROOT, url.pathname) + '.js';
  let mod;
  try {
    mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  } catch (e) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'api not found', detail: String(e && e.message) }));
    return;
  }
  req.query = Object.fromEntries(url.searchParams.entries());
  wrapRes(res);
  try {
    await mod.default(req, res);
    if (!res.writableEnded) res.end();
  } catch (e) {
    if (!res.headersSent) res.statusCode = 500;
    res.end(JSON.stringify({ error: 'handler threw', detail: String((e && e.stack) || e) }));
  }
}

async function handleStatic(url, res) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  let file = join(ROOT, p);
  try {
    const s = await stat(file).catch(() => null);
    if (s && s.isDirectory()) file = join(file, 'index.html'); // /admin → /admin/index.html
    const buf = await readFile(file);
    res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end('Not found: ' + p);
  }
}

await loadEnvLocal();
createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) return handleApi(url, req, res);
  return handleStatic(url, res);
}).listen(PORT, () => {
  console.log(`dev server: http://localhost:${PORT}`);
});
