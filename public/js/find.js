// Find session controller: drives the acoustic engine + dial UI for both
// local (offline, manual roles) and meetup (server-coordinated) modes.
import { t } from './i18n.js';
import { connectWs } from './net.js';
import { RangingSession, createSmoother, proximityBand, pickChannel, CHANNELS } from './ranging.js';
import { qrSvg } from './qr.js';
import { haversineDistance, bearing, compassLabel, combineAccuracy, shouldSuggestAcoustic } from './geo.js';

const DIAL_CIRCUMFERENCE = 2 * Math.PI * 88;
const AUTO_PING_MS = 1600;
const QUICK_KEYS = ['quick.here', 'quick.omw', 'quick.stay', 'quick.entrance', 'quick.twomin'];
const GPS_SEND_MIN_INTERVAL_MS = 2500;
const GPS_SUGGEST_THRESHOLD_M = 15;

const state = {
  active: false,
  mode: null,          // 'local' | 'meetup'
  code: null,
  ws: null,
  session: null,
  smoother: createSmoother(),
  autoTimer: null,
  autoOn: false,
  prevSmoothed: null,
  wakeLock: null,
  peer: null,
  foundShown: false,
  leaving: false,
  gps: {
    watchId: null,
    enabled: false,
    selfFix: null,       // { lat, lon, accuracy }
    peerFix: null,       // { lat, lon, accuracy }
    deviceHeading: null, // degrees, true north, or null if no compass
    lastSentAt: 0,
    orientationHandler: null,
  },
};

function $(id) { return document.getElementById(id); }

// ---------- UI helpers ----------

function setDial(meters) {
  $('dial-distance').textContent = `${meters.toFixed(1)} m`;
  const band = proximityBand(meters);
  $('dial-band').textContent = t(`find.band.${band}`);
  const closeness = Math.max(0, Math.min(1, 1 - meters / 15));
  const fill = $('dial-progress');
  fill.style.visibility = 'visible';
  fill.style.strokeDashoffset = String(DIAL_CIRCUMFERENCE * (1 - closeness));
  fill.style.stroke = band === 'veryClose' ? 'var(--ok)' : band === 'far' ? 'var(--blue)' : 'var(--accent)';

  if (state.prevSmoothed !== null && Math.abs(meters - state.prevSmoothed) > 0.15) {
    const warmer = meters < state.prevSmoothed;
    const trend = $('dial-trend');
    trend.textContent = warmer ? t('find.warmer') : t('find.colder');
    trend.className = `dial-trend ${warmer ? 'trend-warmer' : 'trend-colder'}`;
  }
  state.prevSmoothed = meters;
}

function pulseDial() {
  const g = $('dial-pulse');
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('cx', '100');
  ring.setAttribute('cy', '100');
  ring.setAttribute('r', '88');
  g.appendChild(ring);
  ring.addEventListener('animationend', () => ring.remove());
  setTimeout(() => ring.remove(), 1500); // reduced-motion fallback
}

function haptic(pattern) {
  if (state.ctx?.settings.haptics && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* unsupported */ }
  }
}

function applyRoleUi(role) {
  $('find-role-name').textContent = t(role === 'seeker' ? 'role.seeker' : 'role.responder');
  $('seeker-controls').classList.toggle('hidden', role !== 'seeker');
  $('responder-panel').classList.toggle('hidden', role !== 'responder');
  const dialCenter = $('dial-distance');
  if (role === 'responder' && state.mode === 'local') dialCenter.textContent = '👂';
  $('find-hint').textContent = role === 'seeker'
    ? t(state.session?.isCalibrated ? 'find.readyHint' : 'find.calibrateHint')
    : t('find.responderHint');
  $('role-btn-seeker').classList.toggle('active', role === 'seeker');
  $('role-btn-responder').classList.toggle('active', role !== 'seeker');
  if (role !== 'seeker') stopAutoPing();
}

function setConn(textKey, live) {
  const pill = $('find-conn');
  pill.classList.remove('hidden');
  pill.className = `pill ${live ? 'pill-live' : 'pill-warn'}`;
  $('find-conn-text').textContent = t(textKey);
}

