// Ekspor laporan ke Excel (.xlsx) dan PDF. Data diambil lewat API internal yang sama dengan layar,
// sehingga pembatasan unit & hak akses otomatis berlaku. Satu struktur "dataset" menghasilkan kedua format:
//
//   { nama, judul, info: [[label, nilai]], bagian: [{ sheet, judul?, kolom: [{ k, h, t, w }], baris: [{}], total?: [k…], catatan? }],
//     tandaTangan?: [[jabatan, nama]], landscape? }
//
// tipe kolom (t): teks | angka | rp | tgl.  w = lebar relatif (≈ karakter).
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { HttpError } from './errors.js';
import { formatKode, NAMA_LEVEL } from './kodebarang.js';

import { LABEL, TR_STATUS } from './labels.js';
export { LABEL };
const ROLE = { SUPER_ADMIN: 'Super Admin', OPERATOR: 'Operator', APPROVER: 'Approver' };
const hariIni = () => new Date().toISOString().slice(0, 10);

// ---------- Penyusun dataset ----------
const col = (k, h, t = 'teks', w = 14) => ({ k, h, t, w });

export function susunData(nama, api, query, user) {
  const get = (path, q = {}) => api('GET', path, q, {}, user);
  const semuaUnit = user.role === 'SUPER_ADMIN' && !query.unit_id;
  const unitLabel = () => {
    if (user.role !== 'SUPER_ADMIN') return `${user.unit_kode} - ${user.unit_nama}`;
    const u = query.unit_id && get('/api/unit').find((x) => x.id === Number(query.unit_id));
    return u ? `${u.kode} - ${u.nama}` : 'Semua unit';
  };
  const unitCol = semuaUnit ? [col('unit_kode', 'Unit', 'teks', 8)] : [];
  const ds = { nama, info: [['Unit', unitLabel()], ['Per tanggal', hariIni()]], bagian: [] };

  switch (nama) {
    case 'stok': {
      const rows = get('/api/items', { unit_id: query.unit_id, status: query.status });
      ds.judul = query.status === 'KOSONG' ? 'Daftar Stok Kosong' : query.status === 'MENIPIS' ? 'Daftar Stok Menipis' : 'Laporan Stok Persediaan';
      ds.bagian.push({
        sheet: 'Stok', kolom: [...unitCol, col('kode', 'Kode', 'teks', 12), col('nama', 'Nama Barang', 'teks', 28), col('kode_barang', 'Kode Barang', 'teks', 16),
          col('kategori', 'Kategori', 'teks', 14), col('satuan', 'Satuan', 'teks', 8), col('stok', 'Stok', 'angka', 9), col('stok_minimum', 'Stok Min', 'angka', 9),
          col('harga_rata', 'Harga Rata-rata', 'rp', 14), col('nilai', 'Nilai', 'rp', 15), col('status', 'Status', 'teks', 10)],
        baris: rows.map((r) => ({ ...r, kode_barang: r.kode_barang ? formatKode(r.kode_barang) : '' })), total: ['nilai'],
      });
      break;
    }
    case 'transaksi': {
      const limit = 20000;
      const rows = get('/api/transaksi', { ...pick(query, ['unit_id', 'jenis', 'kategori', 'status', 'dari', 'sampai', 'item_id']), limit });
      ds.judul = `Laporan Transaksi ${query.jenis === 'MASUK' ? 'Masuk' : query.jenis === 'KELUAR' ? 'Keluar' : 'Persediaan'}`;
      if (query.dari || query.sampai) ds.info.push(['Periode', `${query.dari || '...'} s.d. ${query.sampai || '...'}`]);
      if (query.status) ds.info.push(['Status', query.status]);
      ds.bagian.push({
        sheet: 'Transaksi', kolom: [col('tanggal', 'Tanggal', 'tgl', 11), ...unitCol, col('jenis', 'Jenis', 'teks', 8), col('kategori', 'Kategori', 'teks', 18),
          col('kode', 'Kode', 'teks', 11), col('nama', 'Barang', 'teks', 24), col('qty', 'Jumlah', 'angka', 9), col('satuan', 'Satuan', 'teks', 8),
          col('harga_satuan', 'Harga Satuan', 'rp', 13), col('nilai', 'Nilai', 'rp', 14), col('pihak', 'Pihak', 'teks', 16), col('no_dokumen', 'Dokumen', 'teks', 14), col('status', 'Status', 'teks', 11)],
        baris: rows.map((r) => ({ ...r, kategori: LABEL[r.kategori] ?? r.kategori, nilai: r.qty * r.harga_satuan })),
        total: query.jenis ? ['nilai'] : null,
        catatan: rows.length >= limit ? `Data dipotong pada ${limit} baris; persempit periode.` : null,
      });
      break;
    }
    case 'kartu-stok': {
      const { item, rows } = get('/api/laporan/kartu-stok', { item_id: query.item_id });
      ds.judul = 'Kartu Stok';
      ds.info = [['Unit', `${item.unit_kode} - ${item.unit_nama}`], ['Barang', `${item.kode} - ${item.nama}`],
        ['Kode barang', item.kode_barang ? `${formatKode(item.kode_barang)} (${item.kode_barang_uraian ?? ''})` : '-'], ['Satuan', item.satuan], ['Stok akhir', `${item.stok} ${item.satuan}`], ['Per tanggal', hariIni()]];
      ds.bagian.push({
        sheet: 'Kartu Stok', kolom: [col('tanggal', 'Tanggal', 'tgl', 11), col('kategori', 'Kategori', 'teks', 20), col('no_dokumen', 'Dokumen', 'teks', 16), col('pihak', 'Pihak', 'teks', 18),
          col('masuk', 'Masuk', 'angka', 10), col('keluar', 'Keluar', 'angka', 10), col('saldo', 'Saldo', 'angka', 10), col('harga_satuan', 'Harga Satuan', 'rp', 13)],
        baris: rows.map((r) => ({ ...r, kategori: LABEL[r.kategori] ?? r.kategori, masuk: r.jenis === 'MASUK' ? r.qty : null, keluar: r.jenis === 'KELUAR' ? r.qty : null })),
        total: ['masuk', 'keluar'],
      });
      break;
    }
    case 'opname': {
      const o = get(`/api/opname/${Number(query.id)}`);
      ds.judul = `Lembar Stok Opname ${o.tipe === 'SEMESTER' ? 'Semester' : 'Bulanan'}`;
      ds.info = [['Unit', `${o.unit_kode} - ${o.unit_nama}`], ['Periode', o.periode], ['Tanggal opname', o.tanggal], ['Status', o.status], ...(o.catatan ? [['Catatan', o.catatan]] : [])];
      ds.bagian.push({
        sheet: 'Opname', kolom: [col('no', 'No', 'angka', 5), col('kode', 'Kode', 'teks', 12), col('nama', 'Nama Barang', 'teks', 28), col('satuan', 'Satuan', 'teks', 8),
          col('stok_sistem', 'Stok Sistem', 'angka', 11), col('stok_fisik', 'Stok Fisik', 'angka', 11), col('selisih', 'Selisih', 'angka', 10), col('keterangan', 'Keterangan', 'teks', 24)],
        baris: o.lines.map((l, i) => ({ ...l, no: i + 1 })),
      });
      ds.tandaTangan = [['Operator', o.pembuat ?? ''], ['Approver', o.status === 'FINAL' ? (o.pemutus ?? '') : '']];
      break;
    }
    case 'transfer': {
      const rows = get('/api/transfer', pick(query, ['unit_id', 'arah', 'status']));
      ds.judul = 'Laporan Transfer Antar Unit';
      ds.bagian.push({
        sheet: 'Transfer', kolom: [col('id', 'No', 'angka', 5), col('tanggal', 'Tanggal', 'tgl', 11), col('unit_asal_kode', 'Dari', 'teks', 8), col('unit_tujuan_kode', 'Ke', 'teks', 8),
          col('barang', 'Barang', 'teks', 26), col('qty', 'Dikirim', 'angka', 9), col('qty_diterima', 'Diterima', 'angka', 9), col('satuan', 'Satuan', 'teks', 8),
          col('barang_tujuan', 'Barang di Tujuan', 'teks', 26), col('status', 'Status', 'teks', 22), col('catatan', 'Catatan', 'teks', 24)],
        baris: rows.map((r) => ({
          ...r, barang: `${r.item_asal_kode} - ${r.item_asal_nama}`, barang_tujuan: r.item_tujuan_kode ? `${r.item_tujuan_kode} - ${r.item_tujuan_nama}` : '',
          qty_diterima: r.status === 'DITERIMA' ? (r.qty_diterima ?? r.qty) : r.qty_diterima, status: TR_STATUS[r.status] ?? r.status,
          catatan: [r.catatan_keputusan, r.catatan_penerimaan && `Selisih: ${r.catatan_penerimaan}`].filter(Boolean).join('; '),
        })),
      });
      break;
    }
    case 'tren': {
      const t = get('/api/laporan/trend', pick(query, ['unit_id', 'bulan', 'item_id', 'kategori']));
      ds.judul = 'Laporan Tren Pemakaian Persediaan';
      ds.info.push(['Jenis', query.kategori && query.kategori !== 'semua' ? (LABEL[query.kategori] ?? query.kategori) : query.kategori === 'semua' ? 'Semua barang keluar' : 'Pemakaian']);
      ds.bagian.push(
        { sheet: 'Tren Bulanan', judul: 'Barang keluar per bulan', kolom: [col('bulan', 'Bulan', 'teks', 12), col('qty', 'Jumlah', 'angka', 14), col('nilai', 'Nilai', 'rp', 18)], baris: t.series, total: ['qty', 'nilai'] },
        { sheet: 'Pemakaian Terbanyak', judul: 'Pemakaian 90 hari terakhir & perkiraan sisa stok', kolom: [...unitCol, col('kode', 'Kode', 'teks', 12), col('nama', 'Barang', 'teks', 28), col('pemakaian_90_hari', 'Pemakaian 90 Hari', 'angka', 13),
          col('rata_per_bulan', 'Rata-rata/Bulan', 'angka', 13), col('stok', 'Stok', 'angka', 9), col('satuan', 'Satuan', 'teks', 8), col('sisa_hari', 'Perkiraan Habis (hari)', 'angka', 14), col('status', 'Status', 'teks', 10)], baris: t.top },
      );
      break;
    }
    case 'kode-barang': {
      const rows = get('/api/kode-barang', { ...pick(query, ['q', 'level', 'aktif']), limit: 50000 }).rows;
      ds.judul = 'Referensi Kode Barang Persediaan';
      ds.info = [['Per tanggal', hariIni()], ['Jumlah kode', String(rows.length)]];
      ds.bagian.push({
        sheet: 'Kode Barang', kolom: [col('kode_fmt', 'Kode', 'teks', 16), col('kode', 'Kode (angka)', 'teks', 14), col('tingkat', 'Tingkat', 'teks', 16), col('uraian', 'Uraian', 'teks', 50), col('status', 'Status', 'teks', 9)],
        baris: rows.map((r) => ({ ...r, kode_fmt: formatKode(r.kode), tingkat: NAMA_LEVEL[r.level - 1], status: r.aktif ? 'Aktif' : 'Nonaktif' })),
      });
      break;
    }
    default: throw new HttpError(404, 'Jenis laporan tidak dikenal');
  }
  return ds;
}
function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== '').map((k) => [k, o[k]])); }

