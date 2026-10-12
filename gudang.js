// Master gudang (banyak gudang per unit) dan mutasi barang antar gudang dalam satu unit.
//
// Mutasi: operator mengajukan (barang, gudang asal -> tujuan, jumlah); approver unit menyetujui; saat disetujui sistem membuat
// dua transaksi tertaut (mutasi_keluar di asal, mutasi_masuk di tujuan) pada harga rata-rata barang, sehingga nilai persediaan unit tidak berubah.
const SA = 'SUPER_ADMIN', OP = 'OPERATOR', AP = 'APPROVER';

export function createGudang(ctx) {
  const { all, get, run, tx, audit, need, bad, str, num, isDate, today, HttpError, kabari, penerima, iso, stokItem, itemUntuk, stokDi, gudangUntuk, insertTx, assertNoNegative } = ctx;

  const BERSTOK = `(SELECT COUNT(*) FROM (SELECT item_id FROM transactions WHERE gudang_id = g.id AND status = 'DISETUJUI'
                    GROUP BY item_id HAVING ABS(SUM(CASE jenis WHEN 'MASUK' THEN qty ELSE -qty END)) > 1e-9))`;
  const gudangRow = (id) => get(`SELECT g.*, u.kode AS unit_kode, ${BERSTOK} AS jumlah_barang FROM gudang g JOIN units u ON u.id = g.unit_id WHERE g.id = ?`, id);
  const unitBaca = (user, q) => (user.role === SA ? (q.unit_id ? Number(q.unit_id) : null) : user.unit_id);

  const MUT = `SELECT m.*, i.kode AS item_kode, i.nama AS item_nama, i.satuan, ga.kode AS gudang_asal_kode, ga.nama AS gudang_asal_nama,
      gt.kode AS gudang_tujuan_kode, gt.nama AS gudang_tujuan_nama, u.kode AS unit_kode, c.nama AS pembuat
    FROM mutasi m JOIN items i ON i.id = m.item_id JOIN gudang ga ON ga.id = m.gudang_asal_id JOIN gudang gt ON gt.id = m.gudang_tujuan_id
    JOIN units u ON u.id = m.unit_id LEFT JOIN users c ON c.id = m.dibuat_oleh`;
  const aksiMutasi = (user, m) => {
    if (user.unit_id !== m.unit_id) return [];
    if (user.role === AP && m.status === 'MENUNGGU') return ['setujui', 'tolak'];
    if (user.role === OP && m.status !== 'DISETUJUI') return ['hapus'];
    return [];
  };
  const mutasiUntuk = (user, id) => {
    const m = get(`${MUT} WHERE m.id = ?`, Number(id));
    if (!m || (user.role !== SA && user.unit_id !== m.unit_id)) throw new HttpError(404, 'Mutasi tidak ditemukan');
    return m;
  };
  const dgAksi = (user, m) => ({ ...m, aksi: aksiMutasi(user, m) });

  return function handle(method, path, query, body, user) {
    let m;
    // ---------- Gudang ----------
    if (path === '/api/gudang' && method === 'GET') {
      const unit = unitBaca(user, query), c = [], p = [];
      if (unit) { c.push('g.unit_id = ?'); p.push(unit); }
      if (query.aktif) c.push('g.aktif = 1');
      return all(`SELECT g.*, u.kode AS unit_kode, ${BERSTOK} AS jumlah_barang FROM gudang g JOIN units u ON u.id = g.unit_id
                  ${c.length ? 'WHERE ' + c.join(' AND ') : ''} ORDER BY u.kode, g.utama DESC, g.kode`, ...p);
    }
    if (path === '/api/gudang' && method === 'POST') {
      need(user, OP);
      const kode = str(body.kode).toUpperCase(), nama = str(body.nama);
      if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(kode)) throw bad('Kode gudang 1-20 karakter: huruf, angka, titik, garis bawah, atau strip');
      if (!nama || nama.length > 100) throw bad('Nama gudang wajib diisi (maksimal 100 karakter)');
      if (get('SELECT 1 FROM gudang WHERE unit_id = ? AND kode = ?', user.unit_id, kode)) throw bad(`Kode gudang "${kode}" sudah dipakai`);
      const r = run('INSERT INTO gudang (unit_id, kode, nama) VALUES (?,?,?)', user.unit_id, kode, nama);
      audit(user, 'gudang_baru', `${kode} ${nama}`);
      return [201, gudangRow(Number(r.lastInsertRowid))];
    }
    if ((m = path.match(/^\/api\/gudang\/(\d+)$/)) && (method === 'PUT' || method === 'DELETE')) {
      need(user, OP);
      const g = gudangUntuk(user, m[1]);
      if (method === 'DELETE') {
        if (g.utama) throw bad('Gudang utama tidak dapat dihapus');
        const dipakai = get(`SELECT 1 FROM transactions WHERE gudang_id = @g UNION SELECT 1 FROM mutasi WHERE gudang_asal_id = @g OR gudang_tujuan_id = @g
                             UNION SELECT 1 FROM opnames WHERE gudang_id = @g UNION SELECT 1 FROM transfers WHERE gudang_asal_id = @g OR gudang_tujuan_id = @g`, { g: g.id });
        if (dipakai) throw bad('Gudang sudah punya riwayat; nonaktifkan saja');
        run('DELETE FROM gudang WHERE id = ?', g.id);
        audit(user, 'gudang_hapus', g.kode);
        return { ok: true };
      }
      const nama = body.nama === undefined ? g.nama : str(body.nama);
      if (!nama || nama.length > 100) throw bad('Nama gudang wajib diisi (maksimal 100 karakter)');
      const aktif = body.aktif === undefined ? g.aktif : body.aktif === false || body.aktif === 0 ? 0 : 1;
      if (!aktif) {
        if (g.utama && body.utama !== false) throw bad('Gudang utama tidak dapat dinonaktifkan; jadikan gudang lain sebagai utama terlebih dahulu');
        const n = gudangRow(g.id).jumlah_barang;
        if (n) throw bad(`Masih ada ${n} barang berstok di gudang ini; pindahkan dengan mutasi terlebih dahulu`);
        const tunggu = get(`SELECT COUNT(*) AS n FROM transactions WHERE gudang_id = @g AND status = 'MENUNGGU'`, { g: g.id }).n
          + get(`SELECT COUNT(*) AS n FROM mutasi WHERE (gudang_asal_id = @g OR gudang_tujuan_id = @g) AND status = 'MENUNGGU'`, { g: g.id }).n;
        if (tunggu) throw bad(`Masih ada ${tunggu} transaksi/mutasi menunggu persetujuan pada gudang ini`);
      }
      tx(() => {
        if (body.utama === true) {
          if (!aktif) throw bad('Gudang nonaktif tidak dapat menjadi gudang utama');
          run('UPDATE gudang SET utama = 0 WHERE unit_id = ?', g.unit_id);
          run('UPDATE gudang SET utama = 1 WHERE id = ?', g.id);
        } else if (body.utama === false && g.utama) throw bad('Pilih gudang lain sebagai utama; unit harus selalu punya satu gudang utama');
        run('UPDATE gudang SET nama = ?, aktif = ? WHERE id = ?', nama, aktif, g.id);
      });
      audit(user, 'gudang_ubah', g.kode);
      return gudangRow(g.id);
    }

    // ---------- Mutasi antar gudang ----------
    if (path === '/api/mutasi' && method === 'GET') {
      const unit = unitBaca(user, query), c = [], p = [];
      if (unit) { c.push('m.unit_id = ?'); p.push(unit); }
      if (query.status) { c.push('m.status = ?'); p.push(query.status); }
      return all(`${MUT} ${c.length ? 'WHERE ' + c.join(' AND ') : ''} ORDER BY m.id DESC LIMIT 300`, ...p).map((r) => dgAksi(user, r));
    }
    if (path === '/api/mutasi' && method === 'POST') {
      need(user, OP);
      const item = itemUntuk(user, body.item_id);
      if (!item.aktif) throw bad('Barang nonaktif');
      const asal = gudangUntuk(user, body.gudang_asal_id, { aktif: true }), tujuan = gudangUntuk(user, body.gudang_tujuan_id, { aktif: true });
      if (asal.id === tujuan.id) throw bad('Gudang asal dan tujuan harus berbeda');
      const qty = num(body.qty, 'Jumlah');
      if (qty <= 0) throw bad('Jumlah harus lebih dari 0');
      const tersedia = stokDi(item.id, asal.id);
      if (qty > tersedia + 1e-9) throw bad(`Stok tersedia di gudang ${asal.kode} hanya ${tersedia}`);
      const tanggal = str(body.tanggal) || today();
      if (!isDate(tanggal)) throw bad('Format tanggal harus YYYY-MM-DD');
      const r = run('INSERT INTO mutasi (unit_id, item_id, gudang_asal_id, gudang_tujuan_id, qty, tanggal, keterangan, dibuat_oleh) VALUES (?,?,?,?,?,?,?,?)',
        user.unit_id, item.id, asal.id, tujuan.id, qty, tanggal, str(body.keterangan), user.id);
      kabari(penerima(user.unit_id, AP), user.id);
      audit(user, 'mutasi_ajukan', `#${r.lastInsertRowid} ${item.kode} x${qty} ${asal.kode}->${tujuan.kode}`);
      return [201, dgAksi(user, mutasiUntuk(user, r.lastInsertRowid))];
    }
    if ((m = path.match(/^\/api\/mutasi\/(\d+)(?:\/(setujui|tolak))?$/))) {
      const mu = mutasiUntuk(user, m[1]);
      if (method === 'GET' && !m[2]) return dgAksi(user, mu);
      if (method === 'DELETE' && !m[2]) {
        need(user, OP);
        if (user.unit_id !== mu.unit_id) throw new HttpError(404, 'Mutasi tidak ditemukan');
        if (mu.status === 'DISETUJUI') throw bad('Mutasi yang sudah disetujui tidak dapat dihapus');
        run('DELETE FROM mutasi WHERE id = ?', mu.id);
        return { ok: true };
      }
      if (method === 'POST' && m[2]) {
        need(user, AP);
        if (user.unit_id !== mu.unit_id) throw new HttpError(404, 'Mutasi tidak ditemukan');
        if (mu.status !== 'MENUNGGU') throw bad('Mutasi ini sudah diputuskan');
        const catatan = str(body.catatan);
        if (m[2] === 'tolak') {
          if (!catatan) throw bad('Alasan penolakan wajib diisi');
          run("UPDATE mutasi SET status = 'DITOLAK', diputuskan_oleh = ?, diputuskan_at = ?, catatan_keputusan = ? WHERE id = ?", user.id, iso(), catatan, mu.id);
          kabari([mu.dibuat_oleh], user.id);
          audit(user, 'mutasi_tolak', `#${mu.id}`);
          return dgAksi(user, mutasiUntuk(user, mu.id));
        }
        tx(() => {
          for (const gid of [mu.gudang_asal_id, mu.gudang_tujuan_id]) gudangUntuk(user, gid, { aktif: true });
          const tersedia = stokDi(mu.item_id, mu.gudang_asal_id);
          if (mu.qty > tersedia + 1e-9) throw bad(`Stok di gudang ${mu.gudang_asal_kode} sekarang hanya ${tersedia}; tidak cukup untuk mutasi ini`);
          const harga = stokItem(mu.item_id).harga_rata; // nilai tidak berubah: pindah pada harga rata-rata
          const dasar = { tanggal: mu.tanggal, item_id: mu.item_id, qty: mu.qty, harga_satuan: harga, pihak: '', no_dokumen: `MUT-${mu.id}` };
          const extra = { status: 'DISETUJUI', dibuat_oleh: mu.dibuat_oleh, diputuskan_oleh: user.id, mutasi_id: mu.id };
          insertTx({ ...dasar, jenis: 'KELUAR', kategori: 'mutasi_keluar', gudang_id: mu.gudang_asal_id, keterangan: `Mutasi #${mu.id} ke gudang ${mu.gudang_tujuan_kode}` }, extra);
          insertTx({ ...dasar, jenis: 'MASUK', kategori: 'mutasi_masuk', gudang_id: mu.gudang_tujuan_id, keterangan: `Mutasi #${mu.id} dari gudang ${mu.gudang_asal_kode}` }, extra);
          assertNoNegative(mu.item_id);
          run("UPDATE mutasi SET status = 'DISETUJUI', diputuskan_oleh = ?, diputuskan_at = ?, catatan_keputusan = ? WHERE id = ?", user.id, iso(), catatan, mu.id);
        });
        kabari([mu.dibuat_oleh], user.id);
        audit(user, 'mutasi_setuju', `#${mu.id}`);
        return dgAksi(user, mutasiUntuk(user, mu.id));
      }
    }
  };
}
