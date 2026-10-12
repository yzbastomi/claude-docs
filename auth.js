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

const RESET_MS = 30 * 60 * 1000;
const RESET_MAKS_PER_JAM = 3;

export function createAuth(db, { mailer = null, baseUrl = 'http://localhost:3000', passwordLogin = true, log = console } = {}) {
  // Pembatas percobaan disimpan di DB (bukan memori) supaya berlaku di semua proses server.
  const baca = (kunci) => { const r = db.prepare('SELECT n, sampai FROM rate_limit WHERE kunci = ?').get(kunci); return r && r.sampai > Date.now() ? r : null; };
  function hit(kunci, jendelaMs) { // menambah hitungan dalam jendela tetap; mengembalikan hitungan terbaru
    const now = Date.now();
    if (Math.random() < 0.05) db.prepare('DELETE FROM rate_limit WHERE sampai < ?').run(now);
    const r = baca(kunci);
    if (!r) { db.prepare('INSERT OR REPLACE INTO rate_limit (kunci, n, sampai) VALUES (?,1,?)').run(kunci, now + jendelaMs); return 1; }
    db.prepare('UPDATE rate_limit SET n = n + 1 WHERE kunci = ?').run(kunci);
    return r.n + 1;
  }
  const audit = (user_id, aksi, detail = '') =>
    db.prepare('INSERT INTO audit_log (user_id, aksi, detail) VALUES (?,?,?)').run(user_id ?? null, aksi, detail);
  const publik = (u) => ({ id: u.id, username: u.username, nama: u.nama, role: u.role, unit_id: u.unit_id, unit_nama: u.unit_nama ?? null, unit_kode: u.unit_kode ?? null, email: u.email ?? null, notif: u.notif ?? 'LANGSUNG' });

  function login(username, password, ip = '') {
    const key = `${String(username).toLowerCase()}|${ip}`;
    const g = baca(`login|${key}`);
    if (g && g.n >= MAKS_GAGAL) throw new HttpError(429, 'Terlalu banyak percobaan gagal. Coba lagi beberapa menit lagi.');
    const u = db.prepare(`SELECT u.*, un.nama AS unit_nama, un.kode AS unit_kode FROM users u LEFT JOIN units un ON un.id = u.unit_id
                          WHERE u.username = ?`).get(String(username));
    const ok = verifyPassword(String(password ?? ''), u ? u.password_hash : DUMMY) && u && u.aktif;
    if (!ok) {
      hit(`login|${key}`, KUNCI_MS);
      audit(u?.id, 'login_gagal', String(username).slice(0, 64));
      throw new HttpError(401, 'Username atau password salah');
    }
    db.prepare('DELETE FROM rate_limit WHERE kunci = ?').run(`login|${key}`);
    if (!passwordLogin && u.role !== 'SUPER_ADMIN') throw new HttpError(403, 'Login dengan password dinonaktifkan; gunakan SSO');
    audit(u.id, 'login');
    return buatSesi(u);
  }

  function buatSesi(u) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), u.id, Date.now() + SESI_MS);
    return { token, user: publik(u), maxAge: SESI_MS / 1000 };
  }

  // Login SSO: email dari IdP harus cocok dengan pengguna aktif yang sudah didaftarkan.
  function loginSso(email) {
    const u = db.prepare(`SELECT u.*, un.nama AS unit_nama, un.kode AS unit_kode, un.aktif AS unit_aktif FROM users u LEFT JOIN units un ON un.id = u.unit_id
                          WHERE u.email = ? COLLATE NOCASE`).get(String(email).trim());
    if (!u || !u.aktif || (u.unit_id && !u.unit_aktif)) {
      audit(u?.id, 'login_sso_gagal', String(email).slice(0, 100));
      throw new HttpError(403, 'Akun Anda belum terdaftar di aplikasi ini. Hubungi super admin.');
    }
    audit(u.id, 'login_sso');
    return buatSesi(u);
  }

  // Selalu berhasil dari sisi pemanggil (tidak membocorkan apakah akun ada). Email dikirim tanpa ditunggu.
  function lupaPassword(identifier, ip = '') {
    const ident = String(identifier ?? '').trim();
    if (!ident || !mailer) return;
    const u = db.prepare('SELECT * FROM users WHERE aktif = 1 AND email IS NOT NULL AND (username = ? OR email = ? COLLATE NOCASE)').get(ident, ident);
    if (!u || (!passwordLogin && u.role !== 'SUPER_ADMIN')) return;
    const sejam = Date.now() - 3600 * 1000;
    if (db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?').get(u.id, sejam).n >= RESET_MAKS_PER_JAM) return;
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(u.id); // tautan lama tidak berlaku lagi
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha(token), u.id, Date.now(), Date.now() + RESET_MS);
    audit(u.id, 'reset_password_diminta', ip);
    mailer.send({
      to: u.email, subject: 'Reset password Stok Gudang',
      text: `Halo ${u.nama},\n\nKami menerima permintaan reset password untuk akun "${u.username}".\nBuka tautan berikut dalam 30 menit untuk membuat password baru:\n\n${baseUrl}/#reset?token=${token}\n\nJika Anda tidak meminta ini, abaikan email ini; password Anda tidak berubah.\n`,
    }).catch((e) => log.error('Gagal mengirim email reset:', e.message));
  }

  function resetPassword(token, baru) {
    validPassword(baru);
    const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha(String(token ?? '')));
    if (!r || r.used || r.expires_at < Date.now()) throw new HttpError(400, 'Tautan reset tidak valid atau sudah kedaluwarsa');
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(r.user_id);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(baru), r.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id); // paksa login ulang di semua perangkat
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(r.user_id, 'reset_password');
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

  return { hit, login, loginSso, lupaPassword, resetPassword, userFromToken, logout, ubahPassword, ensureAdmin, audit, passwordLogin, resetTersedia: !!mailer };
}
