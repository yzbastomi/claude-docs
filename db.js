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

export function openDb(file = process.env.DB_FILE || 'data/stok.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kode TEXT NOT NULL UNIQUE,
      nama TEXT NOT NULL,
      kategori TEXT NOT NULL DEFAULT '',
      satuan TEXT NOT NULL DEFAULT 'unit',
      stok_minimum REAL NOT NULL DEFAULT 0,
      aktif INTEGER NOT NULL DEFAULT 1
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id, tanggal);
    CREATE INDEX IF NOT EXISTS idx_tx_tanggal ON transactions(tanggal);
    CREATE TABLE IF NOT EXISTS opnames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipe TEXT NOT NULL CHECK (tipe IN ('BULANAN','SEMESTER')),
      periode TEXT NOT NULL,               -- 2026-09 atau 2026-S1
      tanggal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINAL')),
      catatan TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tipe, periode)
    );
    CREATE TABLE IF NOT EXISTS opname_lines (
      opname_id INTEGER NOT NULL REFERENCES opnames(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      stok_sistem REAL NOT NULL,
      stok_fisik REAL,
      keterangan TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (opname_id, item_id)
    );
  `);
  return db;
}

export const STOK_SQL = `
  SELECT i.*,
    COALESCE(SUM(CASE t.jenis WHEN 'MASUK' THEN t.qty ELSE -t.qty END), 0) AS stok,
    COALESCE(SUM(CASE WHEN t.jenis='MASUK' THEN t.qty * t.harga_satuan END), 0) AS nilai_masuk,
    COALESCE(SUM(CASE WHEN t.jenis='MASUK' THEN t.qty END), 0) AS qty_masuk
  FROM items i LEFT JOIN transactions t ON t.item_id = i.id`;
