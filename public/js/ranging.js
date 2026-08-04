// Round-trip chirp ranging: protocol state machine + pure math helpers.
// The pure functions carry no DOM/audio dependencies and are unit-tested in node.

export const SPEED_OF_SOUND = 343; // m/s
export const CHANNELS = {
  A: { seek: 19000, reply: 20000 },
  B: { seek: 17500, reply: 18500 },
};

export function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// RTT (ms) minus calibration offset -> one-way meters. Clamped at 0.
export function distanceFromRtt(rttMs, offsetMs) {
  const adjusted = Math.max(0, rttMs - offsetMs);
  return (adjusted / 1000) * SPEED_OF_SOUND / 2;
}

// A channel is usable only if the mic can sample its reply frequency
// (Nyquist with a safety margin for FFT bin edges).
export function channelUsable(channel, sampleRate) {
  return sampleRate / 2 > CHANNELS[channel].reply + 500;
}

export function pickChannel(preferred, sampleRate) {
  if (channelUsable(preferred, sampleRate)) return preferred;
  const fallback = preferred === 'A' ? 'B' : 'A';
  if (channelUsable(fallback, sampleRate)) return fallback;
  return null;
}

export function proximityBand(meters) {
  if (meters < 2) return 'veryClose';
  if (meters < 5) return 'close';
  if (meters < 12) return 'inRange';
  return 'far';
}

// Rolling smoother: median of recent readings + light EMA on top.
export function createSmoother(windowSize = 5, alpha = 0.45) {
  const window = [];
  let ema = null;
  return {
    push(value) {
      window.push(value);
      if (window.length > windowSize) window.shift();
      const med = median(window);
      ema = ema === null ? med : ema + alpha * (med - ema);
      return ema;
    },
    reset() { window.length = 0; ema = null; },
    get value() { return ema; },
  };
}

// ---- Protocol session (browser-only from here down) ----

const RESPONDER_DEBOUNCE_MS = 350;
const SEEKER_MIN_RTT_MS = 15;   // ignore triggers while our own chirp still rings
const SEEKER_TIMEOUT_MS = 2500;
const ADAPTIVE_MARGIN = 45;     // trigger = noiseFloor + margin
const MIN_ADAPTIVE_THRESHOLD = 90;

export class RangingSession {
  /**
   * @param {import('./audio.js').AudioEngine} engine
   * @param {object} opts { channel, adaptive, manualThreshold, onReading, onTimeout,
   *                        onReply, onDebug, onCalibProgress }
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.role = 'seeker';
    this.channel = opts.channel || 'A';
    this.adaptive = opts.adaptive !== false;
    this.manualThreshold = opts.manualThreshold || 165;
    this.calibrationOffset = 0;
    this.isCalibrated = false;
    this.cb = opts;

    this._raf = null;
    this._running = false;
    this._awaiting = false;
    this._pingStart = 0;
    this._lastReplyAt = -Infinity;
    this.replyCount = 0;
    this.lastRtt = null;
    this._calibrating = false;
  }

  get freqs() { return CHANNELS[this.channel]; }

  threshold(freq) {
    if (!this.adaptive) return this.manualThreshold;
    return Math.max(MIN_ADAPTIVE_THRESHOLD, this.engine.floorAt(freq) + ADAPTIVE_MARGIN);
  }

  setRole(role) {
    this.role = role;
    this._awaiting = false;
  }

  setChannel(channel) {
    this.channel = channel;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._tick();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    this._awaiting = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _tick() {
    const { engine } = this;
    if (!engine.active) return;
    engine.capture();
    const { seek, reply } = this.freqs;
    const magSeek = engine.magAt(seek);
    const magReply = engine.magAt(reply);
    engine.updateFloor(seek, magSeek);
    engine.updateFloor(reply, magReply);
    const now = performance.now();

    if (this.role === 'responder') {
      if (magSeek > this.threshold(seek) && now - this._lastReplyAt > RESPONDER_DEBOUNCE_MS) {
        this._lastReplyAt = now;
        this.replyCount++;
        engine.playTone(reply);
        if (this.cb.onReply) this.cb.onReply(this.replyCount);
      }
    } else if (this._awaiting) {
      const elapsed = now - this._pingStart;
      if (magReply > this.threshold(reply) && elapsed > SEEKER_MIN_RTT_MS) {
        this._awaiting = false;
        this.lastRtt = elapsed;
        this._settleReading(elapsed);
      } else if (elapsed > SEEKER_TIMEOUT_MS) {
        this._awaiting = false;
        this._settleTimeout();
      }
    }

    if (this.cb.onDebug) {
      this.cb.onDebug({
        magSeek, magReply,
        floorSeek: Math.round(engine.floorAt(seek)),
        floorReply: Math.round(engine.floorAt(reply)),
        threshold: Math.round(this.threshold(reply)),
      });
    }
  }

  ping() {
    if (this.role !== 'seeker' || this._awaiting || !this.engine.active) return false;
    this._pingStart = performance.now();
    this._awaiting = true;
    this.engine.playTone(this.freqs.seek);
    return true;
  }

  _settleReading(rtt) {
    if (this._calibrating) {
      this._calibResolve?.(rtt);
    } else if (this.cb.onReading) {
      this.cb.onReading(rtt, distanceFromRtt(rtt, this.calibrationOffset));
    }
  }

  _settleTimeout() {
    if (this._calibrating) this._calibResolve?.(null);
    else if (this.cb.onTimeout) this.cb.onTimeout();
  }

  // Run `rounds` pings at distance zero; median of successes becomes the offset.
  async calibrate(rounds = 5) {
    if (this.role !== 'seeker') throw new Error('only the seeker calibrates');
    this._calibrating = true;
    const results = [];
    try {
      for (let i = 0; i < rounds; i++) {
        const rtt = await new Promise((resolve) => {
          this._calibResolve = resolve;
          if (!this.ping()) resolve(null);
        });
        results.push(rtt);
        if (this.cb.onCalibProgress) this.cb.onCalibProgress(i + 1, rtt !== null);
        await new Promise((r) => setTimeout(r, 450)); // let reverb die down
      }
    } finally {
      this._calibrating = false;
      this._calibResolve = null;
    }
    const successes = results.filter((r) => r !== null);
    if (successes.length < 3) return { ok: false, successes: successes.length };
    this.calibrationOffset = median(successes);
    this.isCalibrated = true;
    return { ok: true, offset: this.calibrationOffset, successes: successes.length };
  }
}
