// AudioWorkletProcessor: runs on the dedicated real-time audio thread, not
// the UI thread. Two things this buys over the old requestAnimationFrame +
// AnalyserNode polling loop:
//   1. Timing precision: process() fires every render quantum (~2.7-2.9ms),
//      timestamped against the audio hardware's own clock (`currentTime`),
//      instead of ~16.7ms rAF ticks that can stretch to whole seconds the
//      moment the tab loses foreground focus (background-tab throttling).
//      That jitter was translating directly into meters of distance error.
//   2. Sensitivity: Goertzel evaluates energy at the *exact* target
//      frequency instead of the nearest FFT bin, so weak/far-away signal is
//      detected a bit further out before it's lost in the noise floor.
//
// Self-contained on purpose (no import) for the widest Safari/iOS
// compatibility with audioWorklet.addModule(). The Goertzel math here is
// intentionally identical to — and unit-tested via — public/js/goertzel.js;
// keep the two in sync if you touch the algorithm.

const WINDOW = 512;          // samples; ~10.7ms @48kHz, ~93.75Hz bin width
const RISING_REFRACTORY_S = 0.08; // don't re-fire mid-tone on amplitude ripple
const LEVEL_REPORT_INTERVAL_S = 0.1; // ~10Hz UI updates, not per-block spam
const FLOOR_ALPHA = 0.03;
const FLOOR_GUARD = 0.06; // ignore spikes when updating the floor EMA

function goertzelMagnitude(samples, freq, sampleRate) {
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

// gain=12 (was 6): confirmed against real-device reports that a genuine,
// confirmed-transmitted reply arriving from a few meters away was landing
// right at ~10% relative amplitude — toByteScale(0.1) was ~77 at gain=6,
// barely clearing (or falling just short of) adaptiveMin below. Doubling
// the gain gives real-but-weak signals comfortable headroom above the
// fixed floor without changing the underlying detector.
function toByteScale(amplitude, gain = 12) {
  return Math.max(0, Math.min(255, Math.round(amplitude * 255 * gain)));
}

class RangingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Default matches ranging.js's FREQ_SLOTS order: [A.seek, A.reply,
    // B.seek, B.reply, C.seek, C.reply] — a Responder always tracks every
    // channel so it never goes deaf just because the two devices' local
    // channel settings didn't happen to match. Overwritten by the first
    // 'config' message.
    this.freqs = [19000, 20000, 17500, 18500, 12500, 13500];
    this.mode = 'adaptive';       // 'adaptive' | 'manual'
    this.manualThreshold = 165;   // 0-255 scale
    // Lowered from 30/70: real-device testing showed a confirmed,
    // successfully-transmitted reply from a few meters away landing well
    // under the old floor even on an audible test channel — this was a
    // sensitivity problem, not a detection/dispatch bug. The high-frequency
    // bands this app uses (12.5-20kHz) carry very little everyday ambient
    // noise, so a lower floor here is safe against false triggers.
    this.adaptiveMargin = 20;
    this.adaptiveMin = 40;

    this.ring = new Float32Array(WINDOW);
    this.ringPos = 0;
    this.filled = 0;

    this.floors = [0, 0, 0, 0];         // 0-255 scale, EMA
    this.floorInit = [false, false, false, false];
    this.lastCross = [-Infinity, -Infinity, -Infinity, -Infinity];
    this.lastLevelReport = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.t !== 'config') return;
      if (Array.isArray(msg.freqs)) this.freqs = msg.freqs;
      if (msg.mode) this.mode = msg.mode;
      if (typeof msg.manualThreshold === 'number') this.manualThreshold = msg.manualThreshold;
    };
  }

  threshold(freqIndex) {
    if (this.mode === 'manual') return this.manualThreshold;
    return Math.max(this.adaptiveMin, this.floors[freqIndex] + this.adaptiveMargin);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      this.ring[this.ringPos] = channel[i];
      this.ringPos = (this.ringPos + 1) % WINDOW;
      if (this.filled < WINDOW) this.filled++;
    }
    if (this.filled < WINDOW) return true;

    const samples = new Float32Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) samples[i] = this.ring[(this.ringPos + i) % WINDOW];

    // A frequency at or above this device's own Nyquist limit can't be
    // measured meaningfully (matches ranging.js's channelUsable() margin) —
    // report it as silent rather than feeding garbage into threshold/floor
    // tracking. This matters now that a Responder always requests both
    // channels regardless of whether its own hardware's sample rate can
    // actually hear the higher one.
    const mags = this.freqs.map((f) =>
      f >= sampleRate / 2 - 500 ? 0 : toByteScale(goertzelMagnitude(samples, f, sampleRate))
    );

    for (let i = 0; i < mags.length; i++) {
      if (!this.floorInit[i]) { this.floors[i] = mags[i]; this.floorInit[i] = true; }
      else if (mags[i] < this.floors[i] + FLOOR_GUARD * 255) {
        this.floors[i] = this.floors[i] * (1 - FLOOR_ALPHA) + mags[i] * FLOOR_ALPHA;
      }
    }

    for (let i = 0; i < mags.length; i++) {
      if (mags[i] > this.threshold(i) && currentTime - this.lastCross[i] > RISING_REFRACTORY_S) {
        this.lastCross[i] = currentTime;
        this.port.postMessage({ t: 'cross', freqIndex: i, time: currentTime, mag: mags[i] });
      }
    }

    if (currentTime - this.lastLevelReport > LEVEL_REPORT_INTERVAL_S) {
      this.lastLevelReport = currentTime;
      this.port.postMessage({
        t: 'levels',
        mags,
        floors: this.floors.map((f) => Math.round(f)),
        thresholds: mags.map((_, i) => Math.round(this.threshold(i))),
      });
    }

    return true;
  }
}

registerProcessor('ranging-processor', RangingProcessor);
