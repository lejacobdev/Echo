// Integration tests: REST API + WebSocket hub against a real server instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createEchoServer } from '../server/server.js';
import { wsConnect } from './helpers/ws-client.js';

const tmpData = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-test-')), 'data.json');
const echo = createEchoServer({ dataFile: tmpData });
const { port } = await echo.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

test.after(async () => { await echo.close(); });

function client() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    async call(pathname, method = 'GET', body) {
      const res = await fetch(base + pathname, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = {};
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    },
  };
}

const alice = client();
const bob = client();

test('health endpoint', async () => {
  const { status, data } = await alice.call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test('static shell is served with security headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const html = await res.text();
  assert.match(html, /<title>Echo/);
});

test('signup validation', async () => {
  assert.equal((await alice.call('/api/auth/signup', 'POST', { handle: 'x', password: 'longenough1' })).status, 400);
  assert.equal((await alice.call('/api/auth/signup', 'POST', { handle: 'alice', password: 'short' })).status, 400);
});

test('signup, session cookie, /api/me', async () => {
  const { status, data } = await alice.call('/api/auth/signup', 'POST', {
    handle: 'alice', name: 'Alice', password: 'password-a1',
  });
  assert.equal(status, 201);
  assert.equal(data.user.handle, 'alice');
  assert.ok(alice.cookie.startsWith('echo_session='));

  const me = await alice.call('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.name, 'Alice');
});

test('duplicate handle rejected (case-insensitive)', async () => {
  const dup = client();
  const { status } = await dup.call('/api/auth/signup', 'POST', {
    handle: 'ALICE', password: 'password-a1',
  });
  assert.equal(status, 409);
});

test('login with wrong password fails, right one works', async () => {
  const fresh = client();
  assert.equal((await fresh.call('/api/auth/login', 'POST', { handle: 'alice', password: 'wrong-pass' })).status, 401);
  assert.equal((await fresh.call('/api/auth/login', 'POST', { handle: 'alice', password: 'password-a1' })).status, 200);
});

test('cross-origin state-changing request is rejected', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('friend request -> accept flow', async () => {
  await bob.call('/api/auth/signup', 'POST', { handle: 'bob', name: 'Bob', password: 'password-b1' });

  const search = await alice.call('/api/users/search?q=bo');
  assert.equal(search.data.results.length, 1);
  assert.equal(search.data.results[0].handle, 'bob');
  assert.equal(search.data.results[0].relation, 'none');

  const req = await alice.call('/api/friends/request', 'POST', { handle: 'bob' });
  assert.equal(req.status, 200);
  assert.equal(req.data.becameFriends, false);

  const bobMe = await bob.call('/api/me');
  assert.equal(bobMe.data.incoming.length, 1);
  assert.equal(bobMe.data.incoming[0].from.handle, 'alice');

  const respond = await bob.call('/api/friends/respond', 'POST', {
    id: bobMe.data.incoming[0].id, accept: true,
  });
  assert.equal(respond.status, 200);
  assert.equal(respond.data.friends.length, 1);
  assert.equal(respond.data.friends[0].handle, 'alice');

  const aliceMe = await alice.call('/api/me');
  assert.equal(aliceMe.data.friends[0].handle, 'bob');
});

test('meetup requires friendship for direct invites', async () => {
  const carol = client();
  await carol.call('/api/auth/signup', 'POST', { handle: 'carol', password: 'password-c1' });
  const aliceMe = await alice.call('/api/me');
  const carolId = (await carol.call('/api/me')).data.user.id;
  assert.ok(aliceMe.data.friends.every((f) => f.id !== carolId));
  const res = await alice.call('/api/meetups', 'POST', { inviteeId: carolId });
  assert.equal(res.status, 403);
});

test('meetup create + user/guest join + full room + role assignment over WS', async () => {
  const created = await alice.call('/api/meetups', 'POST', {});
  assert.equal(created.status, 201);
  const { code } = created.data;
  assert.match(code, /^[A-Z2-9]{6}$/);

  // Guest join via REST issues a ws token
  const guestJoin = await client().call('/api/meetups/join', 'POST', { code, guestName: 'Guest Gal' });
  assert.equal(guestJoin.status, 200);
  assert.equal(guestJoin.data.guest, true);
  assert.ok(guestJoin.data.wsToken);

  // Bad code 404s
  assert.equal((await client().call('/api/meetups/join', 'POST', { code: 'ZZZZZZ', guestName: 'X' })).status, 404);

  // Alice (creator) connects -> seeker
  const wsAlice = await wsConnect(port, `/ws?code=${code}`, alice.cookie);
  const joinedA = await wsAlice.next();
  assert.equal(joinedA.t, 'joined');
  assert.equal(joinedA.self.role, 'seeker');
  assert.equal(joinedA.peer, null);

  // Guest connects -> responder; Alice notified
  const wsGuest = await wsConnect(port, `/ws?code=${code}&token=${guestJoin.data.wsToken}`);
  const joinedG = await wsGuest.next();
  assert.equal(joinedG.t, 'joined');
  assert.equal(joinedG.self.role, 'responder');
  assert.equal(joinedG.peer.role, 'seeker');
  const peerJoined = await wsAlice.next();
  assert.equal(peerJoined.t, 'peer-joined');
  assert.equal(peerJoined.peer.name, 'Guest Gal');

  // Third connection is refused
  const bobJoin = await bob.call('/api/meetups/join', 'POST', { code });
  assert.equal(bobJoin.status, 200);
  const wsBob = await wsConnect(port, `/ws?code=${code}`, bob.cookie);
  const full = await wsBob.next();
  assert.equal(full.t, 'error');
  assert.equal(full.error, 'meetup_full');

  // Swap flips both roles
  wsAlice.send({ t: 'swap' });
  const rolesA = await wsAlice.next();
  const rolesG = await wsGuest.next();
  assert.equal(rolesA.t, 'roles');
  assert.equal(rolesA.self, 'responder');
  assert.equal(rolesG.self, 'seeker');

  // Readings relay seeker -> responder
  wsGuest.send({ t: 'reading', rtt: 120.5, distance: 4.2 });
  const reading = await wsAlice.next();
  assert.equal(reading.t, 'reading');
  assert.equal(reading.distance, 4.2);

  // Quick message relay
  wsAlice.send({ t: 'quick', text: 'On my way' });
  const quick = await wsGuest.next();
  assert.equal(quick.t, 'quick');
  assert.equal(quick.text, 'On my way');
  assert.equal(quick.from, 'Alice');

  // GPS long-range relay: Alice's fix reaches the guest, never touches history/best
  wsAlice.send({ t: 'gps', lat: 48.8584, lon: 2.2945, accuracy: 12.5 });
  const gps = await wsGuest.next();
  assert.equal(gps.t, 'gps');
  assert.equal(gps.lat, 48.8584);
  assert.equal(gps.lon, 2.2945);
  assert.equal(gps.accuracy, 12.5);
  assert.ok(typeof gps.at === 'number');

  // Out-of-range / malformed GPS payloads are silently dropped, not relayed
  wsAlice.send({ t: 'gps', lat: 999, lon: 2.2945, accuracy: 12.5 });
  wsAlice.send({ t: 'gps', lat: 48.85, lon: 2.29, accuracy: -1 });
  wsAlice.send({ t: 'quick', text: 'sentinel' }); // proves the bad gps frames above were dropped, not just slow
  const sentinel = await wsGuest.next();
  assert.equal(sentinel.t, 'quick');
  assert.equal(sentinel.text, 'sentinel');

  // Found -> broadcast + session end + history for the signed-in member
  wsAlice.send({ t: 'found' });
  assert.equal((await wsAlice.next()).t, 'found');
  assert.equal((await wsGuest.next()).t, 'found');
  assert.equal((await wsAlice.next()).t, 'ended');
  assert.equal((await wsGuest.next()).t, 'ended');
  wsAlice.close();
  wsGuest.close();

  const history = await alice.call('/api/meetups/history');
  assert.equal(history.status, 200);
  assert.equal(history.data.history.length, 1);
  assert.equal(history.data.history[0].found, true);
  assert.equal(history.data.history[0].peerName, 'Guest Gal');
  assert.equal(history.data.history[0].bestDistance, 4.2);

  // Ended meetup can't be joined again
  assert.equal((await bob.call('/api/meetups/join', 'POST', { code })).status, 404);
});

test('presence hub notifies invites', async () => {
  const wsBobPresence = await wsConnect(port, '/ws', bob.cookie);
  const hello = await wsBobPresence.next();
  assert.equal(hello.t, 'hello');

  const bobId = (await bob.call('/api/me')).data.user.id;
  const created = await alice.call('/api/meetups', 'POST', { inviteeId: bobId });
  assert.equal(created.status, 201);
  assert.equal(created.data.inviteeOnline, true);

  const invite = await wsBobPresence.next();
  assert.equal(invite.t, 'invite');
  assert.equal(invite.from.handle, 'alice');
  assert.equal(invite.code, created.data.code);
  wsBobPresence.close();
});

test('settings persist via PATCH /api/me', async () => {
  const patch = await alice.call('/api/me', 'PATCH', { settings: { theme: 'dark', channel: 'B' } });
  assert.equal(patch.status, 200);
  const me = await alice.call('/api/me');
  assert.equal(me.data.user.settings.channel, 'B');
});

test('password change invalidates other sessions', async () => {
  const second = client();
  await second.call('/api/auth/login', 'POST', { handle: 'alice', password: 'password-a1' });
  assert.equal((await second.call('/api/me')).status, 200);

  const change = await alice.call('/api/me/password', 'POST', {
    current: 'password-a1', next: 'password-a2new',
  });
  assert.equal(change.status, 200);
  assert.equal((await second.call('/api/me')).data.user, null);
  assert.ok((await alice.call('/api/me')).data.user);
});

test('block removes friendship and hides from search', async () => {
  const bobId = (await bob.call('/api/me')).data.user.id;
  const blocked = await alice.call('/api/friends/block', 'POST', { userId: bobId });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.data.friends.length, 0);
  assert.equal(blocked.data.blocked.length, 1);

  const search = await bob.call('/api/users/search?q=alice');
  assert.equal(search.data.results.length, 0);
  assert.equal((await bob.call('/api/friends/request', 'POST', { handle: 'alice' })).status, 403);

  const unblocked = await alice.call('/api/friends/unblock', 'POST', { userId: bobId });
  assert.equal(unblocked.data.blocked.length, 0);
});

test('account deletion wipes user and session', async () => {
  const doomed = client();
  await doomed.call('/api/auth/signup', 'POST', { handle: 'doomed', password: 'password-d1' });
  assert.equal((await doomed.call('/api/me', 'DELETE', {})).status, 200);
  assert.equal((await doomed.call('/api/me')).data.user, null);
  const search = await alice.call('/api/users/search?q=doomed');
  assert.equal(search.data.results.length, 0);
});

test('deep link /j/CODE redirects to SPA join route', async () => {
  const res = await fetch(base + '/j/ABC234', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/#/join/ABC234');
});

test('path traversal is blocked', async () => {
  const res = await fetch(base + '/..%2f..%2fserver%2fserver.js');
  assert.notEqual(res.status, 200);
});
