# Stok Gudang

Aplikasi web dasar untuk mengelola stok persediaan gudang. Node.js ≥ 22.13 (SQLite bawaan `node:sqlite`), frontend vanilla JS. Dependensi: `nodemailer` (hanya bila SMTP dikonfigurasi), `exceljs` dan `pdfkit` (untuk ekspor).

## Menjalankan

```bash
npm install        # sekali (nodemailer, exceljs, pdfkit)
npm start          # http://localhost:3000  (PORT=... untuk mengganti port)
npm run seed-demo  # opsional: 2 fakultas + akun contoh (hanya untuk mencoba)
npm test           # tes backend (API, hak akses, login)
```

Data tersimpan di `data/stok.db` (ubah dengan `DB_FILE=/path/stok.db`). Basis data dari versi sebelum login memakai skema lama dan harus dihapus.

### Login pertama

Saat database masih kosong, server membuat akun **super admin** (`ADMIN_USERNAME`, default `admin`). Jika `ADMIN_PASSWORD` tidak diisi, password acak dicetak **sekali** di konsol. Setelah login, buat unit (fakultas) dan akun operator/approver di menu **Admin**. Di belakang HTTPS set `COOKIE_SECURE=1`.

## Konfigurasi (variabel lingkungan)

| Variabel | Fungsi |
|---|---|
| `PORT`, `DB_FILE` | Port (3000) dan lokasi database |
| `BASE_URL` | URL publik aplikasi, dipakai pada tautan email reset (mis. `https://stok.kampus.ac.id`). **Wajib di produksi** |
| `COOKIE_SECURE=1` | Tandai cookie sesi `Secure` (di belakang HTTPS) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Akun super admin pertama |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Email keluar untuk reset password. Port 465 = TLS langsung, selain itu STARTTLS. Tanpa `SMTP_HOST`, email hanya dicetak ke konsol (dev) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Aktifkan SSO OpenID Connect |
| `OIDC_REDIRECT_URI` | Default `BASE_URL/api/auth/sso/callback` — daftarkan URL ini di IdP |
| `OIDC_ALLOWED_DOMAIN` | Opsional, batasi domain email (pisahkan koma) |
| `OIDC_EMAIL_CLAIM` | Default `email`; untuk Microsoft Entra bila tak ada gunakan `preferred_username` |
| `OIDC_SCOPES`, `OIDC_LABEL` | Default `openid email profile` dan teks tombol |
| `PASSWORD_LOGIN=off` | Hanya SSO; login password tetap tersedia untuk super admin (akses darurat) |

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
| Kode Barang (super admin) | Referensi kode barang persediaan 10 digit gaya SAKTI, pohon 5 tingkat, tambah satuan atau impor massal |
| Persetujuan | Antrian transaksi & opname untuk approver unit |
| Transaksi Masuk | Pembelian, hibah masuk, transfer masuk, perolehan lainnya |
| Transaksi Keluar | Pemakaian, hibah keluar, transfer keluar (ditolak jika stok tidak cukup) |
| Stok Opname | Bulanan (`YYYY-MM`) dan semester (`YYYY-S1`/`S2`); draft → isi stok fisik → finalisasi membuat transaksi penyesuaian otomatis |
| Dashboard | Stok kosong, stok menipis (≤ minimum), nilai persediaan |
| Ekspor | Excel (.xlsx) & PDF untuk stok (juga kosong/menipis), transaksi (rentang tanggal), kartu stok, lembar opname (dengan kolom tanda tangan), transfer, tren pemakaian, dan kode barang |
| Laporan | Tren barang keluar per bulan, pemakaian terbanyak + perkiraan hari stok habis, kartu stok per barang |

## Ekspor Excel & PDF

