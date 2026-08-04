// Unit tests for the pure ranging math shared with the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median, distanceFromRtt, channelUsable, pickChannel, proximityBand, createSmoother,
} from '../public/js/ranging.js';

test('median', () => {
  assert.equal(median([3]), 3);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
  assert.ok(Number.isNaN(median([])));
});

test('distanceFromRtt', () => {
  // 100 ms adjusted RTT -> 0.1 s * 343 / 2 = 17.15 m
  assert.ok(Math.abs(distanceFromRtt(150, 50) - 17.15) < 1e-9);
  // Offset larger than RTT clamps to zero
  assert.equal(distanceFromRtt(40, 80), 0);
  // ~5.8ms of extra RTT ≈ 1 meter
  assert.ok(Math.abs(distanceFromRtt(105.83, 100) - 1) < 0.01);
});

test('channel usability by sample rate', () => {
  assert.equal(channelUsable('A', 48000), true);   // Nyquist 24k > 20.5k
  assert.equal(channelUsable('A', 44100), true);   // 22.05k > 20.5k
  assert.equal(channelUsable('A', 40000), false);  // 20k < 20.5k
  assert.equal(channelUsable('B', 40000), true);   // 20k > 19k
  assert.equal(pickChannel('A', 44100), 'A');
  assert.equal(pickChannel('A', 40000), 'B');
  assert.equal(pickChannel('B', 48000), 'B');
  assert.equal(pickChannel('A', 16000), null);     // voice-profile mic: nothing fits
});

test('proximity bands', () => {
  assert.equal(proximityBand(0.5), 'veryClose');
  assert.equal(proximityBand(3), 'close');
  assert.equal(proximityBand(8), 'inRange');
  assert.equal(proximityBand(30), 'far');
});

test('smoother rejects single-sample outliers', () => {
  const s = createSmoother(5, 1); // alpha 1 => pure median of window
  s.push(4); s.push(4.2); s.push(3.9);
  const spiked = s.push(60); // one wild echo reading
  assert.ok(spiked < 5, `outlier leaked through: ${spiked}`);
  s.push(4.1);
  assert.ok(Math.abs(s.value - 4.1) < 0.3);
});
