// Referensi kode barang persediaan, mengikuti kodefikasi BMN yang dipakai SAKTI (PMK 29/PMK.06/2010):
// 10 digit  X.XX.XX.XX.XXX = Golongan(1) Bidang(2) Kelompok(2) Sub Kelompok(2) Sub-sub Kelompok(3).
// Disimpan sebagai pohon: setiap tingkat memakai awalan digit tingkat di atasnya (induk harus ada lebih dulu).
// Barang persediaan dipasangkan ke tingkat ke-5 (10 digit).
export const GOLONGAN_PERSEDIAAN = '1'; // golongan 1 = Persediaan; ubah di sini bila tabel resmi berbeda
export const PANJANG = [1, 3, 5, 7, 10];
export const NAMA_LEVEL = ['Golongan', 'Bidang', 'Kelompok', 'Sub Kelompok', 'Sub-sub Kelompok'];

export const normalisasi = (v) => String(v ?? '').replace(/[\s.\-]/g, '');
export const formatKode = (k) => String(k).replace(/^(\d)(\d{2})?(\d{2})?(\d{2})?(\d{3})?$/, (_, ...g) => g.slice(0, 5).filter(Boolean).join('.'));

export function createKodeBarang(ctx) {
  const { all, get, run, tx, audit, need, bad, str, HttpError } = ctx;
  const SA = 'SUPER_ADMIN';

  // Memvalidasi bentuk kode; mengembalikan { kode, level, induk }
  function periksa(mentah) {
    const kode = normalisasi(mentah);
    if (!/^\d+$/.test(kode)) throw bad('Kode barang hanya boleh berisi angka (titik/spasi diabaikan)');
    const level = PANJANG.indexOf(kode.length) + 1;
    if (!level) throw bad(`Panjang kode ${kode.length} digit tidak valid; gunakan 1, 3, 5, 7, atau 10 digit (kode barang lengkap = 10 digit)`);
    if (kode[0] !== GOLONGAN_PERSEDIAAN) throw bad(`Kode persediaan harus diawali golongan ${GOLONGAN_PERSEDIAAN}`);
    return { kode, level, induk: level > 1 ? kode.slice(0, PANJANG[level - 2]) : null };
  }
  const uraianValid = (v) => {
    const u = str(v);
    if (!u) throw bad('Uraian wajib diisi');
    if (u.length > 200) throw bad('Uraian maksimal 200 karakter');
    return u;
  };
  const baris = (kode) => get(`SELECT k.*, (SELECT COUNT(*) FROM items WHERE kode_barang = k.kode) AS dipakai,
      (SELECT COUNT(*) FROM kode_barang c WHERE c.kode <> k.kode AND c.kode LIKE k.kode || '%') AS turunan FROM kode_barang k WHERE k.kode = ?`, kode);

  return function handle(method, path, query, body, user) {
    let m;
    if (path === '/api/kode-barang' && method === 'GET') {
      const c = [], p = [];
      if (query.level) { c.push('k.level = ?'); p.push(Number(query.level)); }
      if (query.aktif) { c.push('k.aktif = 1'); }
      if (query.induk) { const i = normalisasi(query.induk); c.push("k.kode LIKE ? || '%' AND k.kode <> ?"); p.push(i, i); }
      if (query.q) {
        const q = String(query.q).trim(), d = normalisasi(q);
        const esc = (x) => x.replace(/[\\%_]/g, '\\$&');
        c.push(`(k.uraian LIKE ? ESCAPE '\\' ${d ? "OR k.kode LIKE ? ESCAPE '\\'" : ''})`);
        p.push(`%${esc(q)}%`, ...(d ? [`${esc(d)}%`] : []));
      }
      const limit = Math.min(parseInt(query.limit, 10) || 200, 50000);
      const rows = all(`SELECT k.*, (SELECT COUNT(*) FROM items WHERE kode_barang = k.kode) AS dipakai FROM kode_barang k
                        ${c.length ? 'WHERE ' + c.join(' AND ') : ''} ORDER BY k.kode LIMIT ${limit + 1}`, ...p);
      return { rows: rows.slice(0, limit), terpotong: rows.length > limit };
    }
    if ((m = path.match(/^\/api\/kode-barang\/(\d+)$/)) && method === 'GET') {
      const r = baris(m[1]);
      if (!r) throw new HttpError(404, 'Kode barang tidak ditemukan');
      return r;
    }

    if (path === '/api/kode-barang' && method === 'POST') {
      need(user, SA);
      const { kode, level, induk } = periksa(body.kode);
      const uraian = uraianValid(body.uraian);
      if (get('SELECT 1 FROM kode_barang WHERE kode = ?', kode)) throw bad(`Kode ${formatKode(kode)} sudah ada`);
      if (induk && !get('SELECT 1 FROM kode_barang WHERE kode = ?', induk))
        throw bad(`Tingkat induk ${formatKode(induk)} (${NAMA_LEVEL[level - 2]}) belum ada; tambahkan terlebih dahulu`);
      run('INSERT INTO kode_barang (kode, level, uraian) VALUES (?,?,?)', kode, level, uraian);
      audit(user, 'kode_barang_baru', `${formatKode(kode)} ${uraian}`);
      return [201, baris(kode)];
    }

    if (path === '/api/kode-barang/impor' && method === 'POST') {
      need(user, SA);
      const lines = String(body.teks ?? '').split(/\r?\n/);
      if (lines.length > 5000) throw bad('Maksimal 5000 baris per impor');
      const galat = [], items = new Map();
      lines.forEach((ln, i) => {
        if (!ln.trim() || (i === 0 && /^\W*kode/i.test(ln))) return; // baris kosong / header
        const mm = ln.match(/^\s*([\d.\-]+)\s*[;,\t ]\s*(.+?)\s*$/);
        if (!mm) return galat.push(`Baris ${i + 1}: format harus "kode;uraian"`);
        try {
          const k = periksa(mm[1]);
          const uraian = uraianValid(mm[2].replace(/^"(.*)"$/, '$1'));
          if (items.has(k.kode)) return galat.push(`Baris ${i + 1}: kode ${formatKode(k.kode)} ganda dalam berkas`);
          items.set(k.kode, { ...k, uraian, baris: i + 1 });
        } catch (e) { galat.push(`Baris ${i + 1}: ${e.message}`); }
      });
      if (!items.size && !galat.length) throw bad('Tidak ada data untuk diimpor');
      // induk dulu: urutkan menurut panjang kode, lalu periksa keberadaan induk (di DB atau berkas)
      const urut = [...items.values()].sort((a, b) => a.level - b.level || a.kode.localeCompare(b.kode));
      const baru = [];
      let dilewati = 0;
      for (const it of urut) {
        if (get('SELECT 1 FROM kode_barang WHERE kode = ?', it.kode)) { dilewati++; continue; }
        if (it.induk && !get('SELECT 1 FROM kode_barang WHERE kode = ?', it.induk) && !items.has(it.induk))
          galat.push(`Baris ${it.baris}: induk ${formatKode(it.induk)} tidak ada`);
        else baru.push(it);
      }
      if (galat.length) throw bad(`Impor dibatalkan, tidak ada data yang disimpan. ${galat.length} masalah:\n` + galat.slice(0, 10).join('\n') + (galat.length > 10 ? `\n… dan ${galat.length - 10} lainnya` : ''));
      tx(() => { for (const it of baru) run('INSERT INTO kode_barang (kode, level, uraian) VALUES (?,?,?)', it.kode, it.level, it.uraian); });
      audit(user, 'kode_barang_impor', `${baru.length} baru, ${dilewati} dilewati`);
      return { ditambahkan: baru.length, dilewati };
    }

    if ((m = path.match(/^\/api\/kode-barang\/(\d+)$/)) && (method === 'PUT' || method === 'DELETE')) {
      need(user, SA);
      const r = baris(m[1]);
      if (!r) throw new HttpError(404, 'Kode barang tidak ditemukan');
      if (method === 'PUT') { // kode tidak dapat diubah (dipakai sebagai rujukan); hanya uraian & status
        run('UPDATE kode_barang SET uraian = ?, aktif = ? WHERE kode = ?', uraianValid(body.uraian ?? r.uraian), body.aktif === false || body.aktif === 0 ? 0 : 1, r.kode);
        audit(user, 'kode_barang_ubah', formatKode(r.kode));
        return baris(r.kode);
      }
      if (r.turunan) throw bad(`Masih memiliki ${r.turunan} kode turunan; hapus turunannya dulu`);
      if (r.dipakai) throw bad(`Dipakai oleh ${r.dipakai} barang; nonaktifkan saja`);
      run('DELETE FROM kode_barang WHERE kode = ?', r.kode);
      audit(user, 'kode_barang_hapus', formatKode(r.kode));
      return { ok: true };
    }
  };
}
