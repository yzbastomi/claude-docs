import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createApi, HttpError } from '../app.js';

const setup = () => {
  const api = createApi(openDb(':memory:'));
  const call = (m, p, body = {}, q = {}) => {
    const r = api(m, p, q, body);
    return Array.isArray(r) && typeof r[0] === 'number' ? r[1] : r;
  };
  return { call };
};
const hari = (offset = 0) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);

test('stok = masuk - keluar, status kosong/menipis/aman', () => {
  const { call } = setup();
  const a = call('POST', '/api/items', { kode: 'ATK-1', nama: 'Kertas A4', satuan: 'rim', stok_minimum: 5 });
  assert.equal(a.status, 'KOSONG');
  call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 10, harga_satuan: 50000 });
  call('POST', '/api/transaksi', { kategori: 'hibah_masuk', item_id: a.id, qty: 10, harga_satuan: 0 });
  call('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 16 });
  const [it] = call('GET', '/api/items');
  assert.equal(it.stok, 4);
  assert.equal(it.status, 'MENIPIS');
  assert.equal(it.harga_rata, 25000);
  call('POST', '/api/transaksi', { kategori: 'transfer_keluar', item_id: a.id, qty: 4, pihak: 'Gudang B' });
  assert.equal(call('GET', '/api/items')[0].status, 'KOSONG');
  assert.equal(call('GET', '/api/dashboard').kosong.length, 1);
});

test('transaksi keluar ditolak bila stok tidak cukup; hapus masuk yang sudah terpakai ditolak', () => {
  const { call } = setup();
  const a = call('POST', '/api/items', { kode: 'X', nama: 'X' });
  const masuk = call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 5 });
  assert.throws(() => call('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 6 }), HttpError);
  call('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 5 });
  assert.throws(() => call('DELETE', `/api/transaksi/${masuk.id}`), /negatif/);
  assert.equal(call('GET', '/api/items')[0].stok, 0);
});

test('validasi input & kode ganda', () => {
  const { call } = setup();
  const a = call('POST', '/api/items', { kode: 'A', nama: 'A' });
  assert.throws(() => call('POST', '/api/items', { kode: 'A', nama: 'B' }), /sudah dipakai/);
  assert.throws(() => call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 0 }), /lebih dari 0/);
  assert.throws(() => call('POST', '/api/transaksi', { kategori: 'penyesuaian_masuk', item_id: a.id, qty: 1 }), /tidak valid/);
  assert.throws(() => call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 1, tanggal: '31-12-2026' }), /YYYY-MM-DD/);
});

test('stok opname: draft -> isi fisik -> finalisasi membuat penyesuaian', () => {
  const { call } = setup();
  const a = call('POST', '/api/items', { kode: 'A', nama: 'A' });
  const b = call('POST', '/api/items', { kode: 'B', nama: 'B' });
  call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 10, harga_satuan: 100 });
  call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: b.id, qty: 10, harga_satuan: 200 });
  const o = call('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09' });
  assert.equal(o.lines.length, 2);
  assert.throws(() => call('POST', '/api/opname', { tipe: 'BULANAN', periode: '2026-09' }), /sudah ada/);
  assert.throws(() => call('POST', '/api/opname', { tipe: 'SEMESTER', periode: '2026-09' }), /S1/);
  assert.throws(() => call('POST', `/api/opname/${o.id}/finalisasi`), /belum diisi/);
  call('PUT', `/api/opname/${o.id}`, { lines: [{ item_id: a.id, stok_fisik: 8 }, { item_id: b.id, stok_fisik: 12 }] });
  const f = call('POST', `/api/opname/${o.id}/finalisasi`);
  assert.equal(f.status, 'FINAL');
  const stok = Object.fromEntries(call('GET', '/api/items').map((i) => [i.kode, i.stok]));
  assert.deepEqual(stok, { A: 8, B: 12 });
  assert.throws(() => call('PUT', `/api/opname/${o.id}`, { lines: [] }), /final/);
  const adj = call('GET', '/api/transaksi', {}, {}).filter((t) => t.opname_id);
  assert.deepEqual(adj.map((t) => t.kategori).sort(), ['penyesuaian_keluar', 'penyesuaian_masuk']);
  assert.equal(call('GET', '/api/opname')[0].jumlah_selisih, 2);
});

test('trend pemakaian & perkiraan sisa hari', () => {
  const { call } = setup();
  const a = call('POST', '/api/items', { kode: 'A', nama: 'A' });
  call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 100, harga_satuan: 10, tanggal: hari(100) });
  call('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 9, tanggal: hari(1) });
  call('POST', '/api/transaksi', { kategori: 'hibah_keluar', item_id: a.id, qty: 5, tanggal: hari(1) });
  const t = call('GET', '/api/laporan/trend', {}, { bulan: '6' });
  assert.equal(t.series.length, 6);
  assert.equal(t.series.reduce((s, x) => s + x.qty, 0), 9); // hanya pemakaian
  assert.equal(call('GET', '/api/laporan/trend', {}, { bulan: '6', kategori: 'semua' }).series.reduce((s, x) => s + x.qty, 0), 14);
  assert.equal(t.top[0].pemakaian_90_hari, 9);
  assert.equal(t.top[0].sisa_hari, 86 * 10); // stok 86, 0.1/hari
});

test('kartu stok memuat saldo berjalan; barang berriwayat tidak bisa dihapus', () => {
  const { call } = setup();
  const a = call('POST', '/api/items', { kode: 'A', nama: 'A' });
  call('POST', '/api/transaksi', { kategori: 'pembelian', item_id: a.id, qty: 10, tanggal: '2026-01-01' });
  call('POST', '/api/transaksi', { kategori: 'pemakaian', item_id: a.id, qty: 3, tanggal: '2026-01-02' });
  const k = call('GET', '/api/laporan/kartu-stok', {}, { item_id: a.id });
  assert.deepEqual(k.rows.map((r) => r.saldo), [10, 7]);
  assert.throws(() => call('DELETE', `/api/items/${a.id}`), /riwayat/);
});
