// App core: state, hash router, theme/i18n, presence socket, modals, toasts.
import { t, setLang, detectLang, applyTranslations } from './i18n.js';
import { api, connectWs, safeStorage } from './net.js';
import { AudioEngine } from './audio.js';
import { enterFind, leaveFind } from './find.js';
import { initSocial, renderFriends, renderHistory, renderSettings, prepareJoin, prepareAuth } from './social.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  lang: 'auto', theme: 'auto', haptics: true, soundFx: false, notifications: false,
  channel: 'A', adaptive: true, threshold: 165, debug: false,
};

export const ctx = {
  me: null,             // current user (public shape) or null
  payload: null,        // full /api/me payload (friends, requests, …)
  settings: { ...DEFAULT_SETTINGS },
  engine: new AudioEngine(),
  presence: null,       // presence websocket
  guestToken: null,     // ws token after joining a meetup as guest
  postAuthRoute: null,  // where to go after signing in
  t,
  $,
  toast, confirmDialog, navigate, refreshMe, updateSettings, setActivity, notify,
  onPresenceChange: null, // set by social view to live-update the friends list
};

// ---------- Toasts / dialogs ----------

function toast(text, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast${type === 'warn' ? ' toast-warn' : type === 'error' ? ' toast-error' : ''}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function confirmDialog(title, body) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('modal-backdrop').classList.remove('hidden');
    $('modal-confirm').classList.remove('hidden');
    const done = (answer) => {
      $('modal-backdrop').classList.add('hidden');
      $('modal-confirm').classList.add('hidden');
      $('confirm-yes').onclick = $('confirm-no').onclick = null;
      resolve(answer);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

// ---------- Activity pill ----------

function setActivity(state) { // 'idle' | 'listening' | 'denied'
  const pill = $('activity-pill');
  pill.className = 'pill ' + (state === 'listening' ? 'pill-live' : state === 'denied' ? 'pill-warn' : 'pill-idle');
  $('activity-text').textContent =
    state === 'listening' ? t('status.listening') : state === 'denied' ? t('status.denied') : t('status.idle');
}

// ---------- Notifications ----------

function notify(title, body) {
  if (!ctx.settings.notifications || typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted' && document.hidden) {
    try { new Notification(title, { body, icon: '/icons/icon-192.png' }); } catch { /* unsupported */ }
  }
}

// ---------- Settings ----------

function loadSettings() {
  try {
    const raw = safeStorage.get('echo.settings');
    if (raw) ctx.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* corrupted -> defaults */ }
}

function updateSettings(patch, { sync = true } = {}) {
  ctx.settings = { ...ctx.settings, ...patch };
  safeStorage.set('echo.settings', JSON.stringify(ctx.settings));
  applySettings();
  if (sync && ctx.me) api('/api/me', 'PATCH', { settings: ctx.settings }).catch(() => {});
}

function applySettings() {
  const { theme, lang } = ctx.settings;
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#0b0e14' : '#f4f6fa');
  setLang(lang === 'auto' ? detectLang() : lang);
  setActivity(ctx.engine.active ? 'listening' : 'idle');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applySettings());

// ---------- Auth/session ----------

async function refreshMe() {
  try {
    const payload = await api('/api/me');
    setMe(payload.user ? payload : null);
  } catch {
    // network errors: keep whatever state we have
  }
}

export function setMe(payload) {
  ctx.payload = payload;
  ctx.me = payload ? payload.user : null;
  const chip = $('account-chip');
  if (ctx.me) {
    chip.textContent = ctx.me.emoji;
    chip.classList.remove('hidden');
    if (ctx.me.settings && Object.keys(ctx.me.settings).length) {
      ctx.settings = { ...DEFAULT_SETTINGS, ...ctx.me.settings };
      safeStorage.set('echo.settings', JSON.stringify(ctx.settings));
      applySettings();
    }
    startPresence();
  } else {
    chip.classList.add('hidden');
    stopPresence();
  }
}
ctx.setMe = setMe;

// ---------- Presence socket ----------

function startPresence() {
  if (ctx.presence && !ctx.presence.isClosed) return;
  ctx.presence = connectWs(null, {
    onMessage(msg) {
      switch (msg.t) {
        case 'hello':
          if (ctx.payload) {
            for (const f of ctx.payload.friends) f.online = msg.online.includes(f.id);
            ctx.onPresenceChange?.();
          }
          break;
        case 'presence': {
          const f = ctx.payload?.friends.find((x) => x.id === msg.userId);
          if (f) { f.online = msg.online; ctx.onPresenceChange?.(); }
          break;
        }
        case 'invite':
          showInvite(msg.from, msg.code);
          notify(`${msg.from.name}`, `${msg.from.name} ${t('notif.invite')}`);
          break;
        case 'request':
          toast(`${msg.from.emoji} ${msg.from.name} — ${t('notif.request')}`);
          notify(msg.from.name, `${msg.from.name} ${t('notif.request')}`);
          refreshMe().then(() => ctx.onPresenceChange?.());
          break;
        case 'request-accepted':
          toast(`${msg.by.emoji} ${msg.by.name} ${t('request.accepted')}`);
          refreshMe().then(() => ctx.onPresenceChange?.());
          break;
        case 'invite-declined':
          toast(`${msg.by.name} ${t('invite.declined')}`, 'warn');
          break;
      }
    },
  });
}

function stopPresence() {
  if (ctx.presence) { ctx.presence.close(); ctx.presence = null; }
}

// ---------- Invite modal ----------

function showInvite(from, code) {
  $('invite-from').textContent = from.emoji || '📡';
  $('invite-title').textContent = `${from.name} (@${from.handle})`;
  $('modal-backdrop').classList.remove('hidden');
  $('modal-invite').classList.remove('hidden');
  const done = () => {
    $('modal-backdrop').classList.add('hidden');
    $('modal-invite').classList.add('hidden');
    $('invite-accept').onclick = $('invite-decline').onclick = null;
  };
  $('invite-accept').onclick = () => { done(); navigate(`#/meetup/${code}`); };
  $('invite-decline').onclick = () => {
    done();
    api('/api/meetups/decline', 'POST', { code }).catch(() => {});
  };
}

// ---------- Router ----------

const VIEWS = ['home', 'auth', 'join', 'find', 'friends', 'history', 'settings', 'about'];
let currentRoute = null;

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [head, arg] = h.split('/');
  if (!head) return { view: 'home' };
  if (head === 'meetup' && arg) return { view: 'find', mode: 'meetup', code: arg.toUpperCase() };
  if (head === 'find') return { view: 'find', mode: 'local' };
  if (head === 'join') return { view: 'join', code: arg ? arg.toUpperCase() : null };
  if (VIEWS.includes(head)) return { view: head };
  return { view: 'home' };
}

async function route() {
  const r = parseRoute();
  const wasFind = currentRoute?.view === 'find';
  const isSameFind = wasFind && r.view === 'find' &&
    currentRoute.mode === r.mode && currentRoute.code === r.code;
  if (wasFind && !isSameFind) await leaveFind(ctx);
  currentRoute = r;

  for (const v of VIEWS) $(`view-${v}`).classList.toggle('hidden', v !== r.view);
  for (const tab of document.querySelectorAll('#tabbar .tab')) {
    tab.classList.toggle('active', tab.dataset.nav === r.view);
  }

  switch (r.view) {
    case 'find':
      if (!isSameFind) enterFind(ctx, r);
      break;
    case 'friends': renderFriends(ctx); break;
    case 'history': renderHistory(ctx); break;
    case 'settings': renderSettings(ctx); break;
    case 'join': prepareJoin(ctx, r.code); break;
    case 'auth': prepareAuth(ctx); break;
  }
  window.scrollTo(0, 0);
}

// ---------- Boot ----------

async function boot() {
  loadSettings();
  applySettings();
  applyTranslations();

  if (!AudioEngine.supported() || !window.isSecureContext) {
    $('unsupported-card').classList.remove('hidden');
  }

  for (const tab of document.querySelectorAll('#tabbar .tab')) {
    tab.addEventListener('click', () => navigate(`#/${tab.dataset.nav === 'home' ? '' : tab.dataset.nav}`));
  }
  $('account-chip').addEventListener('click', () => navigate('#/settings'));
  $('btn-about').addEventListener('click', () => navigate('#/about'));

  $('home-start').addEventListener('click', async () => {
    if (!ctx.me) {
      ctx.postAuthRoute = '#/';
      toast(t('auth.needed'));
      navigate('#/auth');
      return;
    }
    try {
      const { code } = await api('/api/meetups', 'POST', {});
      navigate(`#/meetup/${code}`);
    } catch (e) {
      toast(t(`err.${e.code}`) === `err.${e.code}` ? t('err.network') : t(`err.${e.code}`), 'error');
    }
  });
  $('home-join').addEventListener('click', () => navigate('#/join'));
  $('home-local').addEventListener('click', () => navigate('#/find'));

  window.addEventListener('online', () => $('offline-banner').classList.add('hidden'));
  window.addEventListener('offline', () => $('offline-banner').classList.remove('hidden'));
  if (!navigator.onLine) $('offline-banner').classList.remove('hidden');

  initSocial(ctx);
  await refreshMe();

  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