// ---------- Auto ping ----------

function startAutoPing() {
  if (state.autoTimer) return;
  state.autoOn = true;
  $('btn-autoping').setAttribute('aria-pressed', 'true');
  state.autoTimer = setInterval(() => {
    if (!document.hidden) state.session?.ping() && pulseDial();
  }, AUTO_PING_MS);
  state.session?.ping() && pulseDial();
}

function stopAutoPing() {
  state.autoOn = false;
  $('btn-autoping').setAttribute('aria-pressed', 'false');
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
}

// ---------- Wake lock ----------

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* denied or unsupported: fine */ }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (!state.active) return;
  if (!document.hidden && !state.wakeLock) acquireWakeLock();
});

// ---------- GPS long-range phase (meetup mode only) ----------

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function setGpsStatus(key, live) {
  const pill = $('gps-status');
  pill.className = `pill ${live ? 'pill-live' : 'pill-idle'}`;
  $('gps-status-text').textContent = t(key);
}

function updateGpsUi() {
  const { selfFix, peerFix, deviceHeading } = state.gps;
  if (!selfFix) return;
  if (!peerFix) { setGpsStatus('gps.selfOnly', false); return; }

  const distance = haversineDistance(selfFix.lat, selfFix.lon, peerFix.lat, peerFix.lon);
  const combinedAcc = combineAccuracy(selfFix.accuracy, peerFix.accuracy);
  const toPeer = bearing(selfFix.lat, selfFix.lon, peerFix.lat, peerFix.lon);

  setGpsStatus('gps.live', true);
  $('gps-distance').textContent = formatDistance(distance);
  $('gps-accuracy').textContent =
    `${compassLabel(toPeer)} · ± ${Math.round(combinedAcc)} m ${t('gps.accuracyLabel')}`;

  const rotate = deviceHeading === null ? toPeer : toPeer - deviceHeading;
  $('compass-arrow').style.transform = `rotate(${rotate}deg)`;
  $('gps-heading-note').classList.toggle('hidden', deviceHeading !== null);

  const suggest = shouldSuggestAcoustic(distance, combinedAcc, GPS_SUGGEST_THRESHOLD_M);
  $('gps-suggest').classList.toggle('hidden', !suggest);
}

function handleOrientation(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === 'number') {
    heading = event.webkitCompassHeading; // iOS Safari: already true-north heading
  } else if (event.absolute && typeof event.alpha === 'number') {
    heading = (360 - event.alpha) % 360; // standard AbsoluteOrientation convention
  }
  if (heading === null) return;
  state.gps.deviceHeading = heading;
  updateGpsUi();
}

async function enableGps(ctx) {
  if (!('geolocation' in navigator)) return;
  state.gps.enabled = true;
  setGpsStatus('gps.searching', false);
  $('gps-enable-row').classList.add('hidden');
  $('gps-denied').classList.add('hidden');
  $('gps-live').classList.remove('hidden');

  // iOS gates DeviceOrientationEvent behind an explicit, gesture-synchronous
  // request; call it before anything async so the gesture is still "fresh".
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm === 'granted') window.addEventListener('deviceorientation', handleOrientation);
    } catch { /* denied or unsupported: falls back to north-up */ }
  } else {
    window.addEventListener('deviceorientationabsolute', handleOrientation);
    window.addEventListener('deviceorientation', handleOrientation);
  }
  state.gps.orientationHandler = handleOrientation;

  state.gps.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const fix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy || 50,
      };
      state.gps.selfFix = fix;
      updateGpsUi();

      const now = performance.now();
      if (state.mode === 'meetup' && state.ws && now - state.gps.lastSentAt > GPS_SEND_MIN_INTERVAL_MS) {
        state.gps.lastSentAt = now;
        state.ws.send({ t: 'gps', lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy });
      }
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        $('gps-live').classList.add('hidden');
        $('gps-denied').classList.remove('hidden');
        setGpsStatus('gps.off', false);
        state.gps.enabled = false;
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function resetGps() {
  if (state.gps.watchId !== null) navigator.geolocation.clearWatch(state.gps.watchId);
  if (state.gps.orientationHandler) {
    window.removeEventListener('deviceorientation', state.gps.orientationHandler);
    window.removeEventListener('deviceorientationabsolute', state.gps.orientationHandler);
  }
  state.gps = {
    watchId: null, enabled: false, selfFix: null, peerFix: null,
    deviceHeading: null, lastSentAt: 0, orientationHandler: null,
  };
  $('gps-enable-row').classList.remove('hidden');
  $('gps-live').classList.add('hidden');
  $('gps-denied').classList.add('hidden');
  $('gps-suggest').classList.add('hidden');
  $('gps-heading-note').classList.add('hidden');
  setGpsStatus('gps.off', false);
}

