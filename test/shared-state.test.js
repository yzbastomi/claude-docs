import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createAuth } from '../auth.js';
import { createOidc, sqliteStore, memoryStore } from '../oidc.js';
import { openDb } from '../db.js';
import { setup } from './helpers.js';

test('pembatas login dibagi antar-instance (dua createAuth pada DB yang sama)', () => {
  const c = setup();
  const a = c.auth, b = createAuth(c.db); // dua "proses" dengan DB yang sama
  for (let i = 0; i < 5; i++) assert.throws(() => a.login('op.feb', 'salah', '1.2.3.4'), (e) => e.status === 401);
  assert.throws(() => b.login('op.feb', 'rahasia123', '1.2.3.4'), (e) => e.status === 429, 'instance lain ikut terkunci');
  assert.ok(b.login('op.feb', 'rahasia123', '9.9.9.9').token, 'IP lain tidak terkunci');
  assert.equal(a.hit('lupa|x', 1000), 1); assert.equal(b.hit('lupa|x', 1000), 2);
  c.db.prepare("UPDATE rate_limit SET sampai = 1 WHERE kunci = 'lupa|x'").run();
  assert.equal(a.hit('lupa|x', 1000), 1, 'jendela kedaluwarsa dimulai ulang');
});

test('berkas DB memakai WAL dan busy_timeout; dua koneksi dapat menulis bergantian', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'wal-')), 's.db');
  const a = openDb(f), b = openDb(f);
  assert.equal(a.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(a.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  a.prepare("INSERT INTO units (kode, nama) VALUES ('A','a')").run();
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM units').get().n, 1);
  b.prepare("INSERT INTO units (kode, nama) VALUES ('B','b')").run();
  assert.equal(a.prepare('SELECT COUNT(*) AS n FROM units').get().n, 2);
});

async function idp() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k', use: 'sig' };
  const st = { nonce: '' };
  const srv = createServer((req, res) => {
    const o = `http://127.0.0.1:${srv.address().port}`, j = (x) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(x)); };
    if (req.url.endsWith('openid-configuration')) return j({ issuer: o, authorization_endpoint: o + '/a', token_endpoint: o + '/t', jwks_uri: o + '/j' });
    if (req.url === '/j') return j({ keys: [jwk] });
    req.resume(); req.on('end', () => {
      const b = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
      const h = b({ alg: 'RS256', kid: 'k' }), p = b({ iss: o, aud: 'cid', exp: Math.floor(Date.now() / 1000) + 300, nonce: st.nonce, email: 'budi@kampus.ac.id' });
      j({ id_token: `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url')}` });
    });
  });
  await new Promise((r) => srv.listen(0, r));
  return { st, issuer: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('state SSO di SQLite: login dimulai di instance A dapat diselesaikan di instance B, tetapi hanya sekali', async () => {
  const server = await idp(); const c = setup();
  const cfg = { issuer: server.issuer, clientId: 'cid', clientSecret: 's', redirectUri: 'http://app/cb', scopes: 'openid email', emailClaim: 'email', allowedDomains: [], label: 'SSO' };
  const A = createOidc(cfg, fetch, sqliteStore(c.db)), B = createOidc(cfg, fetch, sqliteStore(c.db));
  const { url, state } = await A.begin();
  server.st.nonce = new URL(url).searchParams.get('nonce');
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM sso_state').get().n, 1);
  assert.equal(await B.finish('kode', state), 'budi@kampus.ac.id');
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM sso_state').get().n, 0, 'state terpakai habis');
  await assert.rejects(() => A.finish('kode', state), /tidak valid atau kedaluwarsa/);
  // state kedaluwarsa dibersihkan & ditolak
  const s2 = (await A.begin()).state;
  c.db.prepare('UPDATE sso_state SET expires_at = 1').run();
  await assert.rejects(() => B.finish('kode', s2), /tidak valid atau kedaluwarsa/);
  // memoryStore tetap per-proses (perilaku lama)
  const M1 = createOidc(cfg, fetch, memoryStore()), M2 = createOidc(cfg, fetch, memoryStore());
  const m = await M1.begin();
  await assert.rejects(() => M2.finish('kode', m.state), /tidak valid atau kedaluwarsa/);
  server.close();
});
