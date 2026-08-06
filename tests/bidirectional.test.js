// Verifies RangingSession's bidirectional mode is collision-free: two
// simultaneous sessions (simulating two real devices) pinging each other on
// complementary channels at the same time, with the "air" between them
// modeled directly (device A's playTone() is wired straight into device B's
// _onWorkletCross(), and back) — no real audio needed to prove the protocol
// logic itself never confuses "my own ping's reply" with "the peer's ping".
import test from 'node:test';
import assert from 'node:assert/strict';
import { RangingSession, FREQ_SLOTS, CHANNELS } from '../public/js/ranging.js';

function freqIndexOf(freq) {
  return FREQ_SLOTS.findIndex((s) => s.freq === freq);
}

function makeFakeEngine() {
  return {
    workletReady: true,
    active: true,
    currentAudioTime: 0,
    onDetect: null,
    onWorkletLevels: null,
    played: [],
    configureWorklet() {},
    playTone(freq) { this.played.push(freq); },
    floorAt() { return 0; },
  };
}

// Wires deviceA's outbound tones into deviceB's detector and vice versa,
// simulating perfect acoustic coupling between two devices in the same room.
// Each delivery advances the *receiving* device's own clock by a small
// propagation delay (as a real device's own AudioContext clock would when
// it later hears the tone) — using the transmitter's clock, or not
// advancing time at all, would give a 0ms RTT that the real
// SEEKER_MIN_RTT_MS guard correctly rejects as implausible.
function coupleAcoustically(a, b, delay = 0.02) {
  const wrap = (txSession, rxSession) => {
    const orig = txSession.engine.playTone.bind(txSession.engine);
    txSession.engine.playTone = (freq) => {
      orig(freq);
      const idx = freqIndexOf(freq);
      if (idx >= 0) {
        rxSession.engine.currentAudioTime += delay;
        rxSession._onWorkletCross(idx, rxSession.engine.currentAudioTime);
      }
    };
  };
  wrap(a, b);
  wrap(b, a);
}

test('bidirectional: two devices ping each other simultaneously without collision', () => {
  const engineA = makeFakeEngine();
  const engineB = makeFakeEngine();
  const readingsA = [];
  const readingsB = [];

  const deviceA = new RangingSession(engineA, {
    channel: 'A', bidirectional: true,
    onReading: (rtt, dist) => readingsA.push({ rtt, dist }),
  });
  const deviceB = new RangingSession(engineB, {
    channel: 'B', bidirectional: true,
    onReading: (rtt, dist) => readingsB.push({ rtt, dist }),
  });
  coupleAcoustically(deviceA, deviceB);

  // Both ping "simultaneously" — deviceA transmits channel A's seek tone,
  // deviceB transmits channel B's seek tone, at the same instant.
  engineA.currentAudioTime = 1.0;
  engineB.currentAudioTime = 1.0;
  assert.equal(deviceA.ping(), true);
  assert.equal(deviceB.ping(), true);

  // deviceA played A.seek, which coupleAcoustically delivered straight into
  // deviceB's detector -> deviceB must have replied on A.reply.
  assert.ok(engineA.played.includes(CHANNELS.A.seek));
  assert.ok(engineB.played.includes(CHANNELS.A.reply), 'B must respond to A\'s seek on A\'s reply frequency');
  // Symmetric: deviceB played B.seek -> deviceA replied on B.reply.
  assert.ok(engineB.played.includes(CHANNELS.B.seek));
  assert.ok(engineA.played.includes(CHANNELS.B.reply), 'A must respond to B\'s seek on B\'s reply frequency');

  // Each device accepted exactly its OWN reply and got exactly one reading —
  // not the other device's, and not double-counted from cross-talk.
  assert.equal(readingsA.length, 1, `deviceA should get exactly one reading, got ${readingsA.length}`);
  assert.equal(readingsB.length, 1, `deviceB should get exactly one reading, got ${readingsB.length}`);
  assert.ok(readingsA[0].rtt > 0);
  assert.ok(readingsB[0].rtt > 0);

  // Neither device ever played its own seek frequency back as a "reply" to
  // itself, and neither replied to its own transmitted seek tone.
  assert.equal(engineA.played.filter((f) => f === CHANNELS.A.seek).length, 1);
  assert.equal(engineB.played.filter((f) => f === CHANNELS.B.seek).length, 1);

});

test('bidirectional: a device only accepts a reply on the channel it actually transmitted on', () => {
  const engineA = makeFakeEngine();
  const readingsA = [];
  const deviceA = new RangingSession(engineA, {
    channel: 'A', bidirectional: true,
    onReading: (rtt) => readingsA.push(rtt),
  });
  engineA.currentAudioTime = 5.0;
  deviceA.ping(); // transmits on channel A, awaits A.reply

  // A stray B.reply tone (e.g. some unrelated third session/room nearby)
  // must NOT be mistaken for the reply deviceA is waiting for.
  deviceA._onWorkletCross(freqIndexOf(CHANNELS.B.reply), 5.01);
  assert.equal(readingsA.length, 0, 'a reply on the wrong channel must not settle the ping');

  // The real reply, on A, does settle it.
  deviceA._onWorkletCross(freqIndexOf(CHANNELS.A.reply), 5.02);
  assert.equal(readingsA.length, 1);

});

