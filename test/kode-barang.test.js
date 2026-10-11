import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { formatKode, normalisasi } from '../kodebarang.js';

const pohon = (sa) => {
  sa('POST', '/api/kode-barang', { kode: '1', uraian: 'Persediaan' });
  sa('POST', '/api/kode-barang', { kode: '1.01', uraian: 'Barang Konsumsi' }); // titik diabaikan, 3 digit = bidang
  sa('POST', '/api/kode-barang', { kode: '10101', uraian: 'Bahan' });
  sa('POST', '/api/kode-barang', { kode: '1010101', uraian: 'Alat Tulis Kantor' });
  return sa('POST', '/api/kode-barang', { kode: '1.01.01.01.001', uraian: 'Kertas HVS' });
};
const err = (fn, re) => assert.throws(fn, (e) => re.test(e.message) && e.status === 400);

test('format & normalisasi kode', () => {
  assert.equal(formatKode('1010101001'), '1.01.01.01.001');
  assert.equal(formatKode('10101'), '1.01.01');
  assert.equal(formatKode('1'), '1');
  assert.equal(normalisasi(' 1.01 01-01 001 '), '1010101001');
});

test('super admin membangun pohon kode; level & induk divalidasi', () => {
  const c = setup(); const sa = c.as(c.u.sa);
  err(() => sa('POST', '/api/kode-barang', { kode: '1010101001', uraian: 'x' }), /Tingkat induk 1\.01\.01\.01 .*belum ada/);
  const r = pohon(sa);
  assert.equal(r.kode, '1010101001'); assert.equal(r.level, 5);
  assert.equal(sa('GET', '/api/kode-barang', {}, { level: '1' }).rows[0].uraian, 'Persediaan');
  err(() => sa('POST', '/api/kode-barang', { kode: '1010101001', uraian: 'dobel' }), /sudah ada/);
  err(() => sa('POST', '/api/kode-barang', { kode: '10101010', uraian: 'x' }), /Panjang kode 8 digit/);
  err(() => sa('POST', '/api/kode-barang', { kode: '10A', uraian: 'x' }), /hanya boleh berisi angka/);
  err(() => sa('POST', '/api/kode-barang', { kode: '3', uraian: 'Peralatan' }), /diawali golongan 1/);
  err(() => sa('POST', '/api/kode-barang', { kode: '10102', uraian: '' }), /Uraian wajib/);
  assert.equal(sa('GET', '/api/kode-barang', {}, { induk: '10101' }).rows.length, 2);
  assert.equal(sa('GET', '/api/kode-barang', {}, { q: '1.01.01.01' }).rows.length, 2, 'pencarian kode dengan titik');
  assert.equal(sa('GET', '/api/kode-barang', {}, { q: 'kertas' }).rows[0].kode, '1010101001');
  assert.equal(sa('GET', '/api/kode-barang', {}, { q: '100%' }).rows.length, 0, 'wildcard LIKE di-escape');
});

test('hanya super admin yang boleh mengubah; semua peran boleh membaca', () => {
  const c = setup(); const sa = c.as(c.u.sa); pohon(sa);
  for (const u of [c.u.opFeb, c.u.apFeb]) {
    const as = c.as(u);
    assert.equal(as('GET', '/api/kode-barang', {}, { level: '5', aktif: '1' }).rows.length, 1);
    for (const [m, p, b] of [['POST', '/api/kode-barang', { kode: '10102', uraian: 'x' }], ['PUT', '/api/kode-barang/1010101001', { uraian: 'x' }],
      ['DELETE', '/api/kode-barang/1010101001', {}], ['POST', '/api/kode-barang/impor', { teks: '10103;x' }]])
      assert.throws(() => as(m, p, b), (e) => e.status === 403, `${u.username} ${m} ${p}`);
  }
  assert.throws(() => c.as(null)('GET', '/api/kode-barang'), (e) => e.status === 401);
});

