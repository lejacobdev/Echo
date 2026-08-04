// Social views: auth, friends, requests, history, settings, join-by-code.
import { t, applyTranslations, getLang } from './i18n.js';
import { api } from './net.js';

const EMOJI_SET = ['🙂','😀','😎','🦊','🐼','🐸','🦄','🐙','🌟','🎧','🌈','🍀','🔥','🐢','🐳','🦉'];

let authMode = 'login';

function $(id) { return document.getElementById(id); }

function errText(e) {
  const key = `err.${e.code}`;
  const msg = t(key);
  return msg === key ? t('err.network') : msg;
}

// ---------- Auth ----------

export function prepareAuth() {
  $('auth-error').hidden = true;
  $('auth-form').reset();
  setAuthMode(authMode);
}

function setAuthMode(mode) {
  authMode = mode;
  $('auth-tab-login').classList.toggle('active', mode === 'login');
  $('auth-tab-signup').classList.toggle('active', mode === 'signup');
  $('auth-name-field').hidden = mode === 'login';
  $('auth-submit').textContent = t(mode === 'login' ? 'auth.login' : 'auth.signup');
  $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
}

// ---------- Friends ----------

function userRow({ emoji, name, handle, online }, actions) {
  const li = document.createElement('li');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = emoji || '👤';
  if (online) {
    const dot = document.createElement('span');
    dot.className = 'online-dot';
    dot.title = t('friends.online');
    avatar.appendChild(dot);
  }
  const main = document.createElement('div');
  main.className = 'li-main';
  const title = document.createElement('div');
  title.className = 'li-title';
  title.textContent = name;
  const sub = document.createElement('div');
  sub.className = 'li-sub';
  sub.textContent = `@${handle}`;
  main.append(title, sub);
  const actionBox = document.createElement('div');
  actionBox.className = 'li-actions';
  for (const a of actions) actionBox.appendChild(a);
  li.append(avatar, main, actionBox);
  return li;
}

function actionBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = `btn btn-sm ${cls}`;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

export function renderFriends(ctx) {
  const signedIn = !!ctx.me;
  $('friends-signedout').classList.toggle('hidden', signedIn);
  $('friends-signedin').classList.toggle('hidden', !signedIn);
  if (!signedIn || !ctx.payload) return;

  const { friends, incoming, outgoing, blocked } = ctx.payload;

  const list = $('friends-list');
  list.innerHTML = '';
  $('friends-empty').classList.toggle('hidden', friends.length > 0);
  for (const f of friends) {
    list.appendChild(userRow(f, [
      actionBtn(t('friends.find'), 'btn-primary', async () => {
        try {
          const { code, inviteeOnline } = await api('/api/meetups', 'POST', { inviteeId: f.id });
          ctx.toast(inviteeOnline ? t('invite.sent') : `${f.name} ${t('invite.offline')}`, inviteeOnline ? 'info' : 'warn');
          ctx.navigate(`#/meetup/${code}`);
        } catch (e) { ctx.toast(errText(e), 'error'); }
      }),
      actionBtn(t('friends.remove'), 'btn-outline', async () => {
        if (!(await ctx.confirmDialog(t('friends.remove'), t('friends.removeConfirm')))) return;
        try { ctx.setMe(await api('/api/friends/remove', 'POST', { userId: f.id })); renderFriends(ctx); }
        catch (e) { ctx.toast(errText(e), 'error'); }
      }),
    ]));
  }

  const showRequests = incoming.length > 0 || outgoing.length > 0;
  $('requests-card').classList.toggle('hidden', !showRequests);
  const inc = $('requests-incoming');
  inc.innerHTML = '';
  for (const r of incoming) {
    inc.appendChild(userRow(r.from, [
      actionBtn(t('friends.accept'), 'btn-primary', async () => {
        try { ctx.setMe(await api('/api/friends/respond', 'POST', { id: r.id, accept: true })); renderFriends(ctx); }
        catch (e) { ctx.toast(errText(e), 'error'); }
      }),
      actionBtn(t('friends.decline'), 'btn-outline', async () => {
        try { ctx.setMe(await api('/api/friends/respond', 'POST', { id: r.id, accept: false })); renderFriends(ctx); }
        catch (e) { ctx.toast(errText(e), 'error'); }
      }),
      actionBtn(t('friends.block'), 'btn-danger-outline', async () => {
        if (!(await ctx.confirmDialog(t('friends.block'), t('friends.blockConfirm')))) return;
        try { ctx.setMe(await api('/api/friends/block', 'POST', { userId: r.from.id })); renderFriends(ctx); }
        catch (e) { ctx.toast(errText(e), 'error'); }
      }),
    ]));
  }
  const out = $('requests-outgoing');
  out.innerHTML = '';
  for (const r of outgoing) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t('friends.pending');
    out.appendChild(userRow(r.to, [tag]));
  }

  $('blocked-card').classList.toggle('hidden', blocked.length === 0);
  const bl = $('blocked-list');
  bl.innerHTML = '';
  for (const b of blocked) {
    bl.appendChild(userRow(b, [
      actionBtn(t('friends.unblock'), 'btn-outline', async () => {
        try { ctx.setMe(await api('/api/friends/unblock', 'POST', { userId: b.id })); renderFriends(ctx); }
        catch (e) { ctx.toast(errText(e), 'error'); }
      }),
    ]));
  }
}

