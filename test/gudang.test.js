import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, catat, hari } from './helpers.js';
import { openDb, SCHEMA_VERSION } from '../db.js';

const err = (fn, re, status = 400) => assert.throws(fn, (e) => re.test(e.message) && e.status === status, String(re));
const forbid = (fn) => assert.throws(fn, (e) => e.status === 403);

function siap() {
  const c = setup();
  const feb = c.as(c.u.opFeb), apFeb = c.as(c.u.apFeb), ft = c.as(c.u.opFt), apFt = c.as(c.u.apFt), sa = c.as(c.u.sa);
  const utamaFeb = feb('GET', '/api/gudang')[0];
  const gd2 = feb('POST', '/api/gudang', { kode: 'gd2', nama: 'Gudang Dua' });
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'Kertas', satuan: 'rim' });
  const masuk = (qty, gudang_id, harga = 1000, extra = {}) => catat(c, { kategori: 'pembelian', item_id: a.id, qty, harga_satuan: harga, gudang_id, ...extra });
  const stokDi = (as, gid, item = a) => as('GET', '/api/items', {}, { gudang_id: gid }).find((i) => i.id === item.id).stok_gudang;
  return { c, feb, apFeb, ft, apFt, sa, utamaFeb, gd2, a, masuk, stokDi };
}

test('setiap unit punya satu gudang utama (juga unit baru lewat API); master gudang dikelola operator unit', () => {
  const { c, feb, apFeb, ft, sa, utamaFeb, gd2 } = siap();
  assert.equal(utamaFeb.kode, 'UTAMA'); assert.equal(utamaFeb.utama, 1);
  assert.equal(gd2.kode, 'GD2'); assert.equal(gd2.utama, 0); assert.equal(gd2.unit_kode, 'FEB');
  const baru = sa('POST', '/api/unit', { kode: 'fk', nama: 'Kedokteran' });
  assert.deepEqual(sa('GET', '/api/gudang', {}, { unit_id: baru.id }).map((g) => [g.kode, g.utama]), [['UTAMA', 1]]);
  assert.deepEqual(feb('GET', '/api/gudang').map((g) => g.kode), ['UTAMA', 'GD2'], 'staf hanya melihat gudang unitnya');
  assert.equal(ft('GET', '/api/gudang').length, 1);
  assert.equal(sa('GET', '/api/gudang').length, 4);
  err(() => feb('POST', '/api/gudang', { kode: 'GD2', nama: 'x' }), /sudah dipakai/);
  err(() => feb('POST', '/api/gudang', { kode: 'a b', nama: 'x' }), /Kode gudang/);
  err(() => feb('POST', '/api/gudang', { kode: 'OK', nama: '' }), /Nama gudang/);
  ft('POST', '/api/gudang', { kode: 'GD2', nama: 'milik FT' }); // kode sama boleh di unit lain
  forbid(() => apFeb('POST', '/api/gudang', { kode: 'X', nama: 'x' }));
  forbid(() => sa('POST', '/api/gudang', { kode: 'X', nama: 'x' }));
  assert.throws(() => ft('PUT', `/api/gudang/${gd2.id}`, { nama: 'dibajak' }), (e) => e.status === 404);
  assert.equal(feb('PUT', `/api/gudang/${gd2.id}`, { nama: 'Gudang Belakang' }).nama, 'Gudang Belakang');
  // utama berpindah; selalu tepat satu
  const g = feb('PUT', `/api/gudang/${gd2.id}`, { utama: true });
  assert.equal(g.utama, 1);
  assert.deepEqual(feb('GET', '/api/gudang').map((x) => [x.kode, x.utama]), [['GD2', 1], ['UTAMA', 0]]);
  err(() => feb('PUT', `/api/gudang/${gd2.id}`, { utama: false }), /selalu punya satu gudang utama/);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM gudang WHERE unit_id = ? AND utama = 1').get(c.feb).n, 1);
});