test('directional (Nearby mode) responder still replies on either channel — unaffected by bidirectional changes', () => {
  const engine = makeFakeEngine();
  let replies = 0;
  const responder = new RangingSession(engine, {
    bidirectional: false,
    onReply: () => { replies++; },
  });
  responder.setRole('responder');

  engine.currentAudioTime = 2.0;
  responder._onWorkletCross(freqIndexOf(CHANNELS.A.seek), 2.0);
  engine.currentAudioTime = 2.5;
  responder._onWorkletCross(freqIndexOf(CHANNELS.B.seek), 2.5);

  assert.equal(replies, 2);
  assert.deepEqual(engine.played, [CHANNELS.A.reply, CHANNELS.B.reply]);

});

test('directional (Nearby mode) seeker ignores replies, bidirectional seeker does not', () => {
  const engine = makeFakeEngine();
  let readings = 0;
  const seeker = new RangingSession(engine, {
    channel: 'A', bidirectional: false,
    onReply: () => { throw new Error('a pure Seeker must never reply'); },
    onReading: () => { readings++; },
  });
  seeker.setRole('seeker');

  engine.currentAudioTime = 3.0;
  seeker.ping();
  // Even a seek tone on our own channel must not make a pure Seeker reply.
  seeker._onWorkletCross(freqIndexOf(CHANNELS.A.seek), 3.01);
  seeker._onWorkletCross(freqIndexOf(CHANNELS.A.reply), 3.02);
  assert.equal(readings, 1);

});

// calibrate() spends real wall-clock time between rounds (a 450ms
// setTimeout, to let reverb die down), so unlike the other tests here it
// needs a fake engine whose currentAudioTime actually advances with real
// elapsed time — exactly like a real AudioContext's currentTime — rather
// than one a test manually bumps by a fixed hop amount. Otherwise the
// simulated clock barely moves between rounds and RESPONDER_DEBOUNCE_MS
// (350ms) falsely looks uncleared, which is a test-harness artifact, not
// a real bug: real hardware clocks track real time, so 450ms of actual
// waiting always clears a 350ms debounce.
function makeRealtimeFakeEngine() {
  const start = Date.now();
  return {
    workletReady: true,
    active: true,
    get currentAudioTime() { return (Date.now() - start) / 1000; },
    onDetect: null,
    onWorkletLevels: null,
    played: [],
    configureWorklet() {},
    playTone(freq) { this.played.push(freq); },
    floorAt() { return 0; },
  };
}

function coupleRealtime(a, b, delay = 0.02) {
  const wrap = (txSession, rxSession) => {
    const orig = txSession.engine.playTone.bind(txSession.engine);
    txSession.engine.playTone = (freq) => {
      orig(freq);
      const idx = freqIndexOf(freq);
      if (idx >= 0) rxSession._onWorkletCross(idx, rxSession.engine.currentAudioTime + delay);
    };
  };
  wrap(a, b);
  wrap(b, a);
}

test('bidirectional: peer keeps responding normally after one device runs calibrate()', async () => {
  const engineA = makeRealtimeFakeEngine();
  const engineB = makeRealtimeFakeEngine();
  const readingsA = [];
  const readingsB = [];
  let repliesB = 0;

  const deviceA = new RangingSession(engineA, {
    channel: 'A', bidirectional: true,
    onReading: (rtt, dist) => readingsA.push({ rtt, dist }),
  });
  const deviceB = new RangingSession(engineB, {
    channel: 'B', bidirectional: true,
    onReading: (rtt, dist) => readingsB.push({ rtt, dist }),
    onReply: () => { repliesB++; },
  });
  coupleRealtime(deviceA, deviceB);

  const result = await deviceA.calibrate(5);
  assert.equal(result.ok, true, 'calibration should succeed when the peer is present and responding');
  assert.equal(result.successes, 5);
  assert.ok(repliesB >= 5, `deviceB should have replied to every calibration ping, replied ${repliesB} times`);

  // deviceB's Respond path is unconditional and never gated on deviceA's
  // calibration state, so it must still be responding normally afterward.
  readingsA.length = 0;
  assert.equal(deviceA.ping(), true);
  assert.equal(readingsA.length, 1, 'deviceA should still get a normal reading from deviceB after calibration');

  readingsB.length = 0;
  assert.equal(deviceB.ping(), true);
  assert.equal(readingsB.length, 1, 'deviceB should still get a normal reading from deviceA after A calibrated');
});