async function runSearch(ctx) {
  const q = $('friend-search').value.trim();
  const box = $('friend-results');
  if (q.length < 2) { box.innerHTML = ''; return; }
  let results;
  try { ({ results } = await api(`/api/users/search?q=${encodeURIComponent(q)}`)); }
  catch { return; }
  box.innerHTML = '';
  for (const u of results) {
    let action;
    if (u.relation === 'none' || u.relation === 'incoming') {
      action = actionBtn(t('friends.addBtn'), 'btn-primary', async () => {
        try {
          const { becameFriends } = await api('/api/friends/request', 'POST', { userId: u.id, handle: u.handle });
          ctx.toast(t(becameFriends ? 'friends.nowFriends' : 'friends.requestSent'));
          await ctx.refreshMe();
          renderFriends(ctx);
          runSearch(ctx);
        } catch (e) { ctx.toast(errText(e), 'error'); }
      });
    } else {
      action = document.createElement('span');
      action.className = 'tag';
      action.textContent = t(u.relation === 'friend' ? 'friends.yours' : 'friends.pending');
    }
    box.appendChild(userRow(u, [action]));
  }
}

// ---------- History ----------

export async function renderHistory(ctx) {
  const list = $('history-list');
  list.innerHTML = '';
  let history = [];
  if (ctx.me) {
    try { ({ history } = await api('/api/meetups/history')); } catch { /* offline */ }
  }
  $('history-empty').classList.toggle('hidden', history.length > 0);
  const fmt = new Intl.DateTimeFormat(getLang(), { dateStyle: 'medium', timeStyle: 'short' });
  for (const h of history) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'li-main';
    const title = document.createElement('div');
    title.className = 'li-title';
    title.textContent = h.peerName || h.code;
    const sub = document.createElement('div');
    sub.className = 'li-sub';
    sub.textContent = fmt.format(h.endedAt || h.at);
    main.append(title, sub);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = h.found ? `✓ ${t('history.found')}` : t('history.notFound');
    li.append(main, tag);
    if (h.bestDistance !== null && h.bestDistance !== undefined) {
      const best = document.createElement('span');
      best.className = 'li-sub';
      best.textContent = `${h.bestDistance} m ${t('history.best')}`;
      li.appendChild(best);
    }
    list.appendChild(li);
  }
}

// ---------- Settings ----------

export function renderSettings(ctx) {
  const signedIn = !!ctx.me;
  $('profile-card').classList.toggle('hidden', !signedIn);
  $('account-card').classList.toggle('hidden', !signedIn);

  if (signedIn) {
    $('profile-name').value = ctx.me.name;
    const grid = $('emoji-grid');
    grid.innerHTML = '';
    for (const e of EMOJI_SET) {
      const b = document.createElement('button');
      b.className = `emoji-btn${e === ctx.me.emoji ? ' active' : ''}`;
      b.textContent = e;
      b.onclick = () => {
        grid.querySelector('.active')?.classList.remove('active');
        b.classList.add('active');
      };
      grid.appendChild(b);
    }
  }

  const s = ctx.settings;
  $('set-lang').value = s.lang;
  $('set-theme').value = s.theme;
  $('set-haptics').checked = s.haptics;
  $('set-soundfx').checked = s.soundFx;
  $('set-notifications').checked = s.notifications;
  $('set-channel').value = s.channel;
  $('set-adaptive').checked = s.adaptive;
  $('set-threshold').value = String(s.threshold);
  $('set-threshold-val').textContent = String(s.threshold);
  $('manual-threshold-field').hidden = s.adaptive;
  $('set-debug').checked = s.debug;
}