test('transaksi per gudang: default utama, stok keluar dibatasi per gudang, rincian per gudang pada daftar barang', () => {
  const { feb, apFeb, utamaFeb, gd2, a, masuk, stokDi } = siap();
  masuk(10, undefined); masuk(5, gd2.id, 3000);
  const [it] = feb('GET', '/api/items');
  assert.equal(it.stok, 15, 'stok = total semua gudang');
  assert.deepEqual(it.per_gudang.map((g) => [g.gudang_kode, g.stok]), [['UTAMA', 10], ['GD2', 5]]);
  assert.equal(stokDi(feb, utamaFeb.id), 10); assert.equal(stokDi(feb, gd2.id), 5);
  assert.equal(it.harga_rata, (10 * 1000 + 5 * 3000) / 15, 'harga rata-rata tetap per barang');
  // total cukup, tetapi gudang GD2 hanya 5
  err(() => feb('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 8, gudang_id: gd2.id }), /Stok tersedia di gudang GD2 hanya 5/);
  const t = feb('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 8 }); // default = utama (10)
  apFeb('POST', `/api/transaksi/${t.id}/setujui`);
  assert.equal(stokDi(feb, utamaFeb.id), 2);
  // dua pemakaian menunggu pada GD2 yang masing-masing wajar → yang kedua gagal disetujui di GD2
  const p1 = feb('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 4, gudang_id: gd2.id });
  const p2 = feb('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 4, gudang_id: gd2.id });
  apFeb('POST', `/api/transaksi/${p1.id}/setujui`);
  err(() => apFeb('POST', `/api/transaksi/${p2.id}/setujui`), /negatif di gudang GD2/);
  assert.equal(stokDi(feb, gd2.id), 1);
  // kategori sistem tidak bisa dibuat manual; gudang unit lain / nonaktif ditolak
  err(() => feb('POST', '/api/transaksi', { kategori: 'mutasi_masuk', item_id: a.id, qty: 1 }), /Kategori transaksi tidak valid/);
  err(() => feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1, gudang_id: 99999 }), /Gudang tidak ditemukan/, 404);
  const tx = feb('GET', '/api/transaksi', {}, { gudang_id: gd2.id });
  assert.ok(tx.length >= 2 && tx.every((x) => x.gudang_kode === 'GD2'));
});

test('gudang unit lain tidak dapat dipakai; menonaktifkan gudang dibatasi', () => {
  const { c, feb, ft, apFeb, utamaFeb, gd2, a, masuk } = siap();
  const gFt = ft('GET', '/api/gudang')[0];
  err(() => feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1, gudang_id: gFt.id }), /Gudang tidak ditemukan/, 404);
  err(() => feb('PUT', `/api/gudang/${utamaFeb.id}`, { aktif: false }), /Gudang utama tidak dapat dinonaktifkan/);
  masuk(3, gd2.id);
  err(() => feb('PUT', `/api/gudang/${gd2.id}`, { aktif: false }), /1 barang berstok/);
  const pk = feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: gd2.id, gudang_tujuan_id: utamaFeb.id, qty: 3 });
  apFeb('POST', `/api/mutasi/${pk.id}/setujui`);
  const mnt = feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1, gudang_id: gd2.id });
  err(() => feb('PUT', `/api/gudang/${gd2.id}`, { aktif: false }), /1 transaksi\/mutasi menunggu/);
  feb('DELETE', `/api/transaksi/${mnt.id}`);
  assert.equal(feb('PUT', `/api/gudang/${gd2.id}`, { aktif: false }).aktif, 0);
  err(() => feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1, gudang_id: gd2.id }), /nonaktif/);
  err(() => feb('PUT', `/api/gudang/${gd2.id}`, { utama: true }), /nonaktif/);
  // hapus: hanya yang belum punya riwayat
  err(() => feb('DELETE', `/api/gudang/${gd2.id}`), /riwayat/);
  err(() => feb('DELETE', `/api/gudang/${utamaFeb.id}`), /utama tidak dapat dihapus/);
  const g3 = feb('POST', '/api/gudang', { kode: 'G3', nama: 'Baru' });
  assert.deepEqual(feb('DELETE', `/api/gudang/${g3.id}`), { ok: true });
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM gudang WHERE id = ?').get(g3.id).n, 0);
});