Tombol **Excel / PDF** ada di Dashboard (stok kosong/menipis), Barang, Transaksi (dengan rentang tanggal), Transfer, Laporan (tren & kartu stok), Opname (lembar cetak), dan Kode Barang. Endpoint: `GET /api/ekspor/<stok|transaksi|kartu-stok|opname|transfer|tren|kode-barang>?format=xlsx|pdf` plus filter yang sama dengan layar.

- Data diambil lewat API yang sama dengan layar, jadi **pembatasan unit dan hak akses otomatis berlaku** (unit lain → 404). Setiap unduhan tercatat di log audit.
- Excel: judul & info, header ber-filter dan dibekukan, format angka/Rupiah/tanggal asli (bisa dijumlah), baris total berupa rumus `SUM`, siap cetak (lebar menyesuaikan halaman). Isian teks disimpan sebagai teks, bukan rumus.
- PDF: A4 (landscape untuk tabel lebar), header tabel diulang tiap halaman, nomor halaman, pencetak & waktu; lembar opname memuat blok tanda tangan. Memakai font standar PDF, sehingga karakter di luar Latin-1 (mis. huruf non-Latin) diganti `?` di PDF (Excel tetap utuh).
- Maksimal 20.000 baris transaksi per berkas (ada catatan bila terpotong).
- Dependensi: `exceljs`, `pdfkit` (dimuat saat ekspor pertama).

## Referensi kode barang (gaya SAKTI)

Menu **Kode Barang** (khusus super admin) menyimpan referensi kodefikasi BMN persediaan: 10 digit `X.XX.XX.XX.XXX` = Golongan(1) · Bidang(2) · Kelompok(2) · Sub Kelompok(2) · Sub-sub Kelompok(3), mengikuti PMK 29/PMK.06/2010.

- Disimpan sebagai pohon (kode 1, 3, 5, 7, 10 digit); induk harus ada sebelum turunannya. Titik/spasi pada input diabaikan. Kode persediaan harus diawali golongan `1` (konstanta `GOLONGAN_PERSEDIAAN` di `kodebarang.js`).
- Tambah satuan, atau **impor massal** baris `kode;uraian` (urutan bebas; atomik — satu baris salah membatalkan semua; kode yang sudah ada dilewati).
- Kode tidak bisa diubah (hanya uraian dan status aktif); kode yang punya turunan atau dipakai barang tidak bisa dihapus, hanya dinonaktifkan.
- Operator memasangkan barang ke kode 10 digit pada form **Barang** (opsional, ada saran otomatis); barang hasil transfer menyalin kode barangnya.
- **Isi katalog tidak disertakan**: tabel resmi (Tabel Kodifikasi BMN dari DJKN/Kemenkeu) harus diunduh dan diisi lewat impor. Data demo hanya contoh bertanda `[contoh]`.

## Transfer antar unit

