import { KATEGORI, STOK_SQL } from './db.js';
import { HttpError } from './errors.js';
import { hashPassword, validPassword } from './auth.js';
import { transferRoutes } from './transfer.js';
import { createKodeBarang, normalisasi, formatKode } from './kodebarang.js';

export { HttpError };
const bad = (m) => new HttpError(400, m);
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const num = (v, nama) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${nama} harus berupa angka`);
  return n;
};
const str = (v) => (v == null ? '' : String(v).trim());
const SA = 'SUPER_ADMIN', OP = 'OPERATOR', AP = 'APPROVER';

export function createApi(db) {
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const audit = (user, aksi, detail = '') => run('INSERT INTO audit_log (user_id, aksi, detail) VALUES (?,?,?)', user.id, aksi, detail);

  // ---------- Otorisasi ----------
  const need = (user, ...roles) => {
    if (!user) throw new HttpError(401, 'Silakan login');
    if (!roles.includes(user.role)) throw new HttpError(403, 'Anda tidak berwenang melakukan aksi ini');
  };
  // Unit yang berlaku untuk pembacaan: staf unit selalu unitnya sendiri; super admin boleh memfilter.
  const unitBaca = (user, q) => (user.role === SA ? (q.unit_id ? Number(q.unit_id) : null) : user.unit_id);
  const forbidden404 = () => new HttpError(404, 'Data tidak ditemukan');
  const dalamUnit = (user, unit_id) => user.role === SA || user.unit_id === unit_id;

  const status = (stok, min) => (stok <= 0 ? 'KOSONG' : stok <= min ? 'MENIPIS' : 'AMAN');
  const decorate = (r) => {
    const harga_rata = r.qty_masuk > 0 ? r.nilai_masuk / r.qty_masuk : 0;
    return { ...r, harga_rata, nilai: Math.max(r.stok, 0) * harga_rata, status: status(r.stok, r.stok_minimum) };
  };
  function stokList({ unit = null, aktif = false, id = null } = {}) {
    const c = [], p = [];
    if (unit) { c.push('i.unit_id = ?'); p.push(unit); }
    if (aktif) c.push('i.aktif = 1');
    if (id) { c.push('i.id = ?'); p.push(id); }
    return all(`${STOK_SQL} ${c.length ? 'WHERE ' + c.join(' AND ') : ''} GROUP BY i.id ORDER BY u.kode, i.nama`, ...p).map(decorate);
  }
  const stokItem = (id) => stokList({ id })[0];
  // Barang yang boleh diakses user (404 bila di luar unitnya)
  function itemUntuk(user, id) {
    const it = stokItem(Number(id));
    if (!it || !dalamUnit(user, it.unit_id)) throw forbidden404();
    return it;
  }

  // ---------- Barang ----------
  function validItem(b, unit_id, id) {
    const kode = str(b.kode), nama = str(b.nama);
    if (!kode || !nama) throw bad('Kode dan nama barang wajib diisi');
    const stok_minimum = b.stok_minimum === '' || b.stok_minimum == null ? 0 : num(b.stok_minimum, 'Stok minimum');
    if (stok_minimum < 0) throw bad('Stok minimum tidak boleh negatif');
    if (get('SELECT id FROM items WHERE unit_id = ? AND kode = ? AND id IS NOT ?', unit_id, kode, id ?? null)) throw bad(`Kode barang "${kode}" sudah dipakai`);
    // kode_barang: tidak dikirim = tetap; kosong = hapus; terisi = harus 10 digit & ada di referensi (aktif, kecuali tidak berubah)
    let kode_barang;
    const lama = id ? get('SELECT kode_barang FROM items WHERE id = ?', id)?.kode_barang ?? null : null;
    if (!('kode_barang' in b)) kode_barang = lama;
    else {
      const kb = normalisasi(b.kode_barang);
      if (!kb) kode_barang = null;
      else {
        const ref = get('SELECT * FROM kode_barang WHERE kode = ?', kb);
        if (kb.length !== 10 || !ref) throw bad(`Kode barang ${kb.length === 10 ? formatKode(kb) : '"' + kb + '"'} tidak ada di referensi (harus 10 digit)`);
        if (!ref.aktif && kb !== lama) throw bad(`Kode barang ${formatKode(kb)} nonaktif`);
        kode_barang = kb;
      }
    }
    return { kode, nama, kategori: str(b.kategori), satuan: str(b.satuan) || 'unit', stok_minimum, kode_barang };
  }

  // ---------- Transaksi ----------
  function validTx(user, b) {
    const kategori = str(b.kategori);
    const jenis = KATEGORI[kategori];
    if (!jenis || kategori.startsWith('penyesuaian')) throw bad('Kategori transaksi tidak valid');
    const tanggal = str(b.tanggal) || today();
    if (!isDate(tanggal)) throw bad('Format tanggal harus YYYY-MM-DD');
    const qty = num(b.qty, 'Jumlah');
    if (qty <= 0) throw bad('Jumlah harus lebih dari 0');
    const harga_satuan = b.harga_satuan === '' || b.harga_satuan == null ? 0 : num(b.harga_satuan, 'Harga satuan');
    if (harga_satuan < 0) throw bad('Harga satuan tidak boleh negatif');
    const item = itemUntuk(user, b.item_id);
    if (!item.aktif) throw bad('Barang nonaktif');
    return { tanggal, jenis, kategori, item_id: item.id, qty, harga_satuan: jenis === 'MASUK' ? harga_satuan : 0, pihak: str(b.pihak), no_dokumen: str(b.no_dokumen), keterangan: str(b.keterangan), stok: item.stok };
  }
  const insertTx = (t, extra = {}) =>
    run(`INSERT INTO transactions (tanggal,jenis,kategori,item_id,qty,harga_satuan,pihak,no_dokumen,keterangan,opname_id,status,dibuat_oleh,diputuskan_oleh,diputuskan_at,transfer_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t.tanggal, t.jenis, t.kategori, t.item_id, t.qty, t.harga_satuan, t.pihak, t.no_dokumen, t.keterangan,
      extra.opname_id ?? null, extra.status ?? 'MENUNGGU', extra.dibuat_oleh ?? null, extra.diputuskan_oleh ?? null, extra.diputuskan_oleh ? new Date().toISOString() : null, extra.transfer_id ?? null);

  // Saldo (hanya transaksi disetujui) tidak boleh negatif pada titik waktu mana pun
  function assertNoNegative(item_id) {
    const rows = all("SELECT jenis, qty FROM transactions WHERE item_id = ? AND status = 'DISETUJUI' ORDER BY tanggal, id", item_id);
    let saldo = 0;
    for (const r of rows) {
      saldo += r.jenis === 'MASUK' ? r.qty : -r.qty;
      if (saldo < -1e-9) throw bad('Ditolak: stok akan menjadi negatif');
    }
  }
  function txUntuk(user, id) {
    const t = get('SELECT t.*, i.unit_id FROM transactions t JOIN items i ON i.id = t.item_id WHERE t.id = ?', Number(id));
    if (!t || !dalamUnit(user, t.unit_id)) throw forbidden404();
    return t;
  }

  // ---------- Opname ----------
  function validPeriode(tipe, periode) {
    if (tipe === 'BULANAN' && /^\d{4}-(0[1-9]|1[0-2])$/.test(periode)) return;
    if (tipe === 'SEMESTER' && /^\d{4}-S[12]$/.test(periode)) return;
    throw bad(tipe === 'SEMESTER' ? 'Periode semester berformat YYYY-S1 atau YYYY-S2' : 'Periode bulanan berformat YYYY-MM');
  }
  function opnameUntuk(user, id) {
    const o = get(`SELECT o.*, u.kode AS unit_kode, u.nama AS unit_nama, c.nama AS pembuat, d.nama AS pemutus FROM opnames o JOIN units u ON u.id = o.unit_id
                   LEFT JOIN users c ON c.id = o.dibuat_oleh LEFT JOIN users d ON d.id = o.diputuskan_oleh WHERE o.id = ?`, Number(id));
    if (!o || !dalamUnit(user, o.unit_id)) throw new HttpError(404, 'Opname tidak ditemukan');
    o.lines = all(`SELECT l.*, i.kode, i.nama, i.satuan,
        CASE WHEN l.stok_fisik IS NULL THEN NULL ELSE l.stok_fisik - l.stok_sistem END AS selisih
        FROM opname_lines l JOIN items i ON i.id = l.item_id WHERE l.opname_id = ? ORDER BY i.nama`, o.id);
    return o;
  }

  // ---------- Laporan ----------
  function dashboard(user, q) {
    const unit = unitBaca(user, q);
    const items = stokList({ unit, aktif: true });
    const bulan = today().slice(0, 7);
    const w = unit ? 'AND i.unit_id = ?' : '', p = unit ? [unit] : [];
    const n = (sql, ...a) => get(sql, ...a).n;
    return {
      jumlah_barang: items.length,
      kosong: items.filter((i) => i.status === 'KOSONG'),
      menipis: items.filter((i) => i.status === 'MENIPIS'),
      nilai_persediaan: items.reduce((s, i) => s + i.nilai, 0),
      transaksi_bulan_ini: n(`SELECT COUNT(*) AS n FROM transactions t JOIN items i ON i.id=t.item_id WHERE t.status='DISETUJUI' AND substr(t.tanggal,1,7)=? ${w}`, bulan, ...p),
      menunggu_transaksi: n(`SELECT COUNT(*) AS n FROM transactions t JOIN items i ON i.id=t.item_id WHERE t.status='MENUNGGU' ${w}`, ...p),
      transfer_perlu_tindakan: user.role === AP
        ? n(`SELECT COUNT(*) AS n FROM transfers WHERE (unit_asal_id = ? AND status = 'DIAJUKAN') OR (unit_tujuan_id = ? AND status = 'DIPERIKSA')`, user.unit_id, user.unit_id)
        : user.role === OP ? n(`SELECT COUNT(*) AS n FROM transfers WHERE unit_tujuan_id = ? AND status = 'DIKIRIM'`, user.unit_id)
        : n(`SELECT COUNT(*) AS n FROM transfers WHERE status IN ('DIAJUKAN','DIKIRIM','DIPERIKSA') ${unit ? 'AND (unit_asal_id = ? OR unit_tujuan_id = ?)' : ''}`, ...(unit ? [unit, unit] : [])),
      menunggu_opname: n(`SELECT COUNT(*) AS n FROM opnames o WHERE o.status='DIAJUKAN' ${unit ? 'AND o.unit_id = ?' : ''}`, ...p),
    };
  }

  function trend(user, { bulan = 12, item_id, kategori = 'pemakaian', ...q }) {
    const unit = unitBaca(user, q);
    const n = Math.min(Math.max(parseInt(bulan, 10) || 12, 1), 60);
    if (kategori !== 'semua' && !KATEGORI[kategori]) throw bad('Kategori tidak valid');
    if (item_id) itemUntuk(user, item_id);
    const now = new Date();
    const months = [];
    for (let k = n - 1; k >= 0; k--) months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
    const cond = ["t.status = 'DISETUJUI'", "t.jenis = 'KELUAR'", 'substr(t.tanggal,1,7) >= ?'];
    const p = [months[0]];
    if (unit) { cond.push('i.unit_id = ?'); p.push(unit); }
    if (kategori !== 'semua') { cond.push('t.kategori = ?'); p.push(kategori); }
    if (item_id) { cond.push('t.item_id = ?'); p.push(Number(item_id)); }
    const rows = all(`SELECT substr(t.tanggal,1,7) AS bulan, SUM(t.qty) AS qty, SUM(t.qty*t.harga_satuan) AS nilai
                      FROM transactions t JOIN items i ON i.id = t.item_id WHERE ${cond.join(' AND ')} GROUP BY bulan`, ...p);
    const by = Object.fromEntries(rows.map((r) => [r.bulan, r]));
    const series = months.map((m) => ({ bulan: m, qty: by[m]?.qty ?? 0, nilai: by[m]?.nilai ?? 0 }));

    const dari = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const pakai = Object.fromEntries(all(
      `SELECT item_id, SUM(qty) AS q FROM transactions WHERE kategori='pemakaian' AND status='DISETUJUI' AND tanggal >= ? GROUP BY item_id`, dari)
      .map((r) => [r.item_id, r.q]));
    const top = stokList({ unit, aktif: true }).map((i) => {
      const q90 = pakai[i.id] ?? 0, per_hari = q90 / 90;
      return { id: i.id, kode: i.kode, nama: i.nama, satuan: i.satuan, unit_kode: i.unit_kode, stok: i.stok, status: i.status,
        pemakaian_90_hari: q90, rata_per_bulan: per_hari * 30,
        sisa_hari: per_hari > 0 ? Math.floor(Math.max(i.stok, 0) / per_hari) : null };
    }).filter((i) => i.pemakaian_90_hari > 0).sort((a, b) => b.pemakaian_90_hari - a.pemakaian_90_hari);
    return { series, top };
  }

  function kartuStok(user, item_id) {
    const item = itemUntuk(user, item_id);
    let saldo = 0;
    const rows = all("SELECT * FROM transactions WHERE item_id = ? AND status = 'DISETUJUI' ORDER BY tanggal, id", item.id).map((t) => {
      saldo += t.jenis === 'MASUK' ? t.qty : -t.qty;
      return { ...t, saldo };
    });
    return { item, rows };
  }

  // ---------- Pengguna & unit (super admin) ----------
  function validUser(b, id) {
    const out = {};
    const username = str(b.username);
    if (id == null) {
      if (!/^[a-z0-9._-]{3,32}$/i.test(username)) throw bad('Username 3–32 karakter: huruf, angka, titik, garis bawah, atau strip');
      if (get('SELECT 1 FROM users WHERE username = ?', username)) throw bad('Username sudah dipakai');
      out.username = username;
    }
    if (!str(b.nama)) throw bad('Nama wajib diisi');
    out.nama = str(b.nama);
    const email = str(b.email).toLowerCase();
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw bad('Format email tidak valid');
      if (get('SELECT 1 FROM users WHERE email = ? AND id IS NOT ?', email, id ?? null)) throw bad('Email sudah dipakai pengguna lain');
    }
    out.email = email || null;
    if (![SA, OP, AP].includes(b.role)) throw bad('Role tidak valid');
    out.role = b.role;
    if (b.role === SA) out.unit_id = null;
    else {
      const u = get('SELECT * FROM units WHERE id = ? AND aktif = 1', Number(b.unit_id));
      if (!u) throw bad('Unit wajib dipilih untuk operator/approver');
      out.unit_id = u.id;
    }
    return out;
  }
  const userRow = (id) => get(`SELECT u.id, u.username, u.nama, u.email, u.role, u.unit_id, u.aktif, un.kode AS unit_kode, un.nama AS unit_nama
                               FROM users u LEFT JOIN units un ON un.id = u.unit_id WHERE u.id = ?`, id);

  const transfer = transferRoutes({ all, get, run, tx, audit, need, stokItem, itemUntuk, assertNoNegative, insertTx, bad, str, num, isDate, today, HttpError });

  const kodeBarang = createKodeBarang({ all, get, run, tx, audit, need, bad, str, HttpError });

  // ---------- Router ----------
  // Mengembalikan body, atau [status, body]
  return function handle(method, path, query, body, user) {
    if (!user) throw new HttpError(401, 'Silakan login');
    const tr = transfer(method, path, query, body, user);
    if (tr !== undefined) return tr;
    const kb = kodeBarang(method, path, query, body, user);
    if (kb !== undefined) return kb;
    let m;
    if (method === 'GET' && path === '/api/meta') return { kategori: KATEGORI };
    if (method === 'GET' && path === '/api/dashboard') return dashboard(user, query);
    if (method === 'GET' && path === '/api/laporan/trend') return trend(user, query);
    if (method === 'GET' && path === '/api/laporan/kartu-stok') return kartuStok(user, query.item_id);

    // Unit
    if (path === '/api/unit' && method === 'GET')
      return user.role === SA ? all('SELECT * FROM units ORDER BY kode') : all('SELECT * FROM units WHERE id = ?', user.unit_id);
    if (path === '/api/unit' && method === 'POST') {
      need(user, SA);
      const kode = str(body.kode).toUpperCase(), nama = str(body.nama);
      if (!kode || !nama) throw bad('Kode dan nama unit wajib diisi');
      if (get('SELECT 1 FROM units WHERE kode = ?', kode)) throw bad('Kode unit sudah dipakai');
      const r = run('INSERT INTO units (kode, nama) VALUES (?,?)', kode, nama);
      audit(user, 'unit_baru', kode);
      return [201, get('SELECT * FROM units WHERE id = ?', Number(r.lastInsertRowid))];
    }
    if ((m = path.match(/^\/api\/unit\/(\d+)$/)) && method === 'PUT') {
      need(user, SA);
      const u = get('SELECT * FROM units WHERE id = ?', Number(m[1]));
      if (!u) throw forbidden404();
      const nama = str(body.nama) || u.nama;
      run('UPDATE units SET nama = ?, aktif = ? WHERE id = ?', nama, body.aktif === false || body.aktif === 0 ? 0 : 1, u.id);
      audit(user, 'unit_ubah', u.kode);
      return get('SELECT * FROM units WHERE id = ?', u.id);
    }

    // Pengguna
    if (path === '/api/users' && method === 'GET') {
      need(user, SA);
      return all(`SELECT u.id, u.username, u.nama, u.email, u.role, u.unit_id, u.aktif, un.kode AS unit_kode, un.nama AS unit_nama
                  FROM users u LEFT JOIN units un ON un.id = u.unit_id ORDER BY u.role, un.kode, u.username`);
    }
    if (path === '/api/users' && method === 'POST') {
      need(user, SA);
      const v = validUser(body);
      validPassword(body.password);
      const r = run('INSERT INTO users (username, nama, email, password_hash, role, unit_id) VALUES (?,?,?,?,?,?)', v.username, v.nama, v.email, hashPassword(body.password), v.role, v.unit_id);
      audit(user, 'user_baru', `${v.username} (${v.role})`);
      return [201, userRow(Number(r.lastInsertRowid))];
    }
    if ((m = path.match(/^\/api\/users\/(\d+)$/)) && method === 'PUT') {
      need(user, SA);
      const id = Number(m[1]);
      const target = get('SELECT * FROM users WHERE id = ?', id);
      if (!target) throw forbidden404();
      const v = validUser(body, id);
      const aktif = body.aktif === false || body.aktif === 0 ? 0 : 1;
      if (id === user.id && (!aktif || v.role !== SA)) throw bad('Anda tidak dapat menonaktifkan atau menurunkan role akun Anda sendiri');
      run('UPDATE users SET nama=?, email=?, role=?, unit_id=?, aktif=? WHERE id=?', v.nama, v.email, v.role, v.unit_id, aktif, id);
      if (body.password) { validPassword(body.password); run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(body.password), id); }
      if (!aktif || body.password || v.role !== target.role || v.unit_id !== target.unit_id) run('DELETE FROM sessions WHERE user_id = ?', id);
      audit(user, 'user_ubah', target.username);
      return userRow(id);
    }
    if (path === '/api/audit' && method === 'GET') {
      need(user, SA);
      return all(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200`);
    }

    // Barang
    if (path === '/api/items' && method === 'GET') {
      const rows = stokList({ unit: unitBaca(user, query), aktif: !query.semua });
      return query.status ? rows.filter((r) => r.status === query.status) : rows;
    }
    if (path === '/api/items' && method === 'POST') {
      need(user, OP);
      const v = validItem(body, user.unit_id);
      const r = run('INSERT INTO items (unit_id,kode,nama,kategori,satuan,stok_minimum,kode_barang) VALUES (?,?,?,?,?,?,?)', user.unit_id, v.kode, v.nama, v.kategori, v.satuan, v.stok_minimum, v.kode_barang);
      return [201, stokItem(Number(r.lastInsertRowid))];
    }
    if ((m = path.match(/^\/api\/items\/(\d+)$/)) && (method === 'PUT' || method === 'DELETE')) {
      need(user, OP);
      const it = itemUntuk(user, m[1]);
      if (method === 'PUT') {
        const v = validItem(body, it.unit_id, it.id);
        run('UPDATE items SET kode=?, nama=?, kategori=?, satuan=?, stok_minimum=?, kode_barang=?, aktif=? WHERE id=?',
          v.kode, v.nama, v.kategori, v.satuan, v.stok_minimum, v.kode_barang, body.aktif === false || body.aktif === 0 ? 0 : 1, it.id);
        return stokItem(it.id);
      }
      if (get('SELECT 1 FROM transactions WHERE item_id = ? LIMIT 1', it.id) || get('SELECT 1 FROM opname_lines WHERE item_id = ? LIMIT 1', it.id) || get('SELECT 1 FROM transfers WHERE item_asal_id = ? OR item_tujuan_id = ? LIMIT 1', it.id, it.id))
        throw bad('Barang sudah punya riwayat; nonaktifkan saja (aktif = false)');
      run('DELETE FROM items WHERE id = ?', it.id);
      return { ok: true };
    }

    // Transaksi
    if (path === '/api/transaksi' && method === 'GET') {
      const unit = unitBaca(user, query);
      const cond = [], p = [];
      if (unit) { cond.push('i.unit_id = ?'); p.push(unit); }
      for (const [k, col] of [['jenis', 't.jenis'], ['kategori', 't.kategori'], ['status', 't.status']])
        if (query[k]) { cond.push(`${col} = ?`); p.push(query[k]); }
      if (query.item_id) { cond.push('t.item_id = ?'); p.push(Number(query.item_id)); }
      if (query.dari) { cond.push('t.tanggal >= ?'); p.push(query.dari); }
      if (query.sampai) { cond.push('t.tanggal <= ?'); p.push(query.sampai); }
      const limit = Math.min(parseInt(query.limit, 10) || 200, 20000);
      return all(`SELECT t.*, i.kode, i.nama, i.satuan, un.kode AS unit_kode, c.nama AS pembuat, d.nama AS pemutus
                  FROM transactions t JOIN items i ON i.id = t.item_id JOIN units un ON un.id = i.unit_id
                  LEFT JOIN users c ON c.id = t.dibuat_oleh LEFT JOIN users d ON d.id = t.diputuskan_oleh
                  ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY t.tanggal DESC, t.id DESC LIMIT ${limit}`, ...p);
    }
    if (path === '/api/transaksi' && method === 'POST') {
      need(user, OP);
      const v = validTx(user, body);
      if (v.jenis === 'KELUAR' && v.qty > v.stok + 1e-9) throw bad(`Stok tersedia hanya ${v.stok}`);
      const r = insertTx(v, { status: 'MENUNGGU', dibuat_oleh: user.id });
      return [201, { id: Number(r.lastInsertRowid), status: 'MENUNGGU' }];
    }
    if ((m = path.match(/^\/api\/transaksi\/(\d+)(?:\/(setujui|tolak))?$/))) {
      const t = txUntuk(user, m[1]);
      if (method === 'DELETE' && !m[2]) {
        need(user, OP);
        if (t.status === 'DISETUJUI') throw bad('Transaksi yang sudah disetujui tidak dapat dihapus; koreksi melalui stok opname');
        run('DELETE FROM transactions WHERE id = ?', t.id);
        return { ok: true };
      }
      if (method === 'POST' && m[2]) {
        need(user, AP);
        if (t.status !== 'MENUNGGU') throw bad('Transaksi ini sudah diputuskan');
        const catatan = str(body.catatan);
        if (m[2] === 'tolak') {
          if (!catatan) throw bad('Alasan penolakan wajib diisi');
          run("UPDATE transactions SET status='DITOLAK', diputuskan_oleh=?, diputuskan_at=?, catatan_keputusan=? WHERE id=?", user.id, new Date().toISOString(), catatan, t.id);
          audit(user, 'transaksi_tolak', `#${t.id}`);
          return { id: t.id, status: 'DITOLAK' };
        }
        return tx(() => {
          // pemakaian/keluar dinilai dengan harga rata-rata saat disetujui
          const harga = t.jenis === 'KELUAR' ? stokItem(t.item_id).harga_rata : t.harga_satuan;
          run("UPDATE transactions SET status='DISETUJUI', harga_satuan=?, diputuskan_oleh=?, diputuskan_at=?, catatan_keputusan=? WHERE id=?", harga, user.id, new Date().toISOString(), catatan, t.id);
          assertNoNegative(t.item_id);
          audit(user, 'transaksi_setuju', `#${t.id}`);
          return { id: t.id, status: 'DISETUJUI' };
        });
      }
    }

    // Opname
    if (path === '/api/opname' && method === 'GET') {
      const unit = unitBaca(user, query);
      return all(`SELECT o.*, u.kode AS unit_kode, (SELECT COUNT(*) FROM opname_lines WHERE opname_id=o.id) AS jumlah_barang,
        (SELECT COUNT(*) FROM opname_lines WHERE opname_id=o.id AND stok_fisik IS NOT NULL AND stok_fisik <> stok_sistem) AS jumlah_selisih
        FROM opnames o JOIN units u ON u.id = o.unit_id ${unit ? 'WHERE o.unit_id = ?' : ''} ORDER BY o.periode DESC, o.id DESC`, ...(unit ? [unit] : []));
    }
    if (path === '/api/opname' && method === 'POST') {
      need(user, OP);
      const tipe = str(body.tipe).toUpperCase(), periode = str(body.periode);
      validPeriode(tipe, periode);
      const tanggal = str(body.tanggal) || today();
      if (!isDate(tanggal)) throw bad('Format tanggal harus YYYY-MM-DD');
      if (get('SELECT 1 FROM opnames WHERE unit_id=? AND tipe=? AND periode=?', user.unit_id, tipe, periode)) throw bad(`Opname ${tipe.toLowerCase()} periode ${periode} sudah ada`);
      return tx(() => {
        const r = run('INSERT INTO opnames (unit_id,tipe,periode,tanggal,catatan,dibuat_oleh) VALUES (?,?,?,?,?,?)', user.unit_id, tipe, periode, tanggal, str(body.catatan), user.id);
        const id = Number(r.lastInsertRowid);
        for (const i of stokList({ unit: user.unit_id, aktif: true }))
          run('INSERT INTO opname_lines (opname_id,item_id,stok_sistem) VALUES (?,?,?)', id, i.id, i.stok);
        return [201, opnameUntuk(user, id)];
      });
    }
    if ((m = path.match(/^\/api\/opname\/(\d+)(?:\/(ajukan|finalisasi|kembalikan))?$/))) {
      const o = opnameUntuk(user, m[1]);
      const aksi = m[2];
      if (method === 'GET' && !aksi) return o;
      if (method === 'PUT' && !aksi) {
        need(user, OP);
        if (o.status !== 'DRAFT') throw bad('Opname hanya dapat diubah saat berstatus DRAFT');
        return tx(() => {
          for (const l of body.lines ?? []) {
            const fisik = l.stok_fisik === '' || l.stok_fisik == null ? null : num(l.stok_fisik, 'Stok fisik');
            if (fisik != null && fisik < 0) throw bad('Stok fisik tidak boleh negatif');
            run('UPDATE opname_lines SET stok_fisik=?, keterangan=? WHERE opname_id=? AND item_id=?', fisik, str(l.keterangan), o.id, Number(l.item_id));
          }
          if (body.catatan != null) run('UPDATE opnames SET catatan=? WHERE id=?', str(body.catatan), o.id);
          return opnameUntuk(user, o.id);
        });
      }
      if (method === 'POST' && aksi === 'ajukan') {
        need(user, OP);
        if (o.status !== 'DRAFT') throw bad('Opname bukan berstatus DRAFT');
        const kosong = o.lines.filter((l) => l.stok_fisik == null);
        if (kosong.length) throw bad(`${kosong.length} barang belum diisi stok fisiknya`);
        run("UPDATE opnames SET status='DIAJUKAN', catatan_keputusan='' WHERE id=?", o.id);
        audit(user, 'opname_ajukan', `${o.unit_kode} ${o.periode}`);
        return opnameUntuk(user, o.id);
      }
      if (method === 'POST' && aksi === 'kembalikan') {
        need(user, AP);
        if (o.status !== 'DIAJUKAN') throw bad('Opname belum diajukan');
        const catatan = str(body.catatan);
        if (!catatan) throw bad('Alasan pengembalian wajib diisi');
        run("UPDATE opnames SET status='DRAFT', catatan_keputusan=? WHERE id=?", catatan, o.id);
        audit(user, 'opname_kembalikan', `${o.unit_kode} ${o.periode}`);
        return opnameUntuk(user, o.id);
      }
      if (method === 'POST' && aksi === 'finalisasi') {
        need(user, AP);
        if (o.status !== 'DIAJUKAN') throw bad('Opname belum diajukan');
        const pending = get(`SELECT COUNT(*) AS n FROM transactions t JOIN items i ON i.id=t.item_id WHERE t.status='MENUNGGU' AND i.unit_id=?`, o.unit_id).n;
        if (pending) throw bad(`Masih ada ${pending} transaksi menunggu persetujuan; putuskan dulu sebelum finalisasi`);
        return tx(() => {
          for (const l of o.lines) {
            const sekarang = stokItem(l.item_id);
            const selisih = l.stok_fisik - sekarang.stok;
            run('UPDATE opname_lines SET stok_sistem=? WHERE opname_id=? AND item_id=?', sekarang.stok, o.id, l.item_id);
            if (Math.abs(selisih) < 1e-9) continue;
            insertTx({
              tanggal: o.tanggal, jenis: selisih > 0 ? 'MASUK' : 'KELUAR',
              kategori: selisih > 0 ? 'penyesuaian_masuk' : 'penyesuaian_keluar',
              item_id: l.item_id, qty: Math.abs(selisih), harga_satuan: sekarang.harga_rata,
              pihak: '', no_dokumen: `OPNAME-${o.periode}`, keterangan: `Penyesuaian stok opname ${o.tipe.toLowerCase()} ${o.periode}`,
            }, { opname_id: o.id, status: 'DISETUJUI', dibuat_oleh: o.dibuat_oleh, diputuskan_oleh: user.id });
            assertNoNegative(l.item_id);
          }
          run("UPDATE opnames SET status='FINAL', diputuskan_oleh=? WHERE id=?", user.id, o.id);
          audit(user, 'opname_final', `${o.unit_kode} ${o.periode}`);
          return opnameUntuk(user, o.id);
        });
      }
    }
    throw new HttpError(404, 'Endpoint tidak ditemukan');
  };
}