test('mutasi antar gudang: dua transaksi tertaut, stok pindah, nilai persediaan tetap, harga rata-rata tidak berubah', () => {
  const { c, feb, apFeb, ft, utamaFeb, gd2, a, masuk, stokDi } = siap();
  masuk(6, undefined, 1000); masuk(4, undefined, 2000); // rata-rata (6000+8000)/10 = 1400
  const nilai0 = feb('GET', '/api/items')[0].nilai, harga0 = feb('GET', '/api/items')[0].harga_rata;
  err(() => feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: utamaFeb.id, qty: 1 }), /harus berbeda/);
  err(() => feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: gd2.id, qty: 11 }), /Stok tersedia di gudang UTAMA hanya 10/);
  err(() => feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: gd2.id, qty: 0 }), /lebih dari 0/);
  const m = feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: gd2.id, qty: 4, keterangan: 'Rak belakang' });
  assert.equal(m.status, 'MENUNGGU'); assert.deepEqual(m.aksi, ['hapus']);
  assert.equal(stokDi(feb, utamaFeb.id), 10, 'belum berubah sebelum disetujui');
  forbid(() => feb('POST', `/api/mutasi/${m.id}/setujui`));
  assert.throws(() => c.as(c.u.apFt)('POST', `/api/mutasi/${m.id}/setujui`), (e) => e.status === 404, 'approver unit lain');
  assert.throws(() => ft('GET', `/api/mutasi/${m.id}`), (e) => e.status === 404);
  const ok = apFeb('POST', `/api/mutasi/${m.id}/setujui`);
  assert.equal(ok.status, 'DISETUJUI');
  assert.equal(stokDi(feb, utamaFeb.id), 6); assert.equal(stokDi(feb, gd2.id), 4);
  const it = feb('GET', '/api/items')[0];
  assert.equal(it.stok, 10); assert.equal(it.nilai, nilai0); assert.equal(it.harga_rata, harga0);
  const tx = feb('GET', '/api/transaksi').filter((t) => t.mutasi_id === m.id);
  assert.deepEqual(tx.map((t) => [t.kategori, t.gudang_kode, t.qty, t.status]).sort(), [['mutasi_keluar', 'UTAMA', 4, 'DISETUJUI'], ['mutasi_masuk', 'GD2', 4, 'DISETUJUI']]);
  assert.ok(tx.every((t) => t.harga_satuan === 1400 && t.no_dokumen === `MUT-${m.id}`));
  err(() => apFeb('POST', `/api/mutasi/${m.id}/setujui`), /sudah diputuskan/);
  err(() => feb('DELETE', `/api/mutasi/${m.id}`), /sudah disetujui/);
});

test('mutasi: penolakan beralasan, cek ulang stok saat disetujui, batalkan, pemakaian tidak terhitung', () => {
  const { feb, apFeb, utamaFeb, gd2, a, masuk, stokDi } = siap();
  masuk(5, undefined);
  const m1 = feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: gd2.id, qty: 4 });
  err(() => apFeb('POST', `/api/mutasi/${m1.id}/tolak`), /Alasan/);
  assert.equal(apFeb('POST', `/api/mutasi/${m1.id}/tolak`, { catatan: 'Rak penuh' }).status, 'DITOLAK');
  assert.equal(stokDi(feb, gd2.id), 0);
  // stok berubah setelah pengajuan: pemakaian 3 disetujui lebih dulu → mutasi 4 tidak cukup lagi
  const m2 = feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: gd2.id, qty: 4 });
  const pk = feb('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 3 }); apFeb('POST', `/api/transaksi/${pk.id}/setujui`);
  err(() => apFeb('POST', `/api/mutasi/${m2.id}/setujui`), /sekarang hanya 2/);
  assert.equal(feb('GET', `/api/mutasi/${m2.id}`).status, 'MENUNGGU', 'gagal tidak mengubah apa pun');
  assert.equal(feb('GET', '/api/transaksi').filter((t) => t.mutasi_id).length, 0);
  feb('DELETE', `/api/mutasi/${m2.id}`);
  feb('DELETE', `/api/mutasi/${m1.id}`);
  assert.equal(feb('GET', '/api/mutasi').length, 0);
  // mutasi tidak dihitung sebagai pemakaian pada tren
  const m3 = feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: gd2.id, qty: 2 }); apFeb('POST', `/api/mutasi/${m3.id}/setujui`);
  const semua = feb('GET', '/api/laporan/trend', {}, { bulan: '3', kategori: 'semua' }).series.reduce((s, x) => s + x.qty, 0);
  assert.equal(semua, 3, 'hanya pemakaian 3; mutasi_keluar 2 tidak ikut');
});

