// Zero-dependency WebSocket server (RFC 6455) + Echo's realtime hub:
//  - presence connections for signed-in users (online status, invites, requests)
//  - meetup rooms (max 2 members) that relay roles, phases, readings and quick messages
import crypto from 'node:crypto';
import { parseCookies, getSessionUser } from './auth.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024;
const MEETUP_TTL_MS = 24 * 60 * 60 * 1000;

// ---- Frame codec -----------------------------------------------------------

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.alive = true;
    this.onmessage = null;
    this.onclose = null;

    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this._closed());
  }

  send(obj) {
    if (!this.alive) return;
    try {
      this.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj))));
    } catch { this.close(); }
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch {}
    this.socket.end();
    this._closed();
  }

  _closed() {
    if (this._done) return;
    this._done = true;
    this.alive = false;
    if (this.onclose) this.onclose();
  }

  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this._tryFrame()) { /* drain */ }
  }

  _tryFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) { this.close(); return false; }
      len = Number(big); offset = 10;
    }
    if (len > MAX_FRAME || !masked) { this.close(); return false; } // clients MUST mask
    if (buf.length < offset + 4 + len) return false;

    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    this.buffer = buf.subarray(offset + 4 + len);

    if (opcode === 0x8) { this.close(); return false; }
    if (opcode === 0x9) { // ping -> pong
      try { this.socket.write(encodeFrame(0xA, payload)); } catch {}
      return true;
    }
    if (opcode === 0xA) return true; // pong

    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode !== 0x0) this.fragments = [payload];
      else if (this.fragments) this.fragments.push(payload);
      if (fin && this.fragments) {
        const full = Buffer.concat(this.fragments);
        this.fragments = null;
        if (this.onmessage) {
          try { this.onmessage(JSON.parse(full.toString('utf8'))); } catch { /* ignore bad JSON */ }
        }
      }
      return true;
    }
    return true;
  }
}

// ---- Hub -------------------------------------------------------------------

