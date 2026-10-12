import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../app.js';
import { createNotifier } from '../notif.js';
import { openDb, SCHEMA_VERSION } from '../db.js';
import { setup } from './helpers.js';

const JEDA = 5 * 60e3;
const jam = (h, m = 0, hari = 12) => new Date(2026, 9, hari, h, m, 0).getTime(); // waktu lokal

function siap({ digestJam = 7 } = {}) {
  const c = setup();
  const emails = { sa: 'sa@k.id', opFeb: 'op.feb@k.id', apFeb: 'ap.feb@k.id', opFt: 'op.ft@k.id', apFt: 'ap.ft@k.id' };
  for (const [k, e] of Object.entries(emails)) c.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(e, c.u[k].id);
  const surat = []; const waktu = { now: jam(8) };
  const mailer = { async send(m) { if (waktu.gagal) throw new Error('SMTP mati'); surat.push(m); } };
  const log = { error() {}, log() {} };
  const mk = () => createNotifier(c.db, { mailer, baseUrl: 'https://stok.k.id', jedaMs: JEDA, digestJam, log, sekarang: () => waktu.now });
  const notif = mk(), api = createApi(c.db, { notif, sekarang: () => waktu.now });
  const as = (u) => (m, p, b = {}, q = {}) => { const r = api(m, p, q, b, u); return Array.isArray(r) && typeof r[0] === 'number' ? r[1] : r; };
  const ke = (alamat) => surat.filter((s) => s.to === alamat);
  const maju = async (ms) => { waktu.now += ms; await notif.tick(); };
  return { c, notif, mk, as, surat, ke, waktu, maju, api };
}
const U = (c, k) => ({ ...c.u[k] });

test('kejadian beruntun digabung jadi satu email setelah jeda; pelaku dan unit lain tidak diberi tahu', async () => {
  const t = siap(); const op = t.as(t.c.u.opFeb);
  const a = op('POST', '/api/items', { kode: 'A', nama: 'Kertas A4', satuan: 'rim' });
  for (let i = 0; i < 3; i++) op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 + i });
  await t.maju(JEDA - 1000);
  assert.equal(t.surat.length, 0, 'belum lewat jeda');
  await t.maju(2000);
  assert.equal(t.surat.length, 1);
  const m = t.surat[0];
  assert.equal(m.to, 'ap.feb@k.id');
  assert.match(m.subject, /1 hal menunggu tindakan/);
  assert.match(m.text, /3 transaksi menunggu persetujuan {2}->\s+https:\/\/stok\.k\.id\/#persetujuan/);
  assert.match(m.text, /Halo ap\.feb/);
  assert.equal(t.ke('op.feb@k.id').length, 0); assert.equal(t.ke('ap.ft@k.id').length, 0); assert.equal(t.ke('sa@k.id').length, 0);
  await t.maju(JEDA * 3); assert.equal(t.surat.length, 1, 'tidak diulang tanpa kejadian baru');
  op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 }); // kejadian baru → email baru berisi hitungan terkini
  await t.maju(JEDA + 1);
  assert.equal(t.surat.length, 2); assert.match(t.surat[1].text, /4 transaksi menunggu/);
});

test('hasil keputusan sampai ke operator: disetujui dihitung, ditolak disertai alasan; approver tidak diberi tahu tentang aksinya sendiri', async () => {
  const t = siap(); const op = t.as(t.c.u.opFeb), ap = t.as(t.c.u.apFeb);
  const a = op('POST', '/api/items', { kode: 'A', nama: 'Kertas A4', satuan: 'rim' });
  const ids = [1, 2, 3].map((q) => op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: q, tanggal: '2026-10-01' }).id);
  await t.maju(JEDA + 1); t.surat.length = 0;
  ap('POST', `/api/transaksi/${ids[0]}/setujui`); ap('POST', `/api/transaksi/${ids[1]}/setujui`);
  ap('POST', `/api/transaksi/${ids[2]}/tolak`, { catatan: 'Faktur tidak ada' });
  await t.maju(JEDA + 1);
  assert.equal(t.surat.length, 1); assert.equal(t.surat[0].to, 'op.feb@k.id');
  assert.match(t.surat[0].subject, /pembaruan untuk Anda/);
  assert.match(t.surat[0].text, /2 transaksi Anda disetujui/);
  assert.match(t.surat[0].text, /1 transaksi Anda ditolak:\n\s+- 2026-10-01 Pembelian Kertas A4 x3 rim: Faktur tidak ada/);
  await t.maju(JEDA * 3); assert.equal(t.surat.length, 1);
  // hasil yang sama tidak dikirim ulang pada pemberitahuan berikutnya
  op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 }); await t.maju(JEDA + 1);
  assert.equal(t.surat.length, 2); assert.doesNotMatch(t.surat[1].text, /disetujui|ditolak/);
  assert.match(t.surat[1].text, /1 transaksi menunggu/, 'approver menerima yang baru; operator tidak');
  assert.equal(t.surat[1].to, 'ap.feb@k.id');
});

