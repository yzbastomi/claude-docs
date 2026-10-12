// Transfer barang antar unit yang tertaut ke dua transaksi (keluar di asal, masuk di tujuan).
//
//  DIAJUKAN ──approver asal──▶ DIKIRIM ──operator tujuan (petakan barang, jumlah diterima)──▶ DIPERIKSA ──approver tujuan──▶ DITERIMA
//     │ tolak / batal              │ tolak (approver tujuan)                      │ tolak (approver tujuan)
//     ▼                            ▼                                              ▼
//  DITOLAK_ASAL / DIBATALKAN     DIKEMBALIKAN (stok kembali ke unit asal)    DIKEMBALIKAN
//
// Penerimaan sebagian: jika jumlah diterima < jumlah dikirim, selisihnya otomatis kembali ke stok unit asal saat DITERIMA.
// Stok asal berkurang saat DIKIRIM; stok tujuan bertambah saat DITERIMA. Selama di perjalanan,
// barang tidak dihitung di unit mana pun.
const SA = 'SUPER_ADMIN', OP = 'OPERATOR', AP = 'APPROVER';

export function transferRoutes(ctx) {
  const { all, get, run, tx, audit, need, stokItem, itemUntuk, assertNoNegative, insertTx, bad, str, num, isDate, today, HttpError, kabari, penerima, iso, stokDi, gudangUntuk, gudangUtama } = ctx;

  const SELECT = `SELECT t.*, ua.kode AS unit_asal_kode, ua.nama AS unit_asal_nama, ut.kode AS unit_tujuan_kode, ut.nama AS unit_tujuan_nama,
      ia.kode AS item_asal_kode, ia.nama AS item_asal_nama, ia.satuan AS satuan, it.kode AS item_tujuan_kode, it.nama AS item_tujuan_nama,
      ga.kode AS gudang_asal_kode, gt.kode AS gudang_tujuan_kode
    FROM transfers t JOIN units ua ON ua.id = t.unit_asal_id JOIN units ut ON ut.id = t.unit_tujuan_id
    JOIN items ia ON ia.id = t.item_asal_id LEFT JOIN items it ON it.id = t.item_tujuan_id
    LEFT JOIN gudang ga ON ga.id = t.gudang_asal_id LEFT JOIN gudang gt ON gt.id = t.gudang_tujuan_id`;
  // gudang efektif (data lama tanpa gudang = gudang utama unit)
  const gAsal = (t) => t.gudang_asal_id ?? gudangUtama(t.unit_asal_id);
  const gTujuan = (t) => t.gudang_tujuan_id ?? gudangUtama(t.unit_tujuan_id);

  const visible = (u, t) => u.role === SA || t.unit_asal_id === u.unit_id || t.unit_tujuan_id === u.unit_id;
  // Aksi yang boleh dilakukan user pada transfer (dipakai server untuk otorisasi & klien untuk tombol)
  function aksiUntuk(u, t) {
    const asal = t.unit_asal_id === u.unit_id, tujuan = t.unit_tujuan_id === u.unit_id;
    if (u.role === OP && asal && t.status === 'DIAJUKAN') return ['batal'];
    if (u.role === AP && asal && t.status === 'DIAJUKAN') return ['setujui', 'tolak'];
    if (u.role === OP && tujuan && (t.status === 'DIKIRIM' || t.status === 'DIPERIKSA')) return ['terima'];
    if (u.role === AP && tujuan && t.status === 'DIPERIKSA') return ['setujui', 'tolak'];
    if (u.role === AP && tujuan && t.status === 'DIKIRIM') return ['tolak'];
    return [];
  }
  const load = (u, id) => {
    const t = get(`${SELECT} WHERE t.id = ?`, Number(id));
    if (!t || !visible(u, t)) throw new HttpError(404, 'Transfer tidak ditemukan');
    return t;
  };
  const withAksi = (u, t) => ({ ...t, aksi: aksiUntuk(u, t) });
  const izinkan = (u, t, aksi) => {
    if (!u || !aksiUntuk(u, t).includes(aksi)) throw new HttpError(403, `Anda tidak dapat melakukan aksi "${aksi}" pada transfer berstatus ${t.status}`);
  };
  const setStatus = (id, status, kolom = '', ...v) => run(`UPDATE transfers SET status = ?, updated_at = ?${kolom} WHERE id = ?`, status, iso(), ...v, id);

  return function handle(method, path, query, body, user) {
    let m;
    if (path === '/api/unit/tujuan' && method === 'GET')
      return all('SELECT id, kode, nama FROM units WHERE aktif = 1 AND id IS NOT ? ORDER BY kode', user.unit_id ?? null);

    if (path === '/api/transfer' && method === 'GET') {
      const c = [], p = [];
      if (user.role !== SA) { c.push('(t.unit_asal_id = ? OR t.unit_tujuan_id = ?)'); p.push(user.unit_id, user.unit_id); }
      else if (query.unit_id) { c.push('(t.unit_asal_id = ? OR t.unit_tujuan_id = ?)'); p.push(Number(query.unit_id), Number(query.unit_id)); }
      const u = user.role === SA ? Number(query.unit_id) || null : user.unit_id;
      if (query.arah === 'keluar' && u) { c.push('t.unit_asal_id = ?'); p.push(u); }
      if (query.arah === 'masuk' && u) { c.push('t.unit_tujuan_id = ?'); p.push(u); }
      if (query.status) { c.push('t.status = ?'); p.push(query.status); }
      return all(`${SELECT} ${c.length ? 'WHERE ' + c.join(' AND ') : ''} ORDER BY t.id DESC LIMIT 300`, ...p).map((t) => withAksi(user, t));
    }

    if (path === '/api/transfer' && method === 'POST') {
      need(user, OP);
      const item = itemUntuk(user, body.item_id);
      if (!item.aktif) throw bad('Barang nonaktif');
      const tujuan = get('SELECT * FROM units WHERE id = ? AND aktif = 1', Number(body.unit_tujuan_id));
      if (!tujuan || tujuan.id === user.unit_id) throw bad('Unit tujuan tidak valid');
      const qty = num(body.qty, 'Jumlah');
      if (qty <= 0) throw bad('Jumlah harus lebih dari 0');
      const gudang = gudangUntuk(user, body.gudang_asal_id || gudangUtama(user.unit_id), { aktif: true });
      const tersedia = stokDi(item.id, gudang.id);
      if (qty > tersedia + 1e-9) throw bad(`Stok tersedia di gudang ${gudang.kode} hanya ${tersedia}`);
      const tanggal = str(body.tanggal) || today();
      if (!isDate(tanggal)) throw bad('Format tanggal harus YYYY-MM-DD');
      const r = run(`INSERT INTO transfers (unit_asal_id, unit_tujuan_id, item_asal_id, gudang_asal_id, qty, tanggal, no_dokumen, keterangan, dibuat_oleh)
                     VALUES (?,?,?,?,?,?,?,?,?)`, user.unit_id, tujuan.id, item.id, gudang.id, qty, tanggal, str(body.no_dokumen), str(body.keterangan), user.id);
      kabari(penerima(user.unit_id, 'APPROVER'));
      audit(user, 'transfer_ajukan', `#${r.lastInsertRowid} ${item.kode} x${qty} → ${tujuan.kode}`);
      return [201, withAksi(user, load(user, r.lastInsertRowid))];
    }

    if ((m = path.match(/^\/api\/transfer\/(\d+)(?:\/(batal|setujui|tolak|terima))?$/))) {
      const t = load(user, m[1]);
      const aksi = m[2];
      if (method === 'GET' && !aksi) return withAksi(user, t);
      if (method !== 'POST' || !aksi) throw new HttpError(404, 'Endpoint tidak ditemukan');
      izinkan(user, t, aksi);
      const catatan = str(body.catatan);

      if (aksi === 'batal') {
        setStatus(t.id, 'DIBATALKAN');
        audit(user, 'transfer_batal', `#${t.id}`);
      } else if (aksi === 'terima') {
        const asal = get('SELECT * FROM items WHERE id = ?', t.item_asal_id);
        const gudangT = gudangUntuk(user, body.gudang_id || gudangUtama(user.unit_id), { aktif: true });
        const diterima = body.qty_diterima == null || body.qty_diterima === '' ? t.qty : num(body.qty_diterima, 'Jumlah diterima');
        if (!(diterima > 0) || diterima > t.qty + 1e-9) throw bad(`Jumlah diterima harus lebih dari 0 dan paling banyak ${t.qty}`);
        const qtyTerima = Math.abs(diterima - t.qty) < 1e-9 ? t.qty : diterima;
        if (qtyTerima < t.qty && !catatan) throw bad('Alasan selisih penerimaan wajib diisi (isi catatan)');
        let tujuanId;
        if (body.buat_item_baru) {
          if (get('SELECT 1 FROM items WHERE unit_id = ? AND kode = ?', user.unit_id, asal.kode))
            throw bad(`Kode ${asal.kode} sudah dipakai di unit Anda; pilih barang yang sudah ada`);
        } else {
          const it = itemUntuk(user, body.item_id);
          if (!it.aktif) throw bad('Barang nonaktif');
          if (it.satuan.toLowerCase() !== asal.satuan.toLowerCase()) throw bad(`Satuan berbeda (${asal.satuan} ≠ ${it.satuan}); pilih barang dengan satuan yang sama`);
          tujuanId = it.id;
        }
        tx(() => {
          if (body.buat_item_baru)
            tujuanId = Number(run('INSERT INTO items (unit_id, kode, nama, kategori, satuan, stok_minimum, kode_barang) VALUES (?,?,?,?,?,0,?)',
              user.unit_id, asal.kode, asal.nama, asal.kategori, asal.satuan, asal.kode_barang).lastInsertRowid);
          setStatus(t.id, 'DIPERIKSA', ', item_tujuan_id = ?, gudang_tujuan_id = ?, diterima_oleh = ?, qty_diterima = ?, catatan_penerimaan = ?', tujuanId, gudangT.id, user.id, qtyTerima, qtyTerima < t.qty ? catatan : '');
        });
        kabari(penerima(t.unit_tujuan_id, 'APPROVER'));
        audit(user, 'transfer_terima', `#${t.id} ${qtyTerima}/${t.qty}`);
      } else if (aksi === 'setujui') {
        if (t.status === 'DIAJUKAN') {
          tx(() => {
            const item = stokItem(t.item_asal_id), tersedia = stokDi(t.item_asal_id, gAsal(t));
            if (t.qty > tersedia + 1e-9) throw bad(`Stok tersedia hanya ${tersedia}`);
            insertTx({
              tanggal: t.tanggal, jenis: 'KELUAR', kategori: 'transfer_keluar', item_id: t.item_asal_id, gudang_id: gAsal(t), qty: t.qty, harga_satuan: item.harga_rata,
              pihak: t.unit_tujuan_nama, no_dokumen: t.no_dokumen, keterangan: `Transfer #${t.id} ke ${t.unit_tujuan_kode}`,
            }, { status: 'DISETUJUI', dibuat_oleh: t.dibuat_oleh, diputuskan_oleh: user.id, transfer_id: t.id });
            assertNoNegative(t.item_asal_id);
            setStatus(t.id, 'DIKIRIM', ', harga_satuan = ?, disetujui_asal_oleh = ?', item.harga_rata, user.id);
          });
          kabari([...penerima(t.unit_tujuan_id, 'OPERATOR'), t.dibuat_oleh]);
          audit(user, 'transfer_kirim', `#${t.id}`);
        } else { // DIPERIKSA: approver tujuan
          const diterima = t.qty_diterima ?? t.qty, selisih = t.qty - diterima; // NULL = data sebelum fitur sebagian
          tx(() => {
            insertTx({
              tanggal: today(), jenis: 'MASUK', kategori: 'transfer_masuk', item_id: t.item_tujuan_id, gudang_id: gTujuan(t), qty: diterima, harga_satuan: t.harga_satuan,
              pihak: t.unit_asal_nama, no_dokumen: t.no_dokumen, keterangan: `Transfer #${t.id} dari ${t.unit_asal_kode}`,
            }, { status: 'DISETUJUI', dibuat_oleh: t.diterima_oleh, diputuskan_oleh: user.id, transfer_id: t.id });
            if (selisih > 1e-9) // sisa yang tidak diterima kembali ke unit asal
              insertTx({
                tanggal: today(), jenis: 'MASUK', kategori: 'transfer_masuk', item_id: t.item_asal_id, gudang_id: gAsal(t), qty: selisih, harga_satuan: t.harga_satuan,
                pihak: t.unit_tujuan_nama, no_dokumen: t.no_dokumen,
                keterangan: `Pengembalian selisih transfer #${t.id} (diterima ${diterima} dari ${t.qty}): ${t.catatan_penerimaan}`,
              }, { status: 'DISETUJUI', dibuat_oleh: t.dibuat_oleh, diputuskan_oleh: user.id, transfer_id: t.id });
            setStatus(t.id, 'DITERIMA', ', disetujui_tujuan_oleh = ?', user.id);
          });
          kabari([t.dibuat_oleh, t.diterima_oleh]);
          audit(user, 'transfer_diterima', `#${t.id}`);
        }
      } else { // tolak
        if (!catatan) throw bad('Alasan penolakan wajib diisi');
        if (t.status === 'DIAJUKAN') {
          setStatus(t.id, 'DITOLAK_ASAL', ', catatan_keputusan = ?', catatan);
          kabari([t.dibuat_oleh]);
          audit(user, 'transfer_tolak_asal', `#${t.id}`);
        } else { // barang sudah keluar dari asal: kembalikan stoknya
          tx(() => {
            insertTx({
              tanggal: today(), jenis: 'MASUK', kategori: 'transfer_masuk', item_id: t.item_asal_id, gudang_id: gAsal(t), qty: t.qty, harga_satuan: t.harga_satuan,
              pihak: t.unit_tujuan_nama, no_dokumen: t.no_dokumen, keterangan: `Pengembalian transfer #${t.id} (ditolak ${t.unit_tujuan_kode})`,
            }, { status: 'DISETUJUI', dibuat_oleh: t.dibuat_oleh, diputuskan_oleh: user.id, transfer_id: t.id });
            setStatus(t.id, 'DIKEMBALIKAN', ', catatan_keputusan = ?, disetujui_tujuan_oleh = ?', catatan, user.id);
          });
          kabari([t.dibuat_oleh, t.diterima_oleh]);
          audit(user, 'transfer_kembalikan', `#${t.id}`);
        }
      }
      return withAksi(user, load(user, t.id));
    }
  };
}
