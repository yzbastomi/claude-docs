import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createApi } from '../app.js';
import { createApp } from '../server.js';
import { susunData, toXlsx, toPdf } from '../export.js';
import { setup, catat, hari } from './helpers.js';

const ada = (cmd) => spawnSync('which', [cmd]).status === 0;
function pdfTeks(buf) {
  const f = join(mkdtempSync(join(tmpdir(), 'pdf-')), 'x.pdf'); writeFileSync(f, buf);
  return spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }).stdout;
}
const bacaXlsx = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const baris = (ws) => { const r = []; ws.eachRow((row) => r.push(row.values.slice(1))); return r; };
const noBaris = (ws, teks) => { let n = 0; ws.eachRow((row, i) => { if (!n && row.getCell(1).value === teks) n = i; }); return n; };

function data() {
  const c = setup(); const api = createApi(c.db);
  const login = (u) => c.auth.login(u, 'rahasia123').user;
  const U = { sa: login('sa'), opFeb: login('op.feb'), apFeb: login('ap.feb'), opFt: login('op.ft'), apFt: login('ap.ft') };
  const feb = c.as(c.u.opFeb);
  const a = feb('POST', '/api/items', { kode: 'ATK-1', nama: 'Kertas A4 → "premium" − 日本', satuan: 'rim', stok_minimum: 5, kategori: 'ATK' });
  const f = feb('POST', '/api/items', { kode: 'FRM', nama: '=1+1', satuan: 'pcs' });
  catat(c, { kategori: 'pembelian', item_id: a.id, qty: 10, harga_satuan: 40000, tanggal: hari(20), pihak: 'CV Maju', no_dokumen: 'F-1' });
  catat(c, { kategori: 'pembelian', item_id: f.id, qty: 3, harga_satuan: 1500.5 });
  catat(c, { kategori: 'pemakaian', item_id: a.id, qty: 4, tanggal: hari(5) });
  c.as(c.u.opFt)('POST', '/api/items', { kode: 'FT-1', nama: 'Barang Teknik', satuan: 'pcs' });
  return { c, api, U, a, f };
}

test('xlsx stok: judul, info, header, tipe angka/rupiah, total berupa rumus, filter & freeze', async () => {
  const { api, U } = data();
  const ds = susunData('stok', api, {}, U.opFeb);
  const wb = await bacaXlsx(await toXlsx(ds, { dicetakOleh: 'Budi' }));
  const ws = wb.getWorksheet('Stok');
  assert.match(ws.getCell('A1').value, /Laporan Stok Persediaan/);
  assert.equal(ws.getCell('A2').value, 'Unit'); assert.match(ws.getCell('B2').value, /^FEB - /);
  const hdr = noBaris(ws, 'Kode');
  assert.deepEqual(ws.getRow(hdr).values.slice(1, 11), ['Kode', 'Nama Barang', 'Kode Barang', 'Kategori', 'Satuan', 'Stok', 'Stok Min', 'Harga Rata-rata', 'Nilai', 'Status']);
  const r1 = ws.getRow(hdr + 2); // urut menurut nama: "=1+1" (FRM) lebih dulu dari "Kertas…" (ATK-1)
  assert.equal(r1.getCell(1).value, 'ATK-1'); assert.equal(r1.getCell(6).value, 6); assert.equal(typeof r1.getCell(6).value, 'number');
  assert.equal(r1.getCell(9).value, 240000); assert.equal(r1.getCell(9).numFmt, '"Rp" #,##0');
  const tot = ws.getRow(hdr + 3).getCell(9).value;
  assert.match(tot.formula, /^SUM\(I\d+:I\d+\)$/); assert.equal(tot.result, 244501.5);
  assert.equal(ws.views[0].state, 'frozen'); assert.equal(ws.views[0].ySplit, hdr);
  assert.ok(ws.autoFilter);
  // string yang diawali "=" tersimpan sebagai teks, bukan rumus (anti formula-injection)
  const nama = ws.getRow(hdr + 1).getCell(2).value;
  assert.equal(typeof nama, 'string'); assert.equal(nama, '=1+1');
  assert.equal(ws.getRow(hdr + 2).getCell(2).value, 'Kertas A4 → "premium" − 日本', 'Excel menyimpan Unicode apa adanya');
});

