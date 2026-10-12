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
  mutasi_keluar: 'KELUAR',      // dibuat otomatis oleh mutasi antar gudang dalam satu unit
  mutasi_masuk: 'MASUK',
};
// Kategori yang hanya boleh dibuat sistem (bukan input manual operator)
export const KATEGORI_SISTEM = (k) => k.startsWith('penyesuaian') || k.startsWith('mutasi');

export const SCHEMA_VERSION = 7;

// Gudang: satu unit boleh punya banyak gudang; tepat satu bertanda "utama" (default untuk input baru).
const GUDANG_DDL = `
  CREATE TABLE IF NOT EXISTS gudang (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    kode TEXT NOT NULL,
    nama TEXT NOT NULL,
    utama INTEGER NOT NULL DEFAULT 0,
    aktif INTEGER NOT NULL DEFAULT 1,
    UNIQUE (unit_id, kode)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_gudang_utama ON gudang(unit_id) WHERE utama = 1;`;
// Opname per gudang: batas keunikan memuat gudang_id (karena itu tabel dibangun ulang saat migrasi)
const OPNAMES_DDL = (nama) => `CREATE TABLE ${nama} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  gudang_id INTEGER NOT NULL REFERENCES gudang(id),
  tipe TEXT NOT NULL CHECK (tipe IN ('BULANAN','SEMESTER')),
  periode TEXT NOT NULL,               -- 2026-09 atau 2026-S1
  tanggal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DIAJUKAN','FINAL')),
  catatan TEXT NOT NULL DEFAULT '',
  catatan_keputusan TEXT NOT NULL DEFAULT '',
  dibuat_oleh INTEGER REFERENCES users(id),
  diputuskan_oleh INTEGER REFERENCES users(id),
  diputuskan_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_id, gudang_id, tipe, periode)
)`;