test('opname dan transfer: penerima tepat di setiap tahap', async () => {
  const t = siap(); const { c } = t;
  const feb = t.as(c.u.opFeb), apFeb = t.as(c.u.apFeb), ft = t.as(c.u.opFt), apFt = t.as(c.u.apFt);
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'Kertas', satuan: 'rim' });
  const t0 = feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 10, harga_satuan: 100 }); apFeb('POST', `/api/transaksi/${t0.id}/setujui`);
  await t.maju(JEDA + 1); t.surat.length = 0;
  const tahap = async () => { await t.maju(JEDA + 1); const to = t.surat.map((s) => s.to).sort(); t.surat.length = 0; return to; };

  const tr = feb('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 4 });
  assert.deepEqual(await tahap(), ['ap.feb@k.id'], 'ajukan → approver asal');
  apFeb('POST', `/api/transfer/${tr.id}/setujui`);
  const k = await (async () => { await t.maju(JEDA + 1); return [...t.surat]; })(); t.surat.length = 0;
  assert.deepEqual(k.map((s) => s.to).sort(), ['op.feb@k.id', 'op.ft@k.id'], 'kirim → operator tujuan (perlu menerima) & pengaju (info)');
  assert.match(k.find((s) => s.to === 'op.ft@k.id').text, /1 transfer masuk menunggu penerimaan Anda/);
  assert.match(k.find((s) => s.to === 'op.feb@k.id').text, /Transfer #1 Kertas \(FEB -> FT\) disetujui dan dikirim/);
  ft('POST', `/api/transfer/${tr.id}/terima`, { buat_item_baru: true, qty_diterima: 3, catatan: 'rusak 1' });
  assert.deepEqual(await tahap(), ['ap.ft@k.id'], 'diterima operator → approver tujuan');
  apFt('POST', `/api/transfer/${tr.id}/setujui`);
  await t.maju(JEDA + 1);
  assert.deepEqual(t.surat.map((s) => s.to).sort(), ['op.feb@k.id', 'op.ft@k.id'], 'selesai → pengaju & penerima');
  assert.match(t.surat.find((s) => s.to === 'op.feb@k.id').text, /selesai diterima \(3 dari 4\)/); t.surat.length = 0;

  const tr2 = feb('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 1 }); await tahap();
  apFeb('POST', `/api/transfer/${tr2.id}/tolak`, { catatan: 'Stok dicadangkan' });
  await t.maju(JEDA + 1); assert.deepEqual(t.surat.map((s) => s.to), ['op.feb@k.id']); assert.match(t.surat[0].text, /ditolak pengirim: Stok dicadangkan/); t.surat.length = 0;

  const o = feb('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09' });
  feb('PUT', `/api/opname/${o.id}`, { lines: [{ item_id: a.id, stok_fisik: 7 }] });
  feb('POST', `/api/opname/${o.id}/ajukan`);
  assert.deepEqual(await tahap(), ['ap.feb@k.id']);
  apFeb('POST', `/api/opname/${o.id}/kembalikan`, { catatan: 'Hitung ulang' });
  await t.maju(JEDA + 1);
  assert.deepEqual(t.surat.map((s) => s.to), ['op.feb@k.id']);
  assert.match(t.surat[0].text, /1 stok opname dikembalikan approver/); assert.match(t.surat[0].text, /Opname bulanan 2026-09 dikembalikan: Hitung ulang/); t.surat.length = 0;
  feb('POST', `/api/opname/${o.id}/ajukan`); await tahap();
  apFeb('POST', `/api/opname/${o.id}/finalisasi`);
  await t.maju(JEDA + 1); assert.match(t.surat[0].text, /Opname bulanan 2026-09 disetujui dan difinalisasi/);
});

test('mode RINGKASAN: satu email per hari pada jam yang ditentukan; MATI: tidak ada; ganti mode membatalkan penandaan', async () => {
  const t = siap(); const { c } = t;
  const feb = t.as(c.u.opFeb);
  assert.equal(t.as(c.u.apFeb)('POST', '/api/akun/notifikasi', { notif: 'RINGKASAN' }).notif, 'RINGKASAN');
  assert.throws(() => t.as(c.u.apFeb)('POST', '/api/akun/notifikasi', { notif: 'SERING' }), /tidak valid/);
  t.as(c.u.apFt)('POST', '/api/akun/notifikasi', { notif: 'MATI' });
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'A' });
  feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  t.waktu.now = jam(6); await t.notif.tick(); await t.maju(JEDA * 5);
  assert.equal(t.surat.length, 0, 'tidak langsung; belum jam ringkasan');
  t.waktu.now = jam(7, 5); await t.notif.tick();
  assert.equal(t.ke('ap.feb@k.id').length, 1); assert.match(t.surat[0].text, /1 transaksi menunggu/);
  await t.maju(3600e3); assert.equal(t.surat.length, 1, 'sekali per hari');
  t.waktu.now = jam(7, 5, 13); await t.notif.tick();
  assert.equal(t.surat.length, 2, 'hari berikutnya masih ada yang menunggu');
  // tidak ada yang menunggu → tidak ada email, tetapi hari tetap ditandai
  const apFeb = t.as(c.u.apFeb); apFeb('POST', `/api/transaksi/${feb('GET', '/api/transaksi')[0].id}/setujui`);
  t.waktu.now = jam(7, 5, 14); await t.notif.tick(); assert.equal(t.surat.length, 2);
  assert.equal(t.ke('ap.ft@k.id').length, 0, 'MATI');
  // pindah ke LANGSUNG lalu MATI: penandaan menunggu dibatalkan
  t.as(c.u.apFeb)('POST', '/api/akun/notifikasi', { notif: 'LANGSUNG' });
  feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM notif_tunda').get().n, 1);
  t.as(c.u.apFeb)('POST', '/api/akun/notifikasi', { notif: 'MATI' });
  assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM notif_tunda').get().n, 0);
});

