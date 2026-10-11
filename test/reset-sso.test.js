import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { createApp } from '../server.js';
import { createOidc } from '../oidc.js';
import { setup } from './helpers.js';

async function boot(opts = {}) {
  const c = setup();
  c.db.prepare("UPDATE users SET email = 'budi@kampus.ac.id' WHERE username = 'op.feb'").run();
  c.db.prepare("UPDATE users SET email = 'ani@kampus.ac.id' WHERE username = 'ap.feb'").run();
  c.db.prepare("UPDATE users SET email = 'admin@kampus.ac.id' WHERE username = 'sa'").run();
  const server = createApp(c.db, opts);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...headers }, body: body && JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() ?? [];
    for (const x of sc) if (x.startsWith('sid=')) cookie = x.split(';')[0].endsWith('=') ? '' : x.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers, setCookie: sc };
  };
  return { c, server, call, base, close: () => server.close(), setCookie: (v) => (cookie = v) };
}
const mailerPalsu = () => { const kirim = []; return { kirim, kind: 'palsu', send: async (m) => { kirim.push(m); } }; };
const tokenDari = (m) => m.text.match(/token=([a-f0-9]+)/)[1];

test('lupa & reset password: tautan sekali pakai, sesi dicabut, tidak membocorkan akun', async () => {
  const mailer = mailerPalsu(); const t = await boot({ mailer, baseUrl: 'https://stok.kampus.ac.id' });
  assert.equal((await t.call('GET', '/api/auth/config')).body.reset_password, true);
  assert.equal((await t.call('POST', '/api/auth/lupa-password', { identifier: 'tidak.ada' })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/lupa-password', { identifier: 'op.ft' })).status, 200); // akun tanpa email
  assert.equal(mailer.kirim.length, 0);

  await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'rahasia123' });
  assert.equal((await t.call('GET', '/api/items')).status, 200);
  assert.equal((await t.call('POST', '/api/auth/lupa-password', { identifier: 'BUDI@kampus.ac.id' })).status, 200);
  assert.equal(mailer.kirim.length, 1);
  assert.equal(mailer.kirim[0].to, 'budi@kampus.ac.id');
  assert.match(mailer.kirim[0].text, /^.*https:\/\/stok\.kampus\.ac\.id\/#reset\?token=[a-f0-9]{64}/m);
  const tok1 = tokenDari(mailer.kirim[0]);

  await t.call('POST', '/api/auth/lupa-password', { identifier: 'op.feb' }); // permintaan baru membatalkan tautan lama
  const tok2 = tokenDari(mailer.kirim[1]);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { token: tok1, password_baru: 'passwordbaru1' })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { token: tok2, password_baru: 'pendek' })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { token: tok2, password_baru: 'passwordbaru1' })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { token: tok2, password_baru: 'passwordlain2' })).status, 400, 'sekali pakai');
  assert.equal((await t.call('GET', '/api/items')).status, 401, 'sesi lama dicabut');
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'rahasia123' })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'passwordbaru1' })).status, 200);
  t.close();
});

test('reset: token kedaluwarsa ditolak, batas 3 permintaan/jam per akun, tanpa mailer → 503', async () => {
  const mailer = mailerPalsu(); const t = await boot({ mailer });
  await t.call('POST', '/api/auth/lupa-password', { identifier: 'ap.feb' });
  t.c.db.prepare('UPDATE password_resets SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { token: tokenDari(mailer.kirim[0]), password_baru: 'passwordbaru1' })).status, 400);
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/lupa-password', { identifier: 'ap.feb' });
  assert.equal(mailer.kirim.length, 3);
  t.close();
  const polos = await boot();
  assert.equal((await polos.call('POST', '/api/auth/lupa-password', { identifier: 'x' })).status, 503);
  assert.equal((await polos.call('GET', '/api/auth/config')).body.reset_password, false);
  polos.close();
});

test('super admin mengatur email pengguna; email unik; password login nonaktif untuk non-super-admin', async () => {
  const t = await boot({ passwordLogin: false });
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'rahasia123' })).status, 403);
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'sa', password: 'rahasia123' })).status, 200, 'super admin tetap bisa (break-glass)');
  const dup = await t.call('PUT', `/api/users/${t.c.u.opFt.id}`, { nama: 'x', role: 'OPERATOR', unit_id: t.c.ft, email: 'BUDI@kampus.ac.id' });
  assert.equal(dup.status, 400);
  const ok = await t.call('PUT', `/api/users/${t.c.u.opFt.id}`, { nama: 'x', role: 'OPERATOR', unit_id: t.c.ft, email: 'Citra@Kampus.ac.id' });
  assert.equal(ok.body.email, 'citra@kampus.ac.id');
  assert.equal((await t.call('PUT', `/api/users/${t.c.u.opFt.id}`, { nama: 'x', role: 'OPERATOR', unit_id: t.c.ft, email: 'bukan-email' })).status, 400);
  t.close();
});

