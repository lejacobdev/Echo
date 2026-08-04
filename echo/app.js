/*
 * Echo — sound-based precision meetup finder.
 * Round-trip ultrasonic chirp ranging between two browsers. No backend,
 * no persisted state: calibration and role live only in memory for this
 * page's session, by design (see README "Known limitations").
 */
(() => {
  'use strict';

  // ---- Protocol constants ----------------------------------------------
  const SEEK_FREQ = 19000;      // Hz — Seeker's outbound chirp
  const RESPOND_FREQ = 20000;   // Hz — Responder's reply chirp
  const TONE_DURATION = 0.08;   // seconds
  const TONE_ENVELOPE = 0.005;  // seconds fade-in/out, avoids clicks
  const SPEED_OF_SOUND = 343;   // m/s
  const RESPONDER_DEBOUNCE_MS = 300; // ignore re-triggers after replying
  const SEEKER_MIN_RTT_MS = 3;       // ignore implausibly-instant "replies"
  const SEEKER_TIMEOUT_MS = 2000;    // give up waiting for a reply
  const FFT_SIZE = 4096;
  const DEBUG_UI_INTERVAL_MS = 120;  // throttle debug panel repaint

  // ---- Session state (memory-only, never persisted) ----------------------
  const state = {
    role: null,               // 'seeker' | 'responder'
    audioCtx: null,
    micStream: null,
    analyser: null,
    dataArray: null,
    listening: false,
    rafId: null,
    calibrationOffset: 0,     // ms
    isCalibrated: false,
    pingMode: null,           // 'calibrate' | 'measure'
    pingStartTime: null,
    awaitingReply: false,
    lastResponderReplyTime: -Infinity,
    responderReplyCount: 0,
    detectionThreshold: 165,  // 0-255, tune with the debug slider
    lastRtt: null,
    lastDebugPaint: 0,
  };

  // ---- DOM handles ---------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    activityBanner: $('activity-banner'),
    activityText: $('activity-text'),
    stageUnsupported: $('stage-unsupported'),
    stageDenied: $('stage-denied'),
    stageRole: $('stage-role'),
    stageSeeker: $('stage-seeker'),
    stageResponder: $('stage-responder'),
    retryPermission: $('retry-permission'),
    roleSeekerBtn: $('role-seeker'),
    roleResponderBtn: $('role-responder'),
    btnCalibrate: $('btn-calibrate'),
    calibrationStatus: $('calibration-status'),
    btnPing: $('btn-ping'),
    pingVisual: $('ping-visual'),
    responderVisual: $('responder-visual'),
    distanceValue: $('distance-value'),
    distanceLabel: $('distance-label'),
    responderReplyCount: $('responder-reply-count'),
    seekerSwitchRole: $('seeker-switch-role'),
    responderSwitchRole: $('responder-switch-role'),
    debugToggle: $('debug-toggle'),
    debugPanel: $('debug-panel'),
    dbgRole: $('dbg-role'),
    dbgSampleRate: $('dbg-samplerate'),
    dbgRtt: $('dbg-rtt'),
    dbgOffset: $('dbg-offset'),
    dbgMag19: $('dbg-mag19'),
    dbgMag20: $('dbg-mag20'),
    dbgThreshold: $('dbg-threshold'),
    dbgThresholdVal: $('dbg-threshold-val'),
    debugStopSession: $('debug-stop-session'),
  };

  // ---- Feature detection ------------------------------------------------
  function isSupported() {
    return !!(
      (window.AudioContext || window.webkitAudioContext) &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia
    );
  }

  function showStage(stage) {
    [el.stageUnsupported, el.stageDenied, el.stageRole, el.stageSeeker, el.stageResponder]
      .forEach((s) => s.classList.add('hidden'));
    stage.classList.remove('hidden');
  }

  // ---- Audio setup --------------------------------------------------
  async function ensureAudio() {
    if (state.audioCtx && state.micStream) return true;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AudioContextCtor();

    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      showStage(el.stageDenied);
      return false;
    }

    if (state.audioCtx.state === 'suspended') {
      await state.audioCtx.resume();
    }

    const micSource = state.audioCtx.createMediaStreamSource(state.micStream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = FFT_SIZE;
    state.analyser.smoothingTimeConstant = 0;
    micSource.connect(state.analyser);
    state.dataArray = new Uint8Array(state.analyser.frequencyBinCount);

    el.dbgSampleRate.textContent = `${state.audioCtx.sampleRate} Hz`;

    state.listening = true;
    setActivityBanner(true);
    startDetectionLoop();
    return true;
  }

  function stopAudioSession() {
    state.listening = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
      state.micStream = null;
    }
    if (state.audioCtx) {
      state.audioCtx.close();
      state.audioCtx = null;
    }
    state.analyser = null;
    setActivityBanner(false);
  }

  function setActivityBanner(active) {
    el.activityBanner.classList.toggle('hidden', false);
    el.activityBanner.classList.toggle('active', active);
    el.activityText.textContent = active
      ? '🎙️ Microphone listening · 🔊 Speaker armed'
      : 'Microphone & speaker inactive';
  }

  // ---- Tone playback ------------------------------------------------
  function playTone(freq) {
    const ctx = state.audioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + TONE_ENVELOPE);
    gain.gain.setValueAtTime(1, now + TONE_DURATION - TONE_ENVELOPE);
    gain.gain.linearRampToValueAtTime(0, now + TONE_DURATION);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + TONE_DURATION + 0.02);
  }

  // ---- Frequency-bin magnitude lookup --------------------------------
  function magnitudeAt(freq) {
    const sampleRate = state.audioCtx.sampleRate;
    const binHz = sampleRate / state.analyser.fftSize;
    const centerBin = Math.round(freq / binHz);
    let max = 0;
    for (let b = centerBin - 1; b <= centerBin + 1; b++) {
      if (b >= 0 && b < state.dataArray.length) {
        max = Math.max(max, state.dataArray[b]);
      }
    }
    return max;
  }

  // ---- Detection loop (runs for both roles while listening) ---------
  function startDetectionLoop() {
    const loop = () => {
      if (!state.listening) return;
      state.analyser.getByteFrequencyData(state.dataArray);

      const mag19 = magnitudeAt(SEEK_FREQ);
      const mag20 = magnitudeAt(RESPOND_FREQ);
      const now = performance.now();

      if (state.role === 'responder') {
        if (
          mag19 > state.detectionThreshold &&
          now - state.lastResponderReplyTime > RESPONDER_DEBOUNCE_MS
        ) {
          state.lastResponderReplyTime = now;
          state.responderReplyCount += 1;
          playTone(RESPOND_FREQ);
          flashPingVisual(el.responderVisual, 'reply');
          el.responderReplyCount.textContent = String(state.responderReplyCount);
        }
      } else if (state.role === 'seeker' && state.awaitingReply) {
        const elapsed = now - state.pingStartTime;
        if (mag20 > state.detectionThreshold && elapsed > SEEKER_MIN_RTT_MS) {
          state.awaitingReply = false;
          handleRttResult(elapsed);
        } else if (elapsed > SEEKER_TIMEOUT_MS) {
          state.awaitingReply = false;
          handlePingTimeout();
        }
      }

      paintDebug(mag19, mag20, now);
      state.rafId = requestAnimationFrame(loop);
    };
    state.rafId = requestAnimationFrame(loop);
  }

  function paintDebug(mag19, mag20, now) {
    if (now - state.lastDebugPaint < DEBUG_UI_INTERVAL_MS) return;
    state.lastDebugPaint = now;
    el.dbgMag19.textContent = String(mag19);
    el.dbgMag20.textContent = String(mag20);
  }

  // ---- Seeker actions -------------------------------------------------
  function startPing(mode) {
    state.pingMode = mode;
    state.pingStartTime = performance.now();
    state.awaitingReply = true;
    playTone(SEEK_FREQ);
    flashPingVisual(el.pingVisual, 'ping');
  }

  function handleRttResult(rtt) {
    state.lastRtt = rtt;
    el.dbgRtt.textContent = `${rtt.toFixed(1)} ms`;

    if (state.pingMode === 'calibrate') {
      state.calibrationOffset = rtt;
      state.isCalibrated = true;
      el.dbgOffset.textContent = `${rtt.toFixed(1)} ms`;
      el.calibrationStatus.textContent = `Calibrated (offset ${rtt.toFixed(1)} ms)`;
      el.calibrationStatus.classList.add('ok');
      el.btnPing.disabled = false;
      el.distanceLabel.textContent = 'Calibrated — tap Ping to find your friend';
    } else {
      const adjusted = Math.max(0, rtt - state.calibrationOffset);
      const distanceMeters = (adjusted / 1000) * SPEED_OF_SOUND / 2;
      el.distanceValue.textContent = `${distanceMeters.toFixed(1)} m`;
      el.distanceLabel.textContent = state.isCalibrated
        ? 'Live distance — tap Ping again to refresh'
        : 'Not calibrated — this is a rough estimate';
    }
  }

  function handlePingTimeout() {
    if (state.pingMode === 'calibrate') {
      el.calibrationStatus.textContent = 'No reply heard — make sure the other phone is set to Responder, then try again';
    } else {
      el.distanceLabel.textContent = 'No reply heard — out of range, or the Responder is not listening';
    }
  }

  // ---- Ping ring animation -------------------------------------------
  function flashPingVisual(container, kind) {
    const ring = document.createElement('div');
    ring.className = 'ping-ring' + (kind === 'reply' ? ' reply' : '');
    container.appendChild(ring);
    ring.addEventListener('animationend', () => ring.remove());
  }

  // ---- Role selection --------------------------------------------------
  async function selectRole(role) {
    const ok = await ensureAudio();
    if (!ok) return;

    state.role = role;
    el.dbgRole.textContent = role;

    if (role === 'seeker') {
      showStage(el.stageSeeker);
    } else {
      showStage(el.stageResponder);
    }
  }

  function switchRole() {
    state.role = null;
    state.awaitingReply = false;
    showStage(el.stageRole);
  }

  // ---- Wire up UI --------------------------------------------------
  function init() {
    if (!isSupported()) {
      showStage(el.stageUnsupported);
      return;
    }

    el.roleSeekerBtn.addEventListener('click', () => selectRole('seeker'));
    el.roleResponderBtn.addEventListener('click', () => selectRole('responder'));
    el.retryPermission.addEventListener('click', () => {
      showStage(el.stageRole);
    });

    el.btnCalibrate.addEventListener('click', () => startPing('calibrate'));
    el.btnPing.addEventListener('click', () => startPing('measure'));

    el.seekerSwitchRole.addEventListener('click', switchRole);
    el.responderSwitchRole.addEventListener('click', switchRole);

    el.debugToggle.addEventListener('click', () => {
      el.debugPanel.classList.toggle('hidden');
    });

    el.dbgThreshold.addEventListener('input', (e) => {
      state.detectionThreshold = Number(e.target.value);
      el.dbgThresholdVal.textContent = e.target.value;
    });

    el.debugStopSession.addEventListener('click', () => {
      stopAudioSession();
      switchRole();
    });

    showStage(el.stageRole);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