// ---------- Join ----------

export function prepareJoin(ctx, code) {
  $('join-error').hidden = true;
  if (code) $('join-code').value = code;
  $('join-name-field').hidden = !!ctx.me;
}

// ---------- One-time wiring ----------

export function initSocial(ctx) {
  // Auth
  $('auth-tab-login').addEventListener('click', () => setAuthMode('login'));
  $('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));
  $('auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = $('auth-error');
    errEl.hidden = true;
    try {
      const body = {
        handle: $('auth-handle').value.trim(),
        password: $('auth-password').value,
      };
      if (authMode === 'signup') body.name = $('auth-name').value.trim();
      const payload = await api(`/api/auth/${authMode}`, 'POST', body);
      ctx.setMe(payload);
      ctx.toast(`${payload.user.emoji} ${payload.user.name}`);
      ctx.navigate(ctx.postAuthRoute || '#/');
      ctx.postAuthRoute = null;
    } catch (e) {
      errEl.textContent = errText(e);
      errEl.hidden = false;
    }
  });
  $('friends-goto-auth').addEventListener('click', () => {
    ctx.postAuthRoute = '#/friends';
    ctx.navigate('#/auth');
  });

  // Friends search (debounced)
  let searchTimer = null;
  $('friend-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(ctx), 300);
  });
  ctx.onPresenceChange = () => {
    if (!$('view-friends').classList.contains('hidden')) renderFriends(ctx);
  };

  // Join
  $('join-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = $('join-error');
    errEl.hidden = true;
    const code = $('join-code').value.trim().toUpperCase();
    try {
      const res = await api('/api/meetups/join', 'POST', {
        code,
        guestName: $('join-name').value.trim() || undefined,
      });
      ctx.guestToken = res.guest ? res.wsToken : null;
      ctx.navigate(`#/meetup/${code}`);
    } catch (e) {
      errEl.textContent = errText(e);
      errEl.hidden = false;
    }
  });

  // Settings: profile
  $('profile-save').addEventListener('click', async () => {
    try {
      const emoji = $('emoji-grid').querySelector('.active')?.textContent || ctx.me.emoji;
      const payload = await api('/api/me', 'PATCH', { name: $('profile-name').value.trim(), emoji });
      ctx.setMe(payload);
      ctx.toast(t('settings.saved'));
    } catch (e) { ctx.toast(errText(e), 'error'); }
  });

  // Settings: app + acoustic
  $('set-lang').addEventListener('change', (e) => { ctx.updateSettings({ lang: e.target.value }); applyTranslations(); renderSettings(ctx); });
  $('set-theme').addEventListener('change', (e) => ctx.updateSettings({ theme: e.target.value }));
  $('set-haptics').addEventListener('change', (e) => ctx.updateSettings({ haptics: e.target.checked }));
  $('set-soundfx').addEventListener('change', (e) => ctx.updateSettings({ soundFx: e.target.checked }));
  $('set-notifications').addEventListener('change', async (e) => {
    if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { e.target.checked = false; return; }
    }
    ctx.updateSettings({ notifications: e.target.checked });
  });
  $('set-channel').addEventListener('change', (e) => ctx.updateSettings({ channel: e.target.value }));
  $('set-adaptive').addEventListener('change', (e) => {
    ctx.updateSettings({ adaptive: e.target.checked });
    $('manual-threshold-field').hidden = e.target.checked;
  });
  $('set-threshold').addEventListener('input', (e) => {
    $('set-threshold-val').textContent = e.target.value;
    ctx.updateSettings({ threshold: Number(e.target.value) });
  });
  $('set-debug').addEventListener('change', (e) => ctx.updateSettings({ debug: e.target.checked }));

  // Settings: account
  $('password-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/me/password', 'POST', {
        current: $('pw-current').value,
        next: $('pw-next').value,
      });
      $('password-form').reset();
      ctx.toast(t('settings.pwChanged'));
    } catch (e) { ctx.toast(errText(e), 'error'); }
  });
  $('btn-logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', 'POST', {}); } catch { /* best effort */ }
    ctx.setMe(null);
    ctx.navigate('#/');
  });
  $('btn-delete-account').addEventListener('click', async () => {
    if (!(await ctx.confirmDialog(t('settings.deleteAccount'), t('settings.deleteConfirm')))) return;
    try {
      await api('/api/me', 'DELETE', {});
      ctx.setMe(null);
      ctx.navigate('#/');
    } catch (e) { ctx.toast(errText(e), 'error'); }
  });
}
