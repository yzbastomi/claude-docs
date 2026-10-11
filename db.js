import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Kategori transaksi -> arah (MASUK menambah stok, KELUAR mengurangi stok)
export const KATEGORI = {
  pembelian: 'MASUK',
  hibah_masuk: 'MASUK',
  transfer_masuk: 'MASUK',
  perolehan_lain: 'MASUK',
  penyesuaian_masuk: 'MASUK', // dibuat otomatis oleh stok opname
  pemakaian: 'KELUAR',
  hibah_keluar: 'KELUAR',
  transfer_keluar: 'KELUAR',
  penyesuaian_keluar: 'KELUAR', // dibuat otomatis oleh stok opname
};

const SCHEMA_VERSION = 3;

export function openDb(file = process.env.DB_FILE || 'data/stok.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const lama = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'items'").get();
  const versi = db.prepare('PRAGMA user_version').get().user_version;
  if (lama && versi < 2)
    throw new Error(`Database ${file} memakai skema lama (tanpa unit/login). Hapus file tersebut untuk memulai ulang.`);
  if (lama && versi === 2) { // v2 -> v3: email pengguna & tautan transfer pada transaksi
    const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
    if (!has('users', 'email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    if (!has('transactions', 'transfer_id')) db.exec('ALTER TABLE transactions ADD COLUMN transfer_id INTEGER');
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kode TEXT NOT NULL UNIQUE,
      nama TEXT NOT NULL,
      aktif INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      nama TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','OPERATOR','APPROVER')),
      unit_id INTEGER REFERENCES units(id),
      aktif INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      email TEXT,
      CHECK ((role = 'SUPER_ADMIN' AND unit_id IS NULL) OR (role <> 'SUPER_ADMIN' AND unit_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,            -- epoch ms
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL             -- epoch ms
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waktu TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      aksi TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      kode TEXT NOT NULL,
      nama TEXT NOT NULL,
      kategori TEXT NOT NULL DEFAULT '',
      satuan TEXT NOT NULL DEFAULT 'unit',
      stok_minimum REAL NOT NULL DEFAULT 0,
      aktif INTEGER NOT NULL DEFAULT 1,
      UNIQUE (unit_id, kode)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tanggal TEXT NOT NULL,               -- YYYY-MM-DD
      jenis TEXT NOT NULL CHECK (jenis IN ('MASUK','KELUAR')),
      kategori TEXT NOT NULL,
      item_id INTEGER NOT NULL REFERENCES items(id),
      qty REAL NOT NULL CHECK (qty > 0),
      harga_satuan REAL NOT NULL DEFAULT 0,
      pihak TEXT NOT NULL DEFAULT '',      -- pemasok / pemberi / penerima / unit tujuan
      no_dokumen TEXT NOT NULL DEFAULT '',
      keterangan TEXT NOT NULL DEFAULT '',
      opname_id INTEGER,
      status TEXT NOT NULL DEFAULT 'MENUNGGU' CHECK (status IN ('MENUNGGU','DISETUJUI','DITOLAK')),
      dibuat_oleh INTEGER REFERENCES users(id),
      diputuskan_oleh INTEGER REFERENCES users(id),
      diputuskan_at TEXT,
      catatan_keputusan TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      transfer_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tx_transfer ON transactions(transfer_id);
    CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id, tanggal);
    CREATE INDEX IF NOT EXISTS idx_tx_tanggal ON transactions(tanggal);
    CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_asal_id INTEGER NOT NULL REFERENCES units(id),
      unit_tujuan_id INTEGER NOT NULL REFERENCES units(id),
      item_asal_id INTEGER NOT NULL REFERENCES items(id),
      item_tujuan_id INTEGER REFERENCES items(id),   -- dipetakan oleh unit tujuan saat penerimaan
      qty REAL NOT NULL CHECK (qty > 0),
      harga_satuan REAL NOT NULL DEFAULT 0,          -- harga rata-rata unit asal saat dikirim
      tanggal TEXT NOT NULL,
      no_dokumen TEXT NOT NULL DEFAULT '',
      keterangan TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DIAJUKAN' CHECK (status IN
        ('DIAJUKAN','DIKIRIM','DIPERIKSA','DITERIMA','DITOLAK_ASAL','DIKEMBALIKAN','DIBATALKAN')),
      catatan_keputusan TEXT NOT NULL DEFAULT '',
      dibuat_oleh INTEGER REFERENCES users(id),
      disetujui_asal_oleh INTEGER REFERENCES users(id),
      diterima_oleh INTEGER REFERENCES users(id),
      disetujui_tujuan_oleh INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (unit_asal_id <> unit_tujuan_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tr_asal ON transfers(unit_asal_id, status);
    CREATE INDEX IF NOT EXISTS idx_tr_tujuan ON transfers(unit_tujuan_id, status);
    CREATE TABLE IF NOT EXISTS opnames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      tipe TEXT NOT NULL CHECK (tipe IN ('BULANAN','SEMESTER')),
      periode TEXT NOT NULL,               -- 2026-09 atau 2026-S1
      tanggal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DIAJUKAN','FINAL')),
      catatan TEXT NOT NULL DEFAULT '',
      catatan_keputusan TEXT NOT NULL DEFAULT '',
      dibuat_oleh INTEGER REFERENCES users(id),
      diputuskan_oleh INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (unit_id, tipe, periode)
    );
    CREATE TABLE IF NOT EXISTS opname_lines (
      opname_id INTEGER NOT NULL REFERENCES opnames(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      stok_sistem REAL NOT NULL,
      stok_fisik REAL,
      keterangan TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (opname_id, item_id)
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  return db;
}

// Hanya transaksi DISETUJUI yang memengaruhi stok.
export const STOK_SQL = `
  SELECT i.*, u.kode AS unit_kode, u.nama AS unit_nama,
    COALESCE(SUM(CASE t.jenis WHEN 'MASUK' THEN t.qty ELSE -t.qty END), 0) AS stok,
    COALESCE(SUM(CASE WHEN t.jenis='MASUK' THEN t.qty * t.harga_satuan END), 0) AS nilai_masuk,
    COALESCE(SUM(CASE WHEN t.jenis='MASUK' THEN t.qty END), 0) AS qty_masuk
  FROM items i JOIN units u ON u.id = i.unit_id
  LEFT JOIN transactions t ON t.item_id = i.id AND t.status = 'DISETUJUI'`;
