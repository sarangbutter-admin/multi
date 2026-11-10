// Passwords, sessions and secret encryption. Only Node built-ins.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
const pbkdf2 = promisify(crypto.pbkdf2);

export const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

export function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── Passwords (same scheme as sarang: PBKDF2-SHA256, 210k rounds, per-user salt) ──
const hashPw = async (pw, salt) => (await pbkdf2(String(pw), salt, 210000, 32, 'sha256')).toString('hex');
export async function mkCred(pw) { const salt = rid(16); return { salt, hash: await hashPw(pw, salt) }; }
export async function checkPw(cred, pw) {
  if (!cred) { await hashPw(String(pw || ''), 'dummy-salt-for-timing'); return false; } // same timing for unknown users
  return safeEq(await hashPw(pw, cred.salt), cred.hash);
}

// ── Sessions: signed token "payload.signature", used as cookie or Bearer token ──
export function signSession(secret, data, ttlSec = 60 * 60 * 12) {
  const p = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url');
}
export function readSession(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [p, s] = token.split('.');
  if (!safeEq(s, crypto.createHmac('sha256', secret).update(p).digest('base64url'))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() / 1000 ? d : null; }
  catch { return null; }
}

// ── Tenant API keys: AES-256-GCM, key derived from MASTER_KEY ──
const keyOf = master => crypto.createHash('sha256').update(String(master)).digest();
export function encrypt(master, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyOf(master), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function decrypt(master, enc) {
  const [v, iv, tag, ct] = String(enc).split('.');
  if (v !== 'v1') throw new Error('bad secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(master), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}
export const mask = s => (s ? '••••' + String(s).slice(-4) : '');
