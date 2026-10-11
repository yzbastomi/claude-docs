import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../app.js';
import { setup, catat, hari } from './helpers.js';

test('stok hanya berubah setelah transaksi disetujui; status kosong/menipis/aman', () => {
  const c = setup(); const op = c.as(c.u.opFeb), ap = c.as(c.u.apFeb);
  const a = op('POST', '/api/items', { kode: 'ATK-1', nama: 'Kertas A4', satuan: 'rim', stok_minimum: 5 });
  assert.equal(a.status, 'KOSONG');
  const t1 = op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 10, harga_satuan: 50000 });
  assert.equal(op('GET', '/api/items')[0].stok, 0, 'masih menunggu');
  ap('POST', `/api/transaksi/${t1.id}/setujui`);
  catat(c, { kategori: 'hibah_masuk', item_id: a.id, qty: 10 });
  catat(c, { kategori: 'pemakaian', item_id: a.id, qty: 16 });
  const [it] = op('GET', '/api/items');
  assert.equal(it.stok, 4); assert.equal(it.status, 'MENIPIS'); assert.equal(it.harga_rata, 25000);
  const pake = op('GET', '/api/transaksi', {}, { kategori: 'pemakaian' })[0];
  assert.equal(pake.harga_satuan, 25000, 'pemakaian dinilai harga rata-rata saat disetujui');
  catat(c, { kategori: 'transfer_keluar', item_id: a.id, qty: 4, pihak: 'Gudang B' });
  assert.equal(op('GET', '/api/items')[0].status, 'KOSONG');
  assert.equal(ap('GET', '/api/dashboard').kosong.length, 1);
});