test('gagal kirim dicoba lagi dengan jeda bertahap lalu berhenti; pengguna tanpa email/nonaktif tidak ditandai', async () => {
  const t = siap(); const { c } = t; const feb = t.as(c.u.opFeb);
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'A' });
  feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  t.waktu.gagal = true;
  await t.maju(JEDA + 1);
  assert.equal(t.surat.length, 0);
  const r = () => t.c.db.prepare('SELECT * FROM notif_tunda').get();
  assert.equal(r().percobaan, 1);
  await t.maju(30e3); assert.equal(r().percobaan, 1, 'belum waktunya (jeda 1 menit)');
  await t.maju(31e3); assert.equal(r().percobaan, 2);
  t.waktu.gagal = false; await t.maju(6 * 60e3);
  assert.equal(t.surat.length, 1, 'berhasil setelah SMTP pulih'); assert.equal(r(), undefined);
  // menyerah setelah percobaan habis
  feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 }); t.waktu.gagal = true;
  for (let i = 0; i < 8; i++) await t.maju(3 * 3600e3);
  assert.equal(r(), undefined, 'tidak mencoba selamanya');
  // tanpa email / nonaktif
  t.waktu.gagal = false; t.surat.length = 0;
  c.db.prepare('UPDATE users SET email = NULL WHERE id = ?').run(c.u.apFeb.id);
  feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  assert.equal(r(), undefined);
});

test('dua proses berebut: satu penandaan hanya menghasilkan satu email', async () => {
  const t = siap(); const feb = t.as(t.c.u.opFeb);
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'A' });
  feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  const lain = t.mk(); t.waktu.now += JEDA + 1;
  await Promise.all([t.notif.tick(), lain.tick()]);
  assert.equal(t.surat.length, 1);
  // ringkasan harian pun hanya sekali
  t.as(t.c.u.apFeb)('POST', '/api/akun/notifikasi', { notif: 'RINGKASAN' });
  t.waktu.now = jam(9, 0, 13);
  await Promise.all([t.notif.tick(), lain.tick(), t.notif.tick()]);
  assert.equal(t.surat.length, 2);
});

test('super admin tidak menerima notifikasi; tanpa notifier semua tetap berjalan', async () => {
  const t = siap(); const feb = t.as(t.c.u.opFeb);
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'A' });
  feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  await t.maju(JEDA + 1);
  assert.equal(t.ke('sa@k.id').length, 0);
  assert.equal(t.notif.susun({ ...t.c.u.sa, nama: 'sa', unit_id: null, role: 'SUPER_ADMIN' }, '2000-01-01'), null);
  // createApi tanpa notifier (mode tes lain) tidak melempar
  const polos = setup(); polos.as(polos.u.opFeb)('POST', '/api/items', { kode: 'X', nama: 'X' });
});

test('migrasi v5 → v6 menambah kolom notifikasi', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const f = join(mkdtempSync(join(tmpdir(), 'mig-')), 'v5.db');
  const a = openDb(f);
  a.exec("INSERT INTO units(kode,nama) VALUES ('A','a'); INSERT INTO users(username,nama,password_hash,role,unit_id) VALUES ('u','u','h','OPERATOR',1)");
  a.exec('ALTER TABLE users DROP COLUMN notif; ALTER TABLE users DROP COLUMN notif_terakhir; ALTER TABLE users DROP COLUMN digest_terakhir; ALTER TABLE opnames DROP COLUMN diputuskan_at; ALTER TABLE transfers DROP COLUMN updated_at; DROP TABLE notif_tunda; PRAGMA user_version = 5');
  a.close();
  const b = openDb(f);
  assert.equal(b.prepare('SELECT notif FROM users').get().notif, 'LANGSUNG');
  b.prepare('SELECT diputuskan_at FROM opnames').all(); b.prepare('SELECT updated_at FROM transfers').all(); b.prepare('SELECT * FROM notif_tunda').all();
  assert.equal(b.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
});