test('opname per gudang: stok sistem per gudang, penyesuaian hanya di gudang itu, unik per gudang+periode', () => {
  const { c, feb, apFeb, utamaFeb, gd2, a, masuk, stokDi } = siap();
  masuk(10, undefined, 1000); masuk(6, gd2.id, 1000);
  const o1 = feb('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09' });
  assert.equal(o1.gudang_kode, 'UTAMA'); assert.equal(o1.lines[0].stok_sistem, 10);
  const o2 = feb('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09', gudang_id: gd2.id });
  assert.equal(o2.gudang_kode, 'GD2'); assert.equal(o2.lines[0].stok_sistem, 6);
  err(() => feb('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09', gudang_id: gd2.id }), /untuk gudang GD2 sudah ada/);
  err(() => feb('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09' }), /untuk gudang UTAMA sudah ada/);
  assert.deepEqual(feb('GET', '/api/opname').map((o) => o.gudang_kode).sort(), ['GD2', 'UTAMA']);

  feb('PUT', `/api/opname/${o2.id}`, { lines: [{ item_id: a.id, stok_fisik: 4 }] });
  feb('POST', `/api/opname/${o2.id}/ajukan`);
  // transaksi menunggu di gudang LAIN tidak menghalangi; di gudang yang sama menghalangi
  const lain = feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  const sama = feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1, gudang_id: gd2.id });
  err(() => apFeb('POST', `/api/opname/${o2.id}/finalisasi`), /1 transaksi menunggu/);
  feb('DELETE', `/api/transaksi/${sama.id}`);
  assert.equal(apFeb('POST', `/api/opname/${o2.id}/finalisasi`).status, 'FINAL');
  assert.equal(stokDi(feb, gd2.id), 4, 'GD2 disesuaikan 6 → 4');
  assert.equal(stokDi(feb, utamaFeb.id), 10, 'UTAMA tidak tersentuh');
  const adj = feb('GET', '/api/transaksi').filter((t) => t.opname_id);
  assert.deepEqual(adj.map((t) => [t.kategori, t.gudang_kode, t.qty]), [['penyesuaian_keluar', 'GD2', 2]]);
  // mutasi menunggu pada gudang opname menghalangi finalisasi
  feb('PUT', `/api/opname/${o1.id}`, { lines: [{ item_id: a.id, stok_fisik: 10 }] }); feb('POST', `/api/opname/${o1.id}/ajukan`);
  feb('DELETE', `/api/transaksi/${lain.id}`);
  const mu = feb('POST', '/api/mutasi', { item_id: a.id, gudang_asal_id: utamaFeb.id, gudang_tujuan_id: gd2.id, qty: 1 });
  err(() => apFeb('POST', `/api/opname/${o1.id}/finalisasi`), /1 transaksi menunggu/);
  feb('DELETE', `/api/mutasi/${mu.id}`);
  assert.equal(apFeb('POST', `/api/opname/${o1.id}/finalisasi`).status, 'FINAL');
});

