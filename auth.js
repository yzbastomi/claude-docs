import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { HttpError } from './errors.js';

const SESI_MS = 8 * 3600 * 1000;
const MAKS_GAGAL = 5;
const KUNCI_MS = 5 * 60 * 1000;

export const hashPassword = (pw) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
};
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const DUMMY = hashPassword('dummy-untuk-menyamakan-waktu');
const sha = (t) => createHash('sha256').update(t).digest('hex');

export const validPassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password minimal 8 karakter');
  if (pw.length > 200) throw new HttpError(400, 'Password terlalu panjang');
};

export function createAuth(db) {
  const gagal = new Map(); // "username|ip" -> { n, sampai }
  const audit = (user_id, aksi, detail = '') =>
    db.prepare('INSERT INTO audit_log (user_id, aksi, detail) VALUES (?,?,?)').run(user_id ?? null, aksi, detail);
  const publik = (u) => ({ id: u.id, username: u.username, nama: u.nama, role: u.role, unit_id: u.unit_id, unit_nama: u.unit_nama ?? null, unit_kode: u.unit_kode ?? null });

  function login(username, password, ip = '') {
    const key = `${String(username).toLowerCase()}|${ip}`;
    const g = gagal.get(key);
    if (g && g.n >= MAKS_GAGAL && Date.now() < g.sampai) throw new HttpError(429, 'Terlalu banyak percobaan gagal. Coba lagi beberapa menit lagi.');
    const u = db.prepare(`SELECT u.*, un.nama AS unit_nama, un.kode AS unit_kode FROM users u LEFT JOIN units un ON un.id = u.unit_id
                          WHERE u.username = ?`).get(String(username));
    const ok = verifyPassword(String(password ?? ''), u ? u.password_hash : DUMMY) && u && u.aktif;
    if (!ok) {
      gagal.set(key, { n: (g && Date.now() < g.sampai ? g.n : 0) + 1, sampai: Date.now() + KUNCI_MS });
      audit(u?.id, 'login_gagal', String(username).slice(0, 64));
      throw new HttpError(401, 'Username atau password salah');
    }
    gagal.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), u.id, Date.now() + SESI_MS);
    audit(u.id, 'login');
    return { token, user: publik(u), maxAge: SESI_MS / 1000 };
  }

  function userFromToken(token) {
    if (!token) return null;
    const u = db.prepare(`SELECT u.*, un.nama AS unit_nama, un.kode AS unit_kode FROM sessions s JOIN users u ON u.id = s.user_id
                          LEFT JOIN units un ON un.id = u.unit_id
                          WHERE s.token_hash = ? AND s.expires_at > ? AND u.aktif = 1 AND (u.unit_id IS NULL OR un.aktif = 1)`).get(sha(token), Date.now());
    return u ? publik(u) : null;
  }

  const logout = (token) => token && db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));

  function ubahPassword(user, lama, baru) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(lama ?? ''), u.password_hash)) throw new HttpError(400, 'Password saat ini salah');
    validPassword(baru);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(baru), user.id);
    audit(user.id, 'ubah_password');
  }

  // Buat super admin pertama bila belum ada pengguna sama sekali.
  function ensureAdmin(username = process.env.ADMIN_USERNAME || 'admin', password = process.env.ADMIN_PASSWORD) {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
    const pw = password || randomBytes(9).toString('base64url');
    validPassword(pw);
    db.prepare("INSERT INTO users (username, nama, password_hash, role) VALUES (?,?,?, 'SUPER_ADMIN')").run(username, 'Super Admin', hashPassword(pw));
    return { username, password: pw, generated: !password };
  }

  return { login, userFromToken, logout, ubahPassword, ensureAdmin, audit };
}
