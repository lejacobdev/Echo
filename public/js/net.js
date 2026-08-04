// API client + reconnecting WebSocket wrappers.

export async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('network');
    e.code = 'network';
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const e = new Error(data.error || `http_${res.status}`);
    e.code = data.error || `http_${res.status}`;
    e.status = res.status;
    throw e;
  }
  return data;
}

function wsUrl(params) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return `${proto}://${location.host}/ws${qs}`;
}

// Reconnecting socket with exponential backoff. `handlers.onMessage(msg)`,
// optional onOpen/onClose/onGone. Call .close() to stop for good.
export function connectWs(params, handlers) {
  let socket = null;
  let closed = false;
  let attempts = 0;
  let heartbeat = null;

  function open() {
    if (closed) return;
    socket = new WebSocket(wsUrl(params));
    socket.onopen = () => {
      attempts = 0;
      if (handlers.onOpen) handlers.onOpen();
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'hb' }));
        }
      }, 25000);
    };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'hb') return;
      if (msg.t === 'error' || msg.t === 'ended') {
        closed = true; // server says this connection's purpose is over
        clearInterval(heartbeat);
      }
      handlers.onMessage(msg);
    };
    socket.onclose = () => {
      clearInterval(heartbeat);
      if (closed) return;
      if (handlers.onClose) handlers.onClose();
      attempts++;
      if (attempts > 6) {
        closed = true;
        if (handlers.onGone) handlers.onGone();
        return;
      }
      setTimeout(open, Math.min(15000, 500 * 2 ** attempts));
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  open();

  return {
    send(obj) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(obj));
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      if (socket) socket.close();
    },
    get isClosed() { return closed; },
  };
}

// Storage that never throws (private mode, embedded webviews) — falls back to memory.
const memStore = new Map();
export const safeStorage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return memStore.get(key) ?? null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { memStore.set(key, value); }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { memStore.delete(key); }
  },
};