test('transfer antar-unit memilih gudang: asal dibatasi stok gudang, tujuan dipilih operator penerima; tolak/selisih kembali ke gudang asal', () => {
  const { c, feb, apFeb, ft, apFt, utamaFeb, gd2, a, masuk, stokDi } = siap();
  masuk(10, undefined, 500); masuk(6, gd2.id, 500);
  const gFt2 = ft('POST', '/api/gudang', { kode: 'LAB', nama: 'Gudang Lab' });
  err(() => feb('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 8, gudang_asal_id: gd2.id }), /Stok tersedia di gudang GD2 hanya 6/);
  const t = feb('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 5, gudang_asal_id: gd2.id });
  assert.equal(t.gudang_asal_kode, 'GD2');
  apFeb('POST', `/api/transfer/${t.id}/setujui`);
  assert.equal(stokDi(feb, gd2.id), 1); assert.equal(stokDi(feb, utamaFeb.id), 10);
  err(() => ft('POST', `/api/transfer/${t.id}/terima`, { buat_item_baru: true, gudang_id: utamaFeb.id }), /Gudang tidak ditemukan/, 404);
  const p = ft('POST', `/api/transfer/${t.id}/terima`, { buat_item_baru: true, gudang_id: gFt2.id, qty_diterima: 4, catatan: 'rusak 1' });
  assert.equal(p.gudang_tujuan_kode, 'LAB');
  apFt('POST', `/api/transfer/${t.id}/setujui`);
  const itFt = ft('GET', '/api/items')[0];
  assert.deepEqual(itFt.per_gudang.map((g) => [g.gudang_kode, g.stok]), [['LAB', 4]], 'masuk ke gudang yang dipilih penerima');
  assert.equal(stokDi(feb, gd2.id), 2, 'selisih 1 kembali ke GD2 (gudang asal), bukan UTAMA');
  assert.equal(stokDi(feb, utamaFeb.id), 10);
  // penolakan setelah dikirim → seluruhnya ke gudang asal
  const t2 = feb('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 2, gudang_asal_id: gd2.id });
  apFeb('POST', `/api/transfer/${t2.id}/setujui`);
  assert.equal(stokDi(feb, gd2.id), 0);
  apFt('POST', `/api/transfer/${t2.id}/tolak`, { catatan: 'Tidak jadi' });
  assert.equal(stokDi(feb, gd2.id), 2);
  // tanpa gudang_id: memakai gudang utama (perilaku lama)
  const t3 = feb('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 1 });
  assert.equal(t3.gudang_asal_kode, 'UTAMA');
});

test('laporan: kartu stok per gudang, tren per gudang, stok_gudang pada daftar barang', () => {
  const { feb, apFeb, utamaFeb, gd2, a, masuk } = siap();
  masuk(10, undefined, 100, { tanggal: hari(10) }); masuk(6, gd2.id, 100, { tanggal: hari(9) });
  const p = feb('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 3, gudang_id: gd2.id, tanggal: hari(2) }); apFeb('POST', `/api/transaksi/${p.id}/setujui`);
  const p2 = feb('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 1, tanggal: hari(1) }); apFeb('POST', `/api/transaksi/${p2.id}/setujui`);
  const semua = feb('GET', '/api/laporan/kartu-stok', {}, { item_id: a.id });
  assert.deepEqual(semua.rows.map((r) => [r.gudang_kode, r.saldo]), [['UTAMA', 10], ['GD2', 16], ['GD2', 13], ['UTAMA', 12]]);
  const g2 = feb('GET', '/api/laporan/kartu-stok', {}, { item_id: a.id, gudang_id: gd2.id });
  assert.deepEqual(g2.rows.map((r) => r.saldo), [6, 3]); assert.equal(g2.gudang.kode, 'GD2');
  assert.throws(() => feb('GET', '/api/laporan/kartu-stok', {}, { item_id: a.id, gudang_id: c0(feb) }), (e) => e.status === 404);
  const tg = feb('GET', '/api/laporan/trend', {}, { bulan: '3', gudang_id: gd2.id });
  assert.equal(tg.series.reduce((s, x) => s + x.qty, 0), 3); assert.equal(tg.top[0].stok, 3); assert.equal(tg.top[0].status, null);
  const tt = feb('GET', '/api/laporan/trend', {}, { bulan: '3' });
  assert.equal(tt.series.reduce((s, x) => s + x.qty, 0), 4); assert.equal(tt.top[0].stok, 12);
  assert.equal(feb('GET', '/api/items', {}, { gudang_id: utamaFeb.id })[0].stok_gudang, 9);
});
const c0 = () => 987654; // id gudang yang tidak ada

test('migrasi v6 → v7: gudang utama dibuat, data lama diberi gudang, tabel opname dibangun ulang tanpa kehilangan baris opname_lines', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'mig7-')), 'v6.db');
  const a = openDb(f);
  a.exec("INSERT INTO units(kode,nama) VALUES ('FEB','x'),('FT','y')");
  a.exec("INSERT INTO users(username,nama,password_hash,role,unit_id) VALUES ('o','o','h','OPERATOR',1)");
  a.exec("INSERT INTO items(unit_id,kode,nama) VALUES (1,'A','Barang A'),(1,'B','Barang B'),(2,'C','Barang C')");
  a.exec("INSERT INTO transactions(tanggal,jenis,kategori,item_id,qty,harga_satuan,status) VALUES ('2026-01-01','MASUK','pembelian',1,10,100,'DISETUJUI'),('2026-01-02','KELUAR','pemakaian',1,3,100,'DISETUJUI'),('2026-01-01','MASUK','pembelian',3,4,50,'DISETUJUI')");
  a.exec("INSERT INTO transfers(unit_asal_id,unit_tujuan_id,item_asal_id,qty,tanggal,status) VALUES (1,2,1,2,'2026-02-01','DIPERIKSA'),(1,2,2,1,'2026-02-01','DIAJUKAN')");
  // turunkan ke bentuk v6: opnames lama (unik per unit+tipe+periode, tanpa gudang_id), tanpa gudang/mutasi
  a.exec('PRAGMA foreign_keys = OFF');
  a.exec(`CREATE TABLE opnames_lama (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id INTEGER NOT NULL REFERENCES units(id), tipe TEXT NOT NULL, periode TEXT NOT NULL, tanggal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'DRAFT', catatan TEXT NOT NULL DEFAULT '', catatan_keputusan TEXT NOT NULL DEFAULT '', dibuat_oleh INTEGER, diputuskan_oleh INTEGER, diputuskan_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (unit_id, tipe, periode));
          DROP TABLE opnames; ALTER TABLE opnames_lama RENAME TO opnames;`);
  a.exec("INSERT INTO opnames(id,unit_id,tipe,periode,tanggal,status) VALUES (1,1,'BULANAN','2026-01','2026-01-31','FINAL'),(2,1,'SEMESTER','2026-S1','2026-06-30','DRAFT')");
  a.exec("INSERT INTO opname_lines(opname_id,item_id,stok_sistem,stok_fisik) VALUES (1,1,7,7),(1,2,0,0),(2,1,7,NULL)");
  a.exec(`DROP TRIGGER trg_tx_gudang; DROP TRIGGER trg_unit_gudang; DROP INDEX idx_tx_gudang; DROP TABLE mutasi;
          ALTER TABLE transactions DROP COLUMN gudang_id; ALTER TABLE transactions DROP COLUMN mutasi_id;
          ALTER TABLE transfers DROP COLUMN gudang_asal_id; ALTER TABLE transfers DROP COLUMN gudang_tujuan_id;
          DROP TABLE gudang; PRAGMA user_version = 6`);
  a.close();

  const b = openDb(f); // migrasi
  assert.equal(b.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(b.prepare('SELECT unit_id, kode, utama FROM gudang ORDER BY unit_id').all().map((r) => ({ ...r })), [{ unit_id: 1, kode: 'UTAMA', utama: 1 }, { unit_id: 2, kode: 'UTAMA', utama: 1 }]);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM transactions WHERE gudang_id IS NULL').get().n, 0);
  assert.deepEqual(b.prepare('SELECT g.unit_id AS u, t.item_id AS i FROM transactions t JOIN gudang g ON g.id = t.gudang_id ORDER BY t.id').all().map((r) => [r.u, r.i]), [[1, 1], [1, 1], [2, 3]]);
  // opname: data & baris selamat, kini berisi gudang_id
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM opname_lines').get().n, 3, 'opname_lines tidak ikut terhapus oleh DROP TABLE');
  assert.deepEqual(b.prepare('SELECT id, status, gudang_id FROM opnames ORDER BY id').all().map((r) => ({ ...r })), [{ id: 1, status: 'FINAL', gudang_id: 1 }, { id: 2, status: 'DRAFT', gudang_id: 1 }]);
  assert.deepEqual(b.prepare('SELECT opname_id, item_id, stok_fisik FROM opname_lines ORDER BY opname_id, item_id').all().map((r) => [r.opname_id, r.item_id, r.stok_fisik]), [[1, 1, 7], [1, 2, 0], [2, 1, null]]);
  assert.equal(b.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign key kembali aktif');
  assert.deepEqual(b.prepare('PRAGMA foreign_key_check').all(), []);
  // transfer: gudang asal terisi; gudang tujuan hanya untuk yang sudah diterima operator
  assert.deepEqual(b.prepare('SELECT status, gudang_asal_id AS a, gudang_tujuan_id AS t FROM transfers ORDER BY id').all().map((r) => ({ ...r })), [{ status: 'DIPERIKSA', a: 1, t: 2 }, { status: 'DIAJUKAN', a: 1, t: null }]);
  // batas unik baru: opname untuk gudang lain pada periode yang sama diperbolehkan, gudang sama ditolak
  b.exec("INSERT INTO gudang(unit_id,kode,nama) VALUES (1,'GD2','Dua')");
  b.exec("INSERT INTO opnames(unit_id,gudang_id,tipe,periode,tanggal) VALUES (1,3,'BULANAN','2026-01','2026-01-31')");
  assert.throws(() => b.exec("INSERT INTO opnames(unit_id,gudang_id,tipe,periode,tanggal) VALUES (1,1,'BULANAN','2026-01','2026-01-31')"), /UNIQUE/);
  assert.equal(b.prepare('SELECT MAX(id) AS m FROM opnames').get().m, 3, 'urutan id berlanjut (AUTOINCREMENT)');
  b.close();
  const c2 = openDb(f); // membuka ulang tidak mengulang/merusak migrasi
  assert.equal(c2.prepare('SELECT COUNT(*) AS n FROM opname_lines').get().n, 3);
  assert.equal(c2.prepare('SELECT COUNT(*) AS n FROM gudang').get().n, 3);
});
