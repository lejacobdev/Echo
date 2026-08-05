// Verifies the GPS long-range phase end-to-end: two browser contexts pinned
// at real coordinates via Playwright's geolocation mock, connected in a
// meetup room, exchanging live position over the WebSocket relay, and
// rendering a correct distance in the UI.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createEchoServer } from '../server/server.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('playwright not installed; skipping gps e2e'); process.exit(0); }

const tmpData = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-gps-')), 'data.json');
const echo = createEchoServer({ dataFile: tmpData });
const { port } = await echo.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: process.env.ECHO_CHROMIUM || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };
const errors = [];

// Eiffel Tower and a point ~44m north of it (0.0004 deg latitude).
const A = { latitude: 48.8584, longitude: 2.2945 };
const B = { latitude: 48.8588, longitude: 2.2945 };

async function newUser(name, coords) {
  const context = await browser.newContext({
    permissions: ['microphone', 'geolocation'],
    geolocation: { ...coords, accuracy: 10 },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.goto(base);
  return page;
}

const alice = await newUser('alice', A);
const bob = await newUser('bob', B);

async function signup(page, handle, display) {
  await page.click('#home-start');
  await page.click('#auth-tab-signup');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-name', display);
  await page.fill('#auth-password', 'password-123');
  await page.click('#auth-submit');
  await page.waitForSelector('#account-chip:not(.hidden)');
}
await signup(alice, 'alice', 'Alice');
await signup(bob, 'bob', 'Bob');

// Friend + meetup, same flow as the main smoke test.
await alice.click('#tabbar .tab[data-nav="friends"]');
await alice.fill('#friend-search', 'bob');
await alice.waitForSelector('#friend-results li');
await alice.click('#friend-results li button');
await bob.click('#tabbar .tab[data-nav="friends"]');
await bob.waitForSelector('#requests-incoming li', { timeout: 5000 });
await bob.click('#requests-incoming li .li-actions button');
await bob.waitForSelector('#friends-list li');

await alice.waitForSelector('#friends-list li');
await alice.click('#friends-list li .li-actions button');
await alice.waitForSelector('#view-find:not(.hidden)');
await bob.waitForSelector('#modal-invite:not(.hidden)', { timeout: 5000 });
await bob.click('#invite-accept');
await bob.waitForSelector('#view-find:not(.hidden)');
await alice.waitForFunction(() => document.getElementById('find-peer').textContent.includes('Bob'), null, { timeout: 5000 });
console.log('✓ meetup room formed');

// GPS panel should be visible in meetup mode.
await alice.waitForSelector('#gps-card:not(.hidden)');
await bob.waitForSelector('#gps-card:not(.hidden)');
console.log('✓ GPS panel visible in meetup mode');

// Enable GPS on both sides.
await alice.click('#btn-gps-enable');
await bob.click('#btn-gps-enable');
await alice.waitForSelector('#gps-live:not(.hidden)');
await bob.waitForSelector('#gps-live:not(.hidden)');
console.log('✓ GPS enabled on both devices');

// Wait for both fixes to cross the wire and the distance readout to populate.
await alice.waitForFunction(() => document.getElementById('gps-distance').textContent !== '—', null, { timeout: 8000 });
await bob.waitForFunction(() => document.getElementById('gps-distance').textContent !== '—', null, { timeout: 8000 });

const aliceDistance = await alice.textContent('#gps-distance');
const bobDistance = await bob.textContent('#gps-distance');
console.log('alice sees:', aliceDistance, '| bob sees:', bobDistance);

const meters = parseInt(aliceDistance, 10);
assert(meters > 35 && meters < 55, `expected ~44m, got ${aliceDistance}`);
assert(parseInt(bobDistance, 10) > 35 && parseInt(bobDistance, 10) < 55, `expected ~44m, got ${bobDistance}`);
console.log('✓ both sides computed the correct ~44m distance from live GPS fixes');

const aliceAccuracyLine = await alice.textContent('#gps-accuracy');
assert(/[NSEW]/.test(aliceAccuracyLine), `expected a compass letter in "${aliceAccuracyLine}"`);
assert(aliceAccuracyLine.includes('±'), `expected an accuracy figure in "${aliceAccuracyLine}"`);
console.log('✓ compass direction + accuracy radius both shown:', aliceAccuracyLine);

// 44m is beyond the 15m suggest threshold, so the "switch to acoustic" banner should NOT show.
const suggestHidden = await alice.evaluate(() => document.getElementById('gps-suggest').classList.contains('hidden'));
assert(suggestHidden, 'suggest-switch banner should stay hidden at 44m');
console.log('✓ switch-to-acoustic banner correctly suppressed while still far apart');

if (errors.length) {
  console.error('CONSOLE/PAGE ERRORS:');
  for (const e of errors) console.error(' -', e);
  process.exitCode = 1;
} else {
  console.log('✓ zero console or page errors');
}

await browser.close();
await echo.close();
console.log(process.exitCode ? 'GPS E2E SMOKE FAILED' : 'GPS E2E SMOKE PASSED');