// ---------- SSO dengan IdP tiruan (menandatangani id_token RS256 sungguhan) ----------
async function idpTiruan() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const salah = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const st = { claims: {}, nonce: '', challenge: '', pakaiKunciSalah: false, tokenDipanggil: 0 };
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/.well-known/openid-configuration')
      return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks` });
    if (req.url === '/jwks') return json({ keys: [jwk] });
    if (req.url === '/token') {
      let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
        st.tokenDipanggil++;
        const f = new URLSearchParams(raw);
        if (createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== st.challenge) { res.statusCode = 400; return json({ error: 'pkce' }); }
        const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const head = b({ alg: 'RS256', kid: 'k1' }), pay = b({ iss: origin, aud: f.get('client_id'), exp: Math.floor(Date.now() / 1000) + 300, nonce: st.nonce, ...st.claims });
        const sig = createSign('RSA-SHA256').update(`${head}.${pay}`).sign(st.pakaiKunciSalah ? salah : privateKey).toString('base64url');
        json({ id_token: `${head}.${pay}.${sig}`, access_token: 'x', token_type: 'Bearer' });
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, r));
  return { st, issuer: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function jalankanSso(t, idp, claims, mod = {}) {
  idp.st.claims = claims; idp.st.pakaiKunciSalah = !!mod.kunciSalah;
  const login = await t.call('GET', '/api/auth/sso/login');
  assert.equal(login.status, 302);
  const auth = new URL(login.headers.get('location'));
  const state = auth.searchParams.get('state');
  idp.st.nonce = mod.nonce ?? auth.searchParams.get('nonce'); idp.st.challenge = auth.searchParams.get('code_challenge');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(login.setCookie[0], /sso_s=.*HttpOnly; SameSite=Lax/);
  const cookie = mod.tanpaCookie ? '' : `sso_s=${mod.cookieState ?? state}`;
  const cb = await t.call('GET', `/api/auth/sso/callback?code=abc&state=${state}`, undefined, { Cookie: cookie });
  return { cb, loc: cb.headers.get('location'), state };
}

test('SSO OIDC: pengguna terdaftar masuk; peran/unit dari aplikasi; semua kegagalan ditolak', async () => {
  const idp = await idpTiruan();
  const oidc = createOidc({ issuer: idp.issuer, clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://app/cb', scopes: 'openid email', emailClaim: 'email', allowedDomains: ['kampus.ac.id'], label: 'SSO' });
  const t = await boot({ oidc });
  assert.equal((await t.call('GET', '/api/auth/config')).body.sso.label, 'SSO');

  const ok = await jalankanSso(t, idp, { email: 'Budi@Kampus.ac.id', email_verified: true });
  assert.equal(ok.cb.status, 302); assert.equal(ok.loc, '/');
  const sid = ok.cb.setCookie.find((x) => x.startsWith('sid='));
  assert.match(sid, /HttpOnly; SameSite=Strict/);
  t.setCookie(sid.split(';')[0]);
  const me = (await t.call('GET', '/api/auth/me')).body.user;
  assert.equal(me.username, 'op.feb'); assert.equal(me.role, 'OPERATOR'); assert.equal(me.unit_kode, 'FEB');

  const gagal = async (claims, mod, pola) => {
    t.setCookie('');
    const r = await jalankanSso(t, idp, claims, mod);
    assert.match(decodeURIComponent(r.loc), pola);
    assert.ok(!r.cb.setCookie.some((x) => x.startsWith('sid=') && !x.startsWith('sid=;')), 'tidak boleh ada sesi');
  };
  await gagal({ email: 'orang@kampus.ac.id' }, {}, /belum terdaftar/);
  await gagal({ email: 'budi@gmail.com' }, {}, /Domain/);
  await gagal({ email: 'budi@kampus.ac.id', email_verified: false }, {}, /belum terverifikasi/);
  await gagal({ email: 'budi@kampus.ac.id' }, { nonce: 'lain' }, /Nonce/);
  await gagal({ email: 'budi@kampus.ac.id' }, { kunciSalah: true }, /Tanda tangan/);
  await gagal({ email: 'budi@kampus.ac.id', aud: 'klien-lain' }, {}, /Audience/);
  await gagal({ email: 'budi@kampus.ac.id', exp: 1 }, {}, /kedaluwarsa/);
  const sebelum = idp.st.tokenDipanggil;
  await gagal({ email: 'budi@kampus.ac.id' }, { tanpaCookie: true }, /tidak valid/);
  await gagal({ email: 'budi@kampus.ac.id' }, { cookieState: 'state-lain' }, /tidak valid/);
  assert.equal(idp.st.tokenDipanggil, sebelum, 'tanpa state yang cocok IdP tidak dihubungi');

  // pengguna nonaktif tidak bisa masuk via SSO
  t.c.db.prepare("UPDATE users SET aktif = 0 WHERE username = 'op.feb'").run();
  await gagal({ email: 'budi@kampus.ac.id' }, {}, /belum terdaftar/);
  // state sekali pakai
  t.c.db.prepare("UPDATE users SET aktif = 1 WHERE username = 'op.feb'").run();
  const r = await jalankanSso(t, idp, { email: 'budi@kampus.ac.id' });
  const ulang = await t.call('GET', `/api/auth/sso/callback?code=abc&state=${r.state}`, undefined, { Cookie: `sso_s=${r.state}` });
  assert.match(decodeURIComponent(ulang.headers.get('location')), /tidak valid/);
  t.close(); idp.close();
});

test('SSO nonaktif → 404; issuer non-https ditolak', async () => {
  const t = await boot();
  assert.equal((await t.call('GET', '/api/auth/sso/login')).status, 404);
  assert.equal((await t.call('GET', '/api/auth/config')).body.sso, null);
  t.close();
  assert.throws(() => createOidc({ issuer: 'http://idp.kampus.ac.id', clientId: 'a', clientSecret: 'b' }), /https/);
});