// ---------- Audio bootstrap ----------

async function startEngine(ctx) {
  if (ctx.engine.active) return true;
  try {
    await ctx.engine.start();
  } catch {
    ctx.setActivity('denied');
    $('find-hint').textContent = t('find.micNeeded');
    ctx.toast(t('find.micNeeded'), 'warn', 5000);
    return false;
  }
  ctx.setActivity('listening');
  $('dbg-samplerate').textContent = `${ctx.engine.sampleRate} Hz`;

  const preferred = ctx.settings.channel;
  const usable = pickChannel(preferred, ctx.engine.sampleRate);
  if (usable && usable !== preferred) {
    ctx.toast(t('find.lowSampleRate'), 'warn', 5000);
    state.session.setChannel(usable);
  } else if (usable) {
    state.session.setChannel(usable);
  }
  $('dbg-channel').textContent =
    `${state.session.channel} (${CHANNELS[state.session.channel].seek / 1000}/${CHANNELS[state.session.channel].reply / 1000} kHz)`;
  state.session.start();

  if (/iPhone|iPad/.test(navigator.userAgent)) ctx.toast(t('find.silentModeHint'), 'info', 6000);
  return true;
}

// ---------- Calibration ----------

function openCalibOverlay(ctx) {
  const overlay = $('calib-overlay');
  overlay.classList.remove('hidden');
  $('calib-step').textContent = t('calib.hold');
  const dots = $('calib-progress');
  dots.classList.add('hidden');
  for (const d of dots.children) d.className = '';
  $('calib-start').disabled = false;
  $('calib-start').classList.remove('hidden');

  $('calib-cancel').onclick = () => overlay.classList.add('hidden');
  $('calib-start').onclick = async () => {
    if (!(await startEngine(ctx))) return;
    $('calib-start').disabled = true;
    $('calib-step').textContent = t('calib.running');
    dots.classList.remove('hidden');
    state.session.cb.onCalibProgress = (i, ok) => {
      dots.children[i - 1].className = ok ? 'done' : 'fail';
    };
    const result = await state.session.calibrate(5);
    if (result.ok) {
      $('calib-step').textContent = t('calib.done');
      $('dbg-offset').textContent = `${result.offset.toFixed(1)} ms`;
      $('btn-ping').disabled = false;
      $('btn-autoping').disabled = false;
      $('find-hint').textContent = t('find.readyHint');
      $('dial-band').textContent = t('find.readyHint');
      haptic([40, 60, 40]);
      setTimeout(() => overlay.classList.add('hidden'), 900);
    } else {
      $('calib-step').textContent = t('calib.failed');
      $('calib-start').disabled = false;
    }
  };
}

// ---------- Meetup socket ----------