test('lingkup unit: staf hanya melihat unitnya; super admin melihat kolom Unit dan dapat memfilter', async () => {
  const { api, U, c } = data();
  const kodeDi = async (user, q = {}) => (await bacaXlsx(await toXlsx(susunData('stok', api, q, user)))).getWorksheet('Stok')
    .getColumn(1).values.filter((v) => ['ATK-1', 'FRM', 'FT-1'].includes(v));
  assert.deepEqual((await kodeDi(U.opFeb)).sort(), ['ATK-1', 'FRM']);
  assert.deepEqual(await kodeDi(U.opFt), ['FT-1']);
  const semua = (await bacaXlsx(await toXlsx(susunData('stok', api, {}, U.sa)))).getWorksheet('Stok');
  assert.ok(noBaris(semua, 'Unit') > 0, 'header kolom Unit ada untuk super admin tanpa filter');
  assert.equal(susunData('stok', api, {}, U.sa).bagian[0].kolom[0].k, 'unit_kode');
  assert.equal(susunData('stok', api, {}, U.opFeb).bagian[0].kolom[0].k, 'kode', 'staf unit tidak perlu kolom Unit');
  assert.equal(susunData('stok', api, { unit_id: c.ft }, U.sa).bagian[0].baris.length, 1);
  assert.throws(() => susunData('opname', api, { id: 999 }, U.opFeb), (e) => e.status === 404);
  assert.throws(() => susunData('nama-ngawur', api, {}, U.sa), (e) => e.status === 404);
});

test('xlsx transaksi, kartu stok (saldo berjalan), tren (2 sheet), opname, transfer, kode barang', async () => {
  const { api, U, c, a } = data();
  const tx = (await bacaXlsx(await toXlsx(susunData('transaksi', api, { jenis: 'KELUAR' }, U.opFeb)))).getWorksheet('Transaksi');
  const rowsTx = baris(tx).filter((r) => r[0] instanceof Date);
  assert.equal(rowsTx.length, 1); assert.equal(rowsTx[0].includes('Pemakaian'), true);
  assert.ok(baris(tx).some((r) => r[0] === 'Total'), 'total nilai muncul saat jenis difilter');

  const ks = (await bacaXlsx(await toXlsx(susunData('kartu-stok', api, { item_id: a.id }, U.opFeb)))).getWorksheet('Kartu Stok');
  const hdrKs = baris(ks).find((r) => r[0] === 'Tanggal'), iSaldo = hdrKs.indexOf('Saldo');
  assert.ok(hdrKs.includes('Gudang'), 'kolom Gudang ada pada kartu stok semua-gudang');
  assert.deepEqual(baris(ks).filter((r) => r[0] instanceof Date).map((r) => r[iSaldo]), [10, 6]);
  assert.throws(() => susunData('kartu-stok', api, { item_id: a.id }, U.opFt), (e) => e.status === 404);

  const tren = await bacaXlsx(await toXlsx(susunData('tren', api, { bulan: 6 }, U.opFeb)));
  assert.deepEqual(tren.worksheets.map((w) => w.name), ['Tren Bulanan', 'Pemakaian Terbanyak']);
  assert.equal(baris(tren.getWorksheet('Tren Bulanan')).filter((r) => /^\d{4}-\d{2}$/.test(r[0])).length, 6);

  const o = c.as(c.u.opFeb)('POST', '/api/opname', { tipe: 'bulanan', periode: '2026-09' });
  const ws = (await bacaXlsx(await toXlsx(susunData('opname', api, { id: o.id }, U.opFeb)))).getWorksheet('Opname');
  assert.ok(baris(ws).some((r) => r.includes('Stok Sistem')) && baris(ws).some((r) => r.includes('Operator')));

  const t = c.as(c.u.opFeb)('POST', '/api/transfer', { item_id: a.id, unit_tujuan_id: c.ft, qty: 2 });
  const tr = (await bacaXlsx(await toXlsx(susunData('transfer', api, {}, U.opFt)))).getWorksheet('Transfer');
  assert.ok(baris(tr).some((r) => r[0] === t.id && r.includes('Menunggu persetujuan pengirim')));

  c.as(c.u.sa)('POST', '/api/kode-barang', { kode: '1', uraian: 'Persediaan' });
  const kb = (await bacaXlsx(await toXlsx(susunData('kode-barang', api, {}, U.sa)))).getWorksheet('Kode Barang');
  assert.ok(baris(kb).some((r) => r[0] === '1' && r[2] === 'Golongan'));
});

