import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, catat } from './helpers.js';
import { hashPassword } from '../auth.js';

function siap() {
  const c = setup();
  const feb = c.as(c.u.opFeb), apFeb = c.as(c.u.apFeb), ft = c.as(c.u.opFt), apFt = c.as(c.u.apFt), sa = c.as(c.u.sa);
  const kertas = feb('POST', '/api/items', { kode: 'ATK-1', nama: 'Kertas A4', satuan: 'rim' });
  catat(c, { kategori: 'pembelian', item_id: kertas.id, qty: 10, harga_satuan: 40000 });
  const ajukan = (qty = 4) => feb('POST', '/api/transfer', { item_id: kertas.id, unit_tujuan_id: c.ft, qty, no_dokumen: 'ND-1' });
  const stok = (as, kode) => as('GET', '/api/items').find((i) => i.kode === kode)?.stok;
  return { c, feb, apFeb, ft, apFt, sa, kertas, ajukan, stok };
}
const forbid = (fn) => assert.throws(fn, (e) => e.status === 403);

test('transfer lengkap: ajukan → kirim → terima (barang baru) → diterima; dua transaksi tertaut', () => {
  const { c, feb, apFeb, ft, apFt, ajukan, stok } = siap();
  assert.throws(() => ajukan(11), /Stok tersedia/);
  const t = ajukan(4);
  assert.equal(t.status, 'DIAJUKAN');
  assert.deepEqual(t.aksi, ['batal']);
  assert.equal(stok(feb, 'ATK-1'), 10, 'belum ada perubahan stok');
  forbid(() => ft('POST', `/api/transfer/${t.id}/setujui`));
  forbid(() => c.as(c.u.apFt)('POST', `/api/transfer/${t.id}/setujui`)); // approver tujuan belum berwenang
  forbid(() => feb('POST', `/api/transfer/${t.id}/setujui`));

  const kirim = apFeb('POST', `/api/transfer/${t.id}/setujui`);
  assert.equal(kirim.status, 'DIKIRIM');
  assert.equal(kirim.harga_satuan, 40000);
  assert.equal(stok(feb, 'ATK-1'), 6);
  forbid(() => feb('POST', `/api/transfer/${t.id}/batal`));
  assert.throws(() => apFeb('POST', `/api/transfer/${t.id}/setujui`), (e) => e.status === 403, 'tidak bisa kirim dua kali');

  assert.equal(ft('GET', '/api/transfer')[0].aksi[0], 'terima');
  forbid(() => apFt('POST', `/api/transfer/${t.id}/setujui`)); // belum diperiksa operator
  const periksa = ft('POST', `/api/transfer/${t.id}/terima`, { buat_item_baru: true });
  assert.equal(periksa.status, 'DIPERIKSA');
  assert.equal(periksa.item_tujuan_kode, 'ATK-1');
  assert.equal(stok(ft, 'ATK-1'), 0, 'stok tujuan baru bertambah setelah disetujui');
  forbid(() => apFeb('POST', `/api/transfer/${t.id}/setujui`));
  forbid(() => ft('POST', `/api/transfer/${t.id}/setujui`));

  assert.equal(apFt('POST', `/api/transfer/${t.id}/setujui`).status, 'DITERIMA');
  const [it] = ft('GET', '/api/items');
  assert.equal(it.stok, 4); assert.equal(it.harga_rata, 40000);
  const txFt = ft('GET', '/api/transaksi');
  assert.equal(txFt.length, 1); assert.equal(txFt[0].transfer_id, t.id); assert.equal(txFt[0].kategori, 'transfer_masuk');
  assert.equal(feb('GET', '/api/transaksi').find((x) => x.kategori === 'transfer_keluar').transfer_id, t.id);
  assert.equal(c.as(c.u.apFt)('GET', '/api/dashboard').transfer_perlu_tindakan, 0);
});

test('petakan ke barang yang sudah ada; satuan harus sama; kode bentrok pada barang baru', () => {
  const { feb, apFeb, ft, ajukan } = siap();
  const t = ajukan(2); apFeb('POST', `/api/transfer/${t.id}/setujui`);
  const sama = ft('POST', '/api/items', { kode: 'K-9', nama: 'HVS A4', satuan: 'RIM' });
  const lain = ft('POST', '/api/items', { kode: 'K-8', nama: 'Spidol', satuan: 'pcs' });
  ft('POST', '/api/items', { kode: 'ATK-1', nama: 'Bukan kertas', satuan: 'pcs' });
  assert.throws(() => ft('POST', `/api/transfer/${t.id}/terima`, { item_id: lain.id }), /Satuan berbeda/);
  assert.throws(() => ft('POST', `/api/transfer/${t.id}/terima`, { buat_item_baru: true }), /sudah dipakai/);
  assert.throws(() => ft('POST', `/api/transfer/${t.id}/terima`, { item_id: 99999 }), (e) => e.status === 404);
  assert.throws(() => ft('POST', `/api/transfer/${t.id}/terima`, { item_id: 1 }), (e) => e.status === 404, 'barang unit lain');
  assert.equal(ft('POST', `/api/transfer/${t.id}/terima`, { item_id: sama.id }).item_tujuan_kode, 'K-9');
  // operator boleh memperbaiki pemetaan selama belum disetujui
  assert.equal(ft('POST', `/api/transfer/${t.id}/terima`, { item_id: sama.id }).status, 'DIPERIKSA');
  assert.throws(() => feb('DELETE', `/api/items/${t.item_asal_id}`), /riwayat/);
});

