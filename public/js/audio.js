// AudioEngine: owns the AudioContext, mic stream and analyser.
// Emits tone bursts and exposes per-frequency magnitude + noise-floor tracking.

const FFT_SIZE = 4096;
const TONE_DURATION = 0.08;   // s
const TONE_ENVELOPE = 0.006;  // s fade in/out to avoid clicks

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.freqData = null;
    this.floors = new Map(); // freq -> EMA noise floor
    this.outputGain = 1;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  get active() {
    return !!(this.ctx && this.stream);
  }

  static supported() {
    return !!(
      (window.AudioContext || window.webkitAudioContext) &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    );
  }

  async start() {
    if (this.active) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor();
    try {
      // Disable all voice processing: it suppresses exactly the narrow-band
      // ultrasonic signal we depend on.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      await this.stop();
      const e = new Error('mic_denied');
      e.cause = err;
      throw e;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  async stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* already closed */ }
      this.ctx = null;
    }
    this.analyser = null;
    this.floors.clear();
  }

  // Refresh the FFT snapshot; call once per animation frame, then magAt().
  capture() {
    if (this.analyser) this.analyser.getByteFrequencyData(this.freqData);
  }

  // Peak magnitude (0-255) across the bin at `freq` and its neighbors.
  magAt(freq) {
    if (!this.analyser) return 0;
    const binHz = this.sampleRate / FFT_SIZE;
    const center = Math.round(freq / binHz);
    let max = 0;
    for (let b = center - 1; b <= center + 1; b++) {
      if (b >= 0 && b < this.freqData.length && this.freqData[b] > max) max = this.freqData[b];
    }
    return max;
  }

  // Track a slow-moving noise floor per frequency; only updated when the
  // signal is NOT spiking so real chirps don't inflate the floor.
  updateFloor(freq, mag) {
    const prev = this.floors.get(freq) ?? mag;
    if (mag < prev + 30) {
      this.floors.set(freq, prev * 0.95 + mag * 0.05);
    }
    return this.floors.get(freq) ?? prev;
  }

  floorAt(freq) {
    return this.floors.get(freq) ?? 0;
  }

  playTone(freq, when = 0) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(this.outputGain, now + TONE_ENVELOPE);
    gain.gain.setValueAtTime(this.outputGain, now + TONE_DURATION - TONE_ENVELOPE);
    gain.gain.linearRampToValueAtTime(0, now + TONE_DURATION);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + TONE_DURATION + 0.02);
  }

  // Soft audible blip for accessibility feedback (distinct from the chirps).
  playTick(pitch = 880, volume = 0.06) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = pitch;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }
}

export const TONE_DURATION_MS = TONE_DURATION * 1000;
