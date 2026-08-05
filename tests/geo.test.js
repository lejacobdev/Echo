// Verifies the GPS long-range math: distance, bearing, and the
// switch-to-acoustic suggestion heuristic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineDistance, bearing, compassLabel, combineAccuracy, shouldSuggestAcoustic } from '../public/js/geo.js';

test('haversineDistance matches known ~111.32m/0.001deg latitude at the equator', () => {
  const d = haversineDistance(0, 0, 0.001, 0);
  assert.ok(Math.abs(d - 111.32) < 1, `expected ~111.32m, got ${d}`);
});

test('haversineDistance is zero for identical points', () => {
  assert.equal(haversineDistance(48.858, 2.294, 48.858, 2.294), 0);
});

test('haversineDistance is symmetric', () => {
  const a = haversineDistance(40.7, -74.0, 40.71, -74.01);
  const b = haversineDistance(40.71, -74.01, 40.7, -74.0);
  assert.ok(Math.abs(a - b) < 1e-6);
});

test('bearing: due north/east/south/west', () => {
  assert.ok(Math.abs(bearing(0, 0, 1, 0) - 0) < 0.5, 'north');
  assert.ok(Math.abs(bearing(0, 0, 0, 1) - 90) < 0.5, 'east');
  assert.ok(Math.abs(bearing(0, 0, -1, 0) - 180) < 0.5, 'south');
  assert.ok(Math.abs(bearing(0, 0, 0, -1) - 270) < 0.5, 'west');
});

test('compassLabel maps degrees to 16-point compass', () => {
  assert.equal(compassLabel(0), 'N');
  assert.equal(compassLabel(90), 'E');
  assert.equal(compassLabel(180), 'S');
  assert.equal(compassLabel(270), 'W');
  assert.equal(compassLabel(45), 'NE');
  assert.equal(compassLabel(359), 'N'); // wraps
});

test('combineAccuracy is root-sum-square', () => {
  assert.equal(combineAccuracy(3, 4), 5);
  assert.equal(combineAccuracy(0, 7), 7);
});

test('shouldSuggestAcoustic: near-with-good-accuracy suggests, far-with-bad-accuracy does not', () => {
  assert.equal(shouldSuggestAcoustic(12, 5, 15), true);   // 12-5=7 <= 15
  assert.equal(shouldSuggestAcoustic(40, 5, 15), false);  // 40-5=35 > 15
  assert.equal(shouldSuggestAcoustic(30, 20, 15), true);  // shaky fix, but could be close: 30-20=10 <= 15
});
