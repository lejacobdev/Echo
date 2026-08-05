// Pure GPS math for the long-range phase: great-circle distance, initial
// bearing, and a conservative "you might already be close enough for
// acoustic" heuristic. No DOM/geolocation dependency — unit-tested in node.

const EARTH_RADIUS_M = 6371000;

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

// Haversine great-circle distance in meters.
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Initial compass bearing (0-360, 0 = true north) from point 1 to point 2.
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassLabel(bearingDeg) {
  return COMPASS_POINTS[Math.round(bearingDeg / 22.5) % 16];
}

// Two independent GPS fixes -> combined 1-sigma-ish error radius (root-sum-square).
export function combineAccuracy(accuracyA, accuracyB) {
  return Math.sqrt(accuracyA ** 2 + accuracyB ** 2);
}

// Conservative "you could plausibly already be within acoustic range" check:
// true if the reported distance minus one combined-accuracy radius already
// dips under the threshold. GPS `accuracy` is reported as roughly a 68%
// confidence radius on both Android and iOS, so this errs toward suggesting
// the switch a bit early rather than making someone wait on a shaky number.
export function shouldSuggestAcoustic(distanceMeters, combinedAccuracyMeters, thresholdMeters = 15) {
  return distanceMeters - combinedAccuracyMeters <= thresholdMeters;
}
