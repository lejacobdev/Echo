// Round-trip chirp ranging: protocol state machine + pure math helpers.
// The pure functions carry no DOM/audio dependencies and are unit-tested in node.

export const SPEED_OF_SOUND = 343; // m/s
export const CHANNELS = {
  A: { seek: 19000, reply: 20000 },
  B: { seek: 17500, reply: 18500 },
  // Deliberately audible (not near-ultrasonic) and well inside the range
  // every phone mic/speaker reproduces cleanly. Not for real use — it's a
  // diagnostic: if two devices still can't hear each other on C, the
  // problem isn't hardware high-frequency rolloff and lies elsewhere in
  // the protocol/environment; if C works but A/B don't, the phones'
  // mic/speaker response above ~18kHz is the culprit.
  C: { seek: 12500, reply: 13500 },
};

// Fixed index order the worklet/fallback path is always configured with —
// a Responder listens on *both* channels regardless of its own local
// "Frequency channel" setting, so it can never be silently deaf to a Seeker
// on a channel the two devices didn't happen to agree on. Only the Seeker's
// own channel choice determines which frequency it transmits/listens for a
// reply on; the Responder adapts to whichever one it actually hears.
export const FREQ_SLOTS = [
  { channel: 'A', kind: 'seek', freq: CHANNELS.A.seek },   // index 0
  { channel: 'A', kind: 'reply', freq: CHANNELS.A.reply }, // index 1
  { channel: 'B', kind: 'seek', freq: CHANNELS.B.seek },   // index 2
  { channel: 'B', kind: 'reply', freq: CHANNELS.B.reply }, // index 3
  { channel: 'C', kind: 'seek', freq: CHANNELS.C.seek },   // index 4
  { channel: 'C', kind: 'reply', freq: CHANNELS.C.reply }, // index 5
];

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
//
// Detection runs one of two ways:
//  - Worklet mode (engine.workletReady): the AudioWorklet in
//    ranging-worklet.js does the signal detection on the real-time audio
//    thread and posts 'cross' events timestamped in the AudioContext's own
//    clock (ctx.currentTime). ping() and the resulting RTT stay entirely in
//    that clock domain — no requestAnimationFrame involved in the timing at
//    all, which is what actually determines accuracy (rAF ticks are ~16ms
//    at best and can stretch to seconds when the tab backgrounds).
//  - Polling fallback (older browsers without AudioWorklet): the original
//    rAF + AnalyserNode loop, timestamped with performance.now().
// Both paths funnel into the same _settleReading/_settleTimeout, so ping(),
// calibrate() and the public callbacks behave identically either way.

const RESPONDER_DEBOUNCE_MS = 350;
const SEEKER_MIN_RTT_MS = 15;   // ignore triggers while our own chirp still rings
const SEEKER_TIMEOUT_MS = 2500;
const ADAPTIVE_MARGIN = 45;     // fallback-path trigger = noiseFloor + margin
const MIN_ADAPTIVE_THRESHOLD = 90;