test('barang dipasangkan ke kode 10 digit: validasi, nonaktif, kosongkan, dan salin saat transfer', () => {
  const c = setup(); const sa = c.as(c.u.sa), op = c.as(c.u.opFeb);
  pohon(sa);
  const a = op('POST', '/api/items', { kode: 'ATK-1', nama: 'Kertas', kode_barang: '1.01.01.01.001' });
  assert.equal(a.kode_barang, '1010101001'); assert.equal(a.kode_barang_uraian, 'Kertas HVS');
  err(() => op('POST', '/api/items', { kode: 'X', nama: 'X', kode_barang: '10101' }), /tidak ada di referensi \(harus 10 digit\)/);
  err(() => op('POST', '/api/items', { kode: 'X', nama: 'X', kode_barang: '1010101999' }), /tidak ada di referensi/);
  assert.equal(op('POST', '/api/items', { kode: 'Y', nama: 'Y' }).kode_barang, null, 'opsional');
  // PUT tanpa kolom = tidak berubah; kosong = hapus
  assert.equal(op('PUT', `/api/items/${a.id}`, { kode: 'ATK-1', nama: 'Kertas 2' }).kode_barang, '1010101001');
  sa('PUT', '/api/kode-barang/1010101001', { uraian: 'Kertas HVS', aktif: false });
  err(() => op('POST', '/api/items', { kode: 'Z', nama: 'Z', kode_barang: '1010101001' }), /nonaktif/);
  assert.equal(op('PUT', `/api/items/${a.id}`, { kode: 'ATK-1', nama: 'Kertas 3', kode_barang: '1010101001' }).kode_barang, '1010101001', 'barang lama tetap boleh menyimpan');
  // transfer dengan barang baru menyalin kode barang
  const apFeb = c.as(c.u.apFeb), ft = c.as(c.u.opFt);
  const t0 = op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 5, harga_satuan: 1000 });
  apFeb('POST', `/api/transaksi/${t0.id}/setujui`);
  const tr = op('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 2 });
  apFeb('POST', `/api/transfer/${tr.id}/setujui`);
  ft('POST', `/api/transfer/${tr.id}/terima`, { buat_item_baru: true });
  assert.equal(ft('GET', '/api/items')[0].kode_barang, '1010101001');
  assert.equal(op('PUT', `/api/items/${a.id}`, { kode: 'ATK-1', nama: 'Kertas', kode_barang: '' }).kode_barang, null);
});

test('hapus: ditolak bila punya turunan atau dipakai; ubah uraian tidak mengubah kode', () => {
  const c = setup(); const sa = c.as(c.u.sa), op = c.as(c.u.opFeb); pohon(sa);
  err(() => sa('DELETE', '/api/kode-barang/1010101'), /1 kode turunan/);
  op('POST', '/api/items', { kode: 'A', nama: 'A', kode_barang: '1010101001' });
  err(() => sa('DELETE', '/api/kode-barang/1010101001'), /Dipakai oleh 1 barang/);
  const r = sa('PUT', '/api/kode-barang/1010101001', { uraian: 'Kertas HVS A4' });
  assert.equal(r.uraian, 'Kertas HVS A4'); assert.equal(r.kode, '1010101001'); assert.equal(r.dipakai, 1);
  op('PUT', `/api/items/${op('GET', '/api/items')[0].id}`, { kode: 'A', nama: 'A', kode_barang: '' });
  sa('DELETE', '/api/kode-barang/1010101001');
  assert.throws(() => sa('GET', '/api/kode-barang/1010101001'), (e) => e.status === 404);
  sa('DELETE', '/api/kode-barang/1010101'); // kini tidak punya turunan
});

