import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi } from './app.js';
import { createAuth } from './auth.js';
import { HttpError } from './errors.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const COOKIE = 'sid';
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

const cookieOf = (req) => {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return m ? m[1] : null;
};

export function createApp(db = openDb()) {
  const api = createApi(db);
  const auth = createAuth(db);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    const setCookie = (v, maxAge) => `${COOKIE}=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    const send = (status, data, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...HEADERS, ...extra });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        let body = {};
        if (req.method !== 'GET') {
          // Perlindungan CSRF: wajib JSON & Origin (bila ada) sama dengan Host
          if (req.method !== 'DELETE' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Content-Type harus application/json');
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origin tidak diizinkan');
          let raw = '';
          for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, 'Payload terlalu besar'); }
          try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON tidak valid'); }
        }
        const token = cookieOf(req);
        if (req.method === 'POST' && url.pathname === '/api/auth/login') {
          const r = auth.login(body.username, body.password, req.socket.remoteAddress);
          return send(200, { user: r.user }, { 'Set-Cookie': setCookie(r.token, r.maxAge) });
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
          auth.logout(token);
          return send(200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
        }
        const user = auth.userFromToken(token);
        if (req.method === 'GET' && url.pathname === '/api/auth/me') return send(200, { user }); // null bila belum login
        if (!user) throw new HttpError(401, 'Silakan login');
        if (req.method === 'POST' && url.pathname === '/api/auth/ubah-password') {
          auth.ubahPassword(user, body.password_lama, body.password_baru);
          return send(200, { ok: true });
        }
        const out = api(req.method, url.pathname, Object.fromEntries(url.searchParams), body, user);
        return Array.isArray(out) && typeof out[0] === 'number' ? send(out[0], out[1]) : send(200, out);
      }
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(root, rel);
      if (!file.startsWith(root)) throw new HttpError(403, 'Dilarang');
      const data = await readFile(file).catch(() => { throw new HttpError(404, 'Tidak ditemukan'); });
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', ...HEADERS });
      res.end(data);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Kesalahan server' });
    }
  });
  server.auth = auth;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  const admin = server.auth.ensureAdmin();
  if (admin) {
    console.log(`Super admin dibuat — username: ${admin.username}${admin.generated ? `  password: ${admin.password}  (catat sekarang, tidak ditampilkan lagi)` : ''}`);
  }
  server.listen(port, () => console.log(`Stok Gudang berjalan di http://localhost:${port}`));
}
