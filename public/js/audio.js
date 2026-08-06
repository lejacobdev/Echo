// AudioEngine: owns the AudioContext, mic stream, and signal detection.
//
// Detection runs on an AudioWorklet (ranging-worklet.js) when available —
// sample-accurate timing on the real-time audio thread, immune to
// requestAnimationFrame's background-tab throttling and to whatever the UI
// thread is doing. Falls back to AnalyserNode + polling (the original
// approach) on browsers without AudioWorklet support.

const FFT_SIZE = 4096;
const TONE_DURATION = 0.08;   // s
const TONE_ENVELOPE = 0.006;  // s fade in/out to avoid clicks

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.freqData = null;
    this.floors = new Map(); // freq -> EMA noise floor (fallback path only)
    this.outputGain = 1;

    this.worklet = null;
    this.workletReady = false;
    this.onDetect = null;      // (freqIndex, audioTimeSec, mag) => void
    this.onWorkletLevels = null; // ({ mags, floors, thresholds }) => void
    this._starting = null;     // in-flight start() promise, for de-duplication
    // What the browser/OS actually granted, which can differ from what was
    // requested — MediaTrackConstraints are hints, not guarantees, and it's
    // common (especially on Android) for the mic to stay routed through a
    // voice-call audio path that quietly re-enables noise suppression no
    // matter what the page asked for. Surfaced in the debug panel so that's
    // visible instead of just inferred from "detection doesn't work".
    this.trackSettings = null;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  get active() {
    return !!(this.ctx && this.stream);
  }

  get currentAudioTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  static supported() {
    return !!(
      (window.AudioContext || window.webkitAudioContext) &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    );
  }

  // Guards against concurrent invocation: enterFind() kicks this off
  // automatically, and the user tapping Calibrate/Ping moments later (while
  // the mic permission prompt is still pending — entirely normal, it needs
  // a human to physically tap "Allow") would otherwise race a *second*,
  // fully independent start() call. Both would pass the `if (this.active)`
  // guard (stream is still null for either), each creating its own
  // AudioContext + MediaStream — leaking a live mic track and an orphaned
  // AudioContext every time it happens. Caught and confirmed by forcing a
  // realistic getUserMedia delay in a real Chromium run.
  async start() {
    if (this.active) return;
    if (this._starting) return this._starting;
    this._starting = this._doStart();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _doStart() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor();
    try {
      // Disable all voice processing: it suppresses exactly the narrow-band
      // ultrasonic-adjacent signal we depend on. The standard constraints
      // alone are frequently NOT fully honored, especially on Android
      // Chrome, where the mic can still get routed through an OS/driver
      // voice-call audio path that applies its own noise suppression
      // upstream of anything the page can see or control — and a steady
      // narrow-band tone with no speech formants is exactly what
      // voice-tuned noise suppression is designed to remove, which reads
      // as "no signal at all, even very close" rather than a weak one.
      // The legacy "goog*" constraints are non-standard but still honored
      // by Chromium and give a real shot at a truly raw/unprocessed input;
      // unsupported constraint keys are required by spec to be ignored, so
      // this is safe on browsers (like Safari) that don't recognize them.
      // The sampleRate hint nudges away from a lower-bandwidth voice-
      // optimized capture path that would filter out everything above
      // roughly its own Nyquist before it's even digitized.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: { ideal: 48000 },
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
          googTypingNoiseDetection: false,
        },
      });
    } catch (err) {
      await this.stop();
      const e = new Error('mic_denied');
      e.cause = err;
      throw e;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    try { this.trackSettings = this.stream.getAudioTracks()[0]?.getSettings() || null; }
    catch { this.trackSettings = null; }

    const src = this.ctx.createMediaStreamSource(this.stream);

    // Fallback path: always set up (cheap), used directly if the worklet
    // fails to load, and otherwise idle.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

    try {
      await this.ctx.audioWorklet.addModule('/js/ranging-worklet.js');
      this.worklet = new AudioWorkletNode(this.ctx, 'ranging-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      src.connect(this.worklet);
      // A worklet with no live downstream consumer can get starved of
      // process() calls in some engines; route through a silent gain so
      // the graph stays "active" without the user hearing anything.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.worklet.connect(sink).connect(this.ctx.destination);

      this.worklet.port.onmessage = (event) => {
        const msg = event.data;
        if (msg.t === 'cross' && this.onDetect) this.onDetect(msg.freqIndex, msg.time, msg.mag);
        else if (msg.t === 'levels' && this.onWorkletLevels) this.onWorkletLevels(msg);
      };
      this.workletReady = true;
    } catch {
      this.workletReady = false; // ranging.js falls back to rAF + analyser
    }
  }

  async stop() {
    if (this.worklet) {
      try { this.worklet.port.onmessage = null; this.worklet.disconnect(); } catch { /* already gone */ }
      this.worklet = null;
    }
    this.workletReady = false;
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

  configureWorklet({ freqs, mode, manualThreshold }) {
    if (!this.worklet) return;
    this.worklet.port.postMessage({ t: 'config', freqs, mode, manualThreshold });
  }

  // --- Fallback path (AnalyserNode + polling) ---

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

  // --- Playback (shared by both paths) ---

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
