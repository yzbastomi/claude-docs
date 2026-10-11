// Login SSO dengan OpenID Connect (Authorization Code + PKCE). Cocok untuk Google Workspace,
// Microsoft Entra ID, Keycloak, dll. Pengguna HARUS sudah didaftarkan super admin (dicocokkan lewat email);
// SSO hanya membuktikan identitas, peran & unit tetap diatur di aplikasi ini.
import { randomBytes, createHash, createPublicKey, verify as cverify } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
export class SsoError extends Error {}

export function oidcFromEnv(env = process.env, baseUrl = '') {
  if (!env.OIDC_ISSUER) return null;
  for (const k of ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) if (!env[k]) throw new Error(`${k} wajib diisi bila OIDC_ISSUER dipakai`);
  return createOidc({
    issuer: env.OIDC_ISSUER.replace(/\/$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI || `${baseUrl}/api/auth/sso/callback`,
    scopes: env.OIDC_SCOPES || 'openid email profile', emailClaim: env.OIDC_EMAIL_CLAIM || 'email',
    allowedDomains: (env.OIDC_ALLOWED_DOMAIN || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    label: env.OIDC_LABEL || 'Masuk dengan SSO Kampus',
  });
}

export function createOidc(cfg, fetchFn = fetch) {
  const host = new URL(cfg.issuer);
  if (host.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(host.hostname)) throw new Error('OIDC_ISSUER harus https');
  const pending = new Map(); // state -> { nonce, verifier, exp }
  let meta = null, jwks = null;

  const getJson = async (url, init) => {
    const r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new SsoError(`IdP menjawab ${r.status}`);
    return r.json();
  };
  async function metadata() {
    if (!meta) {
      const m = await getJson(`${cfg.issuer}/.well-known/openid-configuration`);
      if (m.issuer?.replace(/\/$/, '') !== cfg.issuer) throw new SsoError('Issuer pada metadata IdP tidak cocok');
      meta = m;
    }
    return meta;
  }
  async function key(kid, refresh) {
    const m = await metadata();
    if (!jwks || refresh) jwks = await getJson(m.jwks_uri);
    return jwks.keys.find((k) => k.kid === kid && (!k.use || k.use === 'sig'));
  }
  async function verifyIdToken(token, nonce) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new SsoError('id_token tidak valid');
    const [h, p, sig] = parts;
    const header = JSON.parse(Buffer.from(h, 'base64url')), claims = JSON.parse(Buffer.from(p, 'base64url'));
    if (header.alg !== 'RS256') throw new SsoError('Algoritma id_token tidak didukung (harus RS256)');
    const jwk = (await key(header.kid, false)) ?? (await key(header.kid, true));
    if (!jwk) throw new SsoError('Kunci penandatangan tidak ditemukan');
    if (!cverify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url')))
      throw new SsoError('Tanda tangan id_token tidak valid');
    const now = Date.now() / 1000;
    if (String(claims.iss).replace(/\/$/, '') !== cfg.issuer) throw new SsoError('Issuer id_token salah');
    if (![].concat(claims.aud).includes(cfg.clientId)) throw new SsoError('Audience id_token salah');
    if (!(claims.exp > now - 60)) throw new SsoError('id_token kedaluwarsa');
    if (claims.nonce !== nonce) throw new SsoError('Nonce tidak cocok');
    return claims;
  }

  return {
    label: cfg.label,
    async begin() {
      const m = await metadata();
      const state = randomBytes(24).toString('base64url'), nonce = randomBytes(24).toString('base64url'), verifier = randomBytes(48).toString('base64url');
      for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
      pending.set(state, { nonce, verifier, exp: Date.now() + 10 * 60 * 1000 });
      const u = new URL(m.authorization_endpoint);
      u.search = new URLSearchParams({
        response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: cfg.scopes, state, nonce,
        code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      }).toString();
      return { url: u.toString(), state };
    },
    // Mengembalikan email terverifikasi dari IdP
    async finish(code, state) {
      const p = pending.get(state);
      pending.delete(state); // sekali pakai
      if (!p || p.exp < Date.now()) throw new SsoError('Sesi login SSO tidak valid atau kedaluwarsa; coba lagi');
      const m = await metadata();
      const tok = await getJson(m.token_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: p.verifier }),
      });
      const claims = await verifyIdToken(tok.id_token, p.nonce);
      const email = String(claims[cfg.emailClaim] ?? '').trim().toLowerCase();
      if (!email.includes('@')) throw new SsoError('IdP tidak mengirim alamat email');
      if (claims.email_verified === false) throw new SsoError('Email belum terverifikasi di IdP');
      if (cfg.allowedDomains.length && !cfg.allowedDomains.includes(email.split('@')[1])) throw new SsoError('Domain email tidak diizinkan');
      return email;
    },
  };
}