test('impor massal: urutan bebas, header/pemisah beragam, duplikat dilewati, atomik bila ada galat', () => {
  const c = setup(); const sa = c.as(c.u.sa);
  const teks = ['kode;uraian', '1.01.01.01.001;"Kertas HVS"', '1;Persediaan', '101,Barang Konsumsi', '10101\tBahan', '1010101 Alat Tulis Kantor', '', '1010101002;Pulpen'].join('\n');
  assert.deepEqual(sa('POST', '/api/kode-barang/impor', { teks }), { ditambahkan: 6, dilewati: 0 });
  assert.equal(sa('GET', '/api/kode-barang/1010101001').uraian, 'Kertas HVS');
  assert.deepEqual(sa('POST', '/api/kode-barang/impor', { teks: '1;Lain\n1010101003;Spidol' }), { ditambahkan: 1, dilewati: 1 });
  assert.equal(sa('GET', '/api/kode-barang/1').uraian, 'Persediaan', 'duplikat tidak menimpa');
  // satu baris salah -> tidak ada yang tersimpan
  const sebelum = sa('GET', '/api/kode-barang').rows.length;
  err(() => sa('POST', '/api/kode-barang/impor', { teks: '1010101004;Baik\n2020202020;Salah golongan\n9999;Panjang salah\nbukan data\n1010199001;Induk hilang' }),
    /tidak ada data yang disimpan\. 4 masalah[\s\S]*Baris 2[\s\S]*Baris 3[\s\S]*Baris 4[\s\S]*Baris 5: induk 1\.01\.01\.99 tidak ada/);
  assert.equal(sa('GET', '/api/kode-barang').rows.length, sebelum);
  err(() => sa('POST', '/api/kode-barang/impor', { teks: '10101;a\n10101;b' }), /ganda dalam berkas/);
  err(() => sa('POST', '/api/kode-barang/impor', { teks: '' }), /Tidak ada data/);
});

test('migrasi dari skema v3 menambah kolom kode_barang tanpa menghapus data', async () => {
  const { openDb } = await import('../db.js');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const f = join(mkdtempSync(join(tmpdir(), 'mig-')), 'v3.db');
  // bangun database v4 sungguhan, lalu turunkan ke bentuk v3 (tanpa kode_barang) dan beri data
  const awal = openDb(f);
  awal.exec("INSERT INTO units(kode,nama) VALUES ('FEB','x'); INSERT INTO items(unit_id,kode,nama) VALUES (1,'A','Barang A')");
  awal.exec('DROP INDEX idx_items_kb; ALTER TABLE items DROP COLUMN kode_barang; DROP TABLE kode_barang; PRAGMA user_version = 3');
  awal.close();
  const db = openDb(f);
  assert.equal(db.prepare('SELECT nama, kode_barang FROM items').get().nama, 'Barang A');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  db.prepare("INSERT INTO kode_barang(kode, level, uraian) VALUES ('1',1,'P')").run();
  assert.throws(() => db.prepare("INSERT INTO kode_barang(kode, level, uraian) VALUES ('12',2,'salah')").run(), /CHECK/);
});

test('migrasi v4 → v5 menambah kolom penerimaan sebagian pada transfer', async () => {
  const { openDb } = await import('../db.js');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const f = join(mkdtempSync(join(tmpdir(), 'mig-')), 'v4.db');
  const awal = openDb(f);
  awal.exec("INSERT INTO units(kode,nama) VALUES ('A','a'),('B','b'); INSERT INTO items(unit_id,kode,nama) VALUES (1,'X','x'); INSERT INTO transfers(unit_asal_id,unit_tujuan_id,item_asal_id,qty,tanggal,status) VALUES (1,2,1,5,'2026-01-01','DIPERIKSA')");
  awal.exec('ALTER TABLE transfers DROP COLUMN qty_diterima; ALTER TABLE transfers DROP COLUMN catatan_penerimaan; PRAGMA user_version = 4');
  awal.close();
  const db = openDb(f);
  const r = db.prepare('SELECT qty, qty_diterima, catatan_penerimaan FROM transfers').get();
  assert.equal(r.qty, 5); assert.equal(r.qty_diterima, null); assert.equal(r.catatan_penerimaan, '');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
});
