import { openDb } from '../db.js';
import { createApi } from '../app.js';
import { createAuth, hashPassword } from '../auth.js';

export const hari = (offset = 0) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);

export function setup() {
  const db = openDb(':memory:');
  const api = createApi(db);
  const auth = createAuth(db);
  const unit = db.prepare('INSERT INTO units (kode, nama) VALUES (?,?)');
  const feb = Number(unit.run('FEB', 'Ekonomi').lastInsertRowid), ft = Number(unit.run('FT', 'Teknik').lastInsertRowid);
  const mk = (username, role, unit_id) => {
    const id = Number(db.prepare('INSERT INTO users (username,nama,password_hash,role,unit_id) VALUES (?,?,?,?,?)').run(username, username, hashPassword('rahasia123'), role, unit_id).lastInsertRowid);
    return { id, username, role, unit_id };
  };
  const u = {
    sa: mk('sa', 'SUPER_ADMIN', null),
    opFeb: mk('op.feb', 'OPERATOR', feb), apFeb: mk('ap.feb', 'APPROVER', feb),
    opFt: mk('op.ft', 'OPERATOR', ft), apFt: mk('ap.ft', 'APPROVER', ft),
  };
  const as = (user) => (method, path, body = {}, query = {}) => {
    const r = api(method, path, query, body, user);
    return Array.isArray(r) && typeof r[0] === 'number' ? r[1] : r;
  };
  return { db, auth, u, as, feb, ft };
}

// Catat transaksi lalu langsung disetujui
export function catat(c, body) {
  const t = c.as(c.u.opFeb)('POST', '/api/transaksi', body);
  c.as(c.u.apFeb)('POST', `/api/transaksi/${t.id}/setujui`);
  return t;
}