function connectRoom(ctx) {
  const params = { code: state.code };
  if (state.ctx.guestToken) params.token = state.ctx.guestToken;

  state.ws = connectWs(params, {
    onOpen() { setConn('find.meetup', true); },
    onClose() { if (!state.leaving) setConn('find.peerLeft', false); },
    onGone() { if (!state.leaving) { ctx.toast(t('err.network'), 'error'); ctx.navigate('#/'); } },
    onMessage(msg) {
      switch (msg.t) {
        case 'joined':
          state.session.setRole(msg.self.role);
          applyRoleUi(msg.self.role);
          if (msg.peer) setPeer(msg.peer);
          else {
            $('find-share-card').classList.remove('hidden');
            renderShareCard(ctx);
          }
          break;
        case 'peer-joined':
          setPeer(msg.peer);
          haptic([30]);
          break;
        case 'peer-left':
          state.peer = null;
          $('find-peer').textContent = t('find.peerLeft');
          $('btn-found').classList.add('hidden');
          break;
        case 'roles':
          state.session.setRole(msg.self);
          applyRoleUi(msg.self);
          break;
        case 'reading':
          // Peer (seeker) shares its computed distance so both screens agree.
          if (state.session.role === 'responder' && Number.isFinite(msg.distance)) {
            setDial(msg.distance);
          }
          break;
        case 'quick':
          ctx.toast(`${msg.from}: ${msg.text}`, 'info', 4000);
          haptic([20, 40, 20]);
          break;
        case 'gps':
          state.gps.peerFix = { lat: msg.lat, lon: msg.lon, accuracy: msg.accuracy };
          updateGpsUi();
          break;
        case 'found':
          state.foundShown = true;
          showFoundModal(ctx);
          break;
        case 'ended':
          if (!state.leaving && !state.foundShown) {
            ctx.toast(t('session.ended'));
            ctx.navigate('#/');
          }
          break;
        case 'error': {
          const key = `err.${msg.error === 'meetup_full' ? 'meetup_full' : 'meetup_not_found'}`;
          ctx.toast(t(key), 'error');
          ctx.navigate('#/');
          break;
        }
      }
    },
  });
}

function setPeer(peer) {
  state.peer = peer;
  $('find-peer').textContent = `${peer.emoji || '👤'} ${peer.name} — ${t('find.peerJoined')}`;
  $('find-share-card').classList.add('hidden');
  $('btn-found').classList.remove('hidden');
}

function renderShareCard(ctx) {
  $('find-code').textContent = state.code;
  const link = `${location.origin}/j/${state.code}`;
  const qrBox = $('find-qr');
  try { qrBox.innerHTML = qrSvg(link); } catch { qrBox.textContent = link; }

  $('btn-copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      ctx.toast(t('find.copied'));
    } catch { ctx.toast(link, 'info', 6000); }
  };
  const shareBtn = $('btn-share-link');
  if (navigator.share) {
    shareBtn.classList.remove('hidden');
    shareBtn.onclick = () => navigator.share({ title: 'Echo', text: `Echo: ${state.code}`, url: link }).catch(() => {});
  } else {
    shareBtn.classList.add('hidden');
  }
}

function showFoundModal(ctx) {
  haptic([60, 80, 60, 80, 120]);
  $('modal-backdrop').classList.remove('hidden');
  $('modal-found').classList.remove('hidden');
  $('found-close').onclick = () => {
    $('modal-backdrop').classList.add('hidden');
    $('modal-found').classList.add('hidden');
    ctx.navigate('#/');
  };
}

// ---------- Enter / leave ----------

