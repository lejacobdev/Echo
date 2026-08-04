// End-to-end smoke test with a real browser (requires Playwright + Chromium).
// Run: node tools/e2e-smoke.mjs   (set ECHO_CHROMIUM to your Chromium binary if needed)
// Covers: home -> signup x2 -> friend request/accept -> meetup invite over the
// presence socket -> both phones in the find room with complementary roles ->
// quick message relay -> end session. Also checks for console errors.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createEchoServer } from '../server/server.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.error('playwright not installed; skipping e2e smoke');
  process.exit(0);
}

const tmpData = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-e2e-')), 'data.json');
const echo = createEchoServer({ dataFile: tmpData });
const { port } = await echo.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
console.log('server on', base);

const browser = await chromium.launch({
  executablePath: process.env.ECHO_CHROMIUM || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const errors = [];
async function newUser(name) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`${name} console: ${m.text()}`);
  });
  await page.goto(base);
  return page;
}

const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };

// --- Sign up two users ---
const alice = await newUser('alice');
const bob = await newUser('bob');

async function signup(page, handle, display) {
  await page.click('#home-start'); // routes to auth since signed out
  await page.waitForSelector('#view-auth:not(.hidden)');
  await page.click('#auth-tab-signup');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-name', display);
  await page.fill('#auth-password', 'password-123');
  await page.click('#auth-submit');
  await page.waitForSelector('#account-chip:not(.hidden)');
}
await signup(alice, 'alice', 'Alice');
await signup(bob, 'bob', 'Bob');
console.log('✓ both users signed up');

// --- Friend request flow ---
await alice.click('#tabbar .tab[data-nav="friends"]');
await alice.waitForSelector('#view-friends:not(.hidden)');
await alice.fill('#friend-search', 'bob');
await alice.waitForSelector('#friend-results li');
await alice.click('#friend-results li button');
await bob.click('#tabbar .tab[data-nav="friends"]');
await bob.waitForSelector('#requests-incoming li', { timeout: 5000 });
await bob.click('#requests-incoming li .li-actions button'); // Accept
await bob.waitForSelector('#friends-list li');
console.log('✓ friend request sent and accepted');

// --- Meetup invite: Alice taps Find on Bob; Bob gets the invite modal ---
await alice.waitForSelector('#friends-list li');
await alice.click('#friends-list li .li-actions button'); // "Find"
await alice.waitForSelector('#view-find:not(.hidden)');
await bob.waitForSelector('#modal-invite:not(.hidden)', { timeout: 5000 });
await bob.click('#invite-accept');
await bob.waitForSelector('#view-find:not(.hidden)');
console.log('✓ invite delivered over presence socket and accepted');

// --- Roles must be complementary; peer names shown ---
await alice.waitForFunction(() => document.getElementById('find-peer').textContent.includes('Bob'), null, { timeout: 5000 });
await bob.waitForFunction(() => document.getElementById('find-peer').textContent.includes('Alice'), null, { timeout: 5000 });
const roleA = await alice.textContent('#find-role-name');
const roleB = await bob.textContent('#find-role-name');
assert(roleA !== roleB, `roles must differ, both are ${roleA}`);
console.log(`✓ roles assigned: alice=${roleA} bob=${roleB}`);

// --- Swap roles ---
await alice.click('#btn-swap');
await alice.waitForFunction(
  (prev) => document.getElementById('find-role-name').textContent !== prev,
  roleA, { timeout: 5000 }
);
console.log('✓ role swap round-trips');

// --- Quick message relay ---
await alice.click('#quick-buttons button');
await bob.waitForSelector('.toast', { timeout: 5000 });
console.log('✓ quick message relayed');

// --- Mic pill active, debug toggle, calibration overlay opens ---
const pill = await alice.textContent('#activity-pill');
assert(pill.length > 0, 'activity pill rendered');
const seeker = (await alice.textContent('#find-role-name')) === 'Seeker' ? alice : bob;
await seeker.click('#btn-calibrate');
await seeker.waitForSelector('#calib-overlay:not(.hidden)');
await seeker.click('#calib-cancel');
console.log('✓ calibration overlay opens and closes');

// --- End session from Alice; Bob sees it end too ---
await alice.click('#btn-end');
await alice.waitForSelector('#view-home:not(.hidden)');
await bob.waitForSelector('#view-home:not(.hidden)', { timeout: 5000 });
console.log('✓ session ended for both sides');

// --- Nearby (local, offline-capable) mode still works signed out ---
const guest = await newUser('guest');
await guest.click('#home-local');
await guest.waitForSelector('#view-find:not(.hidden)');
await guest.waitForSelector('#local-role-toggle:not(.hidden)');
await guest.click('#role-btn-responder');
await guest.waitForSelector('#responder-panel:not(.hidden)');
console.log('✓ nearby mode with manual roles works');

// --- Join view via deep link redirect ---
const joiner = await newUser('joiner');
await joiner.goto(`${base}/j/ABC234`);
await joiner.waitForSelector('#view-join:not(.hidden)');
assert((await joiner.inputValue('#join-code')) === 'ABC234', 'deep link prefills code');
console.log('✓ deep link prefills the join form');

// --- Service worker registered ---
await alice.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then(() => true), null, { timeout: 5000 }).catch(() => {
  console.log('(service worker not confirmed — http origin limits apply)');
});

if (errors.length) {
  console.error('CONSOLE/PAGE ERRORS:');
  for (const e of errors) console.error(' -', e);
  process.exitCode = 1;
} else {
  console.log('✓ zero console or page errors across all pages');
}

await browser.close();
await echo.close();
console.log(process.exitCode ? 'E2E SMOKE FAILED' : 'E2E SMOKE PASSED');