test('keluar ditolak bila stok tidak cukup; transaksi disetujui tidak bisa dihapus', () => {
  const c = setup(); const op = c.as(c.u.opFeb), ap = c.as(c.u.apFeb);
  const a = op('POST', '/api/items', { kode: 'X', nama: 'X' });
  const masuk = catat(c, { kategori: 'pembelian', item_id: a.id, qty: 5 });
  assert.throws(() => op('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 6 }), /Stok tersedia/);
  // dua pemakaian menunggu yang masing-masing wajar, tetapi total melebihi stok -> yang kedua gagal disetujui
  const p1 = op('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 4 });
  const p2 = op('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 4 });
  ap('POST', `/api/transaksi/${p1.id}/setujui`);
  assert.throws(() => ap('POST', `/api/transaksi/${p2.id}/setujui`), /negatif/);
  assert.equal(op('GET', '/api/items')[0].stok, 1);
  assert.throws(() => op('DELETE', `/api/transaksi/${masuk.id}`), /sudah disetujui/);
  op('DELETE', `/api/transaksi/${p2.id}`); // yang masih menunggu boleh dibatalkan
});

test('penolakan wajib beralasan dan transaksi ditolak tidak memengaruhi stok', () => {
  const c = setup(); const op = c.as(c.u.opFeb), ap = c.as(c.u.apFeb);
  const a = op('POST', '/api/items', { kode: 'X', nama: 'X' });
  const t = op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 5 });
  assert.throws(() => ap('POST', `/api/transaksi/${t.id}/tolak`), /Alasan/);
  ap('POST', `/api/transaksi/${t.id}/tolak`, { catatan: 'Dokumen tidak lengkap' });
  assert.equal(op('GET', '/api/items')[0].stok, 0);
  assert.throws(() => ap('POST', `/api/transaksi/${t.id}/setujui`), /sudah diputuskan/);
});

test('hak akses per peran', () => {
  const c = setup(); const op = c.as(c.u.opFeb), ap = c.as(c.u.apFeb), sa = c.as(c.u.sa);
  const a = op('POST', '/api/items', { kode: 'A', nama: 'A' });
  const forbid = (fn) => assert.throws(fn, (e) => e instanceof HttpError && e.status === 403);
  forbid(() => ap('POST', '/api/items', { kode: 'B', nama: 'B' }));
  forbid(() => sa('POST', '/api/items', { kode: 'B', nama: 'B' }));
  forbid(() => ap('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 }));
  forbid(() => sa('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 }));
  const t = op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  forbid(() => op('POST', `/api/transaksi/${t.id}/setujui`)); // operator tak bisa menyetujui sendiri
  forbid(() => sa('POST', `/api/transaksi/${t.id}/setujui`));
  forbid(() => op('GET', '/api/users'));
  forbid(() => ap('POST', '/api/unit', { kode: 'Z', nama: 'Z' }));
  assert.throws(() => c.as(null)('GET', '/api/items'), (e) => e.status === 401);
});

test('isolasi antar-unit: data unit lain tampak tidak ada', () => {
  const c = setup(); const feb = c.as(c.u.opFeb), ft = c.as(c.u.opFt), apFt = c.as(c.u.apFt), sa = c.as(c.u.sa);
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'A' });
  ft('POST', '/api/items', { kode: 'A', nama: 'A-FT' }); // kode sama di unit lain diperbolehkan
  const t = feb('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 5 });
  assert.equal(ft('GET', '/api/items').length, 1);
  assert.equal(ft('GET', '/api/transaksi').length, 0);
  assert.throws(() => ft('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 }), /tidak ditemukan/);
  assert.throws(() => ft('PUT', `/api/items/${a.id}`, { kode: 'A', nama: 'dibajak' }), (e) => e.status === 404);
  assert.throws(() => apFt('POST', `/api/transaksi/${t.id}/setujui`), (e) => e.status === 404);
  assert.throws(() => ft('GET', '/api/laporan/kartu-stok', {}, { item_id: a.id }), (e) => e.status === 404);
  assert.equal(ft('GET', '/api/items', {}, { unit_id: c.feb }).length, 1, 'filter unit_id diabaikan untuk non-super-admin');
  assert.equal(sa('GET', '/api/items').length, 2);
  assert.equal(sa('GET', '/api/items', {}, { unit_id: c.feb }).length, 1);
});

test('stok opname: draft → ajukan → approver finalisasi/kembalikan', () => {
  const c = setup(); const op = c.as(c.u.opFeb), ap = c.as(c.u.apFeb);
  const a = op('POST', '/api/items', { kode: 'A', nama: 'A' });
  const b = op('POST', '/api/items', { kode: 'B', nama: 'B' });
  catat(c, { kategori: 'pembelian', item_id: a.id, qty: 10, harga_satuan: 100 });
  catat(c, { kategori: 'pembelian', item_id: b.id, qty: 10, harga_satuan: 200 });
  const o = op('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09' });
  assert.equal(o.lines.length, 2);
  assert.throws(() => op('POST', '/api/opname', { tipe: 'BULANAN', periode: '2026-09' }), /sudah ada/);
  assert.throws(() => op('POST', '/api/opname', { tipe: 'SEMESTER', periode: '2026-09' }), /S1/);
  assert.throws(() => op('POST', `/api/opname/${o.id}/ajukan`), /belum diisi/);
  op('PUT', `/api/opname/${o.id}`, { lines: [{ item_id: a.id, stok_fisik: 8 }, { item_id: b.id, stok_fisik: 12 }] });
  assert.throws(() => ap('POST', `/api/opname/${o.id}/finalisasi`), /belum diajukan/);
  assert.throws(() => ap('PUT', `/api/opname/${o.id}`, { lines: [] }), (e) => e.status === 403);
  op('POST', `/api/opname/${o.id}/ajukan`);
  assert.throws(() => op('PUT', `/api/opname/${o.id}`, { lines: [] }), /DRAFT/);
  assert.throws(() => op('POST', `/api/opname/${o.id}/finalisasi`), (e) => e.status === 403);
  ap('POST', `/api/opname/${o.id}/kembalikan`, { catatan: 'Hitung ulang item B' });
  assert.equal(op('GET', `/api/opname/${o.id}`).status, 'DRAFT');
  op('POST', `/api/opname/${o.id}/ajukan`);
  const pend = op('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1 });
  assert.throws(() => ap('POST', `/api/opname/${o.id}/finalisasi`), /menunggu persetujuan/);
  op('DELETE', `/api/transaksi/${pend.id}`);
  assert.equal(ap('POST', `/api/opname/${o.id}/finalisasi`).status, 'FINAL');
  assert.deepEqual(Object.fromEntries(op('GET', '/api/items').map((i) => [i.kode, i.stok])), { A: 8, B: 12 });
  assert.equal(op('GET', '/api/transaksi').filter((t) => t.opname_id).length, 2);
  assert.equal(op('GET', '/api/opname')[0].jumlah_selisih, 2);
  assert.equal(c.as(c.u.opFt)('GET', '/api/opname').length, 0);
});

test('trend pemakaian & perkiraan sisa hari (hanya transaksi disetujui)', () => {
  const c = setup(); const op = c.as(c.u.opFeb);
  const a = op('POST', '/api/items', { kode: 'A', nama: 'A' });
  catat(c, { kategori: 'pembelian', item_id: a.id, qty: 100, harga_satuan: 10, tanggal: hari(100) });
  catat(c, { kategori: 'pemakaian', item_id: a.id, qty: 9, tanggal: hari(1) });
  catat(c, { kategori: 'hibah_keluar', item_id: a.id, qty: 5, tanggal: hari(1) });
  op('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 50, tanggal: hari(1) }); // menunggu: tak dihitung
  const t = op('GET', '/api/laporan/trend', {}, { bulan: '6' });
  assert.equal(t.series.length, 6);
  assert.equal(t.series.reduce((s, x) => s + x.qty, 0), 9);
  assert.equal(op('GET', '/api/laporan/trend', {}, { bulan: '6', kategori: 'semua' }).series.reduce((s, x) => s + x.qty, 0), 14);
  assert.equal(t.top[0].sisa_hari, 86 * 10);
});

test('kelola pengguna & unit oleh super admin', () => {
  const c = setup(); const sa = c.as(c.u.sa);
  const u = sa('POST', '/api/users', { username: 'baru', nama: 'Baru', role: 'OPERATOR', unit_id: c.ft, password: 'panjang123' });
  assert.equal(u.unit_kode, 'FT');
  assert.throws(() => sa('POST', '/api/users', { username: 'baru', nama: 'x', role: 'OPERATOR', unit_id: c.ft, password: 'panjang123' }), /sudah dipakai/);
  assert.throws(() => sa('POST', '/api/users', { username: 'lain', nama: 'x', role: 'OPERATOR', password: 'panjang123' }), /Unit wajib/);
  assert.throws(() => sa('POST', '/api/users', { username: 'lain', nama: 'x', role: 'APPROVER', unit_id: c.ft, password: 'pendek' }), /minimal 8/);
  assert.throws(() => sa('PUT', `/api/users/${c.u.sa.id}`, { nama: 'SA', role: 'SUPER_ADMIN', aktif: false }), /sendiri/);
  const unit = sa('POST', '/api/unit', { kode: 'fk', nama: 'Kedokteran' });
  assert.equal(unit.kode, 'FK');
  assert.ok(sa('GET', '/api/audit').length >= 2);
});
