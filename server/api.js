// REST API. All routes live under /api/*. JSON in, JSON out.
// State-changing requests are CSRF-protected by an Origin<->Host check
// (cookies are SameSite=Lax as a second layer).
import crypto from 'node:crypto';
import {
  hashPassword, verifyPassword, createSession, getSessionUser,
  destroySession, createRateLimiter, parseCookies, newId,
} from './auth.js';
import { pairKey } from './store.js';

const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MEETUP_TTL_MS = 24 * 60 * 60 * 1000;
const EMOJI_SET = ['🙂','😀','😎','🦊','🐼','🐸','🦄','🐙','🌟','🎧','🌈','🍀','🔥','🐢','🐳','🦉'];

const authLimiter = createRateLimiter(20, 10 * 60 * 1000);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function sessionCookie(token, req, clear = false) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  if (clear) return `echo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `echo_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure}`;
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

export function createApi(store, hub) {
  const { data } = store;

  const pub = (u) => ({ id: u.id, handle: u.handle, name: u.name, emoji: u.emoji });

  function findByHandle(handle) {
    const lower = String(handle || '').toLowerCase();
    return Object.values(data.users).find((u) => u.handleLower === lower) || null;
  }

  function areFriends(a, b) {
    const k = pairKey(a, b);
    return data.friendships.some((f) => f.a === k.a && f.b === k.b);
  }

  function isBlocked(a, b) {
    return data.blocks.some(
      (bl) => (bl.by === a && bl.target === b) || (bl.by === b && bl.target === a)
    );
  }

  function relationTo(me, other) {
    if (me.id === other.id) return 'self';
    if (areFriends(me.id, other.id)) return 'friend';
    if (data.blocks.some((b) => b.by === me.id && b.target === other.id)) return 'blocked';
    if (data.requests.some((r) => r.from === me.id && r.to === other.id)) return 'outgoing';
    if (data.requests.some((r) => r.from === other.id && r.to === me.id)) return 'incoming';
    return 'none';
  }

  function mePayload(u) {
    const friends = [];
    for (const f of data.friendships) {
      const otherId = f.a === u.id ? f.b : f.b === u.id ? f.a : null;
      if (otherId && data.users[otherId]) {
        friends.push({ ...pub(data.users[otherId]), online: hub.isOnline(otherId) });
      }
    }
    friends.sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name));
    return {
      user: { ...pub(u), settings: u.settings || {} },
      friends,
      incoming: data.requests.filter((r) => r.to === u.id && data.users[r.from])
        .map((r) => ({ id: r.id, from: pub(data.users[r.from]), at: r.at })),
      outgoing: data.requests.filter((r) => r.from === u.id && data.users[r.to])
        .map((r) => ({ id: r.id, to: pub(data.users[r.to]), at: r.at })),
      blocked: data.blocks.filter((b) => b.by === u.id && data.users[b.target])
        .map((b) => pub(data.users[b.target])),
    };
  }

  function newMeetupCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      const existing = data.meetups[code];
      if (!existing || existing.endedAt || Date.now() - existing.createdAt > MEETUP_TTL_MS) return code;
    }
  }

  function meetupValid(code) {
    const m = data.meetups[code];
    if (!m || m.endedAt || Date.now() - m.createdAt > MEETUP_TTL_MS) return null;
    return m;
  }

  // Returns true if the request was handled.
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;

    // CSRF: state-changing requests must come from our own origin (if Origin is sent).
    if (req.method !== 'GET' && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      try {
        if (new URL(req.headers.origin).host !== host) {
          json(res, 403, { error: 'bad_origin' });
          return true;
        }
      } catch {
        json(res, 403, { error: 'bad_origin' });
        return true;
      }
    }

    const cookies = parseCookies(req.headers.cookie);
    const me = getSessionUser(store, cookies.echo_session);
    const route = `${req.method} ${url.pathname}`;

    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
      try { body = await readBody(req); }
      catch (e) {
        json(res, e.message === 'too_large' ? 413 : 400, { error: e.message });
        return true;
      }
    }

    const requireAuth = () => {
      if (!me) { json(res, 401, { error: 'auth_required' }); return false; }
      return true;
    };

    switch (route) {
      case 'GET /api/health':
        json(res, 200, { ok: true, name: 'echo', version: '1.0.0' });
        return true;

      // ---- Auth ----
      case 'POST /api/auth/signup': {
        if (!authLimiter(clientIp(req))) { json(res, 429, { error: 'rate_limited' }); return true; }
        const handle = String(body.handle || '').trim();
        const name = cleanName(body.name) || handle;
        const password = String(body.password || '');
        if (!HANDLE_RE.test(handle)) { json(res, 400, { error: 'bad_handle' }); return true; }
        if (password.length < 8 || password.length > 200) { json(res, 400, { error: 'bad_password' }); return true; }
        if (findByHandle(handle)) { json(res, 409, { error: 'handle_taken' }); return true; }
        const user = {
          id: newId('u'),
          handle,
          handleLower: handle.toLowerCase(),
          name,
          emoji: EMOJI_SET[crypto.randomInt(EMOJI_SET.length)],
          pass: hashPassword(password),
          createdAt: Date.now(),
          settings: {},
        };
        data.users[user.id] = user;
        const token = createSession(store, user.id);
        store.save();
        res.setHeader('Set-Cookie', sessionCookie(token, req));
        json(res, 201, mePayload(user));
        return true;
      }

      case 'POST /api/auth/login': {
        if (!authLimiter(clientIp(req))) { json(res, 429, { error: 'rate_limited' }); return true; }
        const user = findByHandle(body.handle);
        if (!user || !verifyPassword(String(body.password || ''), user.pass)) {
          json(res, 401, { error: 'bad_credentials' });
          return true;
        }
        const token = createSession(store, user.id);
        res.setHeader('Set-Cookie', sessionCookie(token, req));
        json(res, 200, mePayload(user));
        return true;
      }

      case 'POST /api/auth/logout':
        destroySession(store, cookies.echo_session);
        res.setHeader('Set-Cookie', sessionCookie('', req, true));
        json(res, 200, { ok: true });
        return true;

      // ---- Me ----
      case 'GET /api/me':
        // 200 with user:null for anonymous visitors — the app probes this at
        // boot, and a 401 would just pollute every session's console.
        json(res, 200, me ? mePayload(me) : { user: null });
        return true;

      case 'PATCH /api/me': {
        if (!requireAuth()) return true;
        if (body.name !== undefined) {
          const name = cleanName(body.name);
          if (!name) { json(res, 400, { error: 'bad_name' }); return true; }
          me.name = name;
        }
        if (body.emoji !== undefined) {
          if (!EMOJI_SET.includes(body.emoji)) { json(res, 400, { error: 'bad_emoji' }); return true; }
          me.emoji = body.emoji;
        }
        if (body.settings !== undefined && typeof body.settings === 'object' && body.settings) {
          me.settings = { ...(me.settings || {}), ...body.settings };
          const s = JSON.stringify(me.settings);
          if (s.length > 4096) { json(res, 400, { error: 'settings_too_large' }); return true; }
        }
        store.save();
        json(res, 200, mePayload(me));
        return true;
      }

      case 'POST /api/me/password': {
        if (!requireAuth()) return true;
        if (!verifyPassword(String(body.current || ''), me.pass)) {
          json(res, 401, { error: 'bad_credentials' });
          return true;
        }
        const next = String(body.next || '');
        if (next.length < 8 || next.length > 200) { json(res, 400, { error: 'bad_password' }); return true; }
        me.pass = hashPassword(next);
        // Invalidate every other session for this account.
        for (const [tok, s] of Object.entries(data.sessions)) {
          if (s.userId === me.id && tok !== cookies.echo_session) delete data.sessions[tok];
        }
        store.save();
        json(res, 200, { ok: true });
        return true;
      }

      case 'DELETE /api/me': {
        if (!requireAuth()) return true;
        const id = me.id;
        delete data.users[id];
        delete data.history[id];
        for (const [tok, s] of Object.entries(data.sessions)) {
          if (s.userId === id) delete data.sessions[tok];
        }
        data.requests = data.requests.filter((r) => r.from !== id && r.to !== id);
        data.friendships = data.friendships.filter((f) => f.a !== id && f.b !== id);
        data.blocks = data.blocks.filter((b) => b.by !== id && b.target !== id);
        store.save();
        res.setHeader('Set-Cookie', sessionCookie('', req, true));
        json(res, 200, { ok: true });
        return true;
      }

      // ---- Users / friends ----
      case 'GET /api/users/search': {
        if (!requireAuth()) return true;
        const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
        if (q.length < 2) { json(res, 200, { results: [] }); return true; }
        const results = Object.values(data.users)
          .filter((u) => u.id !== me.id &&
            (u.handleLower.includes(q) || u.name.toLowerCase().includes(q)) &&
            !isBlocked(me.id, u.id))
          .slice(0, 10)
          .map((u) => ({ ...pub(u), relation: relationTo(me, u) }));
        json(res, 200, { results });
        return true;
      }

      case 'POST /api/friends/request': {
        if (!requireAuth()) return true;
        const target = findByHandle(body.handle) || data.users[body.userId];
        if (!target || target.id === me.id) { json(res, 404, { error: 'user_not_found' }); return true; }
        if (isBlocked(me.id, target.id)) { json(res, 403, { error: 'blocked' }); return true; }
        if (areFriends(me.id, target.id)) { json(res, 409, { error: 'already_friends' }); return true; }
        if (data.requests.some((r) => r.from === me.id && r.to === target.id)) {
          json(res, 409, { error: 'already_requested' });
          return true;
        }
        // If they already asked us, this is an accept.
        const reverse = data.requests.find((r) => r.from === target.id && r.to === me.id);
        if (reverse) {
          data.requests = data.requests.filter((r) => r !== reverse);
          const k = pairKey(me.id, target.id);
          data.friendships.push({ ...k, at: Date.now() });
          store.save();
          hub.notifyUser(target.id, { t: 'request-accepted', by: pub(me) });
          json(res, 200, { ok: true, becameFriends: true });
          return true;
        }
        data.requests.push({ id: newId('fr'), from: me.id, to: target.id, at: Date.now() });
        store.save();
        hub.notifyUser(target.id, { t: 'request', from: pub(me) });
        json(res, 200, { ok: true, becameFriends: false });
        return true;
      }

      case 'POST /api/friends/respond': {
        if (!requireAuth()) return true;
        const reqRec = data.requests.find((r) => r.id === body.id && r.to === me.id);
        if (!reqRec) { json(res, 404, { error: 'request_not_found' }); return true; }
        data.requests = data.requests.filter((r) => r !== reqRec);
        if (body.accept) {
          const k = pairKey(me.id, reqRec.from);
          data.friendships.push({ ...k, at: Date.now() });
          hub.notifyUser(reqRec.from, { t: 'request-accepted', by: pub(me) });
        }
        store.save();
        json(res, 200, mePayload(me));
        return true;
      }

      case 'POST /api/friends/remove': {
        if (!requireAuth()) return true;
        const k = pairKey(me.id, String(body.userId || ''));
        data.friendships = data.friendships.filter((f) => !(f.a === k.a && f.b === k.b));
        store.save();
        json(res, 200, mePayload(me));
        return true;
      }

      case 'POST /api/friends/block': {
        if (!requireAuth()) return true;
        const target = data.users[body.userId];
        if (!target || target.id === me.id) { json(res, 404, { error: 'user_not_found' }); return true; }
        const k = pairKey(me.id, target.id);
        data.friendships = data.friendships.filter((f) => !(f.a === k.a && f.b === k.b));
        data.requests = data.requests.filter(
          (r) => !((r.from === me.id && r.to === target.id) || (r.from === target.id && r.to === me.id))
        );
        if (!data.blocks.some((b) => b.by === me.id && b.target === target.id)) {
          data.blocks.push({ by: me.id, target: target.id, at: Date.now() });
        }
        store.save();
        json(res, 200, mePayload(me));
        return true;
      }

      case 'POST /api/friends/unblock': {
        if (!requireAuth()) return true;
        data.blocks = data.blocks.filter((b) => !(b.by === me.id && b.target === body.userId));
        store.save();
        json(res, 200, mePayload(me));
        return true;
      }

      // ---- Meetups ----
      case 'POST /api/meetups': {
        if (!requireAuth()) return true;
        const code = newMeetupCode();
        let invitee = null;
        if (body.inviteeId) {
          invitee = data.users[body.inviteeId];
          if (!invitee || !areFriends(me.id, invitee.id)) {
            json(res, 403, { error: 'not_friends' });
            return true;
          }
        }
        data.meetups[code] = {
          code,
          createdBy: { kind: 'user', id: me.id },
          inviteeId: invitee ? invitee.id : null,
          createdAt: Date.now(),
          endedAt: null,
          found: false,
        };
        store.save();
        let delivered = false;
        if (invitee) delivered = hub.notifyUser(invitee.id, { t: 'invite', from: pub(me), code });
        json(res, 201, { code, inviteeOnline: delivered });
        return true;
      }

      case 'POST /api/meetups/join': {
        const code = String(body.code || '').toUpperCase().trim();
        const m = meetupValid(code);
        if (!m) { json(res, 404, { error: 'meetup_not_found' }); return true; }
        if (me) { json(res, 200, { code, guest: false }); return true; }
        const guestName = cleanName(body.guestName);
        if (!guestName) { json(res, 400, { error: 'name_required' }); return true; }
        const wsToken = hub.issueGuestToken(code, guestName);
        json(res, 200, { code, guest: true, wsToken });
        return true;
      }

      case 'POST /api/meetups/decline': {
        if (!requireAuth()) return true;
        const m = meetupValid(String(body.code || '').toUpperCase());
        if (m && m.createdBy.kind === 'user') {
          hub.notifyUser(m.createdBy.id, { t: 'invite-declined', by: pub(me) });
        }
        json(res, 200, { ok: true });
        return true;
      }

      case 'GET /api/meetups/history': {
        if (!requireAuth()) return true;
        const list = (data.history[me.id] || []).slice(-50).reverse();
        json(res, 200, { history: list });
        return true;
      }

      default:
        json(res, 404, { error: 'not_found' });
        return true;
    }
  }

  return { handle };
}