test('penolakan: di asal tidak mengubah stok; di tujuan mengembalikan stok ke asal', () => {
  const { feb, apFeb, ft, apFt, ajukan, stok } = siap();
  const a = ajukan(3);
  assert.throws(() => apFeb('POST', `/api/transfer/${a.id}/tolak`), /Alasan/);
  assert.equal(apFeb('POST', `/api/transfer/${a.id}/tolak`, { catatan: 'Stok dicadangkan' }).status, 'DITOLAK_ASAL');
  assert.equal(stok(feb, 'ATK-1'), 10);

  const b = ajukan(5); apFeb('POST', `/api/transfer/${b.id}/setujui`);
  assert.equal(stok(feb, 'ATK-1'), 5);
  forbid(() => apFeb('POST', `/api/transfer/${b.id}/tolak`, { catatan: 'x' }));
  ft('POST', `/api/transfer/${b.id}/terima`, { buat_item_baru: true });
  assert.throws(() => apFt('POST', `/api/transfer/${b.id}/tolak`), /Alasan/);
  const r = apFt('POST', `/api/transfer/${b.id}/tolak`, { catatan: 'Barang rusak' });
  assert.equal(r.status, 'DIKEMBALIKAN');
  assert.equal(stok(feb, 'ATK-1'), 10, 'stok kembali');
  assert.equal(stok(ft, 'ATK-1'), 0);
  const kembali = feb('GET', '/api/transaksi').find((x) => /Pengembalian/.test(x.keterangan));
  assert.equal(kembali.status, 'DISETUJUI'); assert.equal(kembali.harga_satuan, 40000);
  forbid(() => apFt('POST', `/api/transfer/${b.id}/tolak`, { catatan: 'lagi' }));
});

test('approver tujuan dapat menolak langsung saat DIKIRIM; operator asal dapat membatalkan', () => {
  const { feb, apFeb, apFt, ajukan, stok } = siap();
  const x = ajukan(1); feb('POST', `/api/transfer/${x.id}/batal`);
  assert.equal(feb('GET', `/api/transfer/${x.id}`).status, 'DIBATALKAN');
  const y = ajukan(2); apFeb('POST', `/api/transfer/${y.id}/setujui`);
  assert.equal(apFt('POST', `/api/transfer/${y.id}/tolak`, { catatan: 'Tidak dibutuhkan' }).status, 'DIKEMBALIKAN');
  assert.equal(stok(feb, 'ATK-1'), 10);
});

test('isolasi & peran: unit ketiga tidak melihat; super admin hanya baca; tujuan tidak boleh sama dengan asal', () => {
  const { c, feb, ft, sa, kertas, ajukan } = siap();
  const t = ajukan(1);
  const fk = Number(c.db.prepare("INSERT INTO units (kode, nama) VALUES ('FK','Kedokteran')").run().lastInsertRowid);
  const id = Number(c.db.prepare("INSERT INTO users (username,nama,password_hash,role,unit_id) VALUES ('op.fk','x',?,'OPERATOR',?)").run(hashPassword('rahasia123'), fk).lastInsertRowid);
  const opFk = c.as({ id, role: 'OPERATOR', unit_id: fk });
  assert.equal(opFk('GET', '/api/transfer').length, 0);
  assert.throws(() => opFk('GET', `/api/transfer/${t.id}`), (e) => e.status === 404);
  assert.throws(() => opFk('POST', `/api/transfer/${t.id}/terima`, { buat_item_baru: true }), (e) => e.status === 404);
  assert.equal(sa('GET', '/api/transfer').length, 1);
  assert.equal(sa('GET', '/api/transfer')[0].aksi.length, 0);
  forbid(() => sa('POST', '/api/transfer', { item_id: kertas.id, unit_tujuan_id: c.ft, qty: 1 }));
  assert.throws(() => feb('POST', '/api/transfer', { item_id: kertas.id, unit_tujuan_id: c.feb, qty: 1 }), /tidak valid/);
  assert.throws(() => ft('POST', '/api/transfer', { item_id: kertas.id, unit_tujuan_id: c.feb, qty: 1 }), (e) => e.status === 404);
  assert.deepEqual(feb('GET', '/api/unit/tujuan').map((u) => u.kode), ['FK', 'FT']);
  assert.equal(c.as(c.u.apFt)('GET', '/api/dashboard').transfer_perlu_tindakan, 0);
  assert.equal(c.as(c.u.apFeb)('GET', '/api/dashboard').transfer_perlu_tindakan, 1);
});
