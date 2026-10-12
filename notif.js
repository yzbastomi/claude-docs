// Notifikasi email untuk antrean persetujuan dan hasil keputusan.
//
// Kejadian (transaksi diajukan, opname diajukan, transfer berpindah tahap, keputusan approver) hanya MENANDAI
// penerima di tabel notif_tunda. Pesan disusun saat dikirim dari kondisi terkini, sehingga banyak kejadian dalam
// jeda (default 5 menit) menjadi satu email, bukan banjir email. Tiap pengguna memilih mode:
//   LANGSUNG  : email setelah jeda bila ada hal baru (default)
//   RINGKASAN : satu email per hari pada jam tertentu (bila ada yang menunggu/hasil baru)
//   MATI      : tidak ada email
// Aman untuk beberapa proses: penandaan diambil dengan "hapus-dan-ambil" atomik, ringkasan harian diklaim lewat UPDATE bersyarat.
import { LABEL } from './labels.js';

const BACKOFF_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3]; // jeda ulang bila SMTP gagal
export const MODE = ['LANGSUNG', 'RINGKASAN', 'MATI'];

export function createNotifier(db, { mailer, baseUrl = 'http://localhost:3000', jedaMs = 5 * 60e3, digestJam = 7, log = console, sekarang = () => Date.now() } = {}) {
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  let timer = null;
  const digestGagal = new Map(); // id -> epoch ms: jangan coba lagi sebelum ini

  const penerima = (unitId, role) => all("SELECT id FROM users WHERE unit_id = ? AND role = ? AND aktif = 1", unitId, role).map((r) => r.id);

  // Menandai bahwa pengguna perlu diberi tahu. Panggilan berulang dalam jeda digabung (INSERT OR IGNORE).
  function tandai(ids, kecuali = null) {
    try {
      for (const id of new Set(ids.filter((x) => x != null && x !== kecuali))) {
        const u = get("SELECT id FROM users WHERE id = ? AND aktif = 1 AND email IS NOT NULL AND notif = 'LANGSUNG'", id);
        if (u) run('INSERT OR IGNORE INTO notif_tunda (user_id, kirim_setelah) VALUES (?, ?)', id, sekarang() + jedaMs);
      }
    } catch (e) { log.error('Gagal menandai notifikasi:', e.message); } // notifikasi tidak boleh menggagalkan transaksi
  }

  // Menyusun pesan dari kondisi saat ini; null bila tidak ada yang perlu disampaikan.
  function susun(u, sejak) {
    const n = (sql, ...p) => get(sql, ...p).n;
    const aksi = [], hasil = [];
    const unit = u.unit_id;
    if (u.role === 'APPROVER') {
      const tx = n("SELECT COUNT(*) AS n FROM transactions t JOIN items i ON i.id = t.item_id WHERE t.status = 'MENUNGGU' AND i.unit_id = ?", unit);
      const op = n("SELECT COUNT(*) AS n FROM opnames WHERE unit_id = ? AND status = 'DIAJUKAN'", unit);
      const tr = n("SELECT COUNT(*) AS n FROM transfers WHERE (unit_asal_id = ? AND status = 'DIAJUKAN') OR (unit_tujuan_id = ? AND status = 'DIPERIKSA')", unit, unit);
      if (tx) aksi.push(`${tx} transaksi menunggu persetujuan  ->  ${baseUrl}/#persetujuan`);
      if (op) aksi.push(`${op} stok opname menunggu persetujuan  ->  ${baseUrl}/#persetujuan`);
      if (tr) aksi.push(`${tr} transfer antar-unit menunggu keputusan  ->  ${baseUrl}/#persetujuan`);
    } else if (u.role === 'OPERATOR') {
      const terima = n("SELECT COUNT(*) AS n FROM transfers WHERE unit_tujuan_id = ? AND status = 'DIKIRIM'", unit);
      const balik = n("SELECT COUNT(*) AS n FROM opnames WHERE unit_id = ? AND status = 'DRAFT' AND catatan_keputusan <> ''", unit);
      if (terima) aksi.push(`${terima} transfer masuk menunggu penerimaan Anda  ->  ${baseUrl}/#transfer`);
      if (balik) aksi.push(`${balik} stok opname dikembalikan approver, perlu diperbaiki  ->  ${baseUrl}/#opname`);

      const tx = all(`SELECT t.status, t.tanggal, t.kategori, t.qty, t.catatan_keputusan, i.nama, i.satuan FROM transactions t JOIN items i ON i.id = t.item_id
                      WHERE t.dibuat_oleh = ? AND t.opname_id IS NULL AND t.transfer_id IS NULL AND t.status IN ('DISETUJUI','DITOLAK') AND t.diputuskan_at > ? ORDER BY t.diputuskan_at`, u.id, sejak);
      const ok = tx.filter((t) => t.status === 'DISETUJUI').length;
      if (ok) hasil.push(`${ok} transaksi Anda disetujui`);
      const tolak = tx.filter((t) => t.status === 'DITOLAK');
      if (tolak.length) {
        hasil.push(`${tolak.length} transaksi Anda ditolak:`);
        for (const t of tolak.slice(0, 10)) hasil.push(`   - ${t.tanggal} ${LABEL[t.kategori] ?? t.kategori} ${t.nama} x${t.qty} ${t.satuan}: ${t.catatan_keputusan}`);
        if (tolak.length > 10) hasil.push(`   ... dan ${tolak.length - 10} lainnya  ->  ${baseUrl}/#masuk`);
      }
      for (const o of all("SELECT tipe, periode, status, catatan_keputusan FROM opnames WHERE dibuat_oleh = ? AND diputuskan_at > ?", u.id, sejak))
        hasil.push(o.status === 'FINAL' ? `Opname ${o.tipe.toLowerCase()} ${o.periode} disetujui dan difinalisasi` : `Opname ${o.tipe.toLowerCase()} ${o.periode} dikembalikan: ${o.catatan_keputusan}`);
      for (const t of all(`SELECT t.id, t.status, t.qty, t.qty_diterima, t.catatan_keputusan, ua.kode AS asal, ut.kode AS tujuan, i.nama FROM transfers t
                           JOIN units ua ON ua.id = t.unit_asal_id JOIN units ut ON ut.id = t.unit_tujuan_id JOIN items i ON i.id = t.item_asal_id
                           WHERE (t.dibuat_oleh = ? OR t.diterima_oleh = ?) AND t.updated_at > ? AND t.status IN ('DIKIRIM','DITERIMA','DITOLAK_ASAL','DIKEMBALIKAN')`, u.id, u.id, sejak)) {
        const x = `Transfer #${t.id} ${t.nama} (${t.asal} -> ${t.tujuan})`;
        hasil.push({ DIKIRIM: `${x} disetujui dan dikirim`, DITERIMA: `${x} selesai diterima${t.qty_diterima != null && t.qty_diterima < t.qty ? ` (${t.qty_diterima} dari ${t.qty})` : ''}`,
          DITOLAK_ASAL: `${x} ditolak pengirim: ${t.catatan_keputusan}`, DIKEMBALIKAN: `${x} dikembalikan: ${t.catatan_keputusan}` }[t.status]);
      }
    }
    if (!aksi.length && !hasil.length) return null;
    const subject = aksi.length ? `Stok Gudang: ${aksi.length} hal menunggu tindakan Anda` : 'Stok Gudang: pembaruan untuk Anda';
    const text = [`Halo ${u.nama},`, '', ...(aksi.length ? ['Perlu tindakan Anda:', ...aksi.map((a) => `  * ${a}`), ''] : []),
      ...(hasil.length ? ['Perkembangan terbaru:', ...hasil.map((h) => (h.startsWith('   ') ? h : `  * ${h}`)), ''] : []),
      `Buka aplikasi: ${baseUrl}`, '', 'Anda dapat mengubah atau mematikan notifikasi ini di menu Akun.'].join('\n');
    return { subject, text };
  }

  // Mengirim ke satu pengguna. true = selesai (terkirim atau tidak ada yang dikirim); false = gagal kirim.
  async function kirimKe(id, mode) {
    const u = get('SELECT * FROM users WHERE id = ? AND aktif = 1 AND email IS NOT NULL AND notif = ?', id, mode);
    if (!u) return true;
    const mulai = new Date(sekarang()).toISOString(); // waktu acuan dicatat sebelum menyusun supaya tidak ada hasil yang terlewat
    const pesan = susun(u, u.notif_terakhir ?? new Date(sekarang() - 24 * 3600e3).toISOString());
    if (!pesan) return true;
    try {
      await mailer.send({ to: u.email, ...pesan });
      run('UPDATE users SET notif_terakhir = ? WHERE id = ?', mulai, id);
      return true;
    } catch (e) { log.error(`Gagal mengirim notifikasi ke ${u.email}:`, e.message); return false; }
  }

  // Satu putaran pekerja: kirim penandaan yang jatuh tempo, lalu ringkasan harian bila waktunya.
  async function tick() {
    const now = sekarang();
    for (const { user_id } of all('SELECT user_id FROM notif_tunda WHERE kirim_setelah <= ?', now)) {
      const r = get('DELETE FROM notif_tunda WHERE user_id = ? AND kirim_setelah <= ? RETURNING percobaan', user_id, now);
      if (!r) continue; // sudah diambil proses lain
      if (!(await kirimKe(user_id, 'LANGSUNG')) && r.percobaan < BACKOFF_MS.length)
        run('INSERT OR REPLACE INTO notif_tunda (user_id, kirim_setelah, percobaan) VALUES (?,?,?)', user_id, now + BACKOFF_MS[r.percobaan], r.percobaan + 1);
    }
    const d = new Date(now), hari = d.toLocaleDateString('sv-SE');
    if (d.getHours() >= digestJam) {
      for (const { id, digest_terakhir } of all("SELECT id, digest_terakhir FROM users WHERE aktif = 1 AND email IS NOT NULL AND notif = 'RINGKASAN' AND (digest_terakhir IS NULL OR digest_terakhir < ?)", hari)) {
        if ((digestGagal.get(id) ?? 0) > now) continue;
        const klaim = run('UPDATE users SET digest_terakhir = ? WHERE id = ? AND (digest_terakhir IS NULL OR digest_terakhir < ?)', hari, id, hari);
        if (!klaim.changes) continue; // diklaim proses lain
        if (!(await kirimKe(id, 'RINGKASAN'))) { // gagal: kembalikan klaim, coba lagi nanti
          run('UPDATE users SET digest_terakhir = ? WHERE id = ?', digest_terakhir, id);
          digestGagal.set(id, now + 10 * 60e3);
        }
      }
    }
  }

  return {
    penerima, tandai, susun, tick,
    mulai(intervalMs = 30e3) {
      if (timer) return;
      timer = setInterval(() => tick().catch((e) => log.error('Notifikasi:', e.message)), intervalMs);
      timer.unref();
    },
    berhenti() { clearInterval(timer); timer = null; },
  };
}