export function createHub(store) {
  const presence = new Map();   // userId -> Set<Conn>
  const rooms = new Map();      // code -> { members: [{ conn, ident, role }], best, phase }
  const guestTokens = new Map(); // token -> { code, name, exp }

  function publicUser(u) {
    return { id: u.id, handle: u.handle, name: u.name, emoji: u.emoji };
  }

  function isOnline(userId) {
    return presence.has(userId);
  }

  function notifyUser(userId, msg) {
    const conns = presence.get(userId);
    if (!conns) return false;
    for (const c of conns) c.send(msg);
    return true;
  }

  function friendIdsOf(userId) {
    const out = [];
    for (const f of store.data.friendships) {
      if (f.a === userId) out.push(f.b);
      else if (f.b === userId) out.push(f.a);
    }
    return out;
  }

  function broadcastPresence(userId, online) {
    for (const fid of friendIdsOf(userId)) {
      notifyUser(fid, { t: 'presence', userId, online });
    }
  }

  function issueGuestToken(code, name) {
    const token = crypto.randomBytes(24).toString('base64url');
    guestTokens.set(token, { code, name, exp: Date.now() + MEETUP_TTL_MS });
    return token;
  }

  function meetupValid(code) {
    const m = store.data.meetups[code];
    if (!m || m.endedAt) return null;
    if (Date.now() - m.createdAt > MEETUP_TTL_MS) return null;
    return m;
  }

  function appendHistory(userId, entry) {
    if (!store.data.users[userId]) return;
    const list = store.data.history[userId] || (store.data.history[userId] = []);
    list.push(entry);
    if (list.length > 100) list.splice(0, list.length - 100);
    store.save();
  }

  function endRoom(code, reason) {
    const room = rooms.get(code);
    const m = store.data.meetups[code];
    if (m && !m.endedAt) {
      m.endedAt = Date.now();
      store.save();
      if (room) {
        for (const member of room.members) {
          if (member.ident.kind === 'user') {
            const peer = room.members.find((x) => x !== member);
            appendHistory(member.ident.id, {
              code,
              peerName: peer ? peer.ident.name : null,
              at: m.createdAt,
              endedAt: m.endedAt,
              found: !!m.found,
              bestDistance: room.best,
            });
          }
        }
      }
    }
    if (room) {
      // Deregister first so per-connection close handlers don't emit
      // 'peer-left' for a room that is already over.
      rooms.delete(code);
      for (const member of room.members) {
        member.conn.onclose = null;
        member.conn.send({ t: 'ended', reason });
        member.conn.close();
      }
    }
  }

  // ---- Connection wiring ----

  function attachPresence(conn, user) {
    let set = presence.get(user.id);
    const first = !set;
    if (!set) presence.set(user.id, (set = new Set()));
    set.add(conn);
    if (first) broadcastPresence(user.id, true);

    conn.send({
      t: 'hello',
      online: friendIdsOf(user.id).filter(isOnline),
    });

    conn.onmessage = () => { /* presence connections only receive */ };
    conn.onclose = () => {
      const s = presence.get(user.id);
      if (s) {
        s.delete(conn);
        if (s.size === 0) {
          presence.delete(user.id);
          broadcastPresence(user.id, false);
        }
      }
    };
  }

  function attachRoom(conn, code, ident) {
    const meetup = meetupValid(code);
    if (!meetup) { conn.send({ t: 'error', error: 'meetup_gone' }); conn.close(); return; }

    let room = rooms.get(code);
    if (!room) rooms.set(code, (room = { members: [], best: null, phase: 'lobby' }));

    // Rejoin: replace a stale connection for the same identity.
    const existing = room.members.find(
      (mb) => mb.ident.kind === ident.kind && mb.ident.id === ident.id
    );
    if (existing) {
      existing.conn.onclose = null;
      existing.conn.close();
      room.members = room.members.filter((mb) => mb !== existing);
    }
    if (room.members.length >= 2) {
      conn.send({ t: 'error', error: 'meetup_full' });
      conn.close();
      return;
    }

    // Roles must always be complementary: with a peer present, take the
    // opposite role; alone, a rejoiner keeps its old role, otherwise the
    // creator seeks and anyone else responds.
    const isCreator = meetup.createdBy.kind === ident.kind && meetup.createdBy.id === ident.id;
    const peerNow = room.members[0] || null;
    const role = peerNow ? (peerNow.role === 'seeker' ? 'responder' : 'seeker')
      : existing ? existing.role
      : isCreator ? 'seeker' : 'responder';
    const member = { conn, ident, role };
    room.members.push(member);

    const peer = room.members.find((mb) => mb !== member) || null;
    conn.send({
      t: 'joined',
      code,
      self: { ...identPublic(member.ident), role: member.role },
      peer: peer ? { ...identPublic(peer.ident), role: peer.role } : null,
      phase: room.phase,
    });
    if (peer) peer.conn.send({ t: 'peer-joined', peer: { ...identPublic(member.ident), role: member.role } });

    conn.onmessage = (msg) => handleRoomMessage(code, member, msg);
    conn.onclose = () => {
      const r = rooms.get(code);
      if (!r) return;
      r.members = r.members.filter((mb) => mb !== member);
      for (const mb of r.members) mb.conn.send({ t: 'peer-left' });
      if (r.members.length === 0) rooms.delete(code); // meetup stays joinable until ended/expired
    };
  }

  function identPublic(ident) {
    return { kind: ident.kind, id: ident.id, name: ident.name, emoji: ident.emoji || null };
  }

  function handleRoomMessage(code, member, msg) {
    const room = rooms.get(code);
    if (!room || typeof msg !== 'object' || !msg) return;
    const peer = room.members.find((mb) => mb !== member) || null;

    switch (msg.t) {
      case 'swap': {
        for (const mb of room.members) mb.role = mb.role === 'seeker' ? 'responder' : 'seeker';
        for (const mb of room.members) {
          const p = room.members.find((x) => x !== mb);
          mb.conn.send({ t: 'roles', self: mb.role, peer: p ? p.role : null });
        }
        break;
      }
      case 'phase': {
        if (['lobby', 'calibrating', 'finding'].includes(msg.phase)) {
          room.phase = msg.phase;
          if (peer) peer.conn.send({ t: 'phase', phase: msg.phase });
        }
        break;
      }
      case 'reading': {
        const d = Number(msg.distance);
        if (Number.isFinite(d) && d >= 0 && d < 1000) {
          if (room.best === null || d < room.best) room.best = Math.round(d * 10) / 10;
          if (peer) peer.conn.send({ t: 'reading', distance: d, rtt: Number(msg.rtt) || null });
        }
        break;
      }
      case 'quick': {
        const text = String(msg.text || '').slice(0, 120);
        if (text && peer) peer.conn.send({ t: 'quick', text, from: member.ident.name });
        break;
      }
      case 'found': {
        const m = store.data.meetups[code];
        if (m) { m.found = true; store.save(); }
        for (const mb of room.members) mb.conn.send({ t: 'found' });
        endRoom(code, 'found');
        break;
      }
      case 'end':
        endRoom(code, 'ended_by_member');
        break;
      case 'hb':
        member.conn.send({ t: 'hb' });
        break;
    }
  }

  // ---- HTTP upgrade handler ----

  function handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }

    const cookies = parseCookies(req.headers.cookie);
    const user = getSessionUser(store, cookies.echo_session);
    const code = (url.searchParams.get('code') || '').toUpperCase();
    const guestToken = url.searchParams.get('token');

    let ident = null;
    if (user) {
      ident = { kind: 'user', id: user.id, name: user.name, emoji: user.emoji };
    } else if (guestToken) {
      const g = guestTokens.get(guestToken);
      if (g && g.exp > Date.now() && g.code === code) {
        ident = { kind: 'guest', id: guestToken, name: g.name, emoji: null };
      }
    }
    if (!ident) { socket.destroy(); return; }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const conn = new Conn(socket);

    if (code) attachRoom(conn, code, ident);
    else if (user) attachPresence(conn, user);
    else conn.close();
  }

  return { handleUpgrade, notifyUser, isOnline, issueGuestToken, endRoom, publicUser };
}
