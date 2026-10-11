import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { setup } from './helpers.js';

async function boot() {
  const c = setup();
  const server = createApp(c.db);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...headers }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  return { c, server, call, base, close: () => server.close() };
}

test('login, sesi cookie, logout', async () => {
  const t = await boot();
  assert.equal((await t.call('GET', '/api/items')).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'salah' })).status, 401);
  const ok = await t.call('POST', '/api/auth/login', { username: 'OP.FEB', password: 'rahasia123' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(ok.body.user.role, 'OPERATOR');
  assert.equal(ok.body.user.password_hash, undefined);
  assert.equal((await t.call('GET', '/api/auth/me')).body.user.unit_kode, 'FEB');
  assert.equal((await t.call('GET', '/api/items')).status, 200);
  assert.equal((await t.call('GET', '/api/users')).status, 403);
  await t.call('POST', '/api/auth/logout', {});
  assert.equal((await t.call('GET', '/api/items')).status, 401);
  t.close();
});

test('percobaan gagal berulang dikunci; pengguna nonaktif tidak bisa login & sesinya dicabut', async () => {
  const t = await boot();
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/login', { username: 'ap.feb', password: 'x' });
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'ap.feb', password: 'rahasia123' })).status, 429);
  await t.call('POST', '/api/auth/login', { username: 'op.ft', password: 'rahasia123' });
  assert.equal((await t.call('GET', '/api/items')).status, 200);
  t.c.db.prepare('UPDATE users SET aktif = 0 WHERE username = ?').run('op.ft');
  assert.equal((await t.call('GET', '/api/items')).status, 401);
  t.close();
});

test('ubah password; CSRF: Content-Type & Origin diperiksa', async () => {
  const t = await boot();
  await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'rahasia123' });
  assert.equal((await t.call('POST', '/api/auth/ubah-password', { password_lama: 'salah', password_baru: 'barubaru123' })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/ubah-password', { password_lama: 'rahasia123', password_baru: 'barubaru123' })).status, 200);
  const evil = await t.call('POST', '/api/items', { kode: 'Z', nama: 'Z' }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  const txt = await t.call('POST', '/api/items', { kode: 'Z', nama: 'Z' }, { 'Content-Type': 'text/plain' });
  assert.equal(txt.status, 415);
  await t.call('POST', '/api/auth/logout', {});
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'rahasia123' })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { username: 'op.feb', password: 'barubaru123' })).status, 200);
  t.close();
});

test('super admin pertama dibuat sekali saja', () => {
  const c = setup();
  assert.equal(c.auth.ensureAdmin(), null, 'sudah ada pengguna');
});
