# Stok Gudang

Aplikasi web dasar untuk mengelola stok persediaan gudang. Tanpa dependensi npm: Node.js ≥ 22.13 (SQLite bawaan `node:sqlite`) dan frontend vanilla JS.

## Menjalankan

```bash
npm start          # http://localhost:3000  (PORT=... untuk mengganti port)
npm test           # tes backend
```

Data tersimpan di `data/stok.db` (ubah dengan `DB_FILE=/path/stok.db`).

## Fitur

| Modul | Isi |
|---|---|
| Barang | Kode, nama, kategori, satuan, stok minimum, aktif/nonaktif |
| Transaksi Masuk | Pembelian, hibah masuk, transfer masuk, perolehan lainnya |
| Transaksi Keluar | Pemakaian, hibah keluar, transfer keluar (ditolak jika stok tidak cukup) |
| Stok Opname | Bulanan (`YYYY-MM`) dan semester (`YYYY-S1`/`S2`); draft → isi stok fisik → finalisasi membuat transaksi penyesuaian otomatis |
| Dashboard | Stok kosong, stok menipis (≤ minimum), nilai persediaan |
| Laporan | Tren barang keluar per bulan, pemakaian terbanyak + perkiraan hari stok habis, kartu stok per barang |

## Aturan bisnis

- Stok = Σ masuk − Σ keluar; tidak boleh negatif pada titik waktu mana pun (termasuk saat menghapus/backdate transaksi).
- Nilai persediaan memakai harga rata-rata tertimbang dari transaksi masuk.
- Opname final tidak dapat diubah; selisih dicatat sebagai `penyesuaian_masuk/keluar`.
- Barang yang sudah punya riwayat tidak dapat dihapus, hanya dinonaktifkan.

## Struktur

`db.js` skema SQLite · `app.js` logika bisnis & API · `server.js` HTTP + file statis · `public/` UI · `test/` tes.

## Belum ada (langkah lanjutan yang disarankan)

Login & peran pengguna, multi-gudang/lokasi, ekspor Excel/PDF, upload lampiran dokumen, batch/kedaluwarsa.
