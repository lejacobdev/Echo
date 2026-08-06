// Verifies the Goertzel detector actually discriminates 19kHz from 20kHz
// (the whole premise the seek/reply protocol depends on) and rejects noise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { goertzelMagnitude, toByteScale } from '../public/js/goertzel.js';

const SAMPLE_RATE = 48000;
const N = 512;

function tone(freq, amplitude = 1, sampleRate = SAMPLE_RATE, n = N) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function whiteNoise(amplitude = 0.05, n = N, seed = 42) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * (rand() * 2 - 1);
  return out;
}

test('detects a pure tone strongly at its own frequency', () => {
  const mag = goertzelMagnitude(tone(19000), 19000, SAMPLE_RATE);
  assert.ok(mag > 0.4, `expected strong response, got ${mag}`);
});

test('rejects a tone 1000Hz away (seek vs reply channel separation)', () => {
  const samples = tone(19000);
  const onTarget = goertzelMagnitude(samples, 19000, SAMPLE_RATE);
  const offTarget = goertzelMagnitude(samples, 20000, SAMPLE_RATE);
  assert.ok(offTarget < onTarget * 0.15, `off-target leaked too much: on=${onTarget} off=${offTarget}`);
});

test('channel B frequencies are also separable', () => {
  const samples = tone(17500);
  const onTarget = goertzelMagnitude(samples, 17500, SAMPLE_RATE);
  const offTarget = goertzelMagnitude(samples, 18500, SAMPLE_RATE);
  assert.ok(offTarget < onTarget * 0.2, `channel B bleed too high: on=${onTarget} off=${offTarget}`);
});

test('silence and noise floor stay low relative to a real tone', () => {
  const silence = goertzelMagnitude(new Float32Array(N), 19000, SAMPLE_RATE);
  const noise = goertzelMagnitude(whiteNoise(), 19000, SAMPLE_RATE);
  const strongTone = goertzelMagnitude(tone(19000, 1), 19000, SAMPLE_RATE);
  assert.equal(silence, 0);
  assert.ok(noise < strongTone * 0.25, `noise too close to signal: noise=${noise} tone=${strongTone}`);
});

test('magnitude scales with amplitude (weak/far-away signal still resolvable)', () => {
  const full = goertzelMagnitude(tone(19000, 1), 19000, SAMPLE_RATE);
  const weak = goertzelMagnitude(tone(19000, 0.1), 19000, SAMPLE_RATE);
  assert.ok(Math.abs(weak - full * 0.1) < 0.01, `expected roughly linear scaling, full=${full} weak=${weak}`);
});

test('toByteScale clamps into 0-255', () => {
  assert.equal(toByteScale(0), 0);
  assert.equal(toByteScale(10), 255);
  assert.ok(toByteScale(0.5) > 0 && toByteScale(0.5) <= 255);
});

// Regression for a real-device report: a confirmed-transmitted reply
// arriving from a few meters away was measured well below what the old
// gain/floor combo (gain=6, adaptiveMin=70) could clear — a weak-but-
// genuine signal was being silently rejected as noise, not lost to a
// dispatch bug (the responder's reply counter was confirmed incrementing;
// the seeker just never saw its reply cell cross the threshold). A 5%
// full-scale amplitude tone lands right in that gap: byte 63 at the old
// gain=6 (fails the old floor of 70), byte 126 at the new gain=12 (clears
// the new floor of 40 with room to spare). See ranging-worklet.js's
// adaptiveMin/adaptiveMargin and toByteScale for the matching production
// constants.
test('a weak (5% amplitude) but real signal that used to miss the old threshold now clears it', () => {
  const weakReply = goertzelMagnitude(tone(20000, 0.05), 20000, SAMPLE_RATE);
  const oldByteValue = toByteScale(weakReply, 6);
  const newByteValue = toByteScale(weakReply, 12);
  const oldAdaptiveMin = 70;
  const newAdaptiveMin = 40; // mirrors ranging-worklet.js's adaptiveMin
  assert.ok(
    oldByteValue < oldAdaptiveMin,
    `sanity check: this signal (byte ${oldByteValue}) should have missed the old floor (${oldAdaptiveMin})`
  );
  assert.ok(
    newByteValue > newAdaptiveMin,
    `a real 5%-amplitude signal (byte ${newByteValue}) must clear the new adaptive floor (${newAdaptiveMin}) in a quiet room`
  );
});
