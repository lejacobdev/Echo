// Echo server: static frontend + REST API + WebSocket hub.
// Zero runtime dependencies — plain Node ≥ 18. `node server/server.js` and go.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createApi } from './api.js';
import { createHub } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(self)',
  'X-Frame-Options': 'DENY',
};

export function createEchoServer({ dataFile } = {}) {
  const store = createStore(dataFile || path.join(__dirname, '..', 'data', 'echo-data.json'));
  const hub = createHub(store);
  const api = createApi(store, hub);

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    try {
      if (await api.handle(req, res)) return;
    } catch (err) {
      console.error('API error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"internal"}');
      }
      return;
    }

    serveStatic(req, res);
  });

  // Track upgraded sockets: server.close() won't finish while they're open.
  const upgraded = new Set();
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    hub.handleUpgrade(req, socket);
  });

  function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    // Short invite deep links: /j/CODE -> SPA join route.
    const joinMatch = pathname.match(/^\/j\/([A-Za-z0-9]{4,10})$/);
    if (joinMatch) {
      res.writeHead(302, { Location: `/#/join/${joinMatch[1].toUpperCase()}` });
      res.end();
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }

    fs.readFile(filePath, (err, buf) => {
      if (err) {
        // SPA fallback for unknown navigations, plain 404 for assets.
        if (!path.extname(pathname)) {
          fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, index) => {
            if (e2) { res.writeHead(404).end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(index);
          });
        } else {
          res.writeHead(404).end('Not found');
        }
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (pathname.startsWith('/icons/')) headers['Cache-Control'] = 'public, max-age=604800';
      else if (ext === '.html' || pathname === '/sw.js') headers['Cache-Control'] = 'no-cache';
      else headers['Cache-Control'] = 'public, max-age=3600';
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  return {
    server,
    store,
    hub,
    listen(port, host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async close() {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await store.close();
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const echo = createEchoServer({ dataFile: process.env.ECHO_DATA });
  echo.listen(port, host).then((addr) => {
    console.log(`Echo listening on http://${host}:${addr.port}`);
    console.log('Note: phones require HTTPS for microphone access — put a TLS proxy or tunnel in front.');
  });
  const shutdown = async () => { await echo.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