// v7: multi-gudang. Dijalankan dalam satu transaksi; foreign key dimatikan agar DROP TABLE tidak menghapus opname_lines lewat cascade.
function migrasiGudang(db, has, adaTabel) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(GUDANG_DDL);
    db.exec("INSERT INTO gudang (unit_id, kode, nama, utama) SELECT id, 'UTAMA', 'Gudang Utama', 1 FROM units WHERE id NOT IN (SELECT unit_id FROM gudang)");
    if (!has('transactions', 'gudang_id')) db.exec('ALTER TABLE transactions ADD COLUMN gudang_id INTEGER');
    if (!has('transactions', 'mutasi_id')) db.exec('ALTER TABLE transactions ADD COLUMN mutasi_id INTEGER');
    db.exec(`UPDATE transactions SET gudang_id = (SELECT g.id FROM gudang g JOIN items i ON i.unit_id = g.unit_id AND g.utama = 1 WHERE i.id = transactions.item_id) WHERE gudang_id IS NULL`);
    if (adaTabel('transfers')) {
      if (!has('transfers', 'gudang_asal_id')) db.exec('ALTER TABLE transfers ADD COLUMN gudang_asal_id INTEGER');
      if (!has('transfers', 'gudang_tujuan_id')) db.exec('ALTER TABLE transfers ADD COLUMN gudang_tujuan_id INTEGER');
      db.exec(`UPDATE transfers SET gudang_asal_id = (SELECT id FROM gudang WHERE unit_id = transfers.unit_asal_id AND utama = 1) WHERE gudang_asal_id IS NULL;
               UPDATE transfers SET gudang_tujuan_id = (SELECT id FROM gudang WHERE unit_id = transfers.unit_tujuan_id AND utama = 1)
                 WHERE gudang_tujuan_id IS NULL AND status IN ('DIPERIKSA','DITERIMA')`);
    }
    if (adaTabel('opnames') && !has('opnames', 'gudang_id')) {
      db.exec(OPNAMES_DDL('opnames_baru'));
      db.exec(`INSERT INTO opnames_baru (id, unit_id, gudang_id, tipe, periode, tanggal, status, catatan, catatan_keputusan, dibuat_oleh, diputuskan_oleh, diputuskan_at, created_at)
               SELECT o.id, o.unit_id, (SELECT g.id FROM gudang g WHERE g.unit_id = o.unit_id AND g.utama = 1), o.tipe, o.periode, o.tanggal, o.status, o.catatan,
                      o.catatan_keputusan, o.dibuat_oleh, o.diputuskan_oleh, o.diputuskan_at, o.created_at FROM opnames o`);
      db.exec('DROP TABLE opnames; ALTER TABLE opnames_baru RENAME TO opnames');
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

export function openDb(file = process.env.DB_FILE || 'data/stok.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // Beberapa proses server boleh berbagi satu berkas: WAL mengizinkan pembaca bersamaan, busy_timeout menunggu penulis lain.
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  const lama = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'items'").get();
  const versi = db.prepare('PRAGMA user_version').get().user_version;
  if (lama && versi < 2)
    throw new Error(`Database ${file} memakai skema lama (tanpa unit/login). Hapus file tersebut untuk memulai ulang.`);
  if (lama && versi >= 2 && versi < SCHEMA_VERSION) { // migrasi bertahap (idempotent): v3 email/transfer, v4 kode barang
    const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
    if (!has('users', 'email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    if (!has('transactions', 'transfer_id')) db.exec('ALTER TABLE transactions ADD COLUMN transfer_id INTEGER');
    if (!has('items', 'kode_barang')) db.exec('ALTER TABLE items ADD COLUMN kode_barang TEXT');
    if (!has('users', 'notif')) { // v6: preferensi notifikasi email
      db.exec("ALTER TABLE users ADD COLUMN notif TEXT NOT NULL DEFAULT 'LANGSUNG'; ALTER TABLE users ADD COLUMN notif_terakhir TEXT; ALTER TABLE users ADD COLUMN digest_terakhir TEXT");
    }
    if (!has('opnames', 'diputuskan_at')) db.exec('ALTER TABLE opnames ADD COLUMN diputuskan_at TEXT');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'transfers'").get() && !has('transfers', 'updated_at')) db.exec('ALTER TABLE transfers ADD COLUMN updated_at TEXT');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'transfers'").get() && !has('transfers', 'qty_diterima')) { // v5: penerimaan sebagian
      db.exec("ALTER TABLE transfers ADD COLUMN qty_diterima REAL; ALTER TABLE transfers ADD COLUMN catatan_penerimaan TEXT NOT NULL DEFAULT ''");
    }
    migrasiGudang(db, has, (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(n)); // v7
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kode TEXT NOT NULL UNIQUE,
      nama TEXT NOT NULL,
      aktif INTEGER NOT NULL DEFAULT 1
    );
    ${GUDANG_DDL}
    CREATE TRIGGER IF NOT EXISTS trg_unit_gudang AFTER INSERT ON units   -- setiap unit selalu punya gudang utama
    BEGIN INSERT INTO gudang (unit_id, kode, nama, utama) VALUES (NEW.id, 'UTAMA', 'Gudang Utama', 1); END;
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
      notif TEXT NOT NULL DEFAULT 'LANGSUNG',   -- LANGSUNG | RINGKASAN | MATI
      notif_terakhir TEXT,                      -- ISO; hasil keputusan sebelum waktu ini sudah diberitahukan
      digest_terakhir TEXT,                     -- tanggal (lokal) ringkasan harian terakhir
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
    -- state bersama antar-proses: login SSO yang sedang berjalan dan pembatas percobaan (login gagal, lupa password)
    CREATE TABLE IF NOT EXISTS sso_state (
      state TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_limit (
      kunci TEXT PRIMARY KEY,
      n INTEGER NOT NULL,
      sampai INTEGER NOT NULL                 -- akhir jendela (epoch ms)
    );
    CREATE TABLE IF NOT EXISTS notif_tunda (    -- pengguna yang akan diberi tahu setelah jeda (digabung per pengguna)
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kirim_setelah INTEGER NOT NULL,
      percobaan INTEGER NOT NULL DEFAULT 0
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
      kode_barang TEXT,                    -- 10 digit, merujuk kode_barang.kode (referensi gaya SAKTI)
      UNIQUE (unit_id, kode)
    );
    CREATE TABLE IF NOT EXISTS kode_barang (
      kode TEXT PRIMARY KEY CHECK (kode GLOB '[0-9]*' AND kode NOT GLOB '*[^0-9]*' AND length(kode) IN (1,3,5,7,10)),
      level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),   -- 1 golongan … 5 sub-sub kelompok (10 digit)
      uraian TEXT NOT NULL,
      aktif INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_items_kb ON items(kode_barang);
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
      transfer_id INTEGER,
      gudang_id INTEGER REFERENCES gudang(id),   -- NULL saat INSERT = gudang utama unit (diisi trigger)
      mutasi_id INTEGER
    );
    CREATE TRIGGER IF NOT EXISTS trg_tx_gudang AFTER INSERT ON transactions WHEN NEW.gudang_id IS NULL
    BEGIN UPDATE transactions SET gudang_id = (SELECT g.id FROM gudang g JOIN items i ON i.unit_id = g.unit_id WHERE i.id = NEW.item_id AND g.utama = 1) WHERE id = NEW.id; END;
    CREATE INDEX IF NOT EXISTS idx_tx_gudang ON transactions(gudang_id, item_id);
    CREATE TABLE IF NOT EXISTS mutasi (   -- perpindahan barang antar gudang dalam satu unit (perlu persetujuan approver unit)
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      gudang_asal_id INTEGER NOT NULL REFERENCES gudang(id),
      gudang_tujuan_id INTEGER NOT NULL REFERENCES gudang(id),
      qty REAL NOT NULL CHECK (qty > 0),
      tanggal TEXT NOT NULL,
      keterangan TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'MENUNGGU' CHECK (status IN ('MENUNGGU','DISETUJUI','DITOLAK')),
      dibuat_oleh INTEGER REFERENCES users(id),
      diputuskan_oleh INTEGER REFERENCES users(id),
      diputuskan_at TEXT,
      catatan_keputusan TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (gudang_asal_id <> gudang_tujuan_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mutasi_unit ON mutasi(unit_id, status);
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
      qty_diterima REAL,                             -- diisi operator tujuan; NULL/sama dengan qty = diterima penuh
      catatan_penerimaan TEXT NOT NULL DEFAULT '',   -- alasan bila qty_diterima < qty
      dibuat_oleh INTEGER REFERENCES users(id),
      disetujui_asal_oleh INTEGER REFERENCES users(id),
      diterima_oleh INTEGER REFERENCES users(id),
      disetujui_tujuan_oleh INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,                               -- ISO, setiap perubahan status
      gudang_asal_id INTEGER REFERENCES gudang(id),  -- gudang pengirim (NULL = utama)
      gudang_tujuan_id INTEGER REFERENCES gudang(id),-- dipilih operator tujuan saat penerimaan (NULL = utama)
      CHECK (unit_asal_id <> unit_tujuan_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tr_asal ON transfers(unit_asal_id, status);
    CREATE INDEX IF NOT EXISTS idx_tr_tujuan ON transfers(unit_tujuan_id, status);
    ${OPNAMES_DDL('IF NOT EXISTS opnames')};
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
  SELECT i.*, u.kode AS unit_kode, u.nama AS unit_nama, kb.uraian AS kode_barang_uraian,
    COALESCE(SUM(CASE t.jenis WHEN 'MASUK' THEN t.qty ELSE -t.qty END), 0) AS stok,
    COALESCE(SUM(CASE WHEN t.jenis='MASUK' THEN t.qty * t.harga_satuan END), 0) AS nilai_masuk,
    COALESCE(SUM(CASE WHEN t.jenis='MASUK' THEN t.qty END), 0) AS qty_masuk
  FROM items i JOIN units u ON u.id = i.unit_id
  LEFT JOIN kode_barang kb ON kb.kode = i.kode_barang
  LEFT JOIN transactions t ON t.item_id = i.id AND t.status = 'DISETUJUI'`;