export async function enterFind(ctx, opts) {
  state.ctx = ctx;
  state.active = true;
  state.leaving = false;
  state.mode = opts.mode;
  state.code = opts.code || null;
  state.peer = null;
  state.foundShown = false;
  state.prevSmoothed = null;
  state.smoother.reset();

  // Reset UI
  $('dial-distance').textContent = '—';
  $('dial-band').textContent = t('find.pressPing');
  $('dial-trend').textContent = '';
  $('dial-progress').style.strokeDashoffset = String(DIAL_CIRCUMFERENCE);
  $('dial-progress').style.visibility = 'hidden'; // round linecap draws a dot at zero length
  $('btn-ping').disabled = true;
  $('btn-autoping').disabled = true;
  $('reply-count').textContent = '0';
  $('dbg-rtt').textContent = '—';
  $('dbg-offset').textContent = '—';
  $('find-share-card').classList.add('hidden');
  $('btn-found').classList.add('hidden');
  $('debug').classList.toggle('hidden', !ctx.settings.debug);

  const isMeetup = state.mode === 'meetup';
  $('find-mode-label').textContent = t(isMeetup ? 'find.meetup' : 'find.local');
  $('find-peer').textContent = isMeetup ? t('find.waitingPeer') : '';
  $('find-conn').classList.toggle('hidden', !isMeetup);
  $('local-role-toggle').classList.toggle('hidden', isMeetup);
  $('btn-swap').classList.toggle('hidden', !isMeetup);
  $('quick-card').classList.toggle('hidden', !isMeetup);

  // GPS long-range phase only makes sense in meetup mode — it needs the
  // peer channel Nearby mode doesn't have.
  resetGps();
  const gpsAvailable = isMeetup && 'geolocation' in navigator;
  $('gps-card').classList.toggle('hidden', !gpsAvailable);
  $('precision-title').classList.toggle('hidden', !gpsAvailable);
  $('btn-gps-enable').onclick = () => enableGps(ctx);

  state.session = new RangingSession(ctx.engine, {
    channel: ctx.settings.channel,
    adaptive: ctx.settings.adaptive,
    manualThreshold: ctx.settings.threshold,
    onReading(rtt, distance) {
      const smoothed = state.smoother.push(distance);
      setDial(smoothed);
      $('dbg-rtt').textContent = `${rtt.toFixed(1)} ms`;
      const band = proximityBand(smoothed);
      haptic(band === 'veryClose' ? [30, 40, 30] : [15]);
      if (ctx.settings.soundFx) {
        ctx.engine.playTick(500 + Math.max(0, 15 - smoothed) * 60);
      }
      if (isMeetup && state.ws) {
        state.ws.send({ t: 'reading', rtt, distance: Math.round(smoothed * 10) / 10 });
      }
    },
    onTimeout() {
      $('dial-band').textContent = t('find.noReply');
    },
    onReply(count) {
      $('reply-count').textContent = String(count);
      if (ctx.settings.soundFx) ctx.engine.playTick(700);
      haptic([15]);
    },
    onDebug(d) {
      if (!ctx.settings.debug) return;
      $('dbg-mag-seek').textContent = String(d.magSeek);
      $('dbg-mag-reply').textContent = String(d.magReply);
      $('dbg-floor').textContent = `${d.floorSeek} / ${d.floorReply}`;
      $('dbg-threshold').textContent = String(d.threshold);
    },
  });

  // Wire controls (idempotent — plain assignment replaces old handlers)
  $('btn-calibrate').onclick = () => openCalibOverlay(ctx);
  $('btn-ping').onclick = async () => {
    if (await startEngine(ctx)) { state.session.ping() && pulseDial(); }
  };
  $('btn-autoping').onclick = async () => {
    if (state.autoOn) stopAutoPing();
    else if (await startEngine(ctx)) startAutoPing();
  };
  $('role-btn-seeker').onclick = () => { state.session.setRole('seeker'); applyRoleUi('seeker'); };
  $('role-btn-responder').onclick = async () => {
    if (await startEngine(ctx)) { state.session.setRole('responder'); applyRoleUi('responder'); }
  };
  $('btn-swap').onclick = () => state.ws?.send({ t: 'swap' });
  $('btn-found').onclick = () => state.ws?.send({ t: 'found' });
  $('btn-end').onclick = () => {
    if (isMeetup) state.ws?.send({ t: 'end' });
    ctx.navigate('#/');
  };

  const quickRow = $('quick-buttons');
  quickRow.innerHTML = '';
  for (const key of QUICK_KEYS) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline';
    btn.textContent = t(key);
    btn.onclick = () => { state.ws?.send({ t: 'quick', text: t(key) }); ctx.toast('✓', 'info', 900); };
    quickRow.appendChild(btn);
  }

  applyRoleUi('seeker');
  acquireWakeLock();

  if (isMeetup) {
    connectRoom(ctx);
    // Meetup responders need the mic immediately; seekers when they calibrate.
    startEngine(ctx);
  } else {
    // Local mode: seeker by default; user may flip the toggle.
    startEngine(ctx);
  }
}

export async function leaveFind(ctx) {
  if (!state.active) return;
  state.leaving = true;
  state.active = false;
  stopAutoPing();
  releaseWakeLock();
  resetGps();
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.session) { state.session.stop(); state.session = null; }
  await ctx.engine.stop();
  ctx.setActivity('idle');
  $('calib-overlay').classList.add('hidden');
}
