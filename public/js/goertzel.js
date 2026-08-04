// Goertzel single-frequency energy detector — the exact-frequency alternative
// to reading the nearest bin out of a general-purpose FFT. Cheaper than an
// FFT for checking just 1-2 known frequencies, and doesn't lose energy to
// bin-center misalignment the way AnalyserNode's fixed bin grid can.
// Pure function so it's unit-testable in node and shared as the reference
// implementation for the (necessarily self-contained) copy inside the
// AudioWorkletProcessor in ranging-worklet.js.

// Returns an amplitude-like magnitude, roughly on a 0..1 scale for samples
// in [-1, 1] (i.e. comparable across window sizes), for `freq` Hz.
export function goertzelMagnitude(samples, freq, sampleRate) {
  const N = samples.length;
  const k = Math.round((N * freq) / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / (N / 2);
}

// Maps the ~0..1 amplitude estimate onto the app's historical 0-255 scale
// (what AnalyserNode's getByteFrequencyData used to hand back), so existing
// threshold defaults and the manual-threshold slider stay meaningful.
export function toByteScale(amplitude, gain = 6) {
  return Math.max(0, Math.min(255, Math.round(amplitude * 255 * gain)));
}
