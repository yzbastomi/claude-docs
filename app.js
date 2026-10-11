import { KATEGORI, STOK_SQL } from './db.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const num = (v, nama) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${nama} harus berupa angka`);
  return n;
};
const str = (v) => (v == null ? '' : String(v).trim());

export function createApi(db) {
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const status = (stok, min) => (stok <= 0 ? 'KOSONG' : stok <= min ? 'MENIPIS' : 'AMAN');
  const decorate = (r) => {
    const harga_rata = r.qty_masuk > 0 ? r.nilai_masuk / r.qty_masuk : 0;
    return { ...r, harga_rata, nilai: Math.max(r.stok, 0) * harga_rata, status: status(r.stok, r.stok_minimum) };
  };
  const stokList = (where = '', ...p) =>
    all(`${STOK_SQL} ${where} GROUP BY i.id ORDER BY i.nama`, ...p).map(decorate);
  const stokItem = (id) => stokList('WHERE i.id = ?', id)[0];

  // ---------- Barang ----------
  function validItem(b, id) {
    const kode = str(b.kode), nama = str(b.nama);
    if (!kode || !nama) throw bad('Kode dan nama barang wajib diisi');
    const stok_minimum = b.stok_minimum === '' || b.stok_minimum == null ? 0 : num(b.stok_minimum, 'Stok minimum');
    if (stok_minimum < 0) throw bad('Stok minimum tidak boleh negatif');
    const dupe = get('SELECT id FROM items WHERE kode = ? AND id IS NOT ?', kode, id ?? null);
    if (dupe) throw bad(`Kode barang "${kode}" sudah dipakai`);
    return { kode, nama, kategori: str(b.kategori), satuan: str(b.satuan) || 'unit', stok_minimum };
  }

  // ---------- Transaksi ----------
  function validTx(b) {
    const kategori = str(b.kategori);
    const jenis = KATEGORI[kategori];
    if (!jenis || kategori.startsWith('penyesuaian')) throw bad('Kategori transaksi tidak valid');
    const tanggal = str(b.tanggal) || today();
    if (!isDate(tanggal)) throw bad('Format tanggal harus YYYY-MM-DD');
    const qty = num(b.qty, 'Jumlah');
    if (qty <= 0) throw bad('Jumlah harus lebih dari 0');
    const harga_satuan = b.harga_satuan === '' || b.harga_satuan == null ? 0 : num(b.harga_satuan, 'Harga satuan');
    if (harga_satuan < 0) throw bad('Harga satuan tidak boleh negatif');
    const item = get('SELECT * FROM items WHERE id = ?', Number(b.item_id));
    if (!item) throw bad('Barang tidak ditemukan');
    return { tanggal, jenis, kategori, item_id: item.id, qty, harga_satuan, pihak: str(b.pihak), no_dokumen: str(b.no_dokumen), keterangan: str(b.keterangan) };
  }
  const insertTx = (t, opname_id = null) =>
    run(`INSERT INTO transactions (tanggal,jenis,kategori,item_id,qty,harga_satuan,pihak,no_dokumen,keterangan,opname_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`, t.tanggal, t.jenis, t.kategori, t.item_id, t.qty, t.harga_satuan, t.pihak, t.no_dokumen, t.keterangan, opname_id);

  // Saldo item pada tiap titik waktu tidak boleh negatif (mencegah backdate yang merusak kartu stok)
  function assertNoNegative(item_id) {
    const rows = all('SELECT jenis, qty FROM transactions WHERE item_id = ? ORDER BY tanggal, id', item_id);
    let saldo = 0;
    for (const r of rows) {
      saldo += r.jenis === 'MASUK' ? r.qty : -r.qty;
      if (saldo < -1e-9) throw bad('Transaksi ditolak: stok akan menjadi negatif');
    }
  }

  // ---------- Opname ----------
  function validPeriode(tipe, periode) {
    if (tipe === 'BULANAN' && /^\d{4}-(0[1-9]|1[0-2])$/.test(periode)) return;
    if (tipe === 'SEMESTER' && /^\d{4}-S[12]$/.test(periode)) return;
    throw bad(tipe === 'SEMESTER' ? 'Periode semester berformat YYYY-S1 atau YYYY-S2' : 'Periode bulanan berformat YYYY-MM');
  }
  const getOpname = (id) => {
    const o = get('SELECT * FROM opnames WHERE id = ?', id);
    if (!o) throw new HttpError(404, 'Opname tidak ditemukan');
    o.lines = all(`SELECT l.*, i.kode, i.nama, i.satuan,
        CASE WHEN l.stok_fisik IS NULL THEN NULL ELSE l.stok_fisik - l.stok_sistem END AS selisih
        FROM opname_lines l JOIN items i ON i.id = l.item_id WHERE l.opname_id = ? ORDER BY i.nama`, id);
    return o;
  };

  // ---------- Laporan ----------
  function dashboard() {
    const items = stokList('WHERE i.aktif = 1');
    const bulan = today().slice(0, 7);
    const pakai = get(`SELECT COALESCE(SUM(qty*harga_satuan),0) AS nilai, COUNT(*) AS n FROM transactions
                       WHERE kategori='pemakaian' AND substr(tanggal,1,7)=?`, bulan);
    return {
      jumlah_barang: items.length,
      kosong: items.filter((i) => i.status === 'KOSONG'),
      menipis: items.filter((i) => i.status === 'MENIPIS'),
      nilai_persediaan: items.reduce((s, i) => s + i.nilai, 0),
      transaksi_bulan_ini: get('SELECT COUNT(*) AS n FROM transactions WHERE substr(tanggal,1,7)=?', bulan).n,
      pemakaian_bulan_ini: pakai.n,
    };
  }

  function trend({ bulan = 12, item_id, kategori = 'pemakaian' }) {
    const n = Math.min(Math.max(parseInt(bulan, 10) || 12, 1), 60);
    if (kategori !== 'semua' && !KATEGORI[kategori]) throw bad('Kategori tidak valid');
    const now = new Date();
    const months = [];
    for (let k = n - 1; k >= 0; k--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const cond = ['jenis = \'KELUAR\'', 'substr(tanggal,1,7) >= ?'];
    const p = [months[0]];
    if (kategori !== 'semua') { cond.push('kategori = ?'); p.push(kategori); }
    if (item_id) { cond.push('item_id = ?'); p.push(Number(item_id)); }
    const rows = all(`SELECT substr(tanggal,1,7) AS bulan, SUM(qty) AS qty, SUM(qty*harga_satuan) AS nilai
                      FROM transactions WHERE ${cond.join(' AND ')} GROUP BY bulan`, ...p);
    const by = Object.fromEntries(rows.map((r) => [r.bulan, r]));
    const series = months.map((m) => ({ bulan: m, qty: by[m]?.qty ?? 0, nilai: by[m]?.nilai ?? 0 }));

    // Pemakaian per barang 90 hari terakhir -> rata-rata harian & perkiraan sisa hari
    const dari = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const pakai = Object.fromEntries(all(
      `SELECT item_id, SUM(qty) AS q FROM transactions WHERE kategori='pemakaian' AND tanggal >= ? GROUP BY item_id`, dari)
      .map((r) => [r.item_id, r.q]));
    const top = stokList('WHERE i.aktif = 1').map((i) => {
      const q90 = pakai[i.id] ?? 0;
      const per_hari = q90 / 90;
      return { id: i.id, kode: i.kode, nama: i.nama, satuan: i.satuan, stok: i.stok, status: i.status,
        pemakaian_90_hari: q90, rata_per_bulan: per_hari * 30,
        sisa_hari: per_hari > 0 ? Math.floor(Math.max(i.stok, 0) / per_hari) : null };
    }).filter((i) => i.pemakaian_90_hari > 0).sort((a, b) => b.pemakaian_90_hari - a.pemakaian_90_hari);
    return { series, top };
  }

  function kartuStok(item_id) {
    const item = stokItem(Number(item_id));
    if (!item) throw new HttpError(404, 'Barang tidak ditemukan');
    let saldo = 0;
    const rows = all('SELECT * FROM transactions WHERE item_id = ? ORDER BY tanggal, id', item.id).map((t) => {
      saldo += t.jenis === 'MASUK' ? t.qty : -t.qty;
      return { ...t, saldo };
    });
    return { item, rows };
  }

  // ---------- Router ----------
  // Mengembalikan [status, body]; body bertipe string (csv) atau objek (json)
  return function handle(method, path, query, body) {
    let m;
    if (method === 'GET' && path === '/api/meta') return { kategori: KATEGORI };
    if (method === 'GET' && path === '/api/dashboard') return dashboard();
    if (method === 'GET' && path === '/api/laporan/trend') return trend(query);
    if (method === 'GET' && path === '/api/laporan/kartu-stok') return kartuStok(query.item_id);

    // Barang
    if (path === '/api/items' && method === 'GET') {
      const rows = stokList(query.semua ? '' : 'WHERE i.aktif = 1');
      return query.status ? rows.filter((r) => r.status === query.status) : rows;
    }
    if (path === '/api/items' && method === 'POST') {
      const v = validItem(body);
      const r = run('INSERT INTO items (kode,nama,kategori,satuan,stok_minimum) VALUES (?,?,?,?,?)', v.kode, v.nama, v.kategori, v.satuan, v.stok_minimum);
      return [201, stokItem(Number(r.lastInsertRowid))];
    }
    if ((m = path.match(/^\/api\/items\/(\d+)$/))) {
      const id = Number(m[1]);
      if (!get('SELECT id FROM items WHERE id = ?', id)) throw new HttpError(404, 'Barang tidak ditemukan');
      if (method === 'PUT') {
        const v = validItem(body, id);
        run('UPDATE items SET kode=?, nama=?, kategori=?, satuan=?, stok_minimum=?, aktif=? WHERE id=?',
          v.kode, v.nama, v.kategori, v.satuan, v.stok_minimum, body.aktif === false || body.aktif === 0 ? 0 : 1, id);
        return stokItem(id);
      }
      if (method === 'DELETE') {
        if (get('SELECT 1 FROM transactions WHERE item_id = ? LIMIT 1', id) || get('SELECT 1 FROM opname_lines WHERE item_id = ? LIMIT 1', id))
          throw bad('Barang sudah punya riwayat; nonaktifkan saja (aktif = false)');
        run('DELETE FROM items WHERE id = ?', id);
        return { ok: true };
      }
    }

    // Transaksi
    if (path === '/api/transaksi' && method === 'GET') {
      const cond = [], p = [];
      if (query.jenis) { cond.push('t.jenis = ?'); p.push(query.jenis); }
      if (query.kategori) { cond.push('t.kategori = ?'); p.push(query.kategori); }
      if (query.item_id) { cond.push('t.item_id = ?'); p.push(Number(query.item_id)); }
      if (query.dari) { cond.push('t.tanggal >= ?'); p.push(query.dari); }
      if (query.sampai) { cond.push('t.tanggal <= ?'); p.push(query.sampai); }
      const limit = Math.min(parseInt(query.limit, 10) || 200, 1000);
      return all(`SELECT t.*, i.kode, i.nama, i.satuan FROM transactions t JOIN items i ON i.id = t.item_id
                  ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY t.tanggal DESC, t.id DESC LIMIT ${limit}`, ...p);
    }
    if (path === '/api/transaksi' && method === 'POST') {
      const v = validTx(body);
      return tx(() => {
        // pemakaian/keluar tanpa harga: pakai harga rata-rata barang agar nilai pemakaian terhitung
        if (v.jenis === 'KELUAR' && !v.harga_satuan) v.harga_satuan = stokItem(v.item_id).harga_rata;
        const r = insertTx(v);
        assertNoNegative(v.item_id);
        return [201, { id: Number(r.lastInsertRowid), item: stokItem(v.item_id) }];
      });
    }
    if ((m = path.match(/^\/api\/transaksi\/(\d+)$/)) && method === 'DELETE') {
      const t = get('SELECT * FROM transactions WHERE id = ?', Number(m[1]));
      if (!t) throw new HttpError(404, 'Transaksi tidak ditemukan');
      if (t.opname_id) throw bad('Transaksi penyesuaian opname tidak dapat dihapus');
      return tx(() => { run('DELETE FROM transactions WHERE id = ?', t.id); assertNoNegative(t.item_id); return { ok: true }; });
    }

    // Opname
    if (path === '/api/opname' && method === 'GET') {
      return all(`SELECT o.*, (SELECT COUNT(*) FROM opname_lines WHERE opname_id=o.id) AS jumlah_barang,
        (SELECT COUNT(*) FROM opname_lines WHERE opname_id=o.id AND stok_fisik IS NOT NULL AND stok_fisik <> stok_sistem) AS jumlah_selisih
        FROM opnames o ORDER BY o.periode DESC, o.id DESC`);
    }
    if (path === '/api/opname' && method === 'POST') {
      const tipe = str(body.tipe).toUpperCase(), periode = str(body.periode);
      validPeriode(tipe, periode);
      const tanggal = str(body.tanggal) || today();
      if (!isDate(tanggal)) throw bad('Format tanggal harus YYYY-MM-DD');
      if (get('SELECT 1 FROM opnames WHERE tipe=? AND periode=?', tipe, periode)) throw bad(`Opname ${tipe.toLowerCase()} periode ${periode} sudah ada`);
      return tx(() => {
        const r = run('INSERT INTO opnames (tipe,periode,tanggal,catatan) VALUES (?,?,?,?)', tipe, periode, tanggal, str(body.catatan));
        const id = Number(r.lastInsertRowid);
        for (const i of stokList('WHERE i.aktif = 1'))
          run('INSERT INTO opname_lines (opname_id,item_id,stok_sistem) VALUES (?,?,?)', id, i.id, i.stok);
        return [201, getOpname(id)];
      });
    }
    if ((m = path.match(/^\/api\/opname\/(\d+)(?:\/(finalisasi))?$/))) {
      const id = Number(m[1]);
      const o = getOpname(id);
      if (method === 'GET' && !m[2]) return o;
      if (method === 'PUT' && !m[2]) {
        if (o.status === 'FINAL') throw bad('Opname sudah final dan tidak dapat diubah');
        return tx(() => {
          for (const l of body.lines ?? []) {
            const fisik = l.stok_fisik === '' || l.stok_fisik == null ? null : num(l.stok_fisik, 'Stok fisik');
            if (fisik != null && fisik < 0) throw bad('Stok fisik tidak boleh negatif');
            run('UPDATE opname_lines SET stok_fisik=?, keterangan=? WHERE opname_id=? AND item_id=?', fisik, str(l.keterangan), id, Number(l.item_id));
          }
          if (body.catatan != null) run('UPDATE opnames SET catatan=? WHERE id=?', str(body.catatan), id);
          return getOpname(id);
        });
      }
      if (method === 'POST' && m[2] === 'finalisasi') {
        if (o.status === 'FINAL') throw bad('Opname sudah final');
        const kosong = o.lines.filter((l) => l.stok_fisik == null);
        if (kosong.length) throw bad(`${kosong.length} barang belum diisi stok fisiknya`);
        return tx(() => {
          for (const l of o.lines) {
            // Hitung ulang terhadap stok saat finalisasi supaya transaksi setelah draft tetap konsisten
            const sekarang = stokItem(l.item_id);
            const selisih = l.stok_fisik - sekarang.stok;
            run('UPDATE opname_lines SET stok_sistem=? WHERE opname_id=? AND item_id=?', sekarang.stok, id, l.item_id);
            if (Math.abs(selisih) < 1e-9) continue;
            insertTx({
              tanggal: o.tanggal, jenis: selisih > 0 ? 'MASUK' : 'KELUAR',
              kategori: selisih > 0 ? 'penyesuaian_masuk' : 'penyesuaian_keluar',
              item_id: l.item_id, qty: Math.abs(selisih), harga_satuan: sekarang.harga_rata,
              pihak: '', no_dokumen: `OPNAME-${o.periode}`, keterangan: `Penyesuaian stok opname ${o.tipe.toLowerCase()} ${o.periode}`,
            }, id);
          }
          run("UPDATE opnames SET status='FINAL' WHERE id=?", id);
          return getOpname(id);
        });
      }
    }
    throw new HttpError(404, 'Endpoint tidak ditemukan');
  };
}
