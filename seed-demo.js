// Data contoh untuk mencoba aplikasi: node seed-demo.js  (DB_FILE=... untuk lokasi lain)
import { openDb } from './db.js';
import { createAuth, hashPassword } from './auth.js';

const db = openDb();
const auth = createAuth(db);
const adm = auth.ensureAdmin('admin', 'admin12345');
if (!db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
  const PW = 'demo12345';
  const unit = db.prepare('INSERT INTO units (kode, nama) VALUES (?,?)');
  const user = db.prepare('INSERT INTO users (username, nama, email, password_hash, role, unit_id) VALUES (?,?,?,?,?,?)');
  for (const [kode, nama] of [['FEB', 'Fakultas Ekonomi dan Bisnis'], ['FT', 'Fakultas Teknik']]) {
    const id = Number(unit.run(kode, nama).lastInsertRowid);
    const k = kode.toLowerCase();
    user.run(`op.${k}`, `Operator ${kode}`, `op.${k}@demo.local`, hashPassword(PW), 'OPERATOR', id);
    user.run(`app.${k}`, `Approver ${kode}`, `app.${k}@demo.local`, hashPassword(PW), 'APPROVER', id);
    db.prepare('INSERT INTO items (unit_id, kode, nama, kategori, satuan, stok_minimum) VALUES (?,?,?,?,?,?)').run(id, 'ATK-001', 'Kertas A4', 'ATK', 'rim', 5);
  }
  console.log('Contoh: admin/admin12345; op.feb, app.feb, op.ft, app.ft dengan password demo12345. JANGAN dipakai di produksi.');
} else console.log('Data sudah ada; seed dilewati.');
