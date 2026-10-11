import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi } from './app.js';
import { createAuth } from './auth.js';
import { HttpError } from './errors.js';
import { oidcFromEnv, SsoError } from './oidc.js';
import { createMailer } from './mail.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const COOKIE = 'sid';
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

const cookieOf = (req, name = COOKIE) => {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
};

// opts: { mailer, oidc, baseUrl, passwordLogin } — tanpa mailer, fitur lupa password nonaktif; tanpa oidc, SSO nonaktif.
export function createApp(db = openDb(), opts = {}) {
  const { oidc = null, mailer = null, baseUrl = 'http://localhost:3000', passwordLogin = true } = opts;
  const api = createApi(db);
  const auth = createAuth(db, { mailer, baseUrl, passwordLogin });
  const lupaPerIp = new Map(); // ip -> [waktu]
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    const setCookie = (v, maxAge) => `${COOKIE}=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    const send = (status, data, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...HEADERS, ...extra });
      res.end(JSON.stringify(data));
    };
    const redirect = (to, cookies = []) => {
      res.writeHead(302, { Location: to, 'Set-Cookie': cookies, 'Cache-Control': 'no-store', ...HEADERS });
      res.end();
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/auth/sso/login') {
        if (!oidc) throw new HttpError(404, 'SSO tidak diaktifkan');
        const { url: to, state } = await oidc.begin();
        // Lax: callback datang dari navigasi lintas-situs; cookie mengikat state ke browser ini
        return redirect(to, [`sso_s=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/sso; Max-Age=600${secure ? '; Secure' : ''}`]);
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/sso/callback') {
        if (!oidc) throw new HttpError(404, 'SSO tidak diaktifkan');
        const clear = `sso_s=; HttpOnly; SameSite=Lax; Path=/api/auth/sso; Max-Age=0${secure ? '; Secure' : ''}`;
        const gagalSso = (msg) => redirect(`/#sso-error=${encodeURIComponent(msg)}`, [clear]);
        const state = url.searchParams.get('state'), code = url.searchParams.get('code');
        if (url.searchParams.get('error')) return gagalSso('Login SSO dibatalkan atau ditolak oleh penyedia identitas');
        if (!state || !code || state !== cookieOf(req, 'sso_s')) return gagalSso('Sesi login SSO tidak valid; coba lagi');
        try {
          const r = auth.loginSso(await oidc.finish(code, state));
          return redirect('/', [clear, setCookie(r.token, r.maxAge)]);
        } catch (e) {
          if (e instanceof SsoError || e instanceof HttpError) return gagalSso(e.message);
          console.error('SSO error:', e);
          return gagalSso('Login SSO gagal; hubungi administrator');
        }
      }
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
        if (req.method === 'GET' && url.pathname === '/api/auth/config')
          return send(200, { sso: oidc ? { label: oidc.label } : null, password_login: passwordLogin, reset_password: auth.resetTersedia });
        if (req.method === 'POST' && url.pathname === '/api/auth/lupa-password') {
          if (!auth.resetTersedia) throw new HttpError(503, 'Reset password mandiri belum dikonfigurasi; hubungi administrator');
          const ip = req.socket.remoteAddress, now = Date.now();
          const hist = (lupaPerIp.get(ip) ?? []).filter((t) => t > now - 3600e3);
          if (hist.length >= 10) throw new HttpError(429, 'Terlalu banyak permintaan; coba lagi nanti');
          lupaPerIp.set(ip, [...hist, now]);
          auth.lupaPassword(body.identifier, ip);
          return send(200, { ok: true, pesan: 'Jika akun terdaftar dan memiliki email, tautan reset telah dikirim.' });
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
          auth.resetPassword(body.token, body.password_baru);
          return send(200, { ok: true });
        }
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
        if (req.method === 'GET' && url.pathname.startsWith('/api/ekspor/')) {
          const ex = await import('./export.js'); // dimuat saat pertama dipakai (exceljs & pdfkit cukup besar)
          const nama = url.pathname.slice('/api/ekspor/'.length);
          const format = url.searchParams.get('format') === 'pdf' ? 'pdf' : 'xlsx';
          const ds = ex.susunData(nama, api, Object.fromEntries(url.searchParams), user);
          const opsi = { dicetakOleh: ex.penanda(user) };
          const buf = format === 'pdf' ? await ex.toPdf(ds, opsi) : await ex.toXlsx(ds, opsi);
          auth.audit(user.id, 'ekspor', `${nama}.${format}`);
          res.writeHead(200, {
            'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${ex.NAMA_FILE(ds, user, format)}"`,
            'Content-Length': buf.length, 'Cache-Control': 'no-store', ...HEADERS,
          });
          return res.end(buf);
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
  const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const mailer = await createMailer();
  const oidc = oidcFromEnv(process.env, baseUrl);
  if (mailer.kind === 'console') console.warn('PERINGATAN: SMTP_HOST belum diisi — email reset password hanya dicetak di konsol (jangan untuk produksi).');
  if (process.env.NODE_ENV === 'production' && !process.env.BASE_URL) console.warn('PERINGATAN: BASE_URL belum diisi; tautan reset password akan mengarah ke localhost.');
  const server = createApp(openDb(), { mailer, oidc, baseUrl, passwordLogin: process.env.PASSWORD_LOGIN !== 'off' });
  const admin = server.auth.ensureAdmin();
  if (admin) {
    console.log(`Super admin dibuat — username: ${admin.username}${admin.generated ? `  password: ${admin.password}  (catat sekarang, tidak ditampilkan lagi)` : ''}`);
  }
  server.listen(port, () => console.log(`Stok Gudang berjalan di http://localhost:${port}`));
}