export class RangingSession {
  /**
   * @param {import('./audio.js').AudioEngine} engine
   * @param {object} opts { channel, bidirectional, adaptive, manualThreshold,
   *                        onReading, onTimeout, onReply, onDebug, onCalibProgress }
   *
   * `bidirectional: true` (meetups) makes this device simultaneously Seek
   * on `channel` and Respond on the other channel, continuously — both
   * sides of a meetup get a live reading with nobody waiting passively.
   * `bidirectional: false` (default; Nearby mode) keeps the original
   * either/or behavior driven by `setRole()`, since Nearby mode has no
   * pairing channel to auto-assign complementary transmit channels and a
   * manual role pick is what prevents both devices pinging on the same
   * frequency and colliding.
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.role = 'seeker';
    this.bidirectional = opts.bidirectional === true;
    this.channel = opts.channel || 'A';
    this.adaptive = opts.adaptive !== false;
    this.manualThreshold = opts.manualThreshold || 165;
    this.calibrationOffset = 0;
    this.isCalibrated = false;
    this.cb = opts;

    this._raf = null;
    this._running = false;
    this._awaiting = false;
    this._pingStart = 0;        // performance.now() domain (fallback path)
    this._pingStartAudio = 0;   // ctx.currentTime domain (worklet path)
    this._lastReplyAt = -Infinity;      // performance.now() domain
    this._lastReplyAtAudio = -Infinity; // ctx.currentTime domain
    this.replyCount = 0;
    this.lastRtt = null;
    this._calibrating = false;
  }

  get freqs() { return CHANNELS[this.channel]; }
  // A/B swap only — bidirectional (meetup) sessions are always assigned A
  // or B by the server, never C. C is a Nearby-mode-only manual diagnostic
  // channel with no complementary-pair concept.
  get otherChannel() { return this.channel === 'A' ? 'B' : 'A'; }

  threshold(freq) {
    if (!this.adaptive) return this.manualThreshold;
    return Math.max(MIN_ADAPTIVE_THRESHOLD, this.engine.floorAt(freq) + ADAPTIVE_MARGIN);
  }

  setRole(role) {
    this.role = role;
    this._awaiting = false;
  }

  setChannel(channel) {
    // Only affects what a Seeker transmits/expects back — the worklet's
    // tracked frequency set is fixed (both channels, always) and doesn't
    // need reconfiguring when this changes.
    this.channel = channel;
  }

  _configureWorklet() {
    if (!this.engine.workletReady) return;
    this.engine.configureWorklet({
      freqs: FREQ_SLOTS.map((s) => s.freq),
      mode: this.adaptive ? 'adaptive' : 'manual',
      manualThreshold: this.manualThreshold,
    });
  }

  start() {
    if (this._running) return;
    this._running = true;

    if (this.engine.workletReady) {
      this._configureWorklet();
      this.engine.onDetect = (freqIndex, audioTime) => this._onWorkletCross(freqIndex, audioTime);
      this.engine.onWorkletLevels = (msg) => this._onWorkletLevels(msg);
      const loop = () => {
        if (!this._running) return;
        this._checkTimeout();
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    } else {
      const loop = () => {
        if (!this._running) return;
        this._tick();
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }
  }

  stop() {
    this._running = false;
    this._awaiting = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.engine.onDetect = null;
    this.engine.onWorkletLevels = null;
  }

  // Worklet path: only a coarse "gave up waiting" check runs on rAF —
  // it doesn't need tight precision, just to eventually notice a miss.
  _checkTimeout() {
    const iSeek = this.bidirectional || this.role === 'seeker';
    if (iSeek && this._awaiting) {
      if (performance.now() - this._pingStart > SEEKER_TIMEOUT_MS) {
        this._awaiting = false;
        this._settleTimeout();
      }
    }
  }

  _onWorkletLevels(msg) {
    if (!this.cb.onDebug) return;
    // Full state for both channels — not just "my channel" — so the debug
    // panel can show exactly what's arriving on the frequency a Responder
    // is supposed to be reacting to, not only what this device transmits.
    this.cb.onDebug({
      path: 'worklet',
      channel: this.channel,
      otherChannel: this.bidirectional ? this.otherChannel : null,
      mags: msg.mags,           // [A.seek, A.reply, B.seek, B.reply]
      thresholds: msg.thresholds,
    });
  }

  _replyOnAudio(channel, audioTime) {
    if (audioTime - this._lastReplyAtAudio > RESPONDER_DEBOUNCE_MS / 1000) {
      this._lastReplyAtAudio = audioTime;
      this.replyCount++;
      this.engine.playTone(CHANNELS[channel].reply);
      if (this.cb.onReply) this.cb.onReply(this.replyCount);
    }
  }

  _acceptReplyAudio(audioTime) {
    const elapsed = (audioTime - this._pingStartAudio) * 1000; // -> ms
    if (elapsed > SEEKER_MIN_RTT_MS) {
      this._awaiting = false;
      this.lastRtt = elapsed;
      this._settleReading(elapsed);
    }
  }

  // freqIndex indexes FREQ_SLOTS: 0/1 = channel A seek/reply, 2/3 = channel
  // B seek/reply.
  //  - Bidirectional (meetups): this device is always Seeking on `channel`
  //    and always Responding on `otherChannel`, simultaneously — the two
  //    devices' own outbound chirps live on different frequencies by
  //    construction, so there's no ambiguity about whose reply is whose.
  //  - Directional (Nearby mode): exactly one role is active for the whole
  //    session. A Responder reacts to a seek on *either* channel (so two
  //    devices with mismatched local settings still find each other) and a
  //    Seeker only accepts a reply on the channel it actually transmitted on.
  _onWorkletCross(freqIndex, audioTime) {
    const slot = FREQ_SLOTS[freqIndex];
    if (!slot) return;

    if (this.bidirectional) {
      if (slot.kind === 'seek' && slot.channel === this.otherChannel) {
        this._replyOnAudio(slot.channel, audioTime);
      } else if (this._awaiting && slot.kind === 'reply' && slot.channel === this.channel) {
        this._acceptReplyAudio(audioTime);
      }
      return;
    }

    if (this.role === 'responder' && slot.kind === 'seek') {
      this._replyOnAudio(slot.channel, audioTime);
    } else if (this.role === 'seeker' && this._awaiting && slot.kind === 'reply' && slot.channel === this.channel) {
      this._acceptReplyAudio(audioTime);
    }
  }

  _tick() {
    const { engine } = this;
    if (!engine.active) return;
    engine.capture();

    // Same "listen on both channels" as the worklet path — computed
    // unconditionally since both bidirectional and directional-Responder
    // modes need it.
    const mags = {};
    for (const slot of FREQ_SLOTS) {
      const m = engine.magAt(slot.freq);
      mags[`${slot.channel}${slot.kind}`] = m;
      engine.updateFloor(slot.freq, m);
    }
    const now = performance.now();

    const respondToChannel = this.bidirectional ? this.otherChannel : (this.role === 'responder' ? null : undefined);
    // null (directional responder) = try both; a channel letter = try only that one; undefined = don't respond at all.
    const candidates = respondToChannel === null ? ['A', 'B'] : respondToChannel ? [respondToChannel] : [];
    for (const ch of candidates) {
      const seekFreq = CHANNELS[ch].seek;
      if (mags[`${ch}seek`] > this.threshold(seekFreq) && now - this._lastReplyAt > RESPONDER_DEBOUNCE_MS) {
        this._lastReplyAt = now;
        this.replyCount++;
        engine.playTone(CHANNELS[ch].reply);
        if (this.cb.onReply) this.cb.onReply(this.replyCount);
        break; // one reply per tick even if both somehow spike at once
      }
    }

    const iSeek = this.bidirectional || this.role === 'seeker';
    if (iSeek && this._awaiting) {
      const { reply } = this.freqs; // only accept a reply on our own channel
      const myReplyMag = mags[`${this.channel}reply`];
      const elapsed = now - this._pingStart;
      if (myReplyMag > this.threshold(reply) && elapsed > SEEKER_MIN_RTT_MS) {
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
        path: 'fallback',
        channel: this.channel,
        otherChannel: this.bidirectional ? this.otherChannel : null,
        mags: FREQ_SLOTS.map((s) => mags[`${s.channel}${s.kind}`]),
        thresholds: FREQ_SLOTS.map((s) => Math.round(this.threshold(s.freq))),
      });
    }
  }

  ping() {
    if (!this.bidirectional && this.role !== 'seeker') return false;
    if (this._awaiting || !this.engine.active) return false;
    this._pingStart = performance.now();
    this._pingStartAudio = this.engine.currentAudioTime;
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
    if (!this.bidirectional && this.role !== 'seeker') throw new Error('only the seeker calibrates');
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