test('pdf: valid, banyak baris → banyak halaman dengan header berulang & nomor halaman; karakter non-Latin tidak merusak', async (t) => {
  const { api, U, c } = data();
  const feb = c.as(c.u.opFeb);
  for (let i = 0; i < 160; i++) feb('POST', '/api/items', { kode: `BRG-${String(i).padStart(3, '0')}`, nama: `Barang uji nomor ${i} dengan nama agak panjang supaya membungkus baris`, satuan: 'pcs' });
  const buf = await toPdf(susunData('stok', api, {}, U.opFeb), { dicetakOleh: 'Budi (Operator)', compress: false });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const halaman = (buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
  assert.ok(halaman >= 4, `halaman=${halaman}`);
  if (!ada('pdftotext')) return t.skip('pdftotext tidak tersedia');
  const txt = pdfTeks(buf);
  assert.match(txt, /Laporan Stok Persediaan/); assert.match(txt, /BRG-159/);
  assert.equal((txt.match(/Nama Barang/g) ?? []).length, halaman, 'header tabel diulang di tiap halaman');
  assert.match(txt, new RegExp(`Halaman 1 dari ${halaman}`)); assert.match(txt, new RegExp(`Halaman ${halaman} dari ${halaman}`));
  assert.match(txt, /Dicetak .* oleh Budi \(Operator\)/);
  assert.match(txt, /Kertas A4 > "premium" - \?\?/, 'karakter di luar WinAnsi diganti, bukan menjatuhkan PDF');
  assert.match(txt, /Rp 240\.000/); assert.match(txt, /Total/);
});

test('pdf lembar opname memuat blok tanda tangan', async (t) => {
  const { api, U, c } = data();
  const o = c.as(c.u.opFeb)('POST', '/api/opname', { tipe: 'semester', periode: '2026-S2' });
  const buf = await toPdf(susunData('opname', api, { id: o.id }, U.opFeb));
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  if (!ada('pdftotext')) return t.skip('pdftotext tidak tersedia');
  const txt = pdfTeks(buf);
  assert.match(txt, /Lembar Stok Opname Semester/); assert.match(txt, /2026-S2/); assert.match(txt, /Operator/); assert.match(txt, /Approver/); assert.match(txt, /op\.feb/);
});

test('HTTP: wajib login, unduhan berkas dengan header benar, isolasi unit, tercatat di audit', async () => {
  const { c, a } = data();
  const server = createApp(c.db); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const masuk = async (u) => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'rahasia123' }) }); return r.headers.getSetCookie()[0].split(';')[0]; };
  try {
    assert.equal((await fetch(`${base}/api/ekspor/stok`)).status, 401);
    const cookie = await masuk('op.feb');
    const x = await fetch(`${base}/api/ekspor/stok?format=xlsx`, { headers: { Cookie: cookie } });
    assert.equal(x.status, 200);
    assert.equal(x.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(x.headers.get('content-disposition'), /^attachment; filename="stok-feb-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const buf = Buffer.from(await x.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK'); assert.equal(Number(x.headers.get('content-length')), buf.length);
    const p = await fetch(`${base}/api/ekspor/stok?format=pdf`, { headers: { Cookie: cookie } });
    assert.equal(p.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    // unit lain tidak bisa mengekspor kartu stok barang unit ini
    const ft = await masuk('op.ft');
    const lain = await fetch(`${base}/api/ekspor/kartu-stok?item_id=${a.id}&format=pdf`, { headers: { Cookie: ft } });
    assert.equal(lain.status, 404); assert.match((await lain.json()).error, /tidak ditemukan/);
    assert.equal((await fetch(`${base}/api/ekspor/ngawur`, { headers: { Cookie: cookie } })).status, 404);
    const log = c.db.prepare("SELECT detail FROM audit_log WHERE aksi = 'ekspor' ORDER BY id").all().map((r) => r.detail);
    assert.deepEqual(log, ['stok.xlsx', 'stok.pdf']);
  } finally { server.close(); }
});

test('ekspor multi-gudang: rincian per gudang, laporan satu gudang dinilai dari stok gudang itu, kolom gudang pada transaksi & kartu stok', async () => {
  const c = setup(); const api = createApi(c.db);
  const login = (u) => c.auth.login(u, 'rahasia123').user;
  const op = login('op.feb'), feb = c.as(c.u.opFeb);
  const gd2 = feb('POST', '/api/gudang', { kode: 'GD2', nama: 'Gudang Dua' });
  const a = feb('POST', '/api/items', { kode: 'A', nama: 'Kertas', satuan: 'rim' });
  const b = feb('POST', '/api/items', { kode: 'B', nama: 'Tinta', satuan: 'pcs' });
  catat(c, { kategori: 'pembelian', item_id: a.id, qty: 10, harga_satuan: 1000 });
  catat(c, { kategori: 'pembelian', item_id: a.id, qty: 4, harga_satuan: 1000, gudang_id: gd2.id });
  catat(c, { kategori: 'pembelian', item_id: b.id, qty: 3, harga_satuan: 500 }); // B hanya di gudang utama

  const semua = (await bacaXlsx(await toXlsx(susunData('stok', api, {}, op)))).getWorksheet('Stok');
  const hdr = baris(semua).find((r) => r[0] === 'Kode');
  assert.ok(hdr.includes('Rincian Gudang'));
  assert.ok(baris(semua).some((r) => r[0] === 'A' && r.includes('UTAMA: 10; GD2: 4')));

  const ds = susunData('stok', api, { gudang_id: gd2.id }, op);
  assert.equal(ds.judul, 'Laporan Stok Gudang GD2');
  assert.deepEqual(ds.bagian[0].baris.map((r) => r.kode), ['A'], 'barang B tidak berstok di GD2');
  assert.equal(ds.bagian[0].baris[0].nilai, 4000, 'nilai = stok gudang × harga rata-rata, bukan total barang');
  const g2 = (await bacaXlsx(await toXlsx(ds))).getWorksheet('Stok GD2');
  assert.ok(baris(g2).find((r) => r[0] === 'Kode').includes('Stok di GD2'));
  assert.ok(!baris(g2).find((r) => r[0] === 'Kode').includes('Status'));
  const tot = baris(g2).find((r) => r[0] === 'Total');
  assert.equal(tot.find((v) => v && v.result !== undefined).result, 4000);
  assert.ok(g2.getCell('A4').value === 'Gudang' && /GD2 - Gudang Dua/.test(g2.getCell('B4').value));

  const tx = (await bacaXlsx(await toXlsx(susunData('transaksi', api, {}, op)))).getWorksheet('Transaksi');
  assert.ok(baris(tx).find((r) => r[0] === 'Tanggal').includes('Gudang'));
  const txG = susunData('transaksi', api, { gudang_id: gd2.id }, op).bagian[0];
  assert.equal(txG.baris.length, 1); assert.equal(txG.baris[0].gudang_kode, 'GD2');
  const ks = susunData('kartu-stok', api, { item_id: a.id, gudang_id: gd2.id }, op);
  assert.ok(ks.info.some(([l, v]) => l === 'Gudang' && /GD2/.test(v)) && ks.info.some(([l, v]) => l === 'Stok akhir' && v.startsWith('4 ')));
  assert.ok(!ks.bagian[0].kolom.some((k) => k.k === 'gudang_kode'), 'kolom gudang tak perlu bila sudah difilter');
});
