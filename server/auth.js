// Password hashing (scrypt), session tokens, and rate limiting.
// Uses only node:crypto — no external dependencies.
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split(':');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function createSession(store, userId) {
  const token = newToken();
  store.data.sessions[token] = { userId, at: Date.now(), exp: Date.now() + SESSION_TTL_MS };
  store.save();
  return token;
}

export function getSessionUser(store, token) {
  if (!token) return null;
  const s = store.data.sessions[token];
  if (!s) return null;
  if (s.exp < Date.now()) {
    delete store.data.sessions[token];
    store.save();
    return null;
  }
  return store.data.users[s.userId] || null;
}

export function destroySession(store, token) {
  if (token && store.data.sessions[token]) {
    delete store.data.sessions[token];
    store.save();
  }
}

// Sliding-window rate limiter keyed by an arbitrary string (typically IP).
export function createRateLimiter(maxHits, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }, windowMs).unref();

  return function allow(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (arr.length >= maxHits) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
