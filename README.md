# Stok Gudang

Aplikasi web dasar untuk mengelola stok persediaan gudang. Tanpa dependensi npm: Node.js ≥ 22.13 (SQLite bawaan `node:sqlite`) dan frontend vanilla JS.

## Menjalankan

```bash
npm start          # http://localhost:3000  (PORT=... untuk mengganti port)
npm run seed-demo  # opsional: 2 fakultas + akun contoh (hanya untuk mencoba)
npm test           # tes backend (API, hak akses, login)
```

Data tersimpan di `data/stok.db` (ubah dengan `DB_FILE=/path/stok.db`). Basis data dari versi sebelum login memakai skema lama dan harus dihapus.

### Login pertama

Saat database masih kosong, server membuat akun **super admin** (`ADMIN_USERNAME`, default `admin`). Jika `ADMIN_PASSWORD` tidak diisi, password acak dicetak **sekali** di konsol. Setelah login, buat unit (fakultas) dan akun operator/approver di menu **Admin**. Di belakang HTTPS set `COOKIE_SECURE=1`.

## Peran

| Peran | Cakupan | Wewenang |
|---|---|---|
| Super Admin | Semua unit (bisa difilter) | Kelola unit & pengguna, lihat semua data & log audit. Tidak mencatat/menyetujui transaksi (pemisahan tugas) |
| Operator | Satu unit | Kelola barang, ajukan transaksi masuk/keluar, isi & ajukan opname |
| Approver | Satu unit | Setujui/tolak transaksi, finalisasi/kembalikan opname; hanya baca untuk data lain |

## Fitur

| Modul | Isi |
|---|---|
| Barang | Kode, nama, kategori, satuan, stok minimum, aktif/nonaktif |
| Persetujuan | Antrian transaksi & opname untuk approver unit |
| Transaksi Masuk | Pembelian, hibah masuk, transfer masuk, perolehan lainnya |
| Transaksi Keluar | Pemakaian, hibah keluar, transfer keluar (ditolak jika stok tidak cukup) |
| Stok Opname | Bulanan (`YYYY-MM`) dan semester (`YYYY-S1`/`S2`); draft → isi stok fisik → finalisasi membuat transaksi penyesuaian otomatis |
| Dashboard | Stok kosong, stok menipis (≤ minimum), nilai persediaan |
| Laporan | Tren barang keluar per bulan, pemakaian terbanyak + perkiraan hari stok habis, kartu stok per barang |

## Aturan bisnis

- Transaksi berstatus `MENUNGGU` → `DISETUJUI`/`DITOLAK`. **Hanya yang disetujui memengaruhi stok**; yang sudah disetujui tidak dapat dihapus (koreksi lewat opname). Transaksi keluar dinilai dengan harga rata-rata saat disetujui.
- Opname: `DRAFT` (operator) → `DIAJUKAN` → `FINAL` (approver) atau dikembalikan ke `DRAFT`. Finalisasi ditolak selama masih ada transaksi menunggu di unit tersebut.
- Data tiap unit terisolasi di server (data unit lain dijawab 404). Kode barang unik per unit.
- Stok = Σ masuk − Σ keluar; tidak boleh negatif pada titik waktu mana pun (termasuk saat menghapus/backdate transaksi).
- Nilai persediaan memakai harga rata-rata tertimbang dari transaksi masuk.
- Opname final tidak dapat diubah; selisih dicatat sebagai `penyesuaian_masuk/keluar`.
- Barang yang sudah punya riwayat tidak dapat dihapus, hanya dinonaktifkan.

## Struktur

`db.js` skema SQLite · `auth.js` password/sesi/login · `app.js` logika bisnis, API & otorisasi · `server.js` HTTP, cookie, CSRF · `public/` UI · `test/` tes.

## Keamanan

Password di-hash scrypt; sesi berupa token acak (hanya hash-nya disimpan) di cookie `HttpOnly; SameSite=Strict`, berlaku 8 jam dan dicabut saat pengguna dinonaktifkan atau diubah. Login dikunci 5 menit setelah 5 kegagalan (per username+IP, di memori). Perlindungan CSRF: wajib `application/json` dan `Origin` harus sama dengan host. Aksi penting tercatat di log audit.

## Belum ada (langkah lanjutan yang disarankan)

Transfer antar-unit yang tertaut (keluar di satu unit otomatis jadi masuk di unit tujuan), reset password mandiri/SSO kampus, multi-gudang per unit, ekspor Excel/PDF, upload lampiran dokumen, batch/kedaluwarsa.