Menu **Transfer** memindahkan barang antar fakultas dengan jejak yang tertaut (kolom TRF# pada transaksi):

1. Operator unit asal mengajukan (barang, unit tujuan, jumlah).
2. Approver unit asal menyetujui → stok asal berkurang (transaksi `transfer_keluar`, nilai = harga rata-rata asal), status *Dikirim*.
3. Operator unit tujuan memetakan ke barang miliknya (satuan harus sama) atau membuat barang baru dengan kode/nama yang sama → *Diperiksa*.
4. Approver unit tujuan menyetujui → stok tujuan bertambah (transaksi `transfer_masuk`, harga ikut dari asal) → *Selesai*.

Approver tujuan dapat menolak setelah *Dikirim*: stok otomatis kembali ke unit asal. Selama di perjalanan barang tidak dihitung di unit mana pun. Kategori "Transfer" pada form transaksi biasa tetap ada untuk pihak di luar aplikasi. **Penerimaan sebagian**: operator tujuan mengisi jumlah diterima (≤ dikirim) dan alasan selisih; saat approver tujuan menyetujui, jumlah diterima masuk ke tujuan dan selisihnya otomatis kembali ke stok unit asal (transaksi pengembalian tertaut). Jika barang memang hilang/rusak, unit asal menyesuaikannya lewat stok opname.

## Lupa password & SSO

- **Reset mandiri**: tautan "Lupa password?" mengirim email berisi tautan sekali pakai (30 menit, di *fragment* URL sehingga tidak masuk log server). Respons selalu sama agar keberadaan akun tidak bocor; maksimum 3 permintaan/jam per akun dan 10/jam per IP. Setelah reset, semua sesi akun dicabut. Akun tanpa email tidak bisa memakainya — super admin mengisi email di menu Admin atau mengatur password langsung.
- **SSO (OIDC)**: Authorization Code + PKCE, `state`/`nonce`, tanda tangan `id_token` (RS256) diverifikasi dengan JWKS IdP. SSO hanya membuktikan identitas: pengguna **harus sudah didaftarkan** super admin dengan email yang sama; peran dan unit tetap dari aplikasi (tanpa pembuatan akun otomatis). Hanya IdP berpenanda tangan RS256 yang didukung (Google, Entra, Keycloak default). Untuk Entra gunakan issuer spesifik tenant, bukan `common`. State login SSO yang sedang berjalan disimpan di database (sekali pakai, atomik), sehingga callback boleh dilayani proses server lain.

## Aturan bisnis

- Transaksi berstatus `MENUNGGU` → `DISETUJUI`/`DITOLAK`. **Hanya yang disetujui memengaruhi stok**; yang sudah disetujui tidak dapat dihapus (koreksi lewat opname). Transaksi keluar dinilai dengan harga rata-rata saat disetujui.
- Opname: `DRAFT` (operator) → `DIAJUKAN` → `FINAL` (approver) atau dikembalikan ke `DRAFT`. Finalisasi ditolak selama masih ada transaksi menunggu di unit tersebut.
- Data tiap unit terisolasi di server (data unit lain dijawab 404). Kode barang unik per unit.
- Stok = Σ masuk − Σ keluar; tidak boleh negatif pada titik waktu mana pun (termasuk saat menghapus/backdate transaksi).
- Nilai persediaan memakai harga rata-rata tertimbang dari transaksi masuk.
- Opname final tidak dapat diubah; selisih dicatat sebagai `penyesuaian_masuk/keluar`.
- Barang yang sudah punya riwayat tidak dapat dihapus, hanya dinonaktifkan.

## Struktur

`db.js` skema SQLite · `auth.js` password/sesi/login/reset · `oidc.js` SSO · `mail.js` email · `transfer.js` transfer antar-unit · `kodebarang.js` referensi kode barang · `export.js` Excel/PDF · `app.js` logika bisnis, API & otorisasi · `server.js` HTTP, cookie, CSRF · `public/` UI · `test/` tes.

## Menjalankan beberapa proses

Beberapa proses server boleh berbagi satu berkas database di **mesin yang sama** (mode WAL + `busy_timeout`): sesi login, state SSO, dan pembatas percobaan (login gagal, lupa password) disimpan di database, bukan di memori, sehingga konsisten antar-proses di belakang load balancer. SQLite tidak cocok dibagi lewat jaringan (NFS) atau antar-mesin; untuk itu perlu server database terpisah.

## Keamanan

Password di-hash scrypt; sesi berupa token acak (hanya hash-nya disimpan) di cookie `HttpOnly; SameSite=Strict`, berlaku 8 jam dan dicabut saat pengguna dinonaktifkan atau diubah. Login dikunci 5 menit setelah 5 kegagalan (per username+IP, disimpan di database). Perlindungan CSRF: wajib `application/json` dan `Origin` harus sama dengan host. Aksi penting tercatat di log audit.

## Belum ada (langkah lanjutan yang disarankan)

Notifikasi email untuk antrean persetujuan, penyimpanan state SSO bersama untuk banyak instance, multi-gudang per unit, ekspor Excel/PDF, upload lampiran dokumen, batch/kedaluwarsa.