// ---------- Excel ----------
const NUMFMT = { angka: '#,##0.##', rp: '"Rp" #,##0', tgl: 'yyyy-mm-dd', teks: '@' };
const hurufKolom = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

export async function toXlsx(ds, { dicetakOleh = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stok Gudang'; wb.created = new Date();
  const dipakai = new Set();
  for (const b of ds.bagian) {
    let nama = (b.sheet || ds.judul).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
    for (let i = 2; dipakai.has(nama.toLowerCase()); i++) nama = `${nama.slice(0, 28)} ${i}`;
    dipakai.add(nama.toLowerCase());
    const n = b.kolom.length;
    const ws = wb.addWorksheet(nama, { pageSetup: { paperSize: 9, orientation: n > 7 || ds.landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.columns = b.kolom.map((c, i) => ({ width: Math.max(c.w + 2, i === 0 ? 14 : 0) })); // kolom A juga memuat label info
    const indent = (i) => (i > 0 && ['angka', 'rp'].includes(b.kolom[i - 1].t) && !['angka', 'rp'].includes(b.kolom[i].t) ? 1 : 0); // jarak dari kolom angka di kirinya
    let r = 1;
    ws.mergeCells(r, 1, r, n); ws.getCell(r, 1).value = ds.judul + (b.judul ? ` - ${b.judul}` : ''); ws.getCell(r, 1).font = { bold: true, size: 14 }; r++;
    for (const [l, v] of ds.info) { ws.getCell(r, 1).value = l; ws.getCell(r, 1).font = { bold: true }; ws.mergeCells(r, 2, r, Math.max(2, n)); ws.getCell(r, 2).value = String(v); ws.getCell(r, 2).alignment = { horizontal: 'left' }; r++; }
    ws.getCell(r, 1).value = `Dicetak ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${dicetakOleh ? ' oleh ' + dicetakOleh : ''}`; ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: 'FF666666' } }; r += 2;

    const hdr = r;
    b.kolom.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = c.h; cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7ECF3' } };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
      cell.alignment = { horizontal: c.t === 'teks' || c.t === 'tgl' ? 'left' : 'right', vertical: 'middle', wrapText: true, indent: indent(i) };
    });
    r++;
    const awal = r;
    for (const row of b.baris) {
      b.kolom.forEach((c, i) => {
        let v = row[c.k];
        if (v === undefined || v === null || v === '') return;
        if (c.t === 'tgl') v = new Date(`${v}T00:00:00Z`);
        else if (c.t === 'angka' || c.t === 'rp') v = Number(v);
        else v = String(v);
        const cell = ws.getCell(r, i + 1);
        cell.value = v; cell.numFmt = NUMFMT[c.t];
        cell.alignment = { horizontal: c.t === 'angka' || c.t === 'rp' ? 'right' : 'left', vertical: 'top', wrapText: c.t === 'teks', indent: indent(i) };
      });
      r++;
    }
    const akhir = r - 1;
    if (b.total && b.baris.length) {
      ws.getCell(r, 1).value = 'Total'; ws.getCell(r, 1).font = { bold: true };
      for (const k of b.total) {
        const i = b.kolom.findIndex((c) => c.k === k), c = b.kolom[i];
        const L = hurufKolom(i + 1);
        const cell = ws.getCell(r, i + 1);
        cell.value = { formula: `SUM(${L}${awal}:${L}${akhir})`, result: b.baris.reduce((s, x) => s + (Number(x[k]) || 0), 0) };
        cell.numFmt = NUMFMT[c.t]; cell.font = { bold: true }; cell.alignment = { horizontal: 'right' };
      }
      for (let i = 1; i <= n; i++) ws.getCell(r, i).border = { top: { style: 'thin' } };
      r++;
    }
    if (b.catatan) { r++; ws.getCell(r, 1).value = b.catatan; ws.getCell(r, 1).font = { italic: true, color: { argb: 'FFB54708' } }; r++; }
    if (ds.tandaTangan) {
      r += 2;
      ds.tandaTangan.forEach(([jabatan, nama], i) => {
        const c = 1 + i * Math.max(2, Math.floor(n / ds.tandaTangan.length));
        ws.getCell(r, c).value = jabatan; ws.getCell(r + 4, c).value = nama || '(................................)'; ws.getCell(r + 4, c).font = { bold: true };
      });
    }
    ws.views = [{ state: 'frozen', ySplit: hdr }];
    if (b.baris.length) ws.autoFilter = { from: { row: hdr, column: 1 }, to: { row: akhir, column: n } };
    ws.pageSetup.printTitlesRow = `${hdr}:${hdr}`;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- PDF ----------
// Font standar PDF (WinAnsi) tidak memuat semua karakter Unicode; ganti yang tidak ada.
const aman = (v) => String(v ?? '').replace(/[−]/g, '-').replace(/[→]/g, '>').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—•…]/g, '?');
const idNum = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const tampil = (c, v) => (v === null || v === undefined || v === '' ? '' : c.t === 'angka' ? idNum.format(Number(v)) : c.t === 'rp' ? 'Rp ' + new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Number(v)) : aman(v));

export function toPdf(ds, { dicetakOleh = '', compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const lebarTotal = Math.max(...ds.bagian.map((b) => b.kolom.reduce((s, c) => s + c.w, 0)));
    const landscape = ds.landscape ?? lebarTotal > 85;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true, compress, info: { Title: aman(ds.judul), Author: 'Stok Gudang' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);

    const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    const bawah = () => doc.page.height - doc.page.margins.bottom - 22; // sisakan ruang footer
    const PAD = 3, FS = 8;

    doc.font('Helvetica-Bold').fontSize(14).text(aman(ds.judul), L, doc.y, { width: W });
    doc.moveDown(0.3).font('Helvetica').fontSize(9);
    for (const [l, v] of ds.info) { doc.font('Helvetica-Bold').text(aman(l) + ': ', L, doc.y, { continued: true, width: W }).font('Helvetica').text(aman(v)); }
    doc.moveDown(0.8);

    for (const b of ds.bagian) {
      const tot = b.kolom.reduce((s, c) => s + c.w, 0);
      const lebar = b.kolom.map((c) => (c.w / tot) * W);
      const x = (i) => L + lebar.slice(0, i).reduce((s, v) => s + v, 0);
      const angka = (i) => b.kolom[i].t === 'angka' || b.kolom[i].t === 'rp';
      // kolom teks tepat setelah kolom angka (rata kanan) diberi jarak kiri tambahan agar tidak menempel
      const padKiri = b.kolom.map((_, i) => (i > 0 && angka(i - 1) && !angka(i) ? PAD + 7 : PAD));
      const tinggiBaris = (cells, bold) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS);
        return Math.max(...cells.map((t, i) => doc.heightOfString(t || ' ', { width: lebar[i] - padKiri[i] - PAD }))) + PAD * 2;
      };
      const gambarBaris = (cells, y, h, { bold = false, fill = null, garisAtas = false } = {}) => {
        if (fill) doc.save().rect(L, y, W, h).fill(fill).restore();
        if (garisAtas) doc.save().moveTo(L, y).lineTo(L + W, y).lineWidth(0.7).strokeColor('#333').stroke().restore();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS).fillColor('#000');
        cells.forEach((t, i) => doc.text(t, x(i) + padKiri[i], y + PAD, { width: lebar[i] - padKiri[i] - PAD, align: angka(i) ? 'right' : 'left' }));
      };
      const kepala = () => {
        const cells = b.kolom.map((c) => aman(c.h)), h = tinggiBaris(cells, true);
        if (doc.y + h > bawah()) doc.addPage();
        const y = doc.y;
        gambarBaris(cells, y, h, { bold: true, fill: '#e7ecf3' });
        doc.save().moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.7).strokeColor('#333').stroke().restore();
        doc.y = y + h;
      };
      if (b.judul) { if (doc.y + 40 > bawah()) doc.addPage(); doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(aman(b.judul), L, doc.y, { width: W }); doc.moveDown(0.4); }
      kepala();
      if (!b.baris.length) { doc.font('Helvetica-Oblique').fontSize(FS).text('Tidak ada data', L + PAD, doc.y + PAD); doc.moveDown(1); }
      b.baris.forEach((row, ri) => {
        const cells = b.kolom.map((c) => tampil(c, row[c.k])), h = tinggiBaris(cells);
        if (doc.y + h > bawah()) { doc.addPage(); kepala(); }
        const y = doc.y;
        gambarBaris(cells, y, h, { fill: ri % 2 ? '#f6f7f9' : null });
        doc.y = y + h;
      });
      if (b.total && b.baris.length) {
        const cells = b.kolom.map((c, i) => (i === 0 ? 'Total' : b.total.includes(c.k) ? tampil(c, b.baris.reduce((s, x) => s + (Number(x[c.k]) || 0), 0)) : ''));
        const h = tinggiBaris(cells, true);
        if (doc.y + h > bawah()) { doc.addPage(); kepala(); }
        const y = doc.y; gambarBaris(cells, y, h, { bold: true, garisAtas: true }); doc.y = y + h;
      }
      if (b.catatan) { doc.moveDown(0.5).font('Helvetica-Oblique').fontSize(8).fillColor('#b54708').text(aman(b.catatan), L, doc.y, { width: W }).fillColor('#000'); }
      doc.moveDown(1.2);
    }

    if (ds.tandaTangan) {
      if (doc.y + 100 > bawah()) doc.addPage();
      const y0 = doc.y + 6, lb = W / ds.tandaTangan.length;
      ds.tandaTangan.forEach(([jabatan, nama], i) => {
        const x0 = L + i * lb;
        doc.font('Helvetica').fontSize(9).text(aman(jabatan), x0, y0, { width: lb - 20, align: 'center' });
        doc.moveTo(x0 + 20, y0 + 62).lineTo(x0 + lb - 40, y0 + 62).lineWidth(0.5).strokeColor('#000').stroke();
        doc.font('Helvetica-Bold').text(aman(nama) || ' ', x0, y0 + 66, { width: lb - 20, align: 'center' });
      });
    }

    // Footer di setiap halaman (margin bawah dinolkan agar teks tidak memicu halaman baru)
    const hal = doc.bufferedPageRange();
    for (let i = hal.start; i < hal.start + hal.count; i++) {
      doc.switchToPage(i);
      const m = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      const y = doc.page.height - 30;
      doc.font('Helvetica').fontSize(7.5).fillColor('#666')
        .text(aman(`Dicetak ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${dicetakOleh ? ' oleh ' + dicetakOleh : ''}`), L, y, { width: W / 2, lineBreak: false })
        .text(`Halaman ${i + 1} dari ${hal.count}`, L + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = m;
    }
    doc.end();
  });
}

export const NAMA_FILE = (ds, user, ext) =>
  `${ds.nama}-${(user.unit_kode || 'semua').toLowerCase()}-${hariIni()}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
export const penanda = (user) => `${user.nama} (${ROLE[user.role]})`;
